// Pure model for OmaCast: row shapes, section ordering, the match scorer, the
// frecency store, the calculator and unit converter, the template engine, and
// the config/state normalisers. No Qt, no side effects — Omacast.qml feeds it
// catalogs and renders what comes back, and node --test loads it directly.
//
// Two rules run through the whole file. Sections publish in a fixed order and
// never interleave, so a keystroke can only reorder rows inside one section.
// And learning is a bounded bonus (<= FRECENCY_MAX) that sits below the 500
// point gap between the scorer's tiers, so an exact name match always wins
// over a much-used one.

// ---- Sections

var SECTIONS = ["answer", "pinned", "recent", "apps", "windows", "actions", "keybindings", "quicklinks", "snippets", "commands", "clipboard", "emoji", "files", "web"]

var SECTION_TITLES = {
  answer: "Answer",
  pinned: "Pinned",
  recent: "Recent",
  apps: "Applications",
  windows: "Windows",
  actions: "Omarchy",
  keybindings: "Keybindings",
  quicklinks: "Quicklinks",
  snippets: "Snippets",
  commands: "Commands",
  clipboard: "Clipboard",
  emoji: "Emoji",
  files: "Files",
  web: "Web"
}

var SECTION_CAPS = {
  answer: 1,
  pinned: 20,
  recent: 8,
  apps: 8,
  windows: 5,
  actions: 6,
  keybindings: 4,
  quicklinks: 4,
  snippets: 4,
  commands: 4,
  clipboard: 40,
  emoji: 60,
  files: 20,
  web: 1
}

// Glyphs are Nerd Font literals; the name rides along in a comment so a
// future editor can look them up.
var ICON_APP = ""             // nf-fa-th_large
var ICON_RUNNING = ""         // nf-fa-circle
var ICON_WINDOW = ""          // nf-fa-window_maximize
var ICON_MENU = ""            // nf-fa-bars
var ICON_SUBMENU = ""         // nf-fa-angle_right
var ICON_KEYBIND = ""         // nf-fa-keyboard_o
var ICON_QUICKLINK = ""       // nf-fa-external_link
var ICON_SNIPPET = ""         // nf-fa-scissors
var ICON_COMMAND = ""         // nf-fa-terminal
var ICON_CLIPBOARD = ""       // nf-fa-files_o
var ICON_IMAGE = ""           // nf-fa-picture_o
var ICON_EMOJI = ""           // nf-fa-smile_o
var ICON_FILE = ""            // nf-fa-file
var ICON_SEARCH = ""          // nf-fa-search
var ICON_CALC = ""            // nf-fa-calculator
var ICON_LINK = ""            // nf-fa-globe

function sectionIndex(section) {
  var at = SECTIONS.indexOf(String(section || ""))
  return at < 0 ? SECTIONS.length : at
}

function sectionTitle(section) {
  return SECTION_TITLES[section] || ""
}

// ---- Row normalisation

function clip(value, limit) {
  var text = String(value === undefined || value === null ? "" : value)
  return text.length > limit ? text.slice(0, limit) : text
}

function row(spec) {
  var value = spec || {}
  return {
    key: clip(value.key, 512),
    section: String(value.section || "actions"),
    title: clip(value.title, 200),
    subtitle: clip(value.subtitle, 300),
    icon: String(value.icon || ""),
    iconSource: String(value.iconSource || ""),
    accessory: clip(value.accessory, 60),
    keyword: String(value.keyword || ""),
    frecencyKey: String(value.frecencyKey || ""),
    pinnable: value.pinnable === true,
    confirm: value.confirm === true,
    primaryLabel: clip(value.primaryLabel || "Run", 40),
    secondaryLabel: clip(value.secondaryLabel || "", 40),
    score: typeof value.score === "number" && isFinite(value.score) ? value.score : 0,
    order: typeof value.order === "number" && isFinite(value.order) ? value.order : 0,
    payload: value.payload || ({})
  }
}

// Section order first, then score, then the order the provider emitted. Array
// sort is stable in every engine this runs on, so equal rows keep their input
// order anyway; `order` makes that explicit for providers that care.
function sortRows(rows) {
  var out = (rows || []).slice()
  out.sort(function(a, b) {
    var sa = sectionIndex(a.section)
    var sb = sectionIndex(b.section)
    if (sa !== sb) return sa - sb
    if (a.score !== b.score) return b.score - a.score
    return a.order - b.order
  })
  return out
}

function applyCaps(rows) {
  var seen = ({})
  var out = []
  for (var i = 0; i < rows.length; i++) {
    var section = rows[i].section
    var cap = SECTION_CAPS[section] === undefined ? 25 : SECTION_CAPS[section]
    var count = seen[section] || 0
    if (count >= cap) continue
    seen[section] = count + 1
    out.push(rows[i])
  }
  return out
}

// ---- Matching
//
// A port of the shell's AppSearch.fuzzyScore tiers (shell/services/AppSearch.js)
// generalised over { name, aliases, text }, plus one tier the launcher does not
// have: a subsequence walk over the name so `dwnlds` still finds Downloads.
// Prose (`text`) is contains-only — letting scattered letters match a URL or a
// description admits everything.

function lower(value) {
  return String(value === undefined || value === null ? "" : value).toLowerCase()
}

function wordText(value) {
  return String(value || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[._:/\\-]+/g, " ")
    .toLowerCase()
}

function words(value) {
  var parts = wordText(value).split(/[^a-z0-9]+/)
  var out = []
  for (var i = 0; i < parts.length; i++) if (parts[i]) out.push(parts[i])
  return out
}

function acronymOf(name) {
  var parts = words(name)
  var out = ""
  for (var i = 0; i < parts.length; i++) out += parts[i].charAt(0)
  return out
}

// Number of skipped characters when `term` walks through `name` as a
// subsequence that starts on a word boundary, or -1 when it does not.
function subsequenceGaps(name, term) {
  if (!term) return -1
  var haystack = wordText(name)
  var starts = ({})
  var atWordStart = true
  for (var s = 0; s < haystack.length; s++) {
    var isSpace = haystack.charAt(s) === " "
    if (!isSpace && atWordStart) starts[s] = true
    atWordStart = isSpace
  }

  for (var begin = 0; begin < haystack.length; begin++) {
    if (!starts[begin] || haystack.charAt(begin) !== term.charAt(0)) continue
    var gaps = 0
    var at = begin + 1
    var matched = 1
    while (matched < term.length && at < haystack.length) {
      if (haystack.charAt(at) === term.charAt(matched)) matched += 1
      else gaps += 1
      at += 1
    }
    if (matched === term.length) return gaps
  }
  return -1
}

function fieldAliases(fields) {
  var values = (fields && fields.aliases) || []
  var out = []
  for (var i = 0; i < values.length; i++) {
    var alias = lower(values[i])
    if (alias) out.push(alias)
  }
  return out
}

function termMatches(term, name, aliases, text, acronym) {
  if (name.indexOf(term) >= 0) return true
  for (var i = 0; i < aliases.length; i++) if (aliases[i].indexOf(term) >= 0) return true
  if (text.indexOf(term) >= 0) return true
  if (term.length <= 5 && acronym.indexOf(term) >= 0) return true
  return subsequenceGaps(name, term) >= 0
}

function matchScore(query, fields) {
  var q = lower(query).trim()
  if (!q) return 0

  var name = lower(fields && fields.name)
  var aliases = fieldAliases(fields)
  var text = lower(fields && fields.text)
  var acronym = acronymOf(name)

  var terms = q.split(/\s+/)
  for (var t = 0; t < terms.length; t++) {
    if (terms[t] && !termMatches(terms[t], name, aliases, text, acronym)) return -1
  }

  var directName = name.indexOf(q)
  if (directName === 0) return 10000 - name.length
  for (var a = 0; a < aliases.length; a++) {
    if (aliases[a].indexOf(q) === 0) return 9500 - aliases[a].length
  }
  if (directName > 0) return 8000 - directName * 10 - name.length
  for (var b = 0; b < aliases.length; b++) {
    var aliasAt = aliases[b].indexOf(q)
    if (aliasAt > 0) return 7600 - aliasAt * 10 - aliases[b].length
  }

  var textAt = text.indexOf(q)
  if (textAt >= 0) return 6000 - textAt

  var acronymAt = acronym.indexOf(q)
  if (acronymAt === 0) return 5000 - acronym.length
  if (acronymAt > 0) return 4600 - acronymAt * 10 - acronym.length

  var gaps = subsequenceGaps(name, q.replace(/\s+/g, ""))
  if (gaps >= 0) return 3000 - gaps * 10 - name.length

  return -1
}

