const test = require("node:test")
const assert = require("node:assert/strict")
const W = require("../WindowModel.js")
const Model = require("../Model.js")
const target = () => ({ address: "0xabc", stableId: "1800001b", workspace: 11 })
const enabled = () => ({ enabled: true })

test("window management stays inert until explicitly enabled and config round trips", () => {
  const config = W.normalize({})
  assert.equal(config.enabled, false)
  assert.deepEqual(W.catalog(config), [])
  assert.deepEqual(W.normalize(JSON.parse(JSON.stringify(config))), config)
})

test("bounded layouts retain migrated cells, assignments and physical monitor descriptions", () => {
  const cells = [[{ weight: 2, parts: [1, 2] }, 3], [2]]
  const config = W.normalize({ enabled: true, layouts: [{ id: "asymmetric", weights: [2, 3, 5], cells, gridColumns: 0, overflow: "extend", orientation: "rows" }], workspaces: { "11": "asymmetric", "12": "unknown" }, monitors: { "desc:Panel Model Serial": "asymmetric", "DP-1": "asymmetric", "name:DP-2": "asymmetric" } })
  assert.deepEqual(config.layouts[0].cells, cells)
  assert.equal(config.layouts[0].gridColumns, 0)
  assert.deepEqual(config.workspaces, { "11": "asymmetric" })
  assert.deepEqual(Object.keys(config.monitors), ["desc:Panel Model Serial", "name:DP-2"])
  assert.deepEqual(W.normalize(config), config)
  const bounded = W.normalize({ layouts: [{ id: "bounded", weights: [-1, Infinity, 1e9], gridColumns: 200 }] }).layouts[0]
  assert.deepEqual(bounded.weights, [0.01, 1, 10000])
  assert.equal(bounded.gridColumns, 16)
  assert.deepEqual(W.normalize({ layouts: [{ id: "malformed", cells: [[[1, 2]], []] }] }).layouts[0].cells, [[1], [100]])
  assert.deepEqual(W.normalize({ layouts: [{ id: "UpperCase" }, { id: "under_score" }, { id: "valid-id" }] }).layouts.map(item => item.id), ["valid-id"])
  assert.ok(W.customSize({ id: "Under_Score", name: "Allowed custom ID", width: "50%", height: "100", anchor: "center" }))
})

test("slot placement and frame centering are distinct searchable first-class commands", () => {
  const rows = W.rows(enabled(), "center", target(), Model.matchScore).map(Model.row)
  assert.ok(rows.some(row => row.payload.action === "place-center"))
  assert.ok(rows.some(row => row.payload.action === "center"))
  assert.ok(rows.every(row => row.section === "windowActions"))
  assert.deepEqual(W.rows(enabled(), "", null, Model.matchScore).map(x => x.payload.action), ["previous-space", "next-space"])
})

test("search payload freezes address, exact hexadecimal stable ID and workspace", () => {
  const client = target()
  const rows = W.rows(enabled(), "", client, Model.matchScore)
  client.address = "0xdef"
  client.stableId = "another"
  client.workspace = 99
  assert.deepEqual(rows[0].payload.target, target())
  assert.notEqual(rows[0].payload.target, rows[1].payload.target)
  assert.deepEqual(W.targetFromClient({ address: "0xABC", stableId: "1800001b", workspace: { id: 11 } }), { address: "0xABC", stableId: "1800001b", workspace: 11 })
  const named = W.targetFromClient({ ...target(), workspace: { id: -1337, name: "research" } })
  assert.deepEqual(named, { ...target(), workspace: "name:research" })
  assert.deepEqual(W.targetFromClient(named), named)
  assert.equal(W.targetFromClient({ ...target(), workspace: { id: 11, name: "eleven" } }).workspace, 11)
  assert.equal(W.rows(enabled(), "center", named, Model.matchScore)[0].payload.target.workspace, "name:research")
  assert.equal(W.targetFromClient({ address: "0xabc", workspace: 11 }), null)
  assert.equal(W.targetFromClient({ ...target(), address: "unsafe" }), null)
})

test("dismissed and superseded capture tickets cannot open or retarget another session", () => {
  const state = { generation: 0, pending: false, target: null }
  const old = W.beginSession(state)
  W.cancelSession(state)
  assert.equal(W.finishCapture(state, old, target()), false)
  assert.equal(state.target, null)
  const next = W.beginSession(state)
  const newest = W.beginSession(state)
  assert.equal(W.finishCapture(state, next, target()), false)
  const selected = { ...target(), address: "0xdef", stableId: "1800001c" }
  assert.equal(W.finishCapture(state, newest, selected), true)
  selected.address = "0x999"
  assert.equal(state.target.address, "0xdef")
  assert.equal(W.finishCapture(state, old, target()), false)
  assert.equal(W.finishCapture(state, newest, target()), false)
  assert.equal(state.target.stableId, "1800001c")
})

test("window switch and close use live handle identity rather than reordered indices", () => {
  const a = {}, b = {}, original = [{ index: 0, identity: 1, title: "A", appId: "app", toplevel: a, target: target() }, { index: 1, identity: 2, title: "B", appId: "app", toplevel: b, target: { ...target(), address: "0xdef", stableId: "1800001c" } }]
  const row = Model.windowRows(original, "")[0]
  assert.equal(row.payload.handle, a)
  const reordered = [original[1], original[0]].map((entry, index) => ({ ...entry, index }))
  assert.equal(W.resolveHandle(reordered, row.payload), a)
  assert.equal(Model.windowRows(reordered, "")[1].key, row.key)
  assert.equal(W.resolveHandle([original[1]], row.payload), null)
  assert.equal(W.resolveHandle([{ ...original[0], toplevel: b }], row.payload), null)
  assert.equal(W.resolveHandle([{ ...original[0], target: { ...target(), stableId: "recycled" } }], row.payload), null)
})

