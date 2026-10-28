const test = require("node:test")
const assert = require("node:assert/strict")
const { createHash } = require("node:crypto")
const Model = require("../Model.js")
const NOW = 1800000000000
const digest = text => createHash("md5").update(text).digest("hex")

test("search folds composed accents, compatibility forms and case without changing literal rows", () => {
  for (const [query, name] of [["cafe", "Café"], ["café", "Cafe\u0301"], ["strasse", "Straße"], ["ΟΣ", "ος"], ["東京", "東京駅"], ["привет", "Привет"], ["ＦＯＯ", "Foo"], ["lodz", "Łódź"]]) {
    assert.ok(Model.matchScore(query, { name }) > 0, `${query}: ${name}`)
    assert.equal(Model.matchScore(query, Model.prepareFields(name, [], "")), Model.matchScore(query, { name }))
  }
  const path = "/home/u/Café/FILE.txt"
  const file = Model.fileRows([path], "FILE", "/home/u")[0]
  assert.equal(file.payload.path, path)
  assert.equal(Model.parseQuery("#Café FILE").rest, "Café FILE")
  assert.ok(Model.rankFile(path, "cafe") > 0, "filename search folds accents without changing the path")
})

test("aliases match an exact leading token and retain literal arguments", () => {
  const saved = Model.setAlias({}, "cmd:task", "Résumé", []).state
  assert.equal(Model.aliasTarget("resume-other", saved), null)
  assert.deepEqual(Model.aliasTarget('resume  Café "X Y" ', saved), { key: "cmd:task", alias: "resume", argument: ' Café "X Y" ' })
  assert.equal(Model.setAlias(saved, "app:other", "RESUME", []).ok, false)
  assert.equal(Model.setAlias(saved, "cmd:task", "proj", []).ok, false)
  assert.equal(Model.setAlias(saved, "cmd:task", "wiki", ["wiki"]).ok, false)
  assert.equal(Model.setAlias(saved, "proc:42", "proc", []).ok, false)
  assert.equal(Model.setAlias(saved, "cmd:task", "two words", []).ok, false)
  assert.equal(Model.aliasTarget("resume", Model.clearAlias(saved, "cmd:task")), null)
})

test("state mutations retain aliases, hashed learning and unknown extensions", () => {
  const hash = digest("root\0browser")
  let state = Model.setAlias({ future: { enabled: true } }, "app:browser", "browse", []).state
  state = Model.recordQueryUse(state, "app:browser", hash, NOW)
  state = Model.togglePin(state, "app:browser")
  state = Model.toggleHidden(state, "app:other")
  state = Model.rememberQuery(state, "last query")
  assert.equal(state.aliases["app:browser"], "browse")
  assert.equal(state.queryHistory[hash]["app:browser"].count, 1)
  assert.deepEqual(state.future, { enabled: true })
  assert.equal(Model.recordQueryUse(state, "app:browser", "plaintext", NOW).queryHistory.plaintext, undefined)
  for (const key of ["proc:42", "clip:1", "file:/tmp/a", "agent:answer", "script-result:1", "content:/tmp/a"]) {
    assert.deepEqual(Model.recordQueryUse({}, key, hash, NOW).queryHistory, {})
  }
  const reset = Model.resetUsage(state, "app:browser")
  assert.equal(reset.queryHistory[hash], undefined)
  assert.equal(reset.aliases["app:browser"], "browse")
  assert.deepEqual(Model.clearQueryHistory(state).queryHistory, {})
})

test("query associations and alias stores enforce bounded persistence", () => {
  let state = {}
  for (let i = 0; i < 205; i++) state = Model.recordQueryUse(state, "app:x", digest(String(i)), NOW + i)
  assert.equal(Object.keys(state.queryHistory).length, 200)
  const hash = digest("shared")
  for (let i = 0; i < 12; i++) state = Model.recordQueryUse(state, "app:" + i, hash, NOW + 1000 + i)
  assert.equal(Object.keys(state.queryHistory[hash]).length, 8)
  assert.equal(state.queryHistory[hash]["app:0"], undefined)
  const aliases = {}
  for (let i = 0; i < 205; i++) aliases["app:" + i] = "alias" + i
  assert.equal(Object.keys(Model.normalizeState({ aliases }).aliases).length, 200)
})

test("combined passive ranking never promotes an alias prefix above a name prefix or moves sections", () => {
  const hash = digest("root\0fire")
  let state = Model.recordQueryUse({ usage: { "app:heavy": { count: 1000000, last: NOW } } }, "app:heavy", hash, NOW)
  state.queryHistory[hash]["app:heavy"].count = 1000000
  const exact = Model.row({ key: "app:exact", section: "apps", score: Model.matchScore("fire", { name: "Firefox" }) })
  const heavy = Model.row({ key: "app:heavy", section: "apps", frecencyKey: "app:heavy", score: Model.matchScore("fire", { name: "Browser", aliases: ["fire"] }) + Model.frecencyBonus(state.usage, "app:heavy", NOW) })
  const rows = Model.personalizeRows([exact, heavy], state, hash, NOW)
  assert.ok(rows[0].score > rows[1].score)
  assert.equal(rows[1].section, heavy.section)
  assert.equal(heavy.score + Model.queryBonus(state, "app:heavy", hash, NOW), rows[1].score)
  assert.ok(Model.queryBonus(state, "app:heavy", hash, NOW + 100 * 86400000) < Model.queryBonus(state, "app:heavy", hash, NOW))
})