// ---- Frecency (zoxide's shape: a decayed launch count, bounded)

var FRECENCY_MAX = 400
var FRECENCY_HALF = 6
var USAGE_LIMIT = 400
var USAGE_KEY = /^(app|menu|bind|ql|snip|cmd):[^\x00-\x1f]{1,240}$/

function decay(ageMs) {
  var age = typeof ageMs === "number" && isFinite(ageMs) ? Math.max(0, ageMs) : 0
  if (age < 3600000) return 4
  if (age < 86400000) return 2
  if (age < 604800000) return 0.5
  if (age < 7776000000) return 0.25
  return 0.1
}

function rank(entry, now) {
  if (!entry) return 0
  var count = typeof entry.count === "number" && isFinite(entry.count) ? entry.count : 0
  var last = typeof entry.last === "number" && isFinite(entry.last) ? entry.last : 0
  return count * decay(now - last)
}

function frecencyBonus(usage, key, now) {
  if (!usage || !key) return 0
  var value = rank(usage[key], now)
  if (value <= 0) return 0
  return Math.round(FRECENCY_MAX * (value / (value + FRECENCY_HALF)))
}

function bump(usage, key, now) {
  var next = ({})
  var source = usage || ({})
  for (var k in source) next[k] = source[k]
  if (!USAGE_KEY.test(String(key || ""))) return next
  var prior = next[key]
  var count = prior && typeof prior.count === "number" && isFinite(prior.count) ? prior.count : 0
  next[key] = { count: count + 1, last: Math.round(now) }
  return next
}

function pruneUsage(usage, now, limit) {
  var max = limit === undefined ? USAGE_LIMIT : limit
  var keys = Object.keys(usage || ({}))
  if (keys.length <= max) return usage || ({})

  keys.sort(function(a, b) { return rank(usage[b], now) - rank(usage[a], now) })
  var next = ({})
  for (var i = 0; i < max; i++) next[keys[i]] = usage[keys[i]]
  return next
}

function recentKeys(usage, now, limit, exclude) {
  var source = usage || ({})
  var skip = exclude || ({})
  var keys = []
  for (var key in source) {
    var entry = source[key]
    if (skip[key]) continue
    if (!entry || !(entry.count >= 1)) continue
    keys.push(key)
  }
  keys.sort(function(a, b) {
    var diff = rank(source[b], now) - rank(source[a], now)
    if (diff !== 0) return diff
    return a < b ? -1 : (a > b ? 1 : 0)
  })
  return keys.slice(0, limit)
}

// ---- State (~/.local/state/omarchy/omacast-state.json)

function normalizeState(raw) {
  var value = raw && typeof raw === "object" ? raw : ({})
  var usage = ({})
  var source = value.usage && typeof value.usage === "object" ? value.usage : ({})

  for (var key in source) {
    if (!USAGE_KEY.test(key)) continue
    var entry = source[key]
    if (!entry || typeof entry !== "object") continue
    var count = entry.count
    var last = entry.last
    if (typeof count !== "number" || !isFinite(count) || Math.floor(count) !== count || count < 1) continue
    if (typeof last !== "number" || !isFinite(last) || Math.floor(last) !== last || last < 0) continue
    usage[key] = { count: count, last: last }
  }

  var pins = []
  var seen = ({})
  var rawPins = Array.isArray(value.pins) ? value.pins : []
  for (var i = 0; i < rawPins.length; i++) {
    var pin = rawPins[i]
    if (typeof pin !== "string" || !USAGE_KEY.test(pin) || seen[pin]) continue
    seen[pin] = true
    pins.push(pin)
  }

  return { version: 1, usage: usage, pins: pins }
}

function togglePin(state, key) {
  var current = normalizeState(state)
  if (!USAGE_KEY.test(String(key || ""))) return current
  var pins = []
  var removed = false
  for (var i = 0; i < current.pins.length; i++) {
    if (current.pins[i] === key) { removed = true; continue }
    pins.push(current.pins[i])
  }
  if (!removed) pins.push(key)
  return { version: 1, usage: current.usage, pins: pins }
}

// ---- Empty query: what the palette shows before a keystroke
//
// `catalog.byKey` maps every static row key (apps, menu leaves, quicklinks,
// snippets, commands) to its row; `catalog.windowRows` is the live window list.
// A pin or a recent key with no row behind it — an app that was uninstalled —
// is skipped rather than rendered as a dead entry.

function cloneInto(source, section, order) {
  var next = row(source)
  next.section = section
  next.order = order
  next.score = 0
  return next
}

function emptyQueryRows(catalog, state, now) {
  var byKey = (catalog && catalog.byKey) || ({})
  var windows = (catalog && catalog.windowRows) || []
  var current = normalizeState(state)
  var out = []
  var pinned = ({})

  for (var i = 0; i < current.pins.length; i++) {
    var key = current.pins[i]
    pinned[key] = true
    if (byKey[key]) out.push(cloneInto(byKey[key], "pinned", i))
  }

  var recents = recentKeys(current.usage, now, SECTION_CAPS.recent, pinned)
  for (var r = 0; r < recents.length; r++) {
    if (byKey[recents[r]]) out.push(cloneInto(byKey[recents[r]], "recent", r))
  }

  for (var w = 0; w < windows.length && w < 8; w++) out.push(cloneInto(windows[w], "windows", w))

  return out
}

// ---- Query parsing
//
// A pushed scope always wins: once the user is inside Clipboard, typing `f `
// searches clipboard text for "f", it does not jump to files.

var SCOPES = ["clipboard", "emoji", "files", "windows"]

function parseQuery(text, scope) {
  var raw = String(text === undefined || text === null ? "" : text)
  var trimmed = raw.trim()
  var current = String(scope || "root")

  if (current !== "root") return { raw: raw, trimmed: trimmed, scope: current, prefix: "", rest: trimmed }

  // Prefixes are matched before the trailing space is trimmed away: "cb " is
  // how a user enters the clipboard scope, and trimming first would leave a
  // bare "cb" that matches nothing.
  var lead = raw.replace(/^\s+/, "")

  if (lead.charAt(0) === ":") return { raw: raw, trimmed: trimmed, scope: "emoji", prefix: ":", rest: lead.slice(1).trim() }

  var clip = lead.match(/^(cb|clip|clipboard)\s([\s\S]*)$/)
  if (clip) return { raw: raw, trimmed: trimmed, scope: "clipboard", prefix: clip[1], rest: clip[2].trim() }

  var files = lead.match(/^(f|file|files)\s([\s\S]*)$/)
  if (files) return { raw: raw, trimmed: trimmed, scope: "files", prefix: files[1], rest: files[2].trim() }

  if (/^(~|\/|\.\.?\/)/.test(trimmed)) return { raw: raw, trimmed: trimmed, scope: "files", prefix: "path", rest: trimmed }

  return { raw: raw, trimmed: trimmed, scope: "root", prefix: "", rest: trimmed }
}

// Where fd should look and what it should match, for both file entries: an
// explicit path (`~/coding/oma`) browses that directory, `f oma cast` searches
// $HOME for files matching every term.
function fileRequest(parsed, home) {
  var base = String(home || "")
  if (!parsed || parsed.scope !== "files") return { dir: base, terms: [] }

  if (parsed.prefix === "path") {
    var path = parsed.rest
    if (path.charAt(0) === "~") path = base + path.slice(1)
    var cut = path.lastIndexOf("/")
    var dir = cut <= 0 ? "/" : path.slice(0, cut)
    var term = path.slice(cut + 1)
    return { dir: dir, terms: term ? [term] : [] }
  }

  var terms = parsed.rest ? parsed.rest.split(/\s+/) : []
  return { dir: base, terms: terms }
}