test("selected-window Ctrl+K commands share the catalog and disable immediately", () => {
  const [row] = Model.windowRows([{ index: 0, identity: 1, title: "Selected", toplevel: {}, target: target() }], "")
  const actions = Model.rowActions(row, {}, enabled())
  assert.ok(actions.some(action => action.id === "window:restore"))
  assert.ok(actions.some(action => action.id === "window:place-center"))
  assert.ok(actions.some(action => action.id === "window:center"))
  assert.equal(actions[0].id, "primary")
  assert.equal(actions[1].id, "secondary")
  assert.equal(Model.rowActions(row, {}, { enabled: false }).some(x => x.id.startsWith("window:")), false)
  assert.equal(Model.rowActions({ ...row, payload: { ...row.payload, target: null } }, {}, enabled()).some(x => x.id.startsWith("window:")), false)
})

test("custom sizes validate all dimensions, anchors and offsets and support create edit delete", () => {
  const size = { id: "reading", name: "Reading", width: "66.5%", height: "900", anchor: "center", offsetX: -20, offsetY: 30 }
  assert.deepEqual(W.customSize(size), size)
  for (const patch of [{ width: "0" }, { width: "101%" }, { height: "NaN" }, { height: "1;danger" }, { anchor: "outside" }, { offsetX: Infinity }, { offsetY: "10" }, { name: "" }, { id: "../bad" }]) {
    assert.equal(W.customSize({ ...size, ...patch }), null)
    assert.throws(() => W.update({}, { type: "size", value: { ...size, ...patch } }))
  }
  let raw = W.update({ enabled: true, future: { preserve: true } }, { type: "size", value: size })
  assert.ok(W.rows(raw, "reading", target(), Model.matchScore).some(row => row.payload.action === "custom:reading"))
  raw = W.update(raw, { type: "size", value: { ...size, width: "75%" } })
  assert.equal(raw.customSizes.length, 1)
  assert.equal(raw.customSizes[0].width, "75%")
  assert.deepEqual(W.normalize(JSON.parse(JSON.stringify(raw))), W.normalize(raw))
  raw = W.update(raw, { type: "deleteSize", id: "reading" })
  assert.deepEqual(raw.customSizes, [])
  assert.deepEqual(raw.future, { preserve: true })
})

test("runtime disable preserves unrelated config, assignments, sizes and binding ownership", () => {
  const raw = { enabled: true, workspaces: { "11": "focus" }, future: { keep: "yes" }, customSizes: [{ id: "a", name: "A", width: "50%", height: "50%", anchor: "center" }] }
  const disabled = W.update(raw, { type: "enabled", value: false })
  assert.deepEqual(disabled, { ...raw, enabled: false })
  assert.deepEqual(W.catalog(disabled), [])
  const other = 'local o = require("omarchy")\no.bind("SUPER + Q", "Terminal", "terminal")\n'
  const palette = Model.replaceBindBlock(other, Model.renderBindBlock({ palette: "ALT + SPACE", clipboard: true }))
  const bound = W.replaceBindings(palette, { "place-left": "SUPER + ALT + LEFT", "place-down": "SUPER + ALT + DOWN" })
  assert.deepEqual(W.parseBindings(bound), { "place-left": "SUPER + ALT + LEFT", "place-down": "SUPER + ALT + DOWN" })
  assert.deepEqual(Model.parseBindBlock(bound), Model.parseBindBlock(palette))
  assert.ok(bound.startsWith(other))
  const removed = W.replaceBindings(bound, {})
  assert.ok(removed.startsWith(palette))
  assert.deepEqual(W.parseBindings(removed), {})
  assert.throws(() => W.replaceBindings(other + "-- omacast-windows: begin\n", {}))
})

test("display shortcuts survive editing placement binds and can be independently rebound or removed", () => {
  const other = 'hl.bind("SUPER + Q", function() terminal() end)\n'
  const bindings = { "place-left": "SUPER + ALT + LEFT", "next-display": "SUPER + ALT + N", "previous-display": "SUPER + ALT + P" }
  let text = W.replaceBindings(other, bindings)
  assert.deepEqual(W.parseBindings(text), bindings)
  const reloaded = W.parseBindings(text)
  reloaded["place-right"] = "SUPER + ALT + RIGHT"
  text = W.replaceBindings(text, reloaded)
  assert.deepEqual(W.parseBindings(text), { ...bindings, "place-right": "SUPER + ALT + RIGHT" })
  const changed = W.parseBindings(text)
  changed["next-display"] = "SUPER + CTRL + N"
  changed["previous-display"] = ""
  text = W.replaceBindings(text, changed)
  assert.deepEqual(W.parseBindings(text), { "place-left": bindings["place-left"], "place-right": reloaded["place-right"], "next-display": changed["next-display"] })
  assert.ok(text.startsWith(other))
})

test("Lua serialization safely carries quotes controls and paths without executable interpolation", () => {
  assert.equal(W.luaLiteral('"\\\n\u0000'), '"\\034\\092\\010\\000"')
  assert.equal(W.luaLiteral({ key: [true, false, null, 42] }), '{["key"]={true,false,nil,42}}')
  assert.throws(() => W.luaLiteral(Infinity))
  assert.throws(() => W.actionLua("center", { address: "bad" }))
  const command = W.actionLua("place-left", target())
  assert.ok(command.startsWith("eval do "))
  assert.ok(command.includes(W.luaLiteral(target())))
  assert.ok(W.loaderLua(enabled(), '/plugin/with"quote').includes(W.luaLiteral('/plugin/with"quote/WindowActions.lua')))
})