test("stable result actions expose alias editing, removal and query-only reset but transient rows do not", () => {
  const hash = digest("root\0browser")
  let state = Model.recordQueryUse({}, "app:browser", hash, NOW)
  state = Model.setAlias(state, "app:browser", "browse", []).state
  const ids = Model.rowActions(Model.row({ key: "app:browser", payload: { kind: "app" } }), state).map(action => action.id)
  assert.ok(ids.includes("set-alias"))
  assert.ok(ids.includes("remove-alias"))
  assert.ok(ids.includes("reset-ranking"))
  const transient = Model.rowActions(Model.row({ key: "proc:1", payload: { kind: "process" } }), state)
  assert.ok(!transient.some(action => action.id === "set-alias"))
})

test("shared configuration is normalized, editable and retained across unrelated edits", () => {
  const raw = { queryLearning: true, projectsEnabled: true, inlineAi: true, fileRoots: [{ name: "Work", path: "/work/Café", future: 9 }], semanticEndpoint: "http://127.0.0.1:1234", semanticModel: "local", future: { version: 2 }, commands: [{ name: "Echo", keyword: "echo", command: "printf Café", custom: 7 }] }
  const config = Model.normalizeConfig(raw)
  assert.equal(config.scriptForms, true)
  assert.equal(config.protectPreviews, true)
  assert.equal(config.sshEnabled, false)
  assert.equal(config.fileRoots[0].path, "/work/Café")
  assert.equal(config.commands[0].custom, 7)
  const edited = Model.updateConfig(raw, { op: "set", key: "preview", value: false })
  assert.equal(edited.inlineAi, true)
  assert.equal(edited.fileRoots[0].future, 9)
  assert.deepEqual(edited.future, { version: 2 })
  assert.equal(Model.updateConfig(edited, { op: "set", key: "queryLearning", value: false }).queryLearning, false)
  const roots = Model.updateConfig(edited, { op: "setField", kind: "fileRoots", index: 0, field: "path", value: "/new" })
  assert.equal(roots.fileRoots[0].path, "/new")
  const settings = Model.settingsRows(edited, { config, binds: {}, barButton: null, scriptDir: "/scripts" }, "")
  assert.ok(settings.some(row => row.payload.action && row.payload.action.type === "clear-query-history"))
  assert.ok(settings.some(row => row.payload.action && row.payload.action.scope === "settings:fileRoots"))
})

test("new prefixes and named root requests preserve literal search terms", () => {
  for (const [prefix, scope] of [["proj", "projects"], ["ssh", "ssh"], ["bm", "bookmarks"], ["panel", "plugins"]]) assert.equal(Model.parseQuery(prefix + " ").scope, scope)
  const roots = [{ name: "Home", path: "/home/u" }, { name: "Work", path: "/work" }]
  const request = Model.fileRequest(Model.parseQuery("f @work Café FILE"), "/home/u", roots)
  assert.equal(request.dir, "/work")
  assert.deepEqual(request.terms, ["Café", "FILE"])
  assert.equal(request.rootName, "Work")
  assert.deepEqual(Model.fileRequest(Model.parseQuery("f @types package"), "/home/u", roots).terms, ["@types", "package"])
  assert.equal(Model.fileRequest(Model.parseQuery("f term"), "/home/u", roots, "Missing").dir, "")
  assert.equal(Model.fileRequest(Model.parseQuery("#Literal"), "/home/u", roots, "Work").rootPath, "/work")
  const content = Model.fileRequest(Model.parseQuery("#@Work Café @Override"), "/home/u", roots, "Home")
  assert.equal(content.rootPath, "/home/u")
  assert.deepEqual(content.terms, ["@Work", "Café", "@Override"])
  const selectedContent = Model.fileRequest(Model.parseQuery("#@Override"), "/home/u", roots, "Work")
  assert.equal(selectedContent.rootPath, "/work")
  assert.deepEqual(selectedContent.terms, ["@Override"])
})

test("script metadata results mode and raw structured values survive row creation", () => {
  const meta = Model.parseScriptCommand('# @omacast.schemaVersion 1\n# @omacast.title Choose\n# @omacast.mode results\n# @omacast.argument1 {"type":"text","placeholder":"target","options":["Café",{"title":"Other","value":"x y"}],"validation":".+","default":"Café","percentEncoded":true}\n# @omacast.needsConfirmation true')
  assert.equal(meta.mode, "results")
  assert.equal(meta.arguments[0].default, "Café")
  const script = { path: "/scripts/choose", keyword: "choose", executable: true, meta }
  const item = Model.scriptRows([script], "choose", {}, NOW)[0]
  assert.equal(item.payload.argumentSpecs[0].options[1].value, "x y")
  assert.deepEqual(item.payload.rawArgs, [])
  assert.deepEqual(item.payload.args, ["Caf%C3%A9"])
  assert.equal(item.payload.needsConfirmation, true)
  const invalid = Model.scriptRows([script], "choose invalid", {}, NOW)[0]
  assert.deepEqual(invalid.payload.args, [])
  assert.equal(invalid.payload.needsForm, true)
})