// ---- Providers

function appRows(sorted, query, usage, running, now) {
  var entries = sorted || []
  var runningMap = running || ({})
  var out = []

  for (var i = 0; i < entries.length; i++) {
    var entry = entries[i].entry
    if (!entry) continue
    var id = String(entry.id || "")
    var key = "app:" + id
    var live = runningMap[id]
    var isRunning = live !== undefined && live !== null
    out.push(row({
      key: key,
      section: "apps",
      title: String(entry.name || id),
      subtitle: String(entry.genericName || ""),
      icon: ICON_APP,
      accessory: isRunning ? ICON_RUNNING : "",
      frecencyKey: key,
      pinnable: true,
      primaryLabel: "Open",
      secondaryLabel: isRunning ? "Focus window" : "",
      score: entries[i].score + frecencyBonus(usage, key, now),
      order: i,
      payload: { kind: "app", desktopId: id, name: String(entry.name || id), icon: String(entry.icon || ""), toplevelIndex: isRunning ? live : -1 }
    }))
  }
  return out
}

function windowRows(toplevels, query) {
  var values = toplevels || []
  var out = []

  for (var i = 0; i < values.length; i++) {
    var top = values[i]
    var title = String(top.title || top.appId || "Window")
    var appId = String(top.appId || "")
    var score = matchScore(query, { name: title, aliases: [appId], text: "" })
    if (score < 0) continue
    out.push(row({
      key: "win:" + top.index + ":" + appId,
      section: "windows",
      title: title,
      subtitle: appId,
      icon: ICON_WINDOW,
      primaryLabel: "Switch to",
      secondaryLabel: "Close window",
      score: score,
      order: i,
      payload: { kind: "window", index: top.index, appId: appId }
    }))
  }
  return out
}

var MENU_CONFIRM = /^system\.(logout|reboot|shutdown|hibernate|suspend)$|^remove\./

function menuRows(items, itemOrder, whenResults, checkedResults, query, usage, now, scope, MenuModel) {
  var map = items || ({})
  var order = Array.isArray(itemOrder) ? itemOrder : []
  var out = []
  var scoped = String(scope || "root")
  var browsing = scoped.indexOf("menu:") === 0 ? scoped.slice(5) : ""
  // "catalog" asks for every visible row regardless of query: Omacast.qml
  // builds the key → row map the pinned and recent sections resolve against.
  var catalogMode = scoped === "catalog"
  var q = String(query || "").trim()

  if (!browsing && !catalogMode && !q) return out

  for (var i = 0; i < order.length; i++) {
    var entry = map[order[i]]
    if (!entry || entry.id === "root" || entry.id === "apps") continue
    if (entry.provider) continue
    if (entry.parent === "apps") continue
    if (!MenuModel.isVisible(map, order, whenResults, entry, 0)) continue

    var breadcrumb = MenuModel.pathFor(map, entry.parent)
    var score

    if (catalogMode) {
      score = 0
    } else if (browsing) {
      if (entry.parent !== browsing) continue
      score = matchScore(q, { name: entry.label, aliases: entry.aliases || [], text: breadcrumb })
      if (score < 0) continue
    } else {
      score = matchScore(q, {
        name: entry.label,
        aliases: (entry.aliases || []).concat([MenuModel.searchableToken(entry.id)]),
        text: breadcrumb
      })
      if (score < 0) continue
    }

    var isLeaf = entry.kind === "action" || entry.kind === "link"
    var key = "menu:" + entry.id
    var label = MenuModel.labelFor(entry, checkedResults)
    var primary = entry.kind === "action" ? "Run" : (entry.kind === "link" ? "Open" : "Browse")

    out.push(row({
      key: key,
      section: "actions",
      title: label,
      subtitle: breadcrumb,
      icon: entry.icon || (entry.kind === "menu" ? ICON_SUBMENU : ICON_MENU),
      frecencyKey: isLeaf ? key : "",
      pinnable: isLeaf,
      confirm: MENU_CONFIRM.test(entry.id),
      primaryLabel: primary,
      score: score + (isLeaf ? frecencyBonus(usage, key, now) : 0),
      order: typeof entry.order === "number" ? entry.order : i,
      payload: { kind: "menu", id: entry.id, itemKind: entry.kind, action: entry.action || "", target: entry.target || "", iconFont: entry.iconFont || "" }
    }))
  }
  return out
}

// Records are `<padded combo> → <label>\t<dispatcher>\t<arg>`, straight out of
// omarchy-menu-keybindings' output_binding_records.
function parseKeybindingRecords(text) {
  var lines = String(text || "").split("\n")
  var out = []

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i]
    if (!line) continue
    var fields = line.split("\t")
    var display = fields[0] || ""
    var at = display.indexOf(" → ")
    if (at < 0) continue
    var combo = display.slice(0, at).trim()
    var label = display.slice(at + 3).trim()
    if (!label) continue
    out.push({
      combo: combo,
      label: label,
      dispatcher: (fields[1] || "").trim(),
      arg: fields.slice(2).join("\t")
    })
  }
  return out
}

function keybindingRows(records, query) {
  var values = records || []
  var out = []

  for (var i = 0; i < values.length; i++) {
    var record = values[i]
    var score = matchScore(query, { name: record.label, aliases: [record.combo], text: record.arg })
    if (score < 0) continue
    var disabled = !record.dispatcher
    out.push(row({
      key: "bind:" + record.dispatcher + ":" + record.arg,
      section: "keybindings",
      title: record.label,
      subtitle: disabled ? record.combo + " · keyboard only" : record.combo,
      icon: ICON_KEYBIND,
      accessory: record.combo,
      primaryLabel: "Run",
      score: score,
      order: i,
      payload: { kind: "keybinding", dispatcher: record.dispatcher, arg: record.arg, disabled: disabled }
    }))
  }
  return out
}

// Keyword rows have two ways in: the user typed `gh something`, which is an
// explicit command and outranks every fuzzy tier, or the name/keyword matched
// the query like any other row.
function keywordAdmission(query, name, keyword) {
  var q = String(query || "").trim()
  var word = String(keyword || "")
  if (word && (q === word || q.indexOf(word + " ") === 0)) {
    return { direct: true, argument: q.slice(word.length).trim(), score: 12000 }
  }
  var score = matchScore(q, { name: name, aliases: word ? [word] : [] })
  if (score < 0) return null
  return { direct: false, argument: "", score: score }
}

function quicklinkRows(quicklinks, query, usage, now) {
  var values = quicklinks || []
  var out = []

  for (var i = 0; i < values.length; i++) {
    var link = values[i]
    var admission = keywordAdmission(query, link.name, link.keyword)
    if (!admission) continue

    var key = "ql:" + (link.keyword || link.name)
    var wants = needsArgument(link.url)
    var completing = !admission.direct && wants
    out.push(row({
      key: key,
      section: "quicklinks",
      title: admission.direct && admission.argument ? link.name + ": " + admission.argument : link.name,
      subtitle: link.keyword ? link.keyword + (wants ? " <query>" : "") : link.url,
      icon: ICON_QUICKLINK,
      keyword: link.keyword || "",
      frecencyKey: key,
      pinnable: true,
      primaryLabel: completing ? "Type keyword" : "Open",
      score: admission.score + frecencyBonus(usage, key, now),
      order: i,
      payload: { kind: "quicklink", url: link.url, argument: admission.argument, keyword: link.keyword || "", complete: completing }
    }))
  }
  return out
}

