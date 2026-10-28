// Pure window configuration, identities and command descriptions shared by QML and Node.
var ANCHORS = ["top-left", "top", "top-right", "left", "center", "right", "bottom-left", "bottom", "bottom-right"]
var SNAP_IDS = "left-half right-half top-half bottom-half top-left-quarter top-right-quarter bottom-left-quarter bottom-right-quarter first-three-fourths last-three-fourths first-third center-third last-third first-two-thirds last-two-thirds maximize almost-maximize reasonable-size maximize-height maximize-width center center-half center-two-thirds make-larger make-smaller restore move-left move-right move-up move-down next-display previous-display toggle-fullscreen previous-space next-space".split(" ")
function copy(value) { return JSON.parse(JSON.stringify(value)) }
function object(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : {} }
function bounded(value, fallback, low, high) { return typeof value === "number" && isFinite(value) ? Math.max(low, Math.min(high, value)) : fallback }
function identifier(value) { return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value) }
function preset(id, name, weights, underfill, orientation) { return { id: id, name: name, kind: "ratio", orientation: orientation || "columns", weights: weights, cells: [], fill: "largest", underfill: underfill || "hold", overflow: "last", gridColumns: 2 } }
function defaults() { return [preset("focus", "Focus", [25, 50, 25]), preset("thirds", "Thirds", [1, 1, 1]), preset("even", "Even", [1, 1], "rescale"), preset("main", "Main", [60, 40], "rescale"), preset("rows", "Rows", [1, 1], "rescale", "rows"), { id: "grid", name: "Grid", kind: "grid", orientation: "columns", weights: [1, 1], cells: [], fill: "order", underfill: "rescale", overflow: "extend", gridColumns: 2 }] }
function dimension(value) {
  var text = String(value === undefined ? "" : value).trim()
  if (!/^\d+(\.\d+)?%?$/.test(text)) return null
  var n = parseFloat(text)
  if (n <= 0 || n > (/%$/.test(text) ? 100 : 32768)) return null
  return String(n) + (/%$/.test(text) ? "%" : "")
}
function customSize(raw) {
  raw = object(raw)
  if (!identifier(raw.id) || typeof raw.name !== "string" || !raw.name.trim() || !dimension(raw.width) || !dimension(raw.height) || ANCHORS.indexOf(raw.anchor) < 0) return null
  if ((raw.offsetX !== undefined && (typeof raw.offsetX !== "number" || !isFinite(raw.offsetX) || Math.abs(raw.offsetX) > 32768)) || (raw.offsetY !== undefined && (typeof raw.offsetY !== "number" || !isFinite(raw.offsetY) || Math.abs(raw.offsetY) > 32768))) return null
  return { id: raw.id, name: raw.name.trim().slice(0, 120), width: dimension(raw.width), height: dimension(raw.height), anchor: raw.anchor, offsetX: raw.offsetX || 0, offsetY: raw.offsetY || 0 }
}
function normalize(raw) {
  raw = object(raw)
  var seen = {}, layouts = []
  ;(Array.isArray(raw.layouts) ? raw.layouts : defaults()).slice(0, 64).forEach(function(item) {
    item = object(item)
    if (typeof item.id !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(item.id) || seen[item.id]) return
    seen[item.id] = true
    var weights = (Array.isArray(item.weights) ? item.weights : [1, 1]).slice(0, 16).map(function(n) { return bounded(n, 1, 0.01, 10000) })
    if (!weights.length) weights = [1, 1]
    var cells = (Array.isArray(item.cells) ? item.cells : []).slice(0, weights.length).map(function(column) {
      var parts = (Array.isArray(column) ? column : []).slice(0, 16).map(function(cell) {
        if (cell && typeof cell === "object" && !Array.isArray(cell) && Array.isArray(cell.parts) && cell.parts.length) {
          return { weight: bounded(cell.weight, 1, 0.01, 10000), parts: cell.parts.slice(0, 16).map(function(n) { return bounded(n, 1, 0.01, 10000) }) }
        }
        return bounded(cell, 1, 0.01, 10000)
      })
      return parts.length ? parts : [100]
    })
    layouts.push({ id: item.id, name: String(item.name || item.id).slice(0, 120), kind: item.kind === "grid" ? "grid" : "ratio", orientation: item.orientation === "rows" ? "rows" : "columns", weights: weights, cells: cells, fill: item.fill === "order" ? "order" : "largest", underfill: item.underfill === "rescale" ? "rescale" : "hold", overflow: ["first", "last", "extend"].indexOf(item.overflow) >= 0 ? item.overflow : "last", gridColumns: Math.round(bounded(item.gridColumns, 2, 0, 16)) })
  })
  var workspaces = {}, monitors = {}, customSizes = [], sizeIds = {}
  Object.keys(object(raw.workspaces)).slice(0, 256).forEach(function(key) { if (/^[A-Za-z0-9:_-]{1,100}$/.test(key) && seen[raw.workspaces[key]]) workspaces[key] = raw.workspaces[key] })
  Object.keys(object(raw.monitors)).slice(0, 64).forEach(function(key) { if (/^(desc|name):[^\u0000-\u001f]{1,240}$/.test(key) && seen[raw.monitors[key]]) monitors[key] = raw.monitors[key] })
  ;(Array.isArray(raw.customSizes) ? raw.customSizes : []).slice(0, 64).forEach(function(item) { var size = customSize(item); if (size && !sizeIds[size.id]) { sizeIds[size.id] = true; customSizes.push(size) } })
  return { enabled: raw.enabled === true, layouts: layouts, monitors: monitors, workspaces: workspaces, customSizes: customSizes }
}
function title(id) { return id.split("-").map(function(word) { return word.charAt(0).toUpperCase() + word.slice(1) }).join(" ") }
function catalog(config) {
  config = normalize(config)
  if (!config.enabled) return []
  var out = ["left", "right", "center", "down"].map(function(direction) { return { id: "place-" + direction, title: "Place Window " + title(direction), description: direction === "down" ? "Owned tiling layout: nearest slot below" : "Owned tiling layout: absolute " + direction + " slot; stays tiled", keywords: "window tiled slot layout", needsWindow: true } })
  SNAP_IDS.forEach(function(id) {
    var space = id === "previous-space" || id === "next-space"
    var display = id === "next-display" || id === "previous-display"
    var floating = !space && !display && ["restore", "toggle-fullscreen"].indexOf(id) < 0
    out.push({ id: id, title: display ? "Move Window to " + title(id) : title(id) + (floating ? " (Floating Window)" : space ? " (Workspace)" : " Window"), description: display ? "Move to the display's active workspace; keep tiled or floating" : floating ? "Float the selected window and change its frame" : id === "restore" ? "Restore this window's initial frame and tiling slot" : space ? "Navigate workspace" : "Act on the selected window", keywords: "window snap resize position " + id.replace(/-/g, " "), needsWindow: !space })
  })
  config.customSizes.forEach(function(size) { out.push({ id: "custom:" + size.id, title: size.name + " (Floating Window)", description: size.width + " × " + size.height + " · " + size.anchor, keywords: "window custom size resize", needsWindow: true }) })
  return out
}
function targetFromClient(client) {
  client = object(client)
  var address = String(client.address || ""), stable = client.stableId
  var workspace = client.workspace && typeof client.workspace === "object" ? client.workspace.id : client.workspace
  if (client.workspace && typeof client.workspace === "object" && client.workspace.id < 0 && typeof client.workspace.name === "string" && client.workspace.name)
    workspace = "name:" + client.workspace.name
  if (!/^0x[0-9a-f]+$/i.test(address) || stable === undefined || stable === null || String(stable) === "" || (typeof workspace !== "number" && typeof workspace !== "string")) return null
  return { address: address, stableId: String(stable), workspace: workspace }
}
function rows(config, query, target, matchScore) {
  var frozen = targetFromClient(target)
  return catalog(config).filter(function(action) { return !action.needsWindow || frozen }).map(function(action, index) {
    var score = matchScore(query, { name: action.title, aliases: [action.id], text: action.description + " " + action.keywords })
    return { key: "windowAction:" + action.id, section: "windowActions", title: action.title, subtitle: action.description, primaryLabel: "Run", score: score, order: index, payload: { kind: "windowAction", action: action.id, target: frozen ? copy(frozen) : null } }
  }).filter(function(row) { return row.score >= 0 })
}
function luaLiteral(value) {
  if (value === null || value === undefined) return "nil"
  if (typeof value === "boolean") return value ? "true" : "false"
  if (typeof value === "number") { if (!isFinite(value)) throw new Error("Non-finite Lua number"); return String(value) }
  if (typeof value === "string") return '"' + value.replace(/[\\"\u0000-\u001f\u007f]/g, function(ch) { return "\\" + ("00" + ch.charCodeAt(0)).slice(-3) }) + '"'
  if (Array.isArray(value)) return "{" + value.map(luaLiteral).join(",") + "}"
  if (typeof value === "object") return "{" + Object.keys(value).map(function(key) { return "[" + luaLiteral(key) + "]=" + luaLiteral(value[key]) }).join(",") + "}"
  throw new Error("Unsupported Lua value")
}
function loaderLua(config, pluginDir) { return "local module = dofile(" + luaLiteral(String(pluginDir).replace(/\/$/, "") + "/WindowActions.lua") + ")\nreturn module.configure(" + luaLiteral(normalize(config)) + ")\n" }
function actionLua(action, target) { return "eval do assert(OmacastWindows, 'OmaCast window backend is not loaded; enable Window Management'); OmacastWindows.act(" + luaLiteral(action) + "," + luaLiteral(target === null || target === undefined ? null : targetFromClient(target) || (function() { throw new Error("Invalid window target") })()) + ") end" }
// Capture tickets prevent an old asynchronous reply from reopening or retargeting a new session.
function beginSession(state) { state.generation++; state.pending = true; return state.generation }
function cancelSession(state) { state.generation++; state.pending = false; state.target = null }
function finishCapture(state, ticket, target) { if (!state.pending || ticket !== state.generation) return false; state.pending = false; state.target = targetFromClient(target); return true }
function update(raw, change) {
  var next = copy(object(raw)), sizes = Array.isArray(next.customSizes) ? next.customSizes : []
  if (change.type === "enabled") next.enabled = change.value === true
  else if (change.type === "size") {
    var size = customSize(change.value)
    if (!size) throw new Error("Use a name, valid ID, positive width/height (pixels or %), anchor and numeric offsets")
    var found = false
    next.customSizes = sizes.map(function(item) {
      if (!item || item.id !== size.id) return item
      found = true
      return Object.assign({}, item, size)
    })
    if (!found) {
      if (sizes.length >= 64) throw new Error("At most 64 custom sizes are supported")
      next.customSizes.push(size)
    }
  } else if (change.type === "deleteSize") next.customSizes = sizes.filter(function(item) { return !item || item.id !== change.id })
  else throw new Error("Unknown window configuration change")
  return next
}
function resolveHandle(toplevels, payload) {
  if (!payload || !payload.handle) return null
  for (var i = 0; i < (toplevels || []).length; i++) {
    var entry = toplevels[i]
    if (entry.toplevel !== payload.handle) continue
    if (payload.target && (!entry.target || entry.target.address !== payload.target.address || entry.target.stableId !== payload.target.stableId)) return null
    return entry.toplevel
  }
  return null
}
var BIND_BEGIN = "-- omacast-windows: begin"
var BIND_END = "-- omacast-windows: end"
var SHORTCUTS = ["place-left", "place-right", "place-center", "place-down", "next-display", "previous-display"]
function bindRange(text) {
  var start = text.indexOf(BIND_BEGIN), end = text.indexOf(BIND_END, start)
  if (start < 0) return null
  return { start: start, end: end < 0 ? -1 : end + BIND_END.length }
}
function parseBindings(text) {
  text = String(text || "")
  var range = bindRange(text), out = {}
  if (!range || range.end < 0) return out
  var block = text.slice(range.start, range.end), expression = /hl\.bind\("([A-Z0-9 +_-]+)", function\(\) OmacastWindows\.act\("([a-z-]+)", nil\) end/g, match
  while ((match = expression.exec(block))) if (SHORTCUTS.indexOf(match[2]) >= 0) out[match[2]] = match[1]
  return out
}
function replaceBindings(text, bindings) {
  text = String(text || "")
  var range = bindRange(text)
  if (range && range.end < 0) throw new Error("Window shortcut marker has no end; repair bindings.lua first")
  var lines = []
  SHORTCUTS.forEach(function(id) {
    var chord = bindings[id]
    if (!chord) return
    if (!/^[A-Z0-9 +_-]{1,100}$/.test(chord)) throw new Error("Invalid window shortcut")
    lines.push('hl.bind("' + chord + '", function() OmacastWindows.act("' + id + '", nil) end, {description="OmaCast ' + id + '"})')
  })
  var block = lines.length ? BIND_BEGIN + "\n" + lines.join("\n") + "\n" + BIND_END : ""
  return range ? text.slice(0, range.start) + block + text.slice(range.end) : text + (text && !/\n$/.test(text) ? "\n" : "") + (block ? "\n" + block + "\n" : "")
}
var WindowModelApi = { normalize: normalize, catalog: catalog, rows: rows, luaLiteral: luaLiteral, loaderLua: loaderLua, actionLua: actionLua, targetFromClient: targetFromClient, customSize: customSize, defaults: defaults, update: update, beginSession: beginSession, cancelSession: cancelSession, finishCapture: finishCapture, resolveHandle: resolveHandle, parseBindings: parseBindings, replaceBindings: replaceBindings, SHORTCUTS: SHORTCUTS, SNAP_IDS: SNAP_IDS, ANCHORS: ANCHORS }
if (typeof module !== "undefined") module.exports = WindowModelApi