function snippetRows(snippets, query, usage, now) {
  var values = snippets || []
  var out = []

  for (var i = 0; i < values.length; i++) {
    var snippet = values[i]
    var admission = keywordAdmission(query, snippet.name, snippet.keyword)
    if (!admission) continue

    var key = "snip:" + snippet.name
    var completing = !admission.direct && needsArgument(snippet.text)
    out.push(row({
      key: key,
      section: "snippets",
      title: snippet.name,
      subtitle: clip(firstLine(snippet.text), 80),
      icon: ICON_SNIPPET,
      keyword: snippet.keyword || "",
      frecencyKey: key,
      pinnable: true,
      primaryLabel: completing ? "Type keyword" : "Paste",
      secondaryLabel: completing ? "" : "Copy",
      score: admission.score + frecencyBonus(usage, key, now),
      order: i,
      payload: { kind: "snippet", text: snippet.text, argument: admission.argument, keyword: snippet.keyword || "", complete: completing }
    }))
  }
  return out
}

function commandRows(commands, query, usage, now) {
  var values = commands || []
  var out = []

  for (var i = 0; i < values.length; i++) {
    var command = values[i]
    var admission = keywordAdmission(query, command.name, command.keyword)
    if (!admission) continue

    var key = "cmd:" + command.name
    var args = admission.argument ? admission.argument.split(/\s+/) : []
    out.push(row({
      key: key,
      section: "commands",
      title: command.name,
      subtitle: clip(command.command, 80) + (command.terminal ? " · terminal" : ""),
      icon: ICON_COMMAND,
      keyword: command.keyword || "",
      frecencyKey: key,
      pinnable: true,
      confirm: command.confirm === true,
      primaryLabel: "Run",
      score: admission.score + frecencyBonus(usage, key, now),
      order: i,
      payload: { kind: "command", command: command.command, terminal: command.terminal === true, args: args }
    }))
  }
  return out
}

// ---- Clipboard

var CLIP_SCAN = 8192

function parseClipboard(raw) {
  var parsed
  try { parsed = JSON.parse(String(raw || "")) } catch (e) { return [] }
  if (!Array.isArray(parsed)) return []

  var out = []
  for (var i = 0; i < parsed.length; i++) {
    var entry = parsed[i]
    if (typeof entry === "string") {
      if (entry.trim()) out.push({ type: "text", text: entry, historyIndex: i })
      continue
    }
    if (!entry || typeof entry !== "object") continue
    var type = String(entry.type || entry.kind || "")
    if (type === "image") {
      out.push({
        type: "image",
        path: String(entry.path || ""),
        mime: String(entry.mime || "image/png"),
        capturedAt: String(entry.capturedAt || ""),
        historyIndex: i
      })
    } else if (type === "text" && String(entry.text || "").trim()) {
      out.push({ type: "text", text: String(entry.text), historyIndex: i })
    }
  }
  return out
}

function firstLine(text) {
  var lines = String(text || "").split("\n")
  for (var i = 0; i < lines.length; i++) {
    if (lines[i].trim()) return lines[i].trim()
  }
  return ""
}

function flatten(text) {
  return String(text || "").replace(/\s+/g, " ").trim()
}

function clipboardRows(entries, query) {
  var values = entries || []
  var q = lower(query).trim()
  var terms = q ? q.split(/\s+/) : []
  var out = []

  for (var i = 0; i < values.length; i++) {
    var entry = values[i]

    if (entry.type === "image") {
      var label = entry.capturedAt ? "Image " + entry.capturedAt : "Image"
      if (q && lower(label + " " + entry.mime).indexOf(q) < 0) continue
      out.push(row({
        key: "clip:" + entry.historyIndex,
        section: "clipboard",
        title: label,
        subtitle: entry.mime,
        icon: ICON_IMAGE,
        primaryLabel: "Paste",
        secondaryLabel: "Copy",
        order: i,
        payload: { kind: "clipboard", entryType: "image", path: entry.path, mime: entry.mime, historyIndex: entry.historyIndex }
      }))
      continue
    }

    var head = String(entry.text || "").slice(0, CLIP_SCAN)
    var haystack = lower(head)
    var matched = true
    for (var t = 0; t < terms.length; t++) {
      if (haystack.indexOf(terms[t]) < 0) { matched = false; break }
    }
    if (!matched) continue

    var lineCount = String(entry.text || "").split("\n").length
    out.push(row({
      key: "clip:" + entry.historyIndex,
      section: "clipboard",
      title: clip(flatten(firstLine(head)), 120),
      subtitle: lineCount + (lineCount === 1 ? " line · " : " lines · ") + String(entry.text || "").length + " chars",
      icon: ICON_CLIPBOARD,
      primaryLabel: "Paste",
      secondaryLabel: "Copy",
      order: i,
      payload: { kind: "clipboard", entryType: "text", historyIndex: entry.historyIndex }
    }))
  }
  return out
}

// ---- Emoji

function emojiRows(emojis, query) {
  var values = emojis || []
  var q = lower(query).trim()
  var terms = q ? q.split(/\s+/) : []
  var out = []

  for (var i = 0; i < values.length; i++) {
    var entry = values[i]
    var keywords = lower(entry.k)
    var score = 500
    var matched = true

    for (var t = 0; t < terms.length; t++) {
      var at = keywords.indexOf(terms[t])
      if (at < 0) { matched = false; break }
      if (at === 0 || keywords.charAt(at - 1) === " ") score = 1000
    }
    if (!matched) continue

    out.push(row({
      key: "emoji:" + entry.e,
      section: "emoji",
      title: entry.e + "  " + entry.k,
      icon: entry.e,
      primaryLabel: "Insert",
      secondaryLabel: "Copy",
      score: terms.length ? score : 0,
      order: i,
      payload: { kind: "emoji", emoji: entry.e }
    }))
  }
  return out
}

// ---- Files

function basename(path) {
  var value = String(path || "")
  var cut = value.lastIndexOf("/")
  return cut >= 0 ? value.slice(cut + 1) : value
}

function dirname(path) {
  var value = String(path || "")
  var cut = value.lastIndexOf("/")
  if (cut < 0) return ""
  return cut === 0 ? "/" : value.slice(0, cut)
}

function shortenHome(path, home) {
  var value = String(path || "")
  var base = String(home || "")
  if (base && value.indexOf(base) === 0) return "~" + value.slice(base.length)
  return value
}

function rankFile(path, query) {
  var name = lower(basename(path))
  var full = lower(path)
  var q = lower(query).trim()
  var score

  if (!q) score = 4000
  else if (name.indexOf(q) === 0) score = 5000
  else if (name.indexOf(q) >= 0) score = 4000
  else if (full.indexOf(q) >= 0) score = 3000
  else score = 2000

  var depth = String(path || "").split("/").length - 1
  score -= 150 * depth
  if (name.charAt(0) === ".") score -= 500

  var segments = String(path || "").split("/")
  for (var i = 1; i < segments.length - 1; i++) {
    if (segments[i].charAt(0) === ".") { score -= 1500; break }
  }
  return score
}

// fd prints directories with a trailing slash, which would leave the row with
// an empty basename. Strip it; the glyph stays neutral either way, and gio
// open handles a file and a directory the same.
function fileRows(paths, query, home) {
  var values = paths || []
  var out = []

  for (var i = 0; i < values.length; i++) {
    var raw = String(values[i] || "")
    if (!raw) continue
    var path = raw.length > 1 ? raw.replace(/\/+$/, "") : raw
    if (!path) path = "/"

    out.push(row({
      key: "file:" + path,
      section: "files",
      title: basename(path),
      subtitle: shortenHome(dirname(path), home),
      icon: ICON_FILE,
      primaryLabel: "Open",
      secondaryLabel: "Show in folder",
      score: rankFile(path, query),
      order: i,
      payload: { kind: "file", path: path, dir: dirname(path) }
    }))
  }
  return out
}

// ---- Answers and web fallback

function answerRows(query) {
  var q = String(query || "").trim()
  if (!q) return []
  var out = []

  var answer = evaluate(q) || convert(q)
  if (answer) {
    out.push(row({
      key: "answer:" + answer.display,
      section: "answer",
      title: answer.display,
      subtitle: q,
      icon: ICON_CALC,
      primaryLabel: "Copy",
      score: 1,
      payload: { kind: "answer", copyText: answer.copyText }
    }))
  }

  var url = detectUrl(q)
  if (url) {
    out.push(row({
      key: "answer:url:" + url,
      section: "answer",
      title: "Open " + url,
      subtitle: "Link",
      icon: ICON_LINK,
      primaryLabel: "Open",
      score: 2,
      payload: { kind: "url", url: url }
    }))
  }
  return out
}

function webRows(query, engine) {
  var q = String(query || "").trim()
  if (q.length < 2) return []
  var name = (engine && engine.name) || "the web"
  return [row({
    key: "web:search",
    section: "web",
    title: "Search " + name + " for “" + q + "”",
    icon: ICON_SEARCH,
    primaryLabel: "Search",
    score: 0,
    payload: { kind: "web", query: q }
  })]
}

var SCOPE_ROWS = [
  { scope: "clipboard", name: "Clipboard History", icon: ICON_CLIPBOARD },
  { scope: "emoji", name: "Emoji", icon: ICON_EMOJI },
  { scope: "files", name: "Search Files", icon: ICON_SEARCH },
  { scope: "windows", name: "Windows", icon: ICON_WINDOW }
]

function scopeRows(query) {
  var q = String(query || "").trim()
  if (!q) return []
  var out = []

  for (var i = 0; i < SCOPE_ROWS.length; i++) {
    var spec = SCOPE_ROWS[i]
    var score = matchScore(q, { name: spec.name, aliases: [spec.scope] })
    if (score < 0) continue
    out.push(row({
      key: "scope:" + spec.scope,
      section: "actions",
      title: spec.name,
      subtitle: "Scope",
      icon: spec.icon,
      primaryLabel: "Browse",
      score: score,
      order: i,
      payload: { kind: "scope", scope: spec.scope }
    }))
  }
  return out
}

function scopeTitle(scope) {
  for (var i = 0; i < SCOPE_ROWS.length; i++) {
    if (SCOPE_ROWS[i].scope === scope) return SCOPE_ROWS[i].name
  }
  return ""
}

function scopePlaceholder(scope) {
  if (scope === "clipboard") return "Search clipboard history…"
  if (scope === "emoji") return "Search emoji…"
  if (scope === "files") return "Search files in your home…"
  if (scope === "windows") return "Search open windows…"
  if (String(scope || "").indexOf("menu:") === 0) return "Search this menu…"
  return "Search apps, windows, actions…"
}

// ---- Calculator
//
// evaluate() is the first thing every query hits, so it has to say no fast and
// never throw: a version string, a clock time, a date and a path all look
// arithmetic-ish and must fall through to the other providers.

var FUNCTIONS = {
  sqrt: Math.sqrt, abs: Math.abs, round: Math.round, floor: Math.floor, ceil: Math.ceil,
  sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan,
  log: function(v) { return Math.log(v) / Math.LN10 }, ln: Math.log,
  log2: function(v) { return Math.log(v) / Math.LN2 }, exp: Math.exp,
  min: Math.min, max: Math.max
}

var CONSTANTS = { pi: Math.PI, e: Math.E }

function looksLikeExpression(value) {
  var s = String(value || "").trim()
  if (!s) return false
  if (!/\d/.test(s)) return false
  if (/^\d+\.\d+\.\d+/.test(s)) return false
  if (/^\d{1,2}:\d{2}/.test(s)) return false
  if (/^\d{1,2}[./-]\d{1,2}[./-]/.test(s)) return false
  // A slash next to a word, a ~ or a . is a path or a unit like km/h, not a
  // division. One letter beside it is a magnitude suffix: 10k/4 is arithmetic.
  if (/[A-Za-z]{2}\/|\/[A-Za-z]{2}|~\/|\/~|\.\/|\/\./.test(s)) return false
  if (/[+\-*/^%()x×÷]/.test(s)) return true
  if (/\b(mod|of|to)\b/.test(s)) return true
  for (var name in FUNCTIONS) {
    if (s.indexOf(name + "(") >= 0) return true
  }
  return false
}

function rewritePercents(text) {
  var s = String(text || "")
  s = s.replace(/(\d+(?:\.\d+)?)\s*%\s+of\s+/gi, "($1/100)*")
  var relative = s.match(/^(.+?)\s*([+\-])\s*(\d+(?:\.\d+)?)\s*%\s*$/)
  if (relative) {
    var sign = relative[2] === "+" ? "+" : "-"
    return "(" + relative[1] + ")*(1" + sign + relative[3] + "/100)"
  }
  var lone = s.match(/^\s*(\d+(?:\.\d+)?)\s*%\s*$/)
  if (lone) return "(" + lone[1] + "/100)"
  return s
}

function tokenize(text) {
  var s = String(text || "")
  var tokens = []
  var i = 0

  while (i < s.length) {
    var ch = s.charAt(i)
    if (ch === " " || ch === "\t") { i += 1; continue }

    if (/[0-9.]/.test(ch)) {
      var radix = s.slice(i, i + 2).toLowerCase()
      if (ch === "0" && (radix === "0x" || radix === "0b" || radix === "0o")) {
        var digits = radix === "0x" ? /[0-9a-fA-F]/ : (radix === "0b" ? /[01]/ : /[0-7]/)
        var start = i + 2
        var at = start
        while (at < s.length && digits.test(s.charAt(at))) at += 1
        if (at === start) throw new Error("bad literal")
        var base = radix === "0x" ? 16 : (radix === "0b" ? 2 : 8)
        tokens.push({ type: "num", value: parseInt(s.slice(start, at), base) })
        i = at
        continue
      }

      var numStart = i
      while (i < s.length && /[0-9,_.]/.test(s.charAt(i))) i += 1
      var literal = s.slice(numStart, i).replace(/[,_]/g, "")
      var value = parseFloat(literal)
      if (!isFinite(value)) throw new Error("bad number")
      if (i < s.length && s.charAt(i).toLowerCase() === "k" && !/[a-z]/i.test(s.charAt(i + 1) || "")) {
        value *= 1000
        i += 1
      }
      tokens.push({ type: "num", value: value })
      continue
    }

    if (/[a-zA-Z]/.test(ch)) {
      var identStart = i
      while (i < s.length && /[a-zA-Z0-9_]/.test(s.charAt(i))) i += 1
      var ident = s.slice(identStart, i).toLowerCase()
      var previous = tokens[tokens.length - 1]
      var afterValue = previous && (previous.type === "num" || previous.value === ")")
      if (ident === "x" && afterValue) tokens.push({ type: "op", value: "*" })
      else if (ident === "mod") tokens.push({ type: "op", value: "mod" })
      else tokens.push({ type: "ident", value: ident })
      continue
    }

    if (ch === "×") { tokens.push({ type: "op", value: "*" }); i += 1; continue }
    if (ch === "÷") { tokens.push({ type: "op", value: "/" }); i += 1; continue }
    if ("+-*/^%".indexOf(ch) >= 0) { tokens.push({ type: "op", value: ch }); i += 1; continue }
    if (ch === "(" || ch === ")" || ch === ",") { tokens.push({ type: "op", value: ch }); i += 1; continue }

    throw new Error("bad character")
  }
  return tokens
}

function parseExpression(text) {
  var tokens = tokenize(text)
  var at = 0

  function peek() { return tokens[at] }
  function take() { return tokens[at++] }
  function isOp(value) {
    var token = peek()
    return token && token.type === "op" && token.value === value
  }
  function expect(value) {
    if (!isOp(value)) throw new Error("expected " + value)
    at += 1
  }

  function primary() {
    var token = take()
    if (!token) throw new Error("unexpected end")

    if (token.type === "num") return token.value
    if (token.type === "op" && token.value === "(") {
      var inner = expr()
      expect(")")
      return inner
    }
    if (token.type === "ident") {
      if (CONSTANTS[token.value] !== undefined && !isOp("(")) return CONSTANTS[token.value]
      var fn = FUNCTIONS[token.value]
      if (!fn) throw new Error("unknown name")
      expect("(")
      var args = [expr()]
      while (isOp(",")) { at += 1; args.push(expr()) }
      expect(")")
      return fn.apply(null, args)
    }
    throw new Error("unexpected token")
  }

  function power() {
    var base = primary()
    if (isOp("^")) {
      at += 1
      return Math.pow(base, unary())
    }
    return base
  }

  function unary() {
    if (isOp("-")) { at += 1; return -unary() }
    if (isOp("+")) { at += 1; return unary() }
    return power()
  }

  function term() {
    var value = unary()
    while (peek() && peek().type === "op" && ["*", "/", "%", "mod"].indexOf(peek().value) >= 0) {
      var op = take().value
      var right = unary()
      if (op === "*") value = value * right
      else if (op === "/") value = value / right
      else value = value % right
    }
    return value
  }

  function expr() {
    var value = term()
    while (peek() && peek().type === "op" && (peek().value === "+" || peek().value === "-")) {
      var op = take().value
      var right = term()
      value = op === "+" ? value + right : value - right
    }
    return value
  }

  var result = expr()
  if (at !== tokens.length) throw new Error("trailing input")
  return result
}

function trimZeros(text) {
  var s = String(text)
  if (s.indexOf("e") >= 0) {
    var parts = s.split("e")
    return trimZeros(parts[0]) + "e" + parts[1]
  }
  if (s.indexOf(".") < 0) return s
  return s.replace(/0+$/, "").replace(/\.$/, "")
}

function formatNumber(value) {
  if (typeof value !== "number" || !isFinite(value)) return null
  if (value === 0) return "0"
  if (Math.abs(value) >= 1e15 || Math.abs(value) < 1e-9) return trimZeros(value.toExponential(6))
  var text = value.toPrecision(12)
  if (text.indexOf("e") >= 0) return trimZeros(value.toExponential(6))
  return trimZeros(text)
}

function formatRadix(value, base) {
  if (!isFinite(value)) return null
  var rounded = Math.round(value)
  if (Math.abs(value - rounded) > 1e-9) return null
  var negative = rounded < 0
  var magnitude = Math.abs(rounded)
  var text
  if (base === "hex" || base === "hexadecimal") text = "0x" + magnitude.toString(16)
  else if (base === "bin" || base === "binary") text = "0b" + magnitude.toString(2)
  else if (base === "oct" || base === "octal") text = "0o" + magnitude.toString(8)
  else text = String(magnitude)
  return (negative ? "-" : "") + text
}

function evaluate(input) {
  try {
    var s = String(input || "").trim()
    if (!looksLikeExpression(s)) return null

    var base = ""
    var radix = s.match(/^(.*?)\s+(?:to|in|as)\s+(hex|hexadecimal|bin|binary|oct|octal|dec|decimal)$/i)
    if (radix) {
      s = radix[1]
      base = radix[2].toLowerCase()
    }

    var value = parseExpression(rewritePercents(s))
    if (typeof value !== "number" || !isFinite(value)) return null

    var display = base ? formatRadix(value, base) : formatNumber(value)
    if (display === null) return null
    return { display: display, copyText: display }
  } catch (e) {
    return null
  }
}

// ---- Unit conversion

var UNITS = {
  // length, base metre
  mm: { family: "length", factor: 0.001, display: "mm" },
  cm: { family: "length", factor: 0.01, display: "cm" },
  m: { family: "length", factor: 1, display: "m" },
  km: { family: "length", factor: 1000, display: "km" },
  in: { family: "length", factor: 0.0254, display: "in" },
  ft: { family: "length", factor: 0.3048, display: "ft" },
  yd: { family: "length", factor: 0.9144, display: "yd" },
  mi: { family: "length", factor: 1609.344, display: "mi" },
  nmi: { family: "length", factor: 1852, display: "nmi" },
  // mass, base gram
  mg: { family: "mass", factor: 0.001, display: "mg" },
  g: { family: "mass", factor: 1, display: "g" },
  kg: { family: "mass", factor: 1000, display: "kg" },
  t: { family: "mass", factor: 1000000, display: "t" },
  oz: { family: "mass", factor: 28.349523125, display: "oz" },
  lb: { family: "mass", factor: 453.59237, display: "lb" },
  st: { family: "mass", factor: 6350.29318, display: "st" },
  // data, base byte
  bit: { family: "data", factor: 0.125, display: "bit" },
  b: { family: "data", factor: 1, display: "B" },
  kb: { family: "data", factor: 1000, display: "kB" },
  mb: { family: "data", factor: 1000000, display: "MB" },
  gb: { family: "data", factor: 1000000000, display: "GB" },
  tb: { family: "data", factor: 1000000000000, display: "TB" },
  kib: { family: "data", factor: 1024, display: "KiB" },
  mib: { family: "data", factor: 1048576, display: "MiB" },
  gib: { family: "data", factor: 1073741824, display: "GiB" },
  tib: { family: "data", factor: 1099511627776, display: "TiB" },
  // duration, base second
  ms: { family: "duration", factor: 0.001, display: "ms" },
  s: { family: "duration", factor: 1, display: "s" },
  sec: { family: "duration", factor: 1, display: "s" },
  min: { family: "duration", factor: 60, display: "min" },
  h: { family: "duration", factor: 3600, display: "h" },
  hr: { family: "duration", factor: 3600, display: "h" },
  d: { family: "duration", factor: 86400, display: "d" },
  wk: { family: "duration", factor: 604800, display: "wk" },
  mo: { family: "duration", factor: 2629800, display: "mo" },
  y: { family: "duration", factor: 31557600, display: "y" },
  // speed, base metre/second
  "m/s": { family: "speed", factor: 1, display: "m/s" },
  "km/h": { family: "speed", factor: 0.2777777777777778, display: "km/h" },
  kmh: { family: "speed", factor: 0.2777777777777778, display: "km/h" },
  mph: { family: "speed", factor: 0.44704, display: "mph" },
  kn: { family: "speed", factor: 0.5144444444444445, display: "kn" },
  // volume, base litre
  ml: { family: "volume", factor: 0.001, display: "ml" },
  l: { family: "volume", factor: 1, display: "L" },
  gal: { family: "volume", factor: 3.785411784, display: "gal" },
  qt: { family: "volume", factor: 0.946352946, display: "qt" },
  pt: { family: "volume", factor: 0.473176473, display: "pt" },
  cup: { family: "volume", factor: 0.2365882365, display: "cup" },
  floz: { family: "volume", factor: 0.0295735295625, display: "fl oz" },
  // area, base square metre
  m2: { family: "area", factor: 1, display: "m²" },
  "m²": { family: "area", factor: 1, display: "m²" },
  km2: { family: "area", factor: 1000000, display: "km²" },
  "km²": { family: "area", factor: 1000000, display: "km²" },
  ha: { family: "area", factor: 10000, display: "ha" },
  acre: { family: "area", factor: 4046.8564224, display: "acre" },
  ft2: { family: "area", factor: 0.09290304, display: "ft²" },
  "ft²": { family: "area", factor: 0.09290304, display: "ft²" },
  sqft: { family: "area", factor: 0.09290304, display: "ft²" },
  // temperature, converted through closures rather than a factor
  c: { family: "temperature", display: "°C", toBase: function(v) { return v }, fromBase: function(v) { return v } },
  f: { family: "temperature", display: "°F", toBase: function(v) { return (v - 32) * 5 / 9 }, fromBase: function(v) { return v * 9 / 5 + 32 } },
  k: { family: "temperature", display: "K", toBase: function(v) { return v - 273.15 }, fromBase: function(v) { return v + 273.15 } }
}

var UNIT_ALIASES = {
  millimeter: "mm", millimeters: "mm", millimetre: "mm", millimetres: "mm",
  centimeter: "cm", centimeters: "cm", centimetre: "cm", centimetres: "cm",
  meter: "m", meters: "m", metre: "m", metres: "m",
  kilometer: "km", kilometers: "km", kilometre: "km", kilometres: "km",
  inch: "in", inches: "in", "\"": "in",
  foot: "ft", feet: "ft",
  yard: "yd", yards: "yd",
  mile: "mi", miles: "mi",
  nauticalmile: "nmi", nauticalmiles: "nmi",
  milligram: "mg", milligrams: "mg",
  gram: "g", grams: "g",
  kilogram: "kg", kilograms: "kg", kilo: "kg", kilos: "kg",
  tonne: "t", tonnes: "t", ton: "t", tons: "t",
  ounce: "oz", ounces: "oz",
  pound: "lb", pounds: "lb", lbs: "lb",
  stone: "st", stones: "st",
  bits: "bit", byte: "b", bytes: "b",
  kilobyte: "kb", kilobytes: "kb", megabyte: "mb", megabytes: "mb",
  gigabyte: "gb", gigabytes: "gb", terabyte: "tb", terabytes: "tb",
  kibibyte: "kib", kibibytes: "kib", mebibyte: "mib", mebibytes: "mib",
  gibibyte: "gib", gibibytes: "gib", tebibyte: "tib", tebibytes: "tib",
  millisecond: "ms", milliseconds: "ms", msec: "ms",
  second: "s", seconds: "s", secs: "s",
  minute: "min", minutes: "min", mins: "min",
  hour: "h", hours: "h", hrs: "h",
  day: "d", days: "d",
  week: "wk", weeks: "wk",
  month: "mo", months: "mo",
  year: "y", years: "y", yr: "y", yrs: "y",
  knot: "kn", knots: "kn",
  milliliter: "ml", milliliters: "ml", millilitre: "ml", millilitres: "ml",
  liter: "l", liters: "l", litre: "l", litres: "l",
  gallon: "gal", gallons: "gal",
  quart: "qt", quarts: "qt",
  pint: "pt", pints: "pt",
  cups: "cup",
  fluidounce: "floz", fluidounces: "floz", "fl oz": "floz",
  hectare: "ha", hectares: "ha", acres: "acre",
  squaremeter: "m2", squaremeters: "m2", sqm: "m2", squarefoot: "ft2", squarefeet: "ft2",
  celsius: "c", centigrade: "c", "°c": "c",
  fahrenheit: "f", "°f": "f",
  kelvin: "k"
}

function resolveUnit(token) {
  var value = String(token || "").toLowerCase().replace(/\s+/g, "")
  if (UNITS[value]) return UNITS[value]
  if (UNIT_ALIASES[value] && UNITS[UNIT_ALIASES[value]]) return UNITS[UNIT_ALIASES[value]]
  return null
}

function formatSignificant(value, digits) {
  if (typeof value !== "number" || !isFinite(value)) return null
  if (value === 0) return "0"
  if (Math.abs(value) >= 1e15 || Math.abs(value) < 1e-9) return trimZeros(value.toExponential(digits - 1))
  var text = value.toPrecision(digits)
  if (text.indexOf("e") >= 0) return trimZeros(value.toExponential(digits - 1))
  return trimZeros(text)
}

function convert(input) {
  var s = String(input || "").trim()
  var match = s.match(/^(-?\d+(?:[.,]\d+)?)\s*([a-zA-Z°µ/²³"]+)\s*(?:to|in|as|->|→|=)\s*([a-zA-Z°µ/²³"]+)$/)
  if (!match) return null

  var amount = parseFloat(match[1].replace(",", "."))
  if (!isFinite(amount)) return null

  var from = resolveUnit(match[2])
  var to = resolveUnit(match[3])
  if (!from || !to || from.family !== to.family) return null

  var result
  if (from.family === "temperature") result = to.fromBase(from.toBase(amount))
  else result = amount * from.factor / to.factor

  var display = formatSignificant(result, 6)
  if (display === null) return null

  var text = display + " " + to.display
  return { display: text, copyText: text }
}

// ---- URLs

var TLDS = ["com", "org", "net", "io", "dev", "app", "sh", "co", "uk", "de", "fr", "nl", "eu", "us", "ca", "au", "jp", "cn", "ru", "info", "biz", "me", "tv", "cc", "ai", "gg", "xyz", "online", "site", "tech", "store", "blog", "cloud", "edu", "gov", "mil", "int", "so", "to", "ly", "id"]

function detectUrl(input) {
  var s = String(input || "").trim()
  if (!s || /\s/.test(s)) return ""

  if (/^https?:\/\//i.test(s)) return s
  if (/^mailto:/i.test(s)) return s
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return s
  if (/^localhost(:\d+)?(\/.*)?$/i.test(s)) return "https://" + s
  if (/^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/.*)?$/.test(s)) return "https://" + s

  var host = s.split("/")[0].split(":")[0]
  var parts = host.split(".")
  if (parts.length < 2) return ""
  var tld = parts[parts.length - 1].toLowerCase()
  if (TLDS.indexOf(tld) < 0) return ""
  for (var i = 0; i < parts.length; i++) {
    if (!/^[a-z0-9-]+$/i.test(parts[i])) return ""
  }
  return "https://" + s
}

function destinationKind(value) {
  var s = String(value || "").trim()
  if (/^https?:\/\//i.test(s)) return "web"
  if (s.charAt(0) === "/" || s.charAt(0) === "~" || /^file:\/\//i.test(s)) return "path"
  return "other"
}

// ---- Template engine (quicklinks and snippets share it)

var TOKEN_PATTERN = /\{([a-z]+)((?:\s+[a-z-]+="[^"]*")*)\s*((?:\|\s*[a-z-]+\s*)*)\}/g

function templateTokens(template) {
  var text = String(template || "")
  var out = []
  var pattern = new RegExp(TOKEN_PATTERN.source, "g")
  var match

  while ((match = pattern.exec(text)) !== null) {
    var attrs = ({})
    var attrPattern = /([a-z-]+)="([^"]*)"/g
    var attrMatch
    while ((attrMatch = attrPattern.exec(match[2] || "")) !== null) attrs[attrMatch[1]] = attrMatch[2]

    var modifiers = []
    var rawModifiers = (match[3] || "").split("|")
    for (var i = 0; i < rawModifiers.length; i++) {
      var modifier = rawModifiers[i].trim()
      if (modifier) modifiers.push(modifier)
    }

    out.push({ raw: match[0], name: match[1], attrs: attrs, modifiers: modifiers })
  }
  return out
}

function hasToken(template, names) {
  var tokens = templateTokens(template)
  for (var i = 0; i < tokens.length; i++) {
    if (names.indexOf(tokens[i].name) >= 0) return true
  }
  return false
}

function needsArgument(template) { return hasToken(template, ["argument", "query"]) }
function needsClipboard(template) { return hasToken(template, ["clipboard"]) }
function needsSelection(template) { return hasToken(template, ["selection", "selectedtext"]) }

function pad(value, size) {
  var text = String(value)
  while (text.length < size) text = "0" + text
  return text
}

var WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]

function formatDate(date, format) {
  return String(format)
    .replace(/yyyy/g, String(date.getFullYear()))
    .replace(/MM/g, pad(date.getMonth() + 1, 2))
    .replace(/dd/g, pad(date.getDate(), 2))
    .replace(/HH/g, pad(date.getHours(), 2))
    .replace(/mm/g, pad(date.getMinutes(), 2))
    .replace(/ss/g, pad(date.getSeconds(), 2))
}

function uuid4() {
  var out = ""
  var chars = "0123456789abcdef"
  for (var i = 0; i < 36; i++) {
    if (i === 8 || i === 13 || i === 18 || i === 23) out += "-"
    else if (i === 14) out += "4"
    else if (i === 19) out += chars.charAt(8 + Math.floor(Math.random() * 4))
    else out += chars.charAt(Math.floor(Math.random() * 16))
  }
  return out
}

function tokenValue(token, ctx) {
  var context = ctx || ({})
  var now = context.now instanceof Date ? context.now : new Date(context.now || Date.now())

  if (token.name === "argument" || token.name === "query") return String(context.argument || "")
  if (token.name === "clipboard") return String(context.clipboard || "")
  if (token.name === "selection" || token.name === "selectedtext") return String(context.selection || "")
  if (token.name === "date") return formatDate(now, token.attrs.format || "yyyy-MM-dd")
  if (token.name === "time") return formatDate(now, token.attrs.format || "HH:mm")
  if (token.name === "datetime") return formatDate(now, token.attrs.format || "yyyy-MM-dd HH:mm")
  if (token.name === "day") return WEEKDAYS[now.getDay()]
  if (token.name === "uuid") return uuid4()
  return null
}

function applyModifiers(value, modifiers) {
  var out = String(value)
  for (var i = 0; i < modifiers.length; i++) {
    var modifier = modifiers[i]
    if (modifier === "trim") out = out.trim()
    else if (modifier === "uppercase") out = out.toUpperCase()
    else if (modifier === "lowercase") out = out.toLowerCase()
    else if (modifier === "percent-encode") out = encodeURIComponent(out)
  }
  return out
}

function expandTemplate(template, ctx, mode) {
  var text = String(template || "")
  var tokens = templateTokens(text)

  for (var i = 0; i < tokens.length; i++) {
    var token = tokens[i]
    var value = tokenValue(token, ctx)
    if (value === null) continue

    value = applyModifiers(value, token.modifiers)
    if (mode === "url" && token.modifiers.indexOf("raw") < 0) value = encodeURIComponent(value)
    text = text.split(token.raw).join(value)
  }
  return text
}

// ---- Config (~/.config/omarchy/omacast.json), never written by the plugin

var DEFAULT_SEARCH_ENGINE = "g"

var DEFAULT_QUICKLINKS = [
  { name: "Google", keyword: "g", url: "https://www.google.com/search?q={argument}" },
  { name: "DuckDuckGo", keyword: "ddg", url: "https://duckduckgo.com/?q={argument}" },
  { name: "YouTube", keyword: "yt", url: "https://www.youtube.com/results?search_query={argument}" },
  { name: "GitHub", keyword: "gh", url: "https://github.com/search?q={argument}" },
  { name: "Arch Wiki", keyword: "aw", url: "https://wiki.archlinux.org/index.php?search={argument}" },
  { name: "AUR", keyword: "aur", url: "https://aur.archlinux.org/packages?K={argument}" },
  { name: "Wikipedia", keyword: "w", url: "https://en.wikipedia.org/w/index.php?search={argument}" }
]

var KEYWORD_PATTERN = /^[a-z0-9][a-z0-9.-]{0,15}$/

function normalizeKeyword(value) {
  var keyword = String(value === undefined || value === null ? "" : value).toLowerCase()
  return KEYWORD_PATTERN.test(keyword) ? keyword : ""
}

function normalizeQuicklinks(raw) {
  var out = DEFAULT_QUICKLINKS.slice()
  var byKeyword = ({})
  var byName = ({})

  for (var d = 0; d < out.length; d++) {
    byKeyword[out[d].keyword] = d
    byName[out[d].name] = true
  }

  var values = Array.isArray(raw) ? raw : []
  for (var i = 0; i < values.length; i++) {
    var entry = values[i]
    if (!entry || typeof entry !== "object") continue
    if (typeof entry.name !== "string" || !entry.name) continue
    if (typeof entry.url !== "string" || !entry.url) continue

    var link = { name: entry.name, keyword: normalizeKeyword(entry.keyword), url: entry.url }
    if (link.keyword && byKeyword[link.keyword] !== undefined) {
      out[byKeyword[link.keyword]] = link
      continue
    }
    if (byName[link.name]) continue
    byName[link.name] = true
    if (link.keyword) byKeyword[link.keyword] = out.length
    out.push(link)
  }
  return out
}

function normalizeSnippets(raw) {
  var values = Array.isArray(raw) ? raw : []
  var out = []
  var seen = ({})

  for (var i = 0; i < values.length; i++) {
    var entry = values[i]
    if (!entry || typeof entry !== "object") continue
    if (typeof entry.name !== "string" || !entry.name || seen[entry.name]) continue
    if (typeof entry.text !== "string" || !entry.text) continue
    seen[entry.name] = true
    out.push({ name: entry.name, keyword: normalizeKeyword(entry.keyword), text: entry.text })
  }
  return out
}

function normalizeCommands(raw) {
  var values = Array.isArray(raw) ? raw : []
  var out = []
  var seen = ({})

  for (var i = 0; i < values.length; i++) {
    var entry = values[i]
    if (!entry || typeof entry !== "object") continue
    if (typeof entry.name !== "string" || !entry.name || seen[entry.name]) continue
    if (typeof entry.command !== "string" || !entry.command) continue
    seen[entry.name] = true
    out.push({
      name: entry.name,
      keyword: normalizeKeyword(entry.keyword),
      command: entry.command,
      terminal: entry.terminal === true,
      confirm: entry.confirm === true
    })
  }
  return out
}

function normalizeConfig(raw) {
  var value = raw && typeof raw === "object" ? raw : ({})
  var quicklinks = normalizeQuicklinks(value.quicklinks)

  var engine = normalizeKeyword(value.searchEngine) || DEFAULT_SEARCH_ENGINE
  var found = null
  for (var i = 0; i < quicklinks.length; i++) {
    if (quicklinks[i].keyword === engine) { found = quicklinks[i]; break }
  }
  if (!found) {
    for (var d = 0; d < quicklinks.length; d++) {
      if (quicklinks[d].keyword === DEFAULT_SEARCH_ENGINE) { found = quicklinks[d]; break }
    }
  }
  if (!found) found = quicklinks[0] || DEFAULT_QUICKLINKS[0]

  return {
    searchEngine: found.keyword || DEFAULT_SEARCH_ENGINE,
    searchQuicklink: found,
    quicklinks: quicklinks,
    snippets: normalizeSnippets(value.snippets),
    commands: normalizeCommands(value.commands)
  }
}

function parseJson(raw) {
  try {
    var parsed = JSON.parse(String(raw || ""))
    return parsed && typeof parsed === "object" ? parsed : null
  } catch (e) {
    return null
  }
}

function parseEmojis(raw) {
  var parsed = parseJson(raw)
  return Array.isArray(parsed) ? parsed : []
}

if (typeof module !== "undefined") {
  module.exports = {
    SECTIONS: SECTIONS,
    SECTION_TITLES: SECTION_TITLES,
    SECTION_CAPS: SECTION_CAPS,
    SCOPES: SCOPES,
    DEFAULT_QUICKLINKS: DEFAULT_QUICKLINKS,
    DEFAULT_SEARCH_ENGINE: DEFAULT_SEARCH_ENGINE,
    FRECENCY_MAX: FRECENCY_MAX,
    sectionIndex: sectionIndex,
    sectionTitle: sectionTitle,
    row: row,
    sortRows: sortRows,
    applyCaps: applyCaps,
    matchScore: matchScore,
    decay: decay,
    rank: rank,
    frecencyBonus: frecencyBonus,
    bump: bump,
    pruneUsage: pruneUsage,
    recentKeys: recentKeys,
    normalizeState: normalizeState,
    togglePin: togglePin,
    emptyQueryRows: emptyQueryRows,
    parseQuery: parseQuery,
    fileRequest: fileRequest,
    appRows: appRows,
    windowRows: windowRows,
    menuRows: menuRows,
    parseKeybindingRecords: parseKeybindingRecords,
    keybindingRows: keybindingRows,
    quicklinkRows: quicklinkRows,
    snippetRows: snippetRows,
    commandRows: commandRows,
    parseClipboard: parseClipboard,
    clipboardRows: clipboardRows,
    parseEmojis: parseEmojis,
    emojiRows: emojiRows,
    fileRows: fileRows,
    rankFile: rankFile,
    basename: basename,
    dirname: dirname,
    answerRows: answerRows,
    webRows: webRows,
    scopeRows: scopeRows,
    scopeTitle: scopeTitle,
    scopePlaceholder: scopePlaceholder,
    looksLikeExpression: looksLikeExpression,
    evaluate: evaluate,
    convert: convert,
    detectUrl: detectUrl,
    destinationKind: destinationKind,
    templateTokens: templateTokens,
    needsArgument: needsArgument,
    needsClipboard: needsClipboard,
    needsSelection: needsSelection,
    expandTemplate: expandTemplate,
    normalizeConfig: normalizeConfig,
    parseJson: parseJson,
    firstLine: firstLine
  }
}
