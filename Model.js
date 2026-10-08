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

var SECTIONS = ["answer", "pinned", "recent", "apps", "windows", "actions", "keybindings", "quicklinks", "snippets", "commands", "clipboard", "emoji", "files", "processes", "hidden", "help", "web", "settingsGeneral", "settingsShortcuts", "settingsLibrary", "settingsAdvanced", "settingsEntries", "settingsFields"]

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
  processes: "Processes",
  hidden: "Hidden",
  help: "Keywords",
  web: "Web",
  settingsGeneral: "General",
  settingsShortcuts: "Shortcuts",
  settingsLibrary: "Library",
  settingsAdvanced: "Advanced",
  settingsEntries: "Entries",
  settingsFields: "Fields"
}

var SECTION_CAPS = {
  // Calculator, time zone and colour answers can stack: `#f80` is three rows.
  answer: 3,
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
  processes: 200,
  hidden: 200,
  help: 60,
  // The web fallback, with the opt-in AI row above it.
  web: 2,
  settingsGeneral: 200,
  settingsShortcuts: 200,
  settingsLibrary: 200,
  settingsAdvanced: 200,
  settingsEntries: 200,
  settingsFields: 200
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
var ICON_SETTINGS = ""        // nf-fa-cog
var ICON_CLOCK = ""           // nf-fa-clock_o
var ICON_BELL = ""            // nf-fa-bell
var ICON_BRUSH = ""           // nf-fa-paint_brush
var ICON_PROCESS = ""         // nf-fa-cogs
var ICON_CHAT = ""            // nf-fa-comments
var ICON_MONEY = ""           // nf-fa-money
var ICON_CODE = ""            // nf-fa-code
var ICON_FOLDER = ""          // nf-fa-folder
var ICON_EYE = ""             // nf-fa-eye

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
    promoted: value.promoted === true,
    confirm: value.confirm === true,
    primaryLabel: clip(value.primaryLabel === undefined ? "Run" : value.primaryLabel, 40),
    secondaryLabel: clip(value.secondaryLabel || "", 40),
    score: typeof value.score === "number" && isFinite(value.score) ? value.score : 0,
    order: typeof value.order === "number" && isFinite(value.order) ? value.order : 0,
    payload: value.payload || ({})
  }
}

// Section order first, then score, then the order the provider emitted. Array
// sort is stable in every engine this runs on, so equal rows keep their input
// order anyway; `order` makes that explicit for providers that care.
//
// One thing outranks the section order: a row whose keyword the user actually
// typed. `td` is an instruction, and burying it under every app whose acronym
// happens to be td makes the keyword useless.
function sortRows(rows) {
  var out = (rows || []).slice()
  out.sort(function(a, b) {
    if (a.promoted !== b.promoted) return a.promoted ? -1 : 1
    var sa = sectionIndex(a.section)
    var sb = sectionIndex(b.section)
    if (sa !== sb) return sa - sb
    if (a.score !== b.score) return b.score - a.score
    return a.order - b.order
  })
  return out
}

// Caps are per view, not global: five windows are enough beside eight app
// results, the empty palette shows more of them because there is nothing else
// on screen, and the Windows scope shows every one. `overrides` replaces a
// section's cap; a non-finite cap means no limit.
function applyCaps(rows, overrides) {
  var limits = overrides || ({})
  var seen = ({})
  var out = []

  for (var i = 0; i < rows.length; i++) {
    var section = rows[i].section
    var cap = limits[section] !== undefined
      ? limits[section]
      : (SECTION_CAPS[section] === undefined ? 25 : SECTION_CAPS[section])
    if (!isFinite(cap)) {
      out.push(rows[i])
      continue
    }
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

// Number of skipped characters when `term` walks through `words` as a
// subsequence that starts on a word boundary, or -1 when it does not.
// `words` is wordText() output, which callers on a hot path precompute.
function subsequenceGaps(words, term) {
  if (!term) return -1
  var haystack = words
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

// Lowercasing, the acronym and the word split are the same on every keystroke
// for a row that has not changed. A provider whose source only changes on a
// file or guard event prepares them once; everyone else passes plain strings
// and matchScore does it inline.
function prepareFields(name, aliases, text) {
  var lowered = lower(name)
  return {
    name: lowered,
    aliases: fieldAliases({ aliases: aliases }),
    text: lower(text),
    acronym: acronymOf(lowered),
    words: wordText(lowered),
    prepared: true
  }
}

// One edit away: a swapped pair, a wrong, missing or extra letter. This is
// the optimal-string-alignment distance capped at 1, which is all the typo
// tier needs and never builds a matrix.
function withinOneEdit(a, b) {
  if (a === b) return true
  var la = a.length
  var lb = b.length
  if (Math.abs(la - lb) > 1) return false
  var i = 0
  while (i < la && i < lb && a.charAt(i) === b.charAt(i)) i += 1
  if (la === lb) {
    if (a.slice(i + 1) === b.slice(i + 1)) return true
    return a.charAt(i) === b.charAt(i + 1) && a.charAt(i + 1) === b.charAt(i) && a.slice(i + 2) === b.slice(i + 2)
  }
  if (la > lb) return a.slice(i + 1) === b.slice(i)
  return a.slice(i) === b.slice(i + 1)
}

// Short terms are left alone: at three letters one edit reaches half the
// dictionary. Only whole name words count, so `chrome` never reaches
// Chromium this way.
var TYPO_MIN = 4
var TYPO_SCORE = 1500

function typoMatches(term, words) {
  if (term.length < TYPO_MIN) return false
  var parts = words.split(" ")
  for (var i = 0; i < parts.length; i++) {
    if (parts[i] && withinOneEdit(term, parts[i])) return true
  }
  return false
}

// 1 is a real match, 2 is a match only through the typo tier, 0 is none.
function termMatches(term, name, aliases, text, acronym, words) {
  if (name.indexOf(term) >= 0) return 1
  for (var i = 0; i < aliases.length; i++) if (aliases[i].indexOf(term) >= 0) return 1
  if (text.indexOf(term) >= 0) return 1
  if (term.length <= 5 && acronym.indexOf(term) >= 0) return 1
  if (subsequenceGaps(words, term) >= 0) return 1
  return typoMatches(term, words) ? 2 : 0
}

function matchScore(query, fields) {
  var q = lower(query).trim()
  if (!q) return 0

  var ready = fields && fields.prepared === true
  var name = ready ? fields.name : lower(fields && fields.name)
  var aliases = ready ? fields.aliases : fieldAliases(fields)
  var text = ready ? fields.text : lower(fields && fields.text)
  var acronym = ready ? fields.acronym : acronymOf(name)
  var nameWords = ready ? fields.words : wordText(name)

  var typo = false
  var terms = q.split(/\s+/)
  for (var t = 0; t < terms.length; t++) {
    if (!terms[t]) continue
    var hit = termMatches(terms[t], name, aliases, text, acronym, nameWords)
    if (!hit) return -1
    if (hit === 2) typo = true
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

  var gaps = subsequenceGaps(nameWords, q.replace(/\s+/g, ""))
  if (gaps >= 0) return 3000 - gaps * 10 - name.length

  // Below every real tier and above nothing: `fierfox` should still find
  // Firefox, but never outrank something the user spelled right.
  if (typo) return Math.max(1, TYPO_SCORE - name.length)
  return -1
}

// For names ranked by someone else (the shell's AppSearch): the score of a
// near miss, meaning a one-typo word or a subsequence that skips at most two
// letters, else -1. A dropped letter is a subsequence, so `firfox` needs this
// as much as `fierfox` does.
function nearMissScore(query, name) {
  var score = matchScore(query, { name: name, aliases: [], text: "" })
  if (score <= 0) return -1
  if (score <= TYPO_SCORE) return score
  if (score >= 3000) return -1
  var gaps = subsequenceGaps(wordText(lower(name)), lower(query).replace(/\s+/g, ""))
  return gaps >= 0 && gaps <= 2 ? score : -1
}

// ---- Frecency (zoxide's shape: a decayed launch count, bounded)

var FRECENCY_MAX = 400
var FRECENCY_HALF = 6
var USAGE_LIMIT = 400
// The empty palette has room the root search does not: nothing competes with
// the window list there.
var EMPTY_WINDOW_LIMIT = 8
var USAGE_KEY = /^(app|menu|bind|ql|snip|cmd|oc|theme|sc):[^\x00-\x1f]{1,240}$/
var LAST_QUERY_LIMIT = 240

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
  // Equal rank is reachable: 2 launches an hour ago and 40 from three months
  // ago both come to 4. The fresher one is the better guess, and the key
  // breaks the last tie so the list never reshuffles on its own.
  keys.sort(function(a, b) {
    var diff = rank(source[b], now) - rank(source[a], now)
    if (diff !== 0) return diff
    var age = (source[b].last || 0) - (source[a].last || 0)
    if (age !== 0) return age
    return a < b ? -1 : (a > b ? 1 : 0)
  })
  return keys.slice(0, limit)
}

// ---- State (~/.local/state/omarchy/omacast-state.json)

// Unknown fields are dropped here, so every field the plugin writes has to be
// listed. Callers change state through updateState(), which keeps the rest.
function normalizeKeys(raw) {
  var out = []
  var seen = ({})
  var values = Array.isArray(raw) ? raw : []
  for (var i = 0; i < values.length; i++) {
    var key = values[i]
    if (typeof key !== "string" || !USAGE_KEY.test(key) || seen[key]) continue
    seen[key] = true
    out.push(key)
  }
  return out
}

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

  var lastQuery = typeof value.lastQuery === "string" ? clip(value.lastQuery.replace(/[\x00-\x1f]+/g, " "), LAST_QUERY_LIMIT) : ""

  return { version: 1, usage: usage, pins: normalizeKeys(value.pins), hidden: normalizeKeys(value.hidden), lastQuery: lastQuery }
}

function updateState(state, patch) {
  var current = normalizeState(state)
  var changes = patch || ({})
  for (var key in changes) current[key] = changes[key]
  return normalizeState(current)
}

function toggleKey(list, key) {
  var out = []
  var removed = false
  for (var i = 0; i < list.length; i++) {
    if (list[i] === key) { removed = true; continue }
    out.push(list[i])
  }
  if (!removed) out.push(key)
  return out
}

function togglePin(state, key) {
  var current = normalizeState(state)
  if (!USAGE_KEY.test(String(key || ""))) return current
  return updateState(current, { pins: toggleKey(current.pins, key) })
}

// Hiding also unpins: a pinned row that never renders is a pin nobody can
// remove from the palette.
function toggleHidden(state, key) {
  var current = normalizeState(state)
  if (!USAGE_KEY.test(String(key || ""))) return current
  var hidden = toggleKey(current.hidden, key)
  var pins = hidden.indexOf(key) >= 0 ? current.pins.filter(function(pin) { return pin !== key }) : current.pins
  return updateState(current, { hidden: hidden, pins: pins })
}

function resetUsage(state, key) {
  var current = normalizeState(state)
  var usage = ({})
  for (var k in current.usage) if (k !== key) usage[k] = current.usage[k]
  return updateState(current, { usage: usage })
}

function rememberQuery(state, text) {
  var value = String(text || "").trim()
  if (!value) return normalizeState(state)
  return updateState(state, { lastQuery: value })
}

function hiddenMap(state) {
  var out = ({})
  var list = normalizeState(state).hidden
  for (var i = 0; i < list.length; i++) out[list[i]] = true
  return out
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
  var hidden = hiddenMap(current)

  for (var i = 0; i < current.pins.length; i++) {
    var key = current.pins[i]
    pinned[key] = true
    if (byKey[key] && !hidden[key]) out.push(cloneInto(byKey[key], "pinned", i))
  }

  var skip = ({})
  for (var p in pinned) skip[p] = true
  for (var h in hidden) skip[h] = true
  var recents = recentKeys(current.usage, now, SECTION_CAPS.recent, skip)
  for (var r = 0; r < recents.length; r++) {
    if (byKey[recents[r]]) out.push(cloneInto(byKey[recents[r]], "recent", r))
  }

  for (var w = 0; w < windows.length && w < EMPTY_WINDOW_LIMIT; w++) out.push(cloneInto(windows[w], "windows", w))

  return out
}

// ---- Query parsing
//
// A pushed scope always wins: once the user is inside Clipboard, typing `f `
// searches clipboard text for "f", it does not jump to files.

var SCOPES = ["clipboard", "emoji", "files", "windows", "help", "kill", "content", "hidden", "settings"]

function isSettingsScope(scope) {
  return String(scope || "").indexOf("settings") === 0
}

// A lone hex colour is an answer, not a content search: `#f80` and
// `#ff8800` go to the colour inspector, everything else after `#` to ripgrep.
var HEX_COLOUR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i

function parseQuery(text, scope) {
  var raw = String(text === undefined || text === null ? "" : text)
  var trimmed = raw.trim()
  var current = String(scope || "root")

  if (current !== "root") return { raw: raw, trimmed: trimmed, scope: current, prefix: "", rest: trimmed }

  // Prefixes are matched before the trailing space is trimmed away: "cb " is
  // how a user enters the clipboard scope, and trimming first would leave a
  // bare "cb" that matches nothing.
  var lead = raw.replace(/^\s+/, "")

  // `?` is the cheat sheet: every prefix and every configured keyword, with
  // what it does. Nothing else in the palette starts with it.
  if (lead.charAt(0) === "?") return { raw: raw, trimmed: trimmed, scope: "help", prefix: "?", rest: lead.slice(1).trim() }

  if (lead.charAt(0) === ":") return { raw: raw, trimmed: trimmed, scope: "emoji", prefix: ":", rest: lead.slice(1).trim() }

  var clip = lead.match(/^(cb|clip|clipboard)\s([\s\S]*)$/)
  if (clip) return { raw: raw, trimmed: trimmed, scope: "clipboard", prefix: clip[1], rest: clip[2].trim() }

  var files = lead.match(/^(f|file|files)\s([\s\S]*)$/)
  if (files) return { raw: raw, trimmed: trimmed, scope: "files", prefix: files[1], rest: files[2].trim() }

  // `w` belongs to the Wikipedia quicklink, so windows takes `win `. Only that
  // spelling: `window gaps` and `windows ` are things people search the menu
  // for, and a prefix would swallow them.
  var wins = lead.match(/^win\s([\s\S]*)$/)
  if (wins) return { raw: raw, trimmed: trimmed, scope: "windows", prefix: "win", rest: wins[1].trim() }

  var kill = lead.match(/^kill\s([\s\S]*)$/)
  if (kill) return { raw: raw, trimmed: trimmed, scope: "kill", prefix: "kill", rest: kill[1].trim() }

  if (lead.charAt(0) === "#" && !HEX_COLOUR.test(trimmed)) return { raw: raw, trimmed: trimmed, scope: "content", prefix: "#", rest: lead.slice(1).trim() }

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

// A running app focuses by default and launches another instance on the
// secondary key, the way Raycast and Beacon behave: the common intent behind
// typing an app's name is "take me there", not "open a second copy".
function appRows(sorted, query, usage, running, now, hidden) {
  var entries = sorted || []
  var runningMap = running || ({})
  var skip = hidden || ({})
  var out = []

  for (var i = 0; i < entries.length; i++) {
    var entry = entries[i].entry
    if (!entry) continue
    var id = String(entry.id || "")
    var key = "app:" + id
    if (skip[key]) continue
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
      primaryLabel: isRunning ? "Focus" : "Open",
      secondaryLabel: isRunning ? "Launch new" : "",
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

// Visibility and breadcrumbs cost a tree walk per item, and the menu only
// changes when its JSONC or its guard batch does. Sources.qml builds this
// index on those events; every keystroke then scores a flat array.
function buildMenuIndex(items, itemOrder, whenResults, checkedResults, MenuModel) {
  var map = items || ({})
  var order = Array.isArray(itemOrder) ? itemOrder : []
  var index = []

  for (var i = 0; i < order.length; i++) {
    var entry = map[order[i]]
    if (!entry || entry.id === "root" || entry.id === "apps") continue
    if (entry.provider) continue
    if (entry.parent === "apps") continue
    if (!MenuModel.isVisible(map, order, whenResults, entry, 0)) continue

    var isLeaf = entry.kind === "action" || entry.kind === "link"
    index.push({
      id: entry.id,
      parent: entry.parent,
      kind: entry.kind,
      isLeaf: isLeaf,
      label: MenuModel.labelFor(entry, checkedResults),
      fields: prepareFields(entry.label, (entry.aliases || []).concat([MenuModel.searchableToken(entry.id)]), MenuModel.pathFor(map, entry.parent)),
      breadcrumb: MenuModel.pathFor(map, entry.parent),
      icon: entry.icon || (entry.kind === "menu" ? ICON_SUBMENU : ICON_MENU),
      iconFont: entry.iconFont || "",
      action: entry.action || "",
      target: entry.target || "",
      confirm: MENU_CONFIRM.test(entry.id),
      order: typeof entry.order === "number" ? entry.order : i
    })
  }
  return index
}

function menuRows(menuIndex, query, usage, now, scope) {
  var index = menuIndex || []
  var out = []
  var scoped = String(scope || "root")
  var browsing = scoped.indexOf("menu:") === 0 ? scoped.slice(5) : ""
  // "catalog" asks for every visible row regardless of query: Omacast.qml
  // builds the key → row map the pinned and recent sections resolve against.
  var catalogMode = scoped === "catalog"
  var q = String(query || "").trim()

  if (!browsing && !catalogMode && !q) return out

  for (var i = 0; i < index.length; i++) {
    var entry = index[i]
    // Browsing restricts to one submenu's children; the root search sees the
    // whole tree. Scoring is the same either way.
    if (browsing && entry.parent !== browsing) continue
    var score = catalogMode ? 0 : matchScore(q, entry.fields)
    if (score < 0) continue

    var key = "menu:" + entry.id
    var primary = entry.kind === "action" ? "Run" : (entry.kind === "link" ? "Open" : "Browse")

    out.push(row({
      key: key,
      section: "actions",
      title: entry.label,
      subtitle: entry.breadcrumb,
      icon: entry.icon,
      frecencyKey: entry.isLeaf ? key : "",
      pinnable: entry.isLeaf,
      confirm: entry.confirm,
      primaryLabel: primary,
      score: score + (entry.isLeaf ? frecencyBonus(usage, key, now) : 0),
      order: entry.order,
      payload: {
        kind: "menu", id: entry.id, itemKind: entry.kind, action: entry.action, target: entry.target, iconFont: entry.iconFont,
        preview: { type: "text", text: (entry.breadcrumb ? entry.breadcrumb + " › " : "") + entry.label + (entry.action ? "\n\n" + entry.action : "") }
      }
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
      payload: { kind: "keybinding", dispatcher: record.dispatcher, arg: record.arg, combo: record.combo, disabled: disabled }
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
      promoted: admission.direct,
      title: admission.direct && admission.argument ? link.name + ": " + admission.argument : link.name,
      subtitle: link.keyword ? link.keyword + (wants ? " <query>" : "") : link.url,
      icon: ICON_QUICKLINK,
      keyword: link.keyword || "",
      frecencyKey: key,
      pinnable: true,
      primaryLabel: completing ? "Type keyword" : "Open",
      score: admission.score + frecencyBonus(usage, key, now),
      order: i,
      payload: { kind: "quicklink", url: link.url, argument: admission.argument, keyword: link.keyword || "", complete: completing, preview: { type: "text", text: link.url } }
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
      promoted: admission.direct,
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
      payload: { kind: "snippet", text: snippet.text, argument: admission.argument, keyword: snippet.keyword || "", complete: completing, preview: { type: "snippet", template: snippet.text, argument: admission.argument } }
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
      promoted: admission.direct,
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
      payload: { kind: "command", command: command.command, terminal: command.terminal === true, args: args, preview: { type: "text", text: command.command + (args.length ? "\n\nArguments: " + args.join("  ") : "") } }
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
        payload: { kind: "clipboard", entryType: "image", path: entry.path, mime: entry.mime, historyIndex: entry.historyIndex, preview: { type: "image", path: entry.path } }
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
      payload: { kind: "clipboard", entryType: "text", historyIndex: entry.historyIndex, preview: { type: "text", text: String(entry.text || "").slice(0, PREVIEW_LIMIT) } }
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
var FILE_LIMITS = [20, 40, 60, 100, 200]
var FILE_CANDIDATE_LIMIT = 500
var FILE_FILTERS = [
  { id: "all", label: "All" },
  { id: "folders", label: "Folders" },
  { id: "documents", label: "Documents", extensions: ["txt", "md", "markdown", "rst", "pdf", "odt", "ods", "odp", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "rtf", "csv", "epub"] },
  { id: "images", label: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "avif", "heic", "heif", "tif", "tiff", "ico"] },
  { id: "videos", label: "Videos", extensions: ["mp4", "mkv", "webm", "mov", "avi", "m4v", "mpeg", "mpg", "wmv", "flv"] },
  { id: "audio", label: "Audio", extensions: ["mp3", "flac", "wav", "ogg", "opus", "m4a", "aac", "aiff", "wma"] },
  { id: "code", label: "Code", extensions: ["js", "jsx", "ts", "tsx", "mjs", "cjs", "json", "jsonc", "qml", "py", "rs", "go", "c", "h", "cc", "cpp", "cxx", "hpp", "cs", "java", "kt", "kts", "swift", "rb", "php", "lua", "sh", "bash", "zsh", "fish", "html", "css", "scss", "sass", "less", "vue", "svelte", "sql", "yaml", "yml", "toml", "xml", "ini", "conf", "cmake", "nix", "ex", "exs", "erl", "hrl", "hs", "pl", "r", "dart", "ipynb"], names: ["Dockerfile", "Makefile", "Containerfile", "Justfile"] }
]
var FILE_SORTS = [
  { id: "relevance", label: "Relevance" },
  { id: "newest", label: "Newest" },
  { id: "oldest", label: "Oldest" },
  { id: "nameAsc", label: "Name A–Z" },
  { id: "nameDesc", label: "Name Z–A" }
]

function fileCommand(dir, terms, filter) {
  var selected = FILE_FILTERS[0]
  for (var f = 0; f < FILE_FILTERS.length; f++) {
    if (FILE_FILTERS[f].id === filter) { selected = FILE_FILTERS[f]; break }
  }
  var command = ["fd", "--ignore-case", "--hidden", "--follow", "--one-file-system",
    "--exclude", ".git", "--exclude", "node_modules", "--exclude", ".cache",
    "--max-results", String(FILE_CANDIDATE_LIMIT), "--threads", "2",
    "--absolute-path", "--color", "never", "--full-path"]
  command.push("--type", selected.id === "folders" ? "d" : "f")
  if (selected.id === "all") command.push("--type", "d")

  var values = (terms || []).filter(function(value) { return String(value || "") !== "" })
  if (!values.length) command.push("--max-depth", "1")
  if (selected.id === "code") {
    // fd's fixed-string flag covers every pattern. Escape user terms when
    // the filename predicate needs regex, so they still mean literal text.
    var names = selected.names.map(function(name) { return name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") })
    command.push("--and=(?:^|/)(?:[^/]+\\.(?:" + selected.extensions.join("|") + ")|" + names.join("|") + ")$")
    for (var c = 0; c < values.length; c++) command.push("--and=" + String(values[c]).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  } else {
    command.push("--fixed-strings")
    if (selected.extensions) {
      for (var e = 0; e < selected.extensions.length; e++) command.push("--extension", selected.extensions[e])
    }
    for (var t = 0; t < values.length; t++) command.push("--and=" + String(values[t]))
  }
  command.push("--search-path", String(dir || ""), "")
  return command
}

function fileStatCommand(paths) {
  return ["stat", "--dereference", "--printf", "%Y\t%f\t%n\n", "--"].concat(paths)
}

function parseFileRecords(text) {
  var lines = String(text || "").split("\n")
  var paths = []
  var mtimes = ({})
  for (var i = 0; i < lines.length; i++) {
    var first = lines[i].indexOf("\t")
    var second = lines[i].indexOf("\t", first + 1)
    if (first < 1 || second < 0) continue
    var seconds = Number(lines[i].slice(0, first))
    var modeText = lines[i].slice(first + 1, second)
    if (!isFinite(seconds) || !/^[0-9a-f]+$/i.test(modeText)) continue
    var path = lines[i].slice(second + 1)
    if (path.charAt(0) !== "/") continue
    if (path.length > 1) path = path.replace(/\/+$/, "")
    var isDir = (parseInt(modeText, 16) & 0xf000) === 0x4000
    paths.push(isDir && path !== "/" ? path + "/" : path)
    mtimes[path] = seconds * 1000
  }
  return { paths: paths, mtimes: mtimes }
}


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
  var normalized = String(path || "").replace(/\/+$/, "")
  var name = lower(basename(normalized))
  var full = lower(normalized)
  var terms = lower(query).trim().split(/\s+/).filter(function(term) { return term !== "" })
  var minimum = 5
  var total = 0
  for (var t = 0; t < terms.length; t++) {
    var term = terms[t]
    var at = name.indexOf(term)
    var tier = 1
    if (at < 0 && full.indexOf(term) < 0) return -1
    if (name === term) tier = 5
    else if (at === 0) tier = 4
    else if (at >= 0) {
      tier = 2
      while (at >= 0) {
        if (/[^a-z0-9]/.test(name.charAt(at - 1))) { tier = 3; break }
        at = name.indexOf(term, at + 1)
      }
    }
    minimum = Math.min(minimum, tier)
    total += tier
  }

  var segments = normalized.split("/")
  var penalty = 150 * segments.length
  if (name.charAt(0) === ".") penalty += 500
  for (var i = 1; i < segments.length - 1; i++) {
    if (segments[i].charAt(0) === ".") { penalty += 1500; break }
  }
  // Bounded preferences never push a basename match below a path-only tier.
  return minimum * 1000000 + (terms.length ? total / terms.length * 10000 : 0) - Math.min(penalty, 9999)
}

var PREVIEW_LIMIT = 16384
var IMAGE_FILE = /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i

// What the preview pane shows for a file row: the image itself, the head of
// a text file, or ripgrep's context around a content match. Directories get
// none; there is nothing useful to show in 280 pixels.
function filePreview(path, isDir, term) {
  if (isDir) return null
  if (IMAGE_FILE.test(path)) return { type: "image", path: path }
  if (term) return { type: "content", path: path, term: term }
  return { type: "file", path: path }
}

// fd prints directories with a trailing slash, which would leave the row with
// an empty basename. Strip it and remember the row is a folder; the preview
// and Terminal here still check the disk, for paths that arrive without one.
// `term` is set for content search, whose preview is the match, not the head.
function fileRows(paths, query, home, term, options) {
  var values = paths || []
  var out = []
  var settings = options || ({})

  for (var i = 0; i < values.length; i++) {
    var raw = String(values[i] || "")
    if (!raw) continue
    var isDir = raw.length > 1 && raw.charAt(raw.length - 1) === "/"
    var path = raw.length > 1 ? raw.replace(/\/+$/, "") : raw
    if (!path) path = "/"
    var score = term ? -i : rankFile(path, query)
    if (!term && score < 0) continue

    out.push(row({
      key: "file:" + path,
      section: "files",
      title: basename(path),
      subtitle: shortenHome(dirname(path), home),
      icon: isDir ? ICON_FOLDER : ICON_FILE,
      primaryLabel: "Open",
      secondaryLabel: "Show in folder",
      score: score,
      order: i,
      payload: { kind: "file", path: path, dir: dirname(path), isDir: isDir, preview: filePreview(path, isDir, term || "") }
    }))
  }
  if (!term && settings.sort && settings.sort !== "relevance") {
    var mtimes = settings.mtimes || ({})
    out.sort(function(a, b) {
      if (settings.sort === "newest" || settings.sort === "oldest") {
        var delta = (mtimes[a.payload.path] || 0) - (mtimes[b.payload.path] || 0)
        if (delta) return settings.sort === "newest" ? -delta : delta
      }
      var an = lower(a.title)
      var bn = lower(b.title)
      var names = an < bn ? -1 : (an > bn ? 1 : 0)
      if (!names) names = a.payload.path < b.payload.path ? -1 : (a.payload.path > b.payload.path ? 1 : 0)
      return settings.sort === "nameDesc" ? -names : names
    })
    for (var s = 0; s < out.length; s++) {
      out[s].score = -s
      out[s].order = s
    }
  }
  return out
}

// ---- Answers and web fallback
//
// `ctx` carries what the answers depend on besides the query: the clock, and
// the currency state ({ enabled, rates }) when the user opted in.

function answerRow(answer, q, order) {
  return row({
    key: "answer:" + answer.display,
    section: "answer",
    title: answer.display,
    subtitle: answer.subtitle || q,
    icon: answer.icon || ICON_CALC,
    primaryLabel: "Copy",
    score: 1 - order * 0.01,
    order: order,
    payload: { kind: "answer", copyText: answer.copyText, expression: q, swatch: answer.swatch || "" }
  })
}

function answerRows(query, ctx) {
  var q = String(query || "").trim()
  if (!q) return []
  var context = ctx || ({})
  var now = typeof context.now === "number" ? context.now : Date.now()
  var currency = context.currency || ({})
  var out = []

  var answer = evaluate(q) || convert(q) || (currency.enabled ? convertCurrency(q, currency.rates) : null) || dateAnswer(q, now)
  if (answer) {
    out.push(answerRow(answer, q, 0))
  } else if (currency.enabled && !currency.rates && currencyRequest(q)) {
    out.push(row({
      key: "answer:rates",
      section: "answer",
      title: "Currency rates not fetched yet",
      subtitle: "Fetches the ECB daily reference rates, once a day",
      icon: ICON_MONEY,
      primaryLabel: "Fetch",
      score: 1,
      payload: { kind: "fetchRates" }
    }))
  }

  var colours = colourAnswers(q)
  for (var c = 0; c < colours.length; c++) out.push(answerRow(colours[c], q, c))

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

// Settings opens inside the palette; the scripts folder still opens externally.
function configRows(query, path, scriptDir) {
  var out = []
  var score = matchScore(query, {
    name: "OmaCast Settings",
    aliases: ["settings", "preferences", "config", "shortcuts", "quicklinks", "snippets", "commands", "omacast"],
    text: String(path || "")
  })
  if (score >= 0) {
    out.push(row({
      key: "cfg:settings",
      section: "actions",
      title: "OmaCast Settings",
      subtitle: String(path || ""),
      icon: ICON_SETTINGS,
      primaryLabel: "Open",
      score: score,
      payload: { kind: "scope", scope: "settings" }
    }))
  }

  if (scriptDir) {
    var scriptScore = matchScore(query, { name: "OmaCast Scripts Folder", aliases: ["script commands", "raycast scripts", "omacast"], text: String(scriptDir) })
    if (scriptScore >= 0) {
      out.push(row({
        key: "cfg:scripts",
        section: "actions",
        title: "OmaCast Scripts Folder",
        subtitle: String(scriptDir),
        icon: ICON_FOLDER,
        primaryLabel: "Open",
        score: scriptScore,
        payload: { kind: "scriptsFolder", path: String(scriptDir) }
      }))
    }
  }
  return out
}

function webRows(query, engine) {
  var q = String(query || "").trim()
  if (q.length < 2) return []
  if (!engine || !engine.url) return []
  var name = engine.name
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
  { scope: "content", name: "Search File Contents", icon: ICON_SEARCH },
  { scope: "windows", name: "Windows", icon: ICON_WINDOW },
  { scope: "kill", name: "Kill Process", icon: ICON_PROCESS },
  { scope: "help", name: "Keywords & Prefixes", icon: ICON_SEARCH }
]

// ---- Cheat sheet
//
// Everything that can be typed as a prefix or a keyword, in one scope, so the
// answer to "what was the clipboard prefix again?" is `?` rather than the
// README. Activating a row types the token into the field.

var HELP_PREFIXES = [
  { token: "?", detail: "This list", icon: ICON_SEARCH },
  { token: ":", detail: "Emoji search, as in  :smile", icon: ICON_EMOJI },
  { token: "cb ", detail: "Clipboard history, as in  cb ssh", icon: ICON_CLIPBOARD },
  { token: "f ", detail: "Find files in your home, as in  f invoice", icon: ICON_FILE },
  { token: "#", detail: "Search inside files, as in  #TODO", icon: ICON_SEARCH },
  { token: "win ", detail: "Open windows, as in  win chrome", icon: ICON_WINDOW },
  { token: "kill ", detail: "Terminate one of your processes, as in  kill firefox", icon: ICON_PROCESS },
  { token: "remind ", detail: "Set a reminder, as in  remind 30 check the oven", icon: ICON_BELL },
  { token: "~/", detail: "Browse a path, as in  ~/coding/", icon: ICON_FILE }
]

// `extra` is what the config alone cannot say: loaded script commands, the
// scripts folder, and how many rows the user has hidden.
function helpRows(config, query, extra) {
  var settings = config || ({})
  var more = extra || ({})
  var out = []
  var specs = []

  for (var p = 0; p < HELP_PREFIXES.length; p++) {
    specs.push({ token: HELP_PREFIXES[p].token, name: HELP_PREFIXES[p].detail, detail: "Prefix", icon: HELP_PREFIXES[p].icon })
  }

  var groups = [
    { values: settings.quicklinks || [], detail: "Quicklink", icon: ICON_QUICKLINK },
    { values: settings.snippets || [], detail: "Snippet", icon: ICON_SNIPPET },
    { values: settings.commands || [], detail: "Command", icon: ICON_COMMAND },
    { values: scriptKeywordEntries(more.scripts), detail: "Script", icon: ICON_CODE }
  ]

  for (var g = 0; g < groups.length; g++) {
    for (var i = 0; i < groups[g].values.length; i++) {
      var entry = groups[g].values[i]
      if (!entry.keyword) continue
      specs.push({ token: entry.keyword + " ", name: entry.name, detail: groups[g].detail, icon: groups[g].icon })
    }
  }

  for (var s = 0; s < specs.length; s++) {
    var spec = specs[s]
    var score = matchScore(query, { name: spec.token.trim(), aliases: [spec.name], text: spec.detail })
    if (score < 0) continue
    out.push(row({
      key: "help:" + spec.token,
      section: "help",
      title: spec.token.trim(),
      subtitle: spec.name,
      icon: spec.icon,
      accessory: spec.detail,
      primaryLabel: "Type it",
      score: score,
      order: s,
      payload: { kind: "help", insert: spec.token }
    }))
  }

  if (more.scriptDir && matchScore(query, { name: "Scripts folder", aliases: ["script commands"], text: more.scriptDir }) >= 0) {
    out.push(row({
      key: "help:scripts-folder",
      section: "help",
      title: "Scripts folder",
      subtitle: more.scriptDir,
      icon: ICON_FOLDER,
      accessory: "Folder",
      primaryLabel: "Open",
      order: specs.length,
      payload: { kind: "scriptsFolder", path: more.scriptDir }
    }))
  }

  var hiddenCount = more.hiddenCount || 0
  if (hiddenCount > 0 && matchScore(query, { name: "Show hidden", aliases: ["hidden", "unhide"] }) >= 0) {
    out.push(row({
      key: "help:hidden",
      section: "help",
      title: "Show hidden",
      subtitle: hiddenCount === 1 ? "1 hidden row" : hiddenCount + " hidden rows",
      icon: ICON_EYE,
      accessory: "Scope",
      primaryLabel: "Browse",
      order: specs.length + 1,
      payload: { kind: "scope", scope: "hidden" }
    }))
  }
  return out
}

// ---- Settings rows

function filterSettingsRows(specs, query) {
  var out = []
  specs.forEach(function(spec, index) {
    var score = matchScore(query, { name: spec.title, aliases: [spec.subtitle || ""] })
    if (String(query || "").trim() && score < 0) return
    spec.order = index
    spec.score = score
    spec.icon = ICON_SETTINGS
    if (!spec.payload) {
      spec.payload = { kind: "setting", action: spec.action }
      if (spec.secondaryLabel) spec.payload.secondaryAction = spec.secondaryAction
    }
    out.push(row(spec))
  })
  // A direct setting match should not leave unrelated fuzzy shortcut rows.
  var direct = out.some(function(entry) { return entry.score >= 6000 })
  return direct ? out.filter(function(entry) { return entry.score >= 6000 }) : out
}

function settingsRows(doc, ctx, query) {
  var config = ctx.config
  var binds = ctx.binds
  var specs = [
    { key: "setting:engine", section: "settingsGeneral", title: "Search engine", subtitle: config.searchQuicklink ? config.searchQuicklink.name + " · " + config.searchQuicklink.keyword : "None", primaryLabel: "Change", action: { type: "push", scope: "settings:engine" } },
    { key: "setting:preview", section: "settingsGeneral", title: "Preview pane", subtitle: "Beside the list on screens 1400 px and wider", accessory: doc.preview ? "On" : "Off", primaryLabel: "Toggle", action: { type: "config", op: { op: "set", key: "preview", value: !doc.preview } } },
    { key: "setting:currency", section: "settingsGeneral", title: "Currency rates", subtitle: "Downloads ECB reference rates once a day", accessory: doc.currency ? "On" : "Off", primaryLabel: "Toggle", action: { type: "config", op: { op: "set", key: "currency", value: !doc.currency } } },
    { key: "setting:ai", section: "settingsGeneral", title: "Ask agent", subtitle: "Adds an Ask row that hands the query to omarchy agent prompt", accessory: doc.ai ? "On" : "Off", primaryLabel: "Toggle", action: { type: "config", op: { op: "set", key: "ai", value: !doc.ai } } },
    { key: "setting:barButton", section: "settingsGeneral", title: "Bar button", subtitle: ctx.barButton === null ? "No bar slot: disable OmaCast, then enable it on the right" : "", accessory: ctx.barButton === null ? "" : ctx.barButton ? "On" : "Off", primaryLabel: ctx.barButton === null ? "" : "Toggle", action: ctx.barButton === null ? { type: "none" } : { type: "barButton", value: !ctx.barButton } },
    { key: "setting:palette", section: "settingsShortcuts", title: "Open palette", subtitle: binds.palette || (ctx.handBound ? "Bound by hand in bindings.lua" : "Not bound"), accessory: binds.palette ? "Keyboard" : "", primaryLabel: binds.palette ? "Change" : "Bind", secondaryLabel: binds.palette ? "Unbind" : "", action: { type: "editChord" }, secondaryAction: { type: "binds", patch: { palette: "" } } },
    { key: "setting:clipboard", section: "settingsShortcuts", title: "Clipboard history on SUPER + CTRL + V", subtitle: "Replaces Omarchy's clipboard manager while on", accessory: binds.clipboard ? "On" : "Off", primaryLabel: "Toggle", action: { type: "binds", patch: { clipboard: !binds.clipboard } } }
  ]
  ;["quicklinks", "snippets", "commands"].forEach(function(kind) {
    specs.push({ key: "setting:" + kind, section: "settingsLibrary", title: scopeTitle("settings:" + kind), subtitle: doc[kind].length + " entries", primaryLabel: "Browse", action: { type: "push", scope: "settings:" + kind } })
  })
  var hidden = DEFAULT_QUICKLINKS.filter(function(link) { return doc.hiddenQuicklinks.indexOf(link.keyword) >= 0 || doc.hiddenQuicklinks.indexOf(link.name.toLowerCase()) >= 0 }).length
  specs.push({ key: "setting:builtins", section: "settingsLibrary", title: "Built-in quicklinks", subtitle: doc.builtinQuicklinks ? (7 - hidden) + " of 7 shown" : "Off", primaryLabel: "Browse", action: { type: "push", scope: "settings:builtins" } })
  specs.push({ key: "setting:dirs", section: "settingsLibrary", title: "Script folders", subtitle: ctx.scriptDir + (doc.scriptDirs.length ? " + " + doc.scriptDirs.length + " more" : ""), primaryLabel: "Browse", action: { type: "push", scope: "settings:scriptDirs" } })
  specs.push({ key: "setting:config", section: "settingsAdvanced", title: "Edit config file", subtitle: ctx.configPath, primaryLabel: "Edit", payload: { kind: "config" } })
  specs.push({ key: "setting:scripts", section: "settingsAdvanced", title: "Scripts folder", subtitle: ctx.scriptDir, primaryLabel: "Open", payload: { kind: "scriptsFolder", path: ctx.scriptDir } })
  return filterSettingsRows(specs, query)
}

function settingsChoiceRows(config, doc, query) {
  return filterSettingsRows(config.quicklinks.map(function(link, index) {
    return { key: "setting:engine:" + index, section: "settingsEntries", title: link.name, subtitle: link.keyword, accessory: link.keyword === doc.searchEngine ? "✓" : "", primaryLabel: "Use", action: { type: "config", op: { op: "set", key: "searchEngine", value: link.keyword }, pop: true } }
  }), query)
}

function settingsBuiltinRows(doc, query) {
  var specs = [{ key: "setting:builtins:enabled", section: "settingsEntries", title: "Use built-in quicklinks", accessory: doc.builtinQuicklinks ? "On" : "Off", primaryLabel: "Toggle", action: { type: "config", op: { op: "set", key: "builtinQuicklinks", value: !doc.builtinQuicklinks } } }]
  DEFAULT_QUICKLINKS.forEach(function(link) {
    var hidden = doc.hiddenQuicklinks.indexOf(link.keyword) >= 0
    specs.push({ key: "setting:builtin:" + link.keyword, section: "settingsEntries", title: link.name, subtitle: link.keyword + " · " + link.url, accessory: hidden ? "Off" : "On", primaryLabel: "Toggle", action: { type: "config", op: { op: "toggleHidden", keyword: link.keyword } } })
  })
  return filterSettingsRows(specs, query)
}

function settingsListRows(doc, kind, query) {
  if (!Object.prototype.hasOwnProperty.call(LIST_KINDS, kind)) return []
  var specs = doc[kind].map(function(entry, index) {
    var detail = kind === "quicklinks" ? entry.url : kind === "snippets" ? firstLine(entry.text) : entry.command
    return { key: "setting:" + kind + ":" + index, section: "settingsEntries", title: entry.name || "(unnamed)", subtitle: entry.keyword + " · " + detail, primaryLabel: "Edit", action: { type: "push", scope: "settings:" + kind + ":" + index } }
  })
  specs.push({ key: "setting:" + kind + ":add", section: "settingsEntries", title: "Add " + LIST_KINDS[kind].label, primaryLabel: "Add", action: { type: "config", op: { op: "add", kind: kind }, pushIndex: true } })
  return filterSettingsRows(specs, query)
}

function settingsEntryRows(doc, kind, index, query) {
  if (!Object.prototype.hasOwnProperty.call(LIST_KINDS, kind) || !Number.isInteger(index) || index < 0 || index >= doc[kind].length) return []
  var entry = doc[kind][index]
  var labels = { name: "Name", keyword: "Keyword", url: "URL", text: "Text", command: "Command", terminal: "Run in a terminal", confirm: "Ask before running" }
  var specs = LIST_KINDS[kind].fields.map(function(field) {
    var current = entry[field]
    var boolean = field === "terminal" || field === "confirm"
    var value = field === "text" ? escapeMultiline(current) : current
    return { key: "setting:" + kind + ":" + index + ":" + field, section: "settingsFields", title: labels[field], subtitle: boolean ? "" : value || "(empty)", accessory: boolean ? current ? "On" : "Off" : "", primaryLabel: boolean ? "Toggle" : "Edit", action: boolean
      ? { type: "config", op: { op: "setField", kind: kind, index: index, field: field, value: !current } }
      : { type: "editField", kind: kind, index: index, field: field, label: labels[field], value: value } }
  })
  specs.push({ key: "setting:" + kind + ":" + index + ":delete", section: "settingsFields", title: "Delete " + LIST_KINDS[kind].label, primaryLabel: "Delete", confirm: true, action: { type: "config", op: { op: "remove", kind: kind, index: index }, pop: true } })
  return filterSettingsRows(specs, query)
}

function settingsDirRows(doc, scriptDir, query) {
  var specs = [{ key: "setting:dir:default", section: "settingsEntries", title: scriptDir, subtitle: "Always included", primaryLabel: "Open", payload: { kind: "scriptsFolder", path: scriptDir } }]
  doc.scriptDirs.forEach(function(path, index) {
    specs.push({ key: "setting:dir:" + index, section: "settingsEntries", title: path, primaryLabel: "Edit", secondaryLabel: "Remove", action: { type: "editDir", index: index, value: path }, secondaryAction: { type: "config", op: { op: "removeDir", index: index } } })
  })
  specs.push({ key: "setting:dir:add", section: "settingsEntries", title: "Add folder", primaryLabel: "Add", action: { type: "editDir", index: -1, value: "~/" } })
  return filterSettingsRows(specs, query)
}

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

function scopeTitle(scope, doc) {
  if (isSettingsScope(scope)) {
    var parts = String(scope).split(":")
    if (!parts[1]) return "Settings"
    var kind = parts[1]
    if (Object.prototype.hasOwnProperty.call(LIST_KINDS, kind) && parts[2] !== undefined) {
      var entry = doc && doc[kind] && doc[kind][parseInt(parts[2], 10)]
      return entry && entry.name || LIST_KINDS[kind].label
    }
    return { engine: "Search engine", builtins: "Built-in quicklinks", quicklinks: "Quicklinks", snippets: "Snippets", commands: "Commands", scriptDirs: "Script folders" }[kind] || "Settings"
  }
  if (scope === "hidden") return "Hidden"
  for (var i = 0; i < SCOPE_ROWS.length; i++) {
    if (SCOPE_ROWS[i].scope === scope) return SCOPE_ROWS[i].name
  }
  return ""
}

function scopePlaceholder(scope) {
  if (isSettingsScope(scope)) return "Filter settings…"
  if (scope === "clipboard") return "Search clipboard history…"
  if (scope === "emoji") return "Search emoji…"
  if (scope === "files") return "Search files in your home…"
  if (scope === "content") return "Search inside files in your home…"
  if (scope === "windows") return "Search open windows…"
  if (scope === "kill") return "Search your processes…"
  if (scope === "hidden") return "Search hidden rows…"
  if (scope === "help") return "Search prefixes and keywords…"
  if (String(scope || "").indexOf("menu:") === 0) return "Search this menu…"
  return "Search apps, windows, actions…  ? for keywords"
}

// Rows the user hid, resolved against the unfiltered catalog. A key whose
// row is gone (an uninstalled app) still shows, so it can be unhidden.
function hiddenRows(byKey, state, query) {
  var list = normalizeState(state).hidden
  var catalog = byKey || ({})
  var out = []
  for (var i = 0; i < list.length; i++) {
    var key = list[i]
    var source = catalog[key]
    var title = source ? source.title : key
    if (matchScore(query, { name: title, aliases: [key] }) < 0 && String(query || "").trim()) continue
    out.push(row({
      key: "hidden:" + key,
      section: "hidden",
      title: title,
      subtitle: source ? source.subtitle : "No longer installed",
      icon: source ? source.icon : ICON_EYE,
      primaryLabel: "Unhide",
      order: i,
      payload: { kind: "unhide", key: key, target: source ? source.payload : null }
    }))
  }
  return out
}

// ---- Dates and times
//
// Everything local is plain synchronous Date. Converting between zones goes
// through `date`, because Quickshell's JS engine has no Intl and
// toLocaleString ignores `timeZone`: timeZoneRequest() describes the question,
// Sources.qml asks `date`, timeZoneRows() renders the answer.

var DAY_MS = 86400000
var MONTH_NAMES = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"]
var DAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"]

function startOfDay(ms) {
  var d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

function titleCase(text) {
  return String(text || "").replace(/(^|[\s_\/-])([a-z])/g, function(all, lead, ch) { return lead + ch.toUpperCase() })
}

function shortMonth(index) {
  return titleCase(MONTH_NAMES[index].slice(0, 3))
}

function formatDay(date) {
  return WEEKDAYS[date.getDay()].slice(0, 3) + " " + date.getDate() + " " + shortMonth(date.getMonth()) + " " + date.getFullYear()
}

function monthIndex(token) {
  var t = lower(token).replace(/\.$/, "")
  if (t.length < 3) return -1
  for (var i = 0; i < MONTH_NAMES.length; i++) if (MONTH_NAMES[i].indexOf(t) === 0) return i
  return -1
}

function weekdayIndex(token) {
  return DAY_NAMES.indexOf(lower(token))
}

function makeDate(year, month, day) {
  var d = new Date(year, month, day)
  return d.getMonth() === month && d.getDate() === day ? d : null
}

function nextWeekday(today, target) {
  var ahead = (target - today.getDay() + 7) % 7
  if (ahead === 0) ahead = 7
  return new Date(today.getFullYear(), today.getMonth(), today.getDate() + ahead)
}

// `rollForward` is for questions about the future: `days until dec 25` asked
// on December 26th means next year's.
function parseDay(text, now, rollForward) {
  var t = lower(text).trim().replace(/\s+/g, " ")
  var today = startOfDay(now)
  if (t === "today" || t === "now") return today
  if (t === "tomorrow") return new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1)
  if (t === "yesterday") return new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1)

  var m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)
  if (m) return makeDate(Number(m[1]), Number(m[2]) - 1, Number(m[3]))

  var month = -1
  var day = -1
  var year = -1
  m = t.match(/^([a-z]+\.?) (\d{1,2})(?:st|nd|rd|th)?(?:,? (\d{4}))?$/)
  if (m && monthIndex(m[1]) >= 0) {
    month = monthIndex(m[1]); day = Number(m[2]); year = m[3] ? Number(m[3]) : -1
  } else {
    m = t.match(/^(\d{1,2})(?:st|nd|rd|th)? ([a-z]+\.?)(?:,? (\d{4}))?$/)
    if (m && monthIndex(m[2]) >= 0) { month = monthIndex(m[2]); day = Number(m[1]); year = m[3] ? Number(m[3]) : -1 }
  }
  if (month >= 0) {
    var date = makeDate(year >= 0 ? year : today.getFullYear(), month, day)
    if (date && year < 0 && rollForward && date < today) date = makeDate(today.getFullYear() + 1, month, day)
    return date
  }

  m = t.match(/^(?:next )?([a-z]+)$/)
  if (m && weekdayIndex(m[1]) >= 0) return nextWeekday(today, weekdayIndex(m[1]))
  return null
}

function periodUnit(token) {
  var t = lower(token)
  if (/^(d|days?)$/.test(t)) return "d"
  if (/^(w|wks?|weeks?)$/.test(t)) return "w"
  if (/^(mo|mos|months?)$/.test(t)) return "m"
  if (/^(y|yrs?|years?)$/.test(t)) return "y"
  return ""
}

// Months and years clamp to the end of the month: Jan 31 + 1 month is Feb
// 28 (or 29), never March 3rd.
function addPeriod(date, amount, unit) {
  var y = date.getFullYear()
  var mo = date.getMonth()
  var d = date.getDate()
  if (unit === "d") return new Date(y, mo, d + amount)
  if (unit === "w") return new Date(y, mo, d + amount * 7)
  var target = new Date(y, mo + (unit === "y" ? amount * 12 : amount), 1)
  var last = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate()
  return new Date(target.getFullYear(), target.getMonth(), Math.min(d, last))
}

function dayCount(days) {
  return Math.abs(days) === 1 ? days + " day" : days + " days"
}

function dateAnswer(input, now) {
  var s = lower(input).trim().replace(/\s+/g, " ")
  if (!s) return null

  if (s === "now" || s === "unix time" || s === "timestamp") {
    var seconds = String(Math.floor(now / 1000))
    return { display: seconds, copyText: seconds, subtitle: "Unix time", icon: ICON_CLOCK }
  }

  if (/^(\d{10}|\d{13})$/.test(s)) {
    var stamp = new Date(s.length === 10 ? Number(s) * 1000 : Number(s))
    var local = formatDate(stamp, "yyyy-MM-dd HH:mm:ss")
    return { display: WEEKDAYS[stamp.getDay()].slice(0, 3) + " " + local, copyText: local, subtitle: "Unix time " + s + ", in your time zone", icon: ICON_CLOCK }
  }

  var m = s.match(/^(?:how many )?days? (until|till|til|to|since|from) (.+?)\??$/)
  if (m) {
    var future = m[1] !== "since" && m[1] !== "from"
    var target = parseDay(m[2], now, future)
    if (!target) return null
    var diff = Math.round((target - startOfDay(now)) / DAY_MS)
    var count = future ? diff : -diff
    return { display: dayCount(count) + (future ? " until " : " since ") + formatDay(target), copyText: String(count), icon: ICON_CLOCK }
  }

  m = s.match(/^(.+?) ?([+-]) ?(\d{1,5}) ?([a-z]+)$/)
  if (m && periodUnit(m[4])) {
    var base = parseDay(m[1], now, false)
    if (base) {
      var result = addPeriod(base, (m[2] === "-" ? -1 : 1) * Number(m[3]), periodUnit(m[4]))
      return { display: formatDay(result), copyText: formatDate(result, "yyyy-MM-dd"), icon: ICON_CLOCK }
    }
  }

  m = s.match(/^(?:next )?([a-z]+)$/)
  if (m && weekdayIndex(m[1]) >= 0) {
    var next = nextWeekday(startOfDay(now), weekdayIndex(m[1]))
    return { display: formatDay(next), copyText: formatDate(next, "yyyy-MM-dd"), subtitle: "Next " + titleCase(m[1]), icon: ICON_CLOCK }
  }
  return null
}

// City and abbreviation → IANA zone. Abbreviations mean the region, not the
// literal offset: `pst` in July is what people say for Los Angeles time, and
// `date` prints PDT for it.
var ZONE_ABBREVIATIONS = {
  utc: "UTC", gmt: "UTC",
  pst: "America/Los_Angeles", pdt: "America/Los_Angeles", mst: "America/Denver", mdt: "America/Denver",
  cst: "America/Chicago", cdt: "America/Chicago", est: "America/New_York", edt: "America/New_York",
  akst: "America/Anchorage", hst: "Pacific/Honolulu",
  bst: "Europe/London", wet: "Europe/Lisbon", cet: "Europe/Paris", cest: "Europe/Paris",
  eet: "Europe/Athens", eest: "Europe/Athens", msk: "Europe/Moscow",
  ist: "Asia/Kolkata", pkt: "Asia/Karachi", ict: "Asia/Bangkok", wib: "Asia/Jakarta", sgt: "Asia/Singapore",
  hkt: "Asia/Hong_Kong", jst: "Asia/Tokyo", kst: "Asia/Seoul", gst: "Asia/Dubai",
  aest: "Australia/Sydney", aedt: "Australia/Sydney", acst: "Australia/Adelaide", awst: "Australia/Perth",
  nzst: "Pacific/Auckland", nzdt: "Pacific/Auckland", brt: "America/Sao_Paulo", art: "America/Argentina/Buenos_Aires",
  sast: "Africa/Johannesburg", eat: "Africa/Nairobi", wat: "Africa/Lagos"
}

var ZONE_CITIES = {
  london: "Europe/London", manchester: "Europe/London", edinburgh: "Europe/London", dublin: "Europe/Dublin",
  lisbon: "Europe/Lisbon", madrid: "Europe/Madrid", barcelona: "Europe/Madrid", paris: "Europe/Paris",
  brussels: "Europe/Brussels", amsterdam: "Europe/Amsterdam", berlin: "Europe/Berlin", munich: "Europe/Berlin",
  frankfurt: "Europe/Berlin", hamburg: "Europe/Berlin", zurich: "Europe/Zurich", geneva: "Europe/Zurich",
  vienna: "Europe/Vienna", rome: "Europe/Rome", milan: "Europe/Rome", prague: "Europe/Prague",
  warsaw: "Europe/Warsaw", budapest: "Europe/Budapest", stockholm: "Europe/Stockholm", oslo: "Europe/Oslo",
  copenhagen: "Europe/Copenhagen", helsinki: "Europe/Helsinki", athens: "Europe/Athens", bucharest: "Europe/Bucharest",
  istanbul: "Europe/Istanbul", kyiv: "Europe/Kyiv", kiev: "Europe/Kyiv", moscow: "Europe/Moscow",
  reykjavik: "Atlantic/Reykjavik", cairo: "Africa/Cairo", lagos: "Africa/Lagos", nairobi: "Africa/Nairobi",
  johannesburg: "Africa/Johannesburg", "cape town": "Africa/Johannesburg", casablanca: "Africa/Casablanca",
  dubai: "Asia/Dubai", "abu dhabi": "Asia/Dubai", riyadh: "Asia/Riyadh", doha: "Asia/Qatar",
  "tel aviv": "Asia/Jerusalem", jerusalem: "Asia/Jerusalem", tehran: "Asia/Tehran", karachi: "Asia/Karachi",
  delhi: "Asia/Kolkata", "new delhi": "Asia/Kolkata", mumbai: "Asia/Kolkata", bangalore: "Asia/Kolkata",
  bengaluru: "Asia/Kolkata", kolkata: "Asia/Kolkata", chennai: "Asia/Kolkata", hyderabad: "Asia/Kolkata",
  dhaka: "Asia/Dhaka", kathmandu: "Asia/Kathmandu", bangkok: "Asia/Bangkok", hanoi: "Asia/Bangkok",
  jakarta: "Asia/Jakarta", singapore: "Asia/Singapore", "kuala lumpur": "Asia/Kuala_Lumpur", manila: "Asia/Manila",
  "hong kong": "Asia/Hong_Kong", shanghai: "Asia/Shanghai", beijing: "Asia/Shanghai", shenzhen: "Asia/Shanghai",
  taipei: "Asia/Taipei", seoul: "Asia/Seoul", tokyo: "Asia/Tokyo", osaka: "Asia/Tokyo",
  sydney: "Australia/Sydney", melbourne: "Australia/Melbourne", brisbane: "Australia/Brisbane", perth: "Australia/Perth",
  adelaide: "Australia/Adelaide", auckland: "Pacific/Auckland", wellington: "Pacific/Auckland", honolulu: "Pacific/Honolulu",
  anchorage: "America/Anchorage", "los angeles": "America/Los_Angeles", la: "America/Los_Angeles",
  "san francisco": "America/Los_Angeles", sf: "America/Los_Angeles", seattle: "America/Los_Angeles",
  vancouver: "America/Vancouver", denver: "America/Denver", phoenix: "America/Phoenix", chicago: "America/Chicago",
  dallas: "America/Chicago", houston: "America/Chicago", austin: "America/Chicago", toronto: "America/Toronto",
  montreal: "America/Toronto", "new york": "America/New_York", nyc: "America/New_York", boston: "America/New_York",
  washington: "America/New_York", miami: "America/New_York", atlanta: "America/New_York",
  "mexico city": "America/Mexico_City", bogota: "America/Bogota", lima: "America/Lima", santiago: "America/Santiago",
  "buenos aires": "America/Argentina/Buenos_Aires", "sao paulo": "America/Sao_Paulo", "rio de janeiro": "America/Sao_Paulo"
}

var IANA_ZONE = /^[a-z]+(?:\/[a-z_-]+){1,2}$/

// Returns { zone, label } or null. A typed IANA name is re-cased, since the
// query was lowercased before it got here.
function resolveZone(token) {
  var t = lower(token).trim().replace(/\s+/g, " ")
  if (!t) return null
  if (ZONE_ABBREVIATIONS[t]) return { zone: ZONE_ABBREVIATIONS[t], label: t.toUpperCase() }
  if (ZONE_CITIES[t]) return { zone: ZONE_CITIES[t], label: t.length <= 3 ? t.toUpperCase() : titleCase(t) }
  if (IANA_ZONE.test(t)) {
    var zone = titleCase(t)
    return { zone: zone, label: zone }
  }
  return null
}

// `3pm`, `3:30 pm`, `15:30`, `noon`. A bare `3` is a number, not a time.
function parseClock(text) {
  var t = lower(text).trim()
  if (t === "noon" || t === "midday") return { h: 12, m: 0 }
  if (t === "midnight") return { h: 0, m: 0 }
  var m = t.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?$/)
  if (!m) return null
  var h = Number(m[1])
  var min = m[2] ? Number(m[2]) : 0
  var suffix = m[3] ? m[3].charAt(0) : ""
  if (!suffix && !m[2]) return null
  if (min > 59) return null
  if (suffix) {
    if (h < 1 || h > 12) return null
    if (suffix === "p" && h < 12) h += 12
    if (suffix === "a" && h === 12) h = 0
  } else if (h > 23) {
    return null
  }
  return { h: h, m: min }
}

function zoneList(text) {
  var parts = String(text || "").split(/\s*,\s*|\s+and\s+/)
  var zones = []
  var labels = []
  for (var i = 0; i < parts.length; i++) {
    var resolved = resolveZone(parts[i])
    if (!resolved) return null
    zones.push(resolved.zone)
    labels.push(resolved.label)
  }
  return zones.length ? { zones: zones, labels: labels } : null
}

// `3pm ist` splits into a clock and a source zone at whichever space works.
function clockAndZone(text) {
  var clock = parseClock(text)
  if (clock) return { clock: clock, source: null }
  var words = text.split(" ")
  for (var i = words.length - 1; i >= 1; i--) {
    var c = parseClock(words.slice(0, i).join(" "))
    if (!c) continue
    var zone = resolveZone(words.slice(i).join(" "))
    return zone ? { clock: c, source: zone } : null
  }
  return null
}

// Describes a time zone question for Sources.qml, or returns null. `epoch`
// is set when the instant is known here (now, or a local wall time);
// otherwise `source` + `wall` ask `date` to place a wall time in a zone.
function timeZoneRequest(query, now) {
  var q = lower(query).trim().replace(/\s+/g, " ")
  if (!q) return null

  var targets = null
  var parts = null
  var m = q.match(/^(?:now|time|current time|what time is it|what's the time)\s+(?:in|at)\s+(.+?)\??$/)
  if (m) {
    targets = zoneList(m[1])
  } else if ((m = q.match(/^(.+?) time\??$/))) {
    targets = zoneList(m[1])
  } else if ((m = q.match(/^(.+?) (?:in|to|as) (.+?)\??$/))) {
    parts = clockAndZone(m[1])
    if (!parts) return null
    targets = zoneList(m[2])
  }
  if (!targets) return null

  var request = { key: q, zones: targets.zones, labels: targets.labels, epoch: -1, source: "", sourceLabel: "", wall: "", clock: "" }
  if (!parts) {
    request.epoch = Math.floor(now / 1000)
    return request
  }

  var today = new Date(now)
  request.clock = pad(parts.clock.h, 2) + ":" + pad(parts.clock.m, 2)
  if (!parts.source) {
    request.epoch = Math.floor(new Date(today.getFullYear(), today.getMonth(), today.getDate(), parts.clock.h, parts.clock.m).getTime() / 1000)
  } else {
    request.source = parts.source.zone
    request.sourceLabel = parts.source.label
    request.wall = formatDate(today, "yyyy-MM-dd") + " " + request.clock
  }
  return request
}

// argv for the one `date` batch that answers a request.
function timeZoneCommand(request) {
  var script = 'e=$1; src=$2; wall=$3; shift 3; if [ -n "$src" ]; then e=$(TZ=$src date -d "$wall" +%s) || exit 1; fi; for z in "$@"; do TZ=$z date -d "@$e" "+%Y-%m-%d %H:%M %Z"; done'
  return ["bash", "-c", script, "bash", String(request.epoch), request.source, request.wall].concat(request.zones)
}

function timeZoneRows(request, output) {
  if (!request) return []
  var lines = String(output || "").split("\n")
  var out = []
  for (var i = 0; i < request.zones.length; i++) {
    var m = String(lines[i] || "").match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}:\d{2}) (\S+)$/)
    if (!m) continue
    var day = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
    var time = m[4] + " " + m[5]
    var from = request.source ? " · from " + request.clock + " " + request.sourceLabel : (request.clock ? " · from " + request.clock + " here" : "")
    out.push(row({
      key: "tz:" + request.zones[i],
      section: "answer",
      title: time + "  ·  " + WEEKDAYS[day.getDay()].slice(0, 3) + " " + day.getDate() + " " + shortMonth(day.getMonth()),
      subtitle: request.labels[i] + from,
      icon: ICON_CLOCK,
      primaryLabel: "Copy",
      score: 1.5,
      order: i,
      payload: { kind: "answer", copyText: time, expression: request.key }
    }))
  }
  return out
}

// ---- Colours

function clampByte(value) {
  return Math.max(0, Math.min(255, Math.round(value)))
}

function hslToRgb(h, s, l) {
  var hue = ((h % 360) + 360) % 360 / 360
  var sat = s / 100
  var light = l / 100
  if (sat === 0) return { r: clampByte(light * 255), g: clampByte(light * 255), b: clampByte(light * 255) }
  var q = light < 0.5 ? light * (1 + sat) : light + sat - light * sat
  var p = 2 * light - q
  function channel(t) {
    var v = t < 0 ? t + 1 : (t > 1 ? t - 1 : t)
    if (v < 1 / 6) return p + (q - p) * 6 * v
    if (v < 1 / 2) return q
    if (v < 2 / 3) return p + (q - p) * (2 / 3 - v) * 6
    return p
  }
  return { r: clampByte(channel(hue + 1 / 3) * 255), g: clampByte(channel(hue) * 255), b: clampByte(channel(hue - 1 / 3) * 255) }
}

function rgbToHsl(r, g, b) {
  var rn = r / 255
  var gn = g / 255
  var bn = b / 255
  var max = Math.max(rn, gn, bn)
  var min = Math.min(rn, gn, bn)
  var l = (max + min) / 2
  var h = 0
  var s = 0
  if (max !== min) {
    var d = max - min
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0)
    else if (max === gn) h = (bn - rn) / d + 2
    else h = (rn - gn) / d + 4
    h *= 60
  }
  return { h: Math.round(h) % 360, s: Math.round(s * 100), l: Math.round(l * 100) }
}

function parseColour(input) {
  var s = lower(input).trim()
  var m = s.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/)
  if (m) {
    var hex = m[1].length === 3 ? m[1].replace(/(.)/g, "$1$1") : m[1]
    return { r: parseInt(hex.slice(0, 2), 16), g: parseInt(hex.slice(2, 4), 16), b: parseInt(hex.slice(4, 6), 16) }
  }
  m = s.match(/^rgba?\(\s*(\d{1,3})\s*[,\s]\s*(\d{1,3})\s*[,\s]\s*(\d{1,3})\s*(?:[,\/]\s*[\d.]+%?\s*)?\)$/)
  if (m) {
    var r = Number(m[1]), g = Number(m[2]), b = Number(m[3])
    if (r > 255 || g > 255 || b > 255) return null
    return { r: r, g: g, b: b }
  }
  m = s.match(/^hsla?\(\s*(\d{1,3}(?:\.\d+)?)(?:deg)?\s*[,\s]\s*(\d{1,3}(?:\.\d+)?)%\s*[,\s]\s*(\d{1,3}(?:\.\d+)?)%\s*(?:[,\/]\s*[\d.]+%?\s*)?\)$/)
  if (m) {
    if (Number(m[2]) > 100 || Number(m[3]) > 100) return null
    return hslToRgb(Number(m[1]), Number(m[2]), Number(m[3]))
  }
  return null
}

// Three answers for one colour, each carrying the swatch the row draws.
function colourAnswers(input) {
  var c = parseColour(input)
  if (!c) return []
  var hex = "#" + pad(c.r.toString(16), 2) + pad(c.g.toString(16), 2) + pad(c.b.toString(16), 2)
  var hsl = rgbToHsl(c.r, c.g, c.b)
  var values = [
    { display: hex, subtitle: "HEX" },
    { display: "rgb(" + c.r + ", " + c.g + ", " + c.b + ")", subtitle: "RGB" },
    { display: "hsl(" + hsl.h + ", " + hsl.s + "%, " + hsl.l + "%)", subtitle: "HSL" }
  ]
  for (var i = 0; i < values.length; i++) {
    values[i].copyText = values[i].display
    values[i].swatch = hex
    values[i].icon = ICON_BRUSH
  }
  return values
}

// ---- Reminders (omarchy reminder <minutes> "<text>")

function durationLabel(minutes) {
  if (minutes < 60) return minutes + " min"
  var h = Math.floor(minutes / 60)
  var m = minutes % 60
  return h + " h" + (m ? " " + m + " min" : "")
}

function reminderRows(query, now) {
  var q = String(query || "").trim().replace(/\s+/g, " ")
  var m = q.match(/^remind(?: me)?(?: ([\s\S]*))?$/i)
  if (!m) return []
  var rest = String(m[1] || "").trim()
  var minutes = 0
  var text = ""
  var when = ""

  var abs = rest.match(/^at (\d{1,2})(?::(\d{2}))? ?(am|pm)?(?: (?:to )?([\s\S]*))?$/i)
  var rel = rest.match(/^(?:in )?(\d{1,4}) ?(m|mins?|minutes?|h|hrs?|hours?)?(?: (?:to )?([\s\S]*))?$/i)
  if (abs) {
    var clock = parseClock(abs[1] + (abs[2] ? ":" + abs[2] : "") + (abs[3] || (abs[2] ? "" : ":00")))
    if (clock) {
      var base = new Date(now)
      var target = new Date(base.getFullYear(), base.getMonth(), base.getDate(), clock.h, clock.m)
      if (target.getTime() <= now) target = new Date(base.getFullYear(), base.getMonth(), base.getDate() + 1, clock.h, clock.m)
      minutes = Math.max(1, Math.ceil((target.getTime() - now) / 60000))
      when = "at " + pad(clock.h, 2) + ":" + pad(clock.m, 2) + " (in " + durationLabel(minutes) + ")"
      text = String(abs[4] || "").trim()
    }
  } else if (rel) {
    var amount = Number(rel[1])
    minutes = /^h/i.test(rel[2] || "") ? amount * 60 : amount
    when = "in " + durationLabel(minutes)
    text = String(rel[3] || "").trim()
  }

  if (minutes < 1) {
    var pending = rest.replace(/^to /i, "")
    return [row({
      key: "remind:pending",
      section: "answer",
      title: pending ? "Remind: " + pending : "Remind me…",
      subtitle: "needs a time, as in  remind 30 check the oven",
      icon: ICON_BELL,
      primaryLabel: "Needs a time",
      score: 1,
      payload: { kind: "reminder", disabled: true }
    })]
  }

  return [row({
    key: "remind:" + minutes + ":" + text,
    section: "answer",
    title: "Remind " + when + (text ? ": " + text : ""),
    subtitle: "omarchy reminder",
    icon: ICON_BELL,
    primaryLabel: "Set reminder",
    score: 3,
    payload: { kind: "reminder", minutes: minutes, text: text, disabled: false }
  })]
}

// ---- Processes (the `kill ` scope)
//
// Sources.qml prints the shell's own pid, its parent and its own helper pid
// on the first line, then `ps -o pid=,pcpu=,pmem=,comm=`. Those pids are the
// ones a slip of the Enter key must never reach.
function parseProcesses(text) {
  var lines = String(text || "").split("\n")
  var skip = ({})
  var first = String(lines[0] || "").trim().split(/\s+/)
  for (var s = 0; s < first.length; s++) if (first[s]) skip[first[s]] = true

  var out = []
  for (var i = 1; i < lines.length; i++) {
    var m = lines[i].match(/^\s*(\d+)\s+([\d.]+)\s+([\d.]+)\s+(.+?)\s*$/)
    if (!m || skip[m[1]]) continue
    out.push({ pid: m[1], cpu: Number(m[2]), mem: Number(m[3]), comm: m[4] })
  }
  return out
}

function processRows(processes, query) {
  var values = processes || []
  var terms = lower(query).trim() ? lower(query).trim().split(/\s+/) : []
  var out = []
  for (var i = 0; i < values.length; i++) {
    var proc = values[i]
    var haystack = lower(proc.comm) + " " + proc.pid
    var matched = true
    for (var t = 0; t < terms.length; t++) {
      if (haystack.indexOf(terms[t]) < 0) { matched = false; break }
    }
    if (!matched) continue
    out.push(row({
      key: "proc:" + proc.pid,
      section: "processes",
      title: proc.comm,
      subtitle: proc.pid + " · " + proc.cpu.toFixed(1) + "% cpu · " + proc.mem.toFixed(1) + "% mem",
      icon: ICON_PROCESS,
      confirm: true,
      primaryLabel: "Terminate",
      secondaryLabel: "Kill",
      order: i,
      payload: { kind: "process", pid: proc.pid, comm: proc.comm }
    }))
  }
  return out
}

// ---- `omarchy commands --json`
//
// Only commands that take no arguments and no sudo can run from a row. A
// command the menu already runs is dropped, so Lock appears once.
var CATALOG_CONFIRM = /\b(remove|reinstall|refresh|reboot|shutdown|logout|close all|restart shell)\b/

function parseCommandCatalog(text) {
  var parsed = parseJson(text)
  var list = parsed && Array.isArray(parsed.commands) ? parsed.commands : []
  var out = []
  for (var i = 0; i < list.length; i++) {
    var c = list[i]
    if (!c || c.args !== "" || c.requires_sudo !== false || c.hidden === true) continue
    if (typeof c.route !== "string" || c.route.indexOf("omarchy ") !== 0) continue
    out.push({ route: c.route, binary: String(c.binary || ""), summary: String(c.summary || c.route) })
  }
  return out
}

function buildCommandCatalog(commands, menuIndex) {
  var actions = ({})
  var index = menuIndex || []
  for (var m = 0; m < index.length; m++) if (index[m].action) actions[String(index[m].action).trim()] = true

  var values = commands || []
  var out = []
  for (var i = 0; i < values.length; i++) {
    var c = values[i]
    if (actions[c.route] || (c.binary && actions[c.binary])) continue
    var short = c.route.slice("omarchy ".length)
    out.push({
      route: c.route,
      summary: c.summary,
      // The route is the name; the summary is prose and only matches as a
      // substring, or scattered letters would admit every long summary.
      fields: prepareFields(short, [c.route], c.summary),
      confirm: CATALOG_CONFIRM.test(short)
    })
  }
  return out
}

function commandCatalogRows(catalog, query, usage, now, all) {
  var values = catalog || []
  var q = String(query || "").trim()
  if (!q && !all) return []
  var out = []
  for (var i = 0; i < values.length; i++) {
    var c = values[i]
    var score = all ? 0 : matchScore(q, c.fields)
    if (score < 0) continue
    var key = "oc:" + c.route
    out.push(row({
      key: key,
      section: "actions",
      title: firstLine(c.summary).replace(/\.$/, ""),
      subtitle: c.route,
      icon: ICON_COMMAND,
      frecencyKey: key,
      pinnable: true,
      confirm: c.confirm,
      primaryLabel: "Run",
      score: score + frecencyBonus(usage, key, now),
      order: i,
      payload: { kind: "omarchyCommand", route: c.route, preview: { type: "text", text: c.route + "\n\n" + c.summary } }
    }))
  }
  return out
}

// ---- Themes (`omarchy theme current`, a `---` line, `omarchy theme list`)

function parseThemes(text) {
  var lines = String(text || "").split("\n")
  var cut = lines.indexOf("---")
  var current = cut > 0 ? lines[0].trim() : ""
  var names = []
  for (var i = cut + 1; i < lines.length; i++) {
    var name = lines[i].trim()
    if (name) names.push(name)
  }
  return { current: current, names: names }
}

function themeRows(themes, query, usage, now, all) {
  var data = themes || ({ current: "", names: [] })
  var q = String(query || "").trim()
  if (!q && !all) return []
  var out = []
  for (var i = 0; i < data.names.length; i++) {
    var name = data.names[i]
    var score = all ? 0 : matchScore(q, { name: "Theme: " + name, aliases: ["theme " + name, name] })
    if (score < 0) continue
    var key = "theme:" + name
    var isCurrent = lower(name) === lower(data.current)
    out.push(row({
      key: key,
      section: "actions",
      title: "Theme: " + name,
      subtitle: isCurrent ? "Current theme" : "omarchy theme set",
      icon: ICON_BRUSH,
      accessory: isCurrent ? "✓" : "",
      frecencyKey: key,
      pinnable: true,
      primaryLabel: "Apply",
      score: score + frecencyBonus(usage, key, now),
      order: i,
      payload: { kind: "theme", name: name }
    }))
  }
  return out
}

// ---- Opt-in AI hand-off (omarchy agent prompt)

function aiRows(query, agent) {
  var q = String(query || "").trim()
  if (!q) return []
  var ask = q.match(/^ask\s+([\s\S]+)$/i)
  var prompt = ask ? ask[1].trim() : q
  if (!ask && q.split(/\s+/).length < 3) return []
  var name = String(agent || "").trim() || "agent"
  return [row({
    key: "ai:ask",
    section: "web",
    title: "Ask " + name,
    subtitle: clip(flatten(prompt), 120),
    icon: ICON_CHAT,
    primaryLabel: "Ask",
    score: 1,
    payload: { kind: "ai", prompt: prompt, preview: { type: "text", text: prompt } }
  })]
}

// ---- Script commands (Raycast's header format)
//
// A script is any file in the scripts folder whose header carries
// `@raycast.schemaVersion 1` and `@raycast.title`, commented with `#`, `//`
// or `--`. Everything else is ignored, so a README in the folder is harmless.

var SCRIPT_MODES = ["silent", "compact", "fullOutput", "inline"]
var SCRIPT_OUTPUT_LIMIT = 65536

function parseRefresh(value) {
  var m = String(value || "").trim().match(/^(\d+)\s*([smhd])$/)
  if (!m) return 0
  var ms = Number(m[1]) * ({ s: 1000, m: 60000, h: 3600000, d: 86400000 })[m[2]]
  return Math.max(10000, ms)
}

function parseScriptCommand(text) {
  var lines = String(text || "").split("\n")
  var meta = ({})
  var args = []
  var pattern = /^\s*(?:#|\/\/|--)\s*@raycast\.([A-Za-z0-9]+)\s*(.*?)\s*$/

  for (var i = 0; i < lines.length; i++) {
    var m = lines[i].match(pattern)
    if (!m) continue
    var arg = m[1].match(/^argument([123])$/)
    if (arg) {
      var spec = parseJson(m[2])
      if (spec) {
        args[Number(arg[1]) - 1] = {
          type: String(spec.type || "text"),
          placeholder: String(spec.placeholder || "argument" + arg[1]),
          optional: spec.optional === true,
          percentEncoded: spec.percentEncoded === true
        }
      }
      continue
    }
    meta[m[1]] = m[2]
  }

  if (String(meta.schemaVersion) !== "1" || !meta.title) return null
  var compact = []
  for (var a = 0; a < args.length; a++) if (args[a]) compact.push(args[a])
  var icon = String(meta.icon || "")
  return {
    title: clip(meta.title, 200),
    mode: SCRIPT_MODES.indexOf(meta.mode) >= 0 ? meta.mode : "fullOutput",
    packageName: String(meta.packageName || ""),
    // Raycast also takes paths and URLs; only an emoji means anything here.
    icon: /^[^\x00-\x7f]{1,8}$/.test(icon) ? icon : "",
    arguments: compact,
    needsConfirmation: meta.needsConfirmation === "true",
    refreshMs: meta.mode === "inline" ? parseRefresh(meta.refreshTime) : 0
  }
}

// Records are `\x1e<path>\x1f<0|1 executable>\x1f<head of file>`.
function parseScriptRecords(text) {
  var chunks = String(text || "").split("\x1e")
  var out = []
  for (var i = 1; i < chunks.length; i++) {
    var fields = chunks[i].split("\x1f")
    if (fields.length < 3) continue
    var meta = parseScriptCommand(fields.slice(2).join("\x1f"))
    if (!meta) continue
    var stem = basename(fields[0]).replace(/\.[^.]+$/, "")
    out.push({ path: fields[0], executable: fields[1] === "1", keyword: lower(stem).replace(/\s+/g, "-"), meta: meta })
  }
  return out
}

function scriptKeywordEntries(scripts) {
  var values = scripts || []
  var out = []
  for (var i = 0; i < values.length; i++) out.push({ keyword: values[i].keyword, name: values[i].meta.title })
  return out
}

// Whitespace-separated, with "double quotes" keeping spaces together.
function splitArguments(text) {
  var out = []
  var pattern = /"([^"]*)"|(\S+)/g
  var m
  while ((m = pattern.exec(String(text || ""))) !== null) out.push(m[1] !== undefined ? m[1] : m[2])
  return out
}

function shellQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'"
}

function scriptRows(scripts, query, usage, now, inline, all) {
  var values = scripts || []
  var outputs = inline || ({})
  var q = String(query || "").trim()
  if (!q && !all) return []
  var out = []

  for (var i = 0; i < values.length; i++) {
    var script = values[i]
    var meta = script.meta
    var admission = all ? { direct: false, argument: "", score: 0 } : keywordAdmission(q, meta.title, script.keyword)
    if (!admission) continue

    var typed = admission.direct ? splitArguments(admission.argument) : []
    var args = []
    var missing = ""
    for (var a = 0; a < meta.arguments.length; a++) {
      var spec = meta.arguments[a]
      var value = typed[a] !== undefined ? typed[a] : ""
      if (!value && !spec.optional && !missing) missing = spec.placeholder
      args.push(spec.percentEncoded ? encodeURIComponent(value) : value)
    }

    var placeholders = meta.arguments.map(function(spec) { return "<" + spec.placeholder + ">" }).join(" ")
    var completing = !admission.direct && meta.arguments.length > 0 && missing !== "" && script.executable
    var disabled = !script.executable || (admission.direct && missing !== "")
    var key = "sc:" + script.path
    var subtitle = !script.executable
      ? "not executable"
      : (meta.mode === "inline" && outputs[script.path] ? outputs[script.path] : script.keyword + (placeholders ? " " + placeholders : ""))
    var primary = !script.executable ? "Not executable" : (completing ? "Type keyword" : (disabled ? "Needs " + missing : "Run"))

    out.push(row({
      key: key,
      section: "commands",
      promoted: admission.direct,
      title: meta.title + (admission.direct && typed.length ? ": " + typed.join(" ") : ""),
      subtitle: subtitle,
      icon: meta.icon || ICON_CODE,
      keyword: script.keyword,
      frecencyKey: key,
      pinnable: true,
      confirm: meta.needsConfirmation && !disabled && !completing,
      primaryLabel: primary,
      score: admission.score + frecencyBonus(usage, key, now),
      order: i,
      payload: {
        kind: "script", path: script.path, mode: meta.mode, title: meta.title, args: args,
        keyword: script.keyword, complete: completing, disabled: disabled && !completing,
        preview: { type: "file", path: script.path }
      }
    }))
  }
  return out
}

function lastLine(text) {
  var lines = String(text || "").split("\n")
  for (var i = lines.length - 1; i >= 0; i--) if (lines[i].trim()) return lines[i].trim()
  return ""
}

// ---- Actions panel (Ctrl+K)
//
// The first two entries are always the row's primary and secondary, so the
// footer and the panel never disagree about what Enter does.
function rowActions(item, state) {
  if (!item) return []
  var p = item.payload || ({})
  var current = normalizeState(state)
  var out = [{ id: "primary", label: item.primaryLabel, shortcut: "↵" }]
  if (item.secondaryLabel) out.push({ id: "secondary", label: item.secondaryLabel, shortcut: "Ctrl+↵" })
  function add(id, label, shortcut) { out.push({ id: id, label: label, shortcut: shortcut || "" }) }

  if (p.kind === "app") add("copy-id", "Copy desktop id")
  else if (p.kind === "menu" && p.action) add("copy-command", "Copy command")
  else if (p.kind === "keybinding" && p.combo) add("copy-combo", "Copy key combo")
  else if (p.kind === "file") {
    add("copy-path", "Copy path")
    add("terminal-here", "Open terminal here")
    add("reveal", "Reveal in file manager")
  } else if (p.kind === "clipboard") add("delete-entry", "Delete from history", "⌦")
  else if (p.kind === "quicklink" && !p.complete) add("copy-url", "Copy URL")
  else if (p.kind === "command") {
    if (!p.terminal) add("run-terminal", "Run in terminal")
    add("copy-command", "Copy command")
  } else if (p.kind === "answer") add("copy-expression", "Copy with expression")
  else if (p.kind === "theme") add("preview-theme", "Preview in terminal")
  else if (p.kind === "omarchyCommand") add("copy-command", "Copy command")
  else if (p.kind === "script") {
    if (p.mode !== "fullOutput" && !p.disabled && !p.complete) add("run-terminal", "Run in terminal")
    add("copy-path", "Copy script path")
  }

  if (item.pinnable) add("pin", current.pins.indexOf(item.key) >= 0 ? "Unpin" : "Pin", "Ctrl+.")
  if (item.frecencyKey && current.usage[item.frecencyKey]) add("reset-ranking", "Reset ranking")
  if (p.kind === "app") add("hide", "Hide")
  return out
}

// ---- Currency (opt-in, ECB daily reference rates, EUR base)

var CURRENCY_NAMES = {
  "€": "EUR", eur: "EUR", euro: "EUR", euros: "EUR",
  "$": "USD", usd: "USD", "us$": "USD", dollar: "USD", dollars: "USD", bucks: "USD",
  "£": "GBP", gbp: "GBP", pound: "GBP", pounds: "GBP", quid: "GBP",
  "¥": "JPY", jpy: "JPY", yen: "JPY",
  chf: "CHF", franc: "CHF", francs: "CHF",
  cny: "CNY", yuan: "CNY", rmb: "CNY", renminbi: "CNY",
  "₹": "INR", inr: "INR", rupee: "INR", rupees: "INR",
  "₩": "KRW", krw: "KRW", won: "KRW",
  aud: "AUD", cad: "CAD", nzd: "NZD", hkd: "HKD", sgd: "SGD",
  sek: "SEK", nok: "NOK", dkk: "DKK", isk: "ISK",
  pln: "PLN", zloty: "PLN", czk: "CZK", koruna: "CZK", huf: "HUF", forint: "HUF", ron: "RON", leu: "RON", bgn: "BGN", lev: "BGN",
  try: "TRY", lira: "TRY", brl: "BRL", real: "BRL", reais: "BRL", mxn: "MXN",
  idr: "IDR", rupiah: "IDR", ils: "ILS", shekel: "ILS", shekels: "ILS", myr: "MYR", ringgit: "MYR",
  php: "PHP", thb: "THB", baht: "THB", zar: "ZAR", rand: "ZAR"
}

var CURRENCY_PATTERN = /^([€$£¥₹₩]?)\s*(\d+(?:[.,]\d+)?)\s*([a-z$€£¥₹₩]*)\s+(?:to|in|as|->|→|=)\s+([a-z$€£¥₹₩]+)$/

// { amount, from, to } when the query is shaped like a currency conversion
// between two known currencies, whether or not rates are loaded.
function currencyRequest(input) {
  var m = lower(input).trim().replace(/\s+/g, " ").match(CURRENCY_PATTERN)
  if (!m) return null
  if (m[1] && m[3]) return null
  var from = CURRENCY_NAMES[m[1] || m[3]]
  var to = CURRENCY_NAMES[m[4]]
  if (!from || !to) return null
  var amount = parseFloat(m[2].replace(",", "."))
  return isFinite(amount) ? { amount: amount, from: from, to: to } : null
}

function parseEcbRates(xml) {
  var text = String(xml || "")
  var rates = { EUR: 1 }
  var found = 0
  var pattern = /currency=['"](\w{3})['"]\s+rate=['"]([\d.]+)['"]/g
  var m
  while ((m = pattern.exec(text)) !== null) {
    var value = parseFloat(m[2])
    if (!isFinite(value) || value <= 0) continue
    rates[m[1]] = value
    found += 1
  }
  var date = text.match(/time=['"](\d{4}-\d{2}-\d{2})['"]/)
  return found > 0 ? { date: date ? date[1] : "", rates: rates } : null
}

function convertCurrency(input, rates) {
  var request = currencyRequest(input)
  if (!request || !rates || !rates.rates) return null
  var from = rates.rates[request.from]
  var to = rates.rates[request.to]
  if (!from || !to) return null
  var value = request.amount / from * to
  var text = value.toFixed(value !== 0 && Math.abs(value) < 0.01 ? 4 : 2) + " " + request.to
  var stamp = ""
  var m = String(rates.date || "").match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (m) stamp = "rates " + Number(m[3]) + " " + shortMonth(Number(m[2]) - 1)
  return { display: text, copyText: text, subtitle: stamp || "ECB rates", icon: ICON_MONEY }
}

// ---- Clipboard history edits, same shape the stock clipboard writes

function removeClipboardEntry(raw, historyIndex) {
  var parsed
  try { parsed = JSON.parse(String(raw || "")) } catch (e) { return null }
  if (!Array.isArray(parsed)) return null
  var index = Number(historyIndex)
  if (!(index >= 0 && index < parsed.length) || Math.floor(index) !== index) return null
  parsed.splice(index, 1)
  return JSON.stringify(parsed, null, 2) + "\n"
}

// Text for the preview pane when no process is needed.
function previewText(preview, now) {
  if (!preview) return ""
  if (preview.type === "text") return String(preview.text || "")
  if (preview.type === "snippet") return expandTemplate(preview.template, { argument: preview.argument || "", clipboard: "{clipboard}", selection: "{selection}", now: now }, "text")
  return ""
}

// argv for previews that need a process, or null.
function previewCommand(preview) {
  if (!preview) return null
  // A folder lists its entries; `head` on a directory prints nothing.
  if (preview.type === "file") return ["bash", "-c", 'if [ -d "$1" ]; then ls -1Ap -- "$1" | head -n 200; else head -c ' + PREVIEW_LIMIT + ' -- "$1"; fi', "bash", preview.path]
  if (preview.type === "content") return ["rg", "-n", "-C", "3", "--max-count", "5", "--fixed-strings", "--ignore-case", "--", preview.term, preview.path]
  return null
}

// A NUL in the first 16 KiB is a binary file; printing it is noise.
function cleanPreview(text) {
  var value = String(text || "")
  return value.indexOf("\u0000") >= 0 ? "Binary file" : value
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

// ---- Config (~/.config/omarchy/omacast.json), written by Settings

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

// Built-ins live in code, not in a generated file, so an upgrade can change
// them without touching anyone's config. The cost is that a user needs a way
// to say no to one: `hiddenQuicklinks: ["ddg"]` drops it, and
// `builtinQuicklinks: false` drops the lot.
function normalizeQuicklinks(raw, builtins, hidden) {
  var skip = ({})
  var hiddenValues = Array.isArray(hidden) ? hidden : []
  for (var h = 0; h < hiddenValues.length; h++) {
    if (typeof hiddenValues[h] === "string") skip[hiddenValues[h].toLowerCase()] = true
  }

  var out = []
  if (builtins !== false) {
    for (var b = 0; b < DEFAULT_QUICKLINKS.length; b++) {
      var builtin = DEFAULT_QUICKLINKS[b]
      if (skip[builtin.keyword] || skip[builtin.name.toLowerCase()]) continue
      out.push(builtin)
    }
  }

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
  var quicklinks = normalizeQuicklinks(value.quicklinks, value.builtinQuicklinks, value.hiddenQuicklinks)

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
  // Everything removed is a legitimate answer: no quicklinks means no web
  // fallback row either, rather than a Google row nobody asked for.
  if (!found) found = quicklinks[0] || null

  return {
    searchEngine: found ? found.keyword : "",
    searchQuicklink: found,
    quicklinks: quicklinks,
    snippets: normalizeSnippets(value.snippets),
    commands: normalizeCommands(value.commands),
    // The preview pane is on unless switched off; network features are off
    // unless switched on.
    preview: value.preview !== false,
    currency: value.currency === true,
    ai: value.ai === true,
    scriptDirs: normalizeScriptDirs(value.scriptDirs)
  }
}

// ---- Hyprland bindings block

var BIND_BEGIN = "-- omacast: begin. Written by OmaCast settings; remove the block whole to undo."
var BIND_END = "-- omacast: end."
var CLIPBOARD_CHORD = "SUPER + CTRL + V"

function renderBindBlock(binds) {
  if (!binds.palette && !binds.clipboard) return ""
  var lines = []
  if (binds.palette) lines.push('o.rebind("' + binds.palette + '", "OmaCast", "omarchy-shell shell toggle io.github.terrifiedbug.omacast \'{}\'")')
  if (binds.clipboard) lines.push('o.rebind("SUPER + CTRL + V", "OmaCast clipboard", "omarchy-shell shell toggle io.github.terrifiedbug.omacast \'{\\"scope\\":\\"clipboard\\"}\'")')
  return "\n" + BIND_BEGIN + "\n" + lines.join("\n") + "\n" + BIND_END + "\n"
}

function bindBlockRange(text) {
  var begin = new RegExp("^" + BIND_BEGIN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$", "m").exec(text)
  if (!begin) return null
  var tail = text.slice(begin.index + BIND_BEGIN.length)
  var end = new RegExp("^" + BIND_END.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$", "m").exec(tail)
  if (!end) return { start: begin.index, end: -1 }
  var after = begin.index + BIND_BEGIN.length + end.index + BIND_END.length
  if (text.charAt(after) === "\n") after += 1
  return { start: begin.index, end: after }
}

function parseBindBlock(text) {
  var value = String(text || "")
  var range = bindBlockRange(value)
  if (!range || range.end < 0) return { palette: "", clipboard: false, found: false }
  var block = value.slice(range.start, range.end)
  var palette = /^o\.rebind\("([^"]+)", "OmaCast",/m.exec(block)
  return { palette: palette ? palette[1] : "", clipboard: block.indexOf('"OmaCast clipboard"') >= 0, found: true }
}

function replaceBindBlock(text, block) {
  var value = String(text || "")
  var range = bindBlockRange(value)
  if (range && range.end < 0) return null
  if (!range) {
    if (!block) return value
    return value + (value && value.charAt(value.length - 1) !== "\n" ? "\n" : "") + block
  }
  var start = range.start
  if (!block && start > 0 && value.slice(start - 2, start) === "\n\n") start -= 1
  // Render includes the blank separator for appending, not for replacing.
  return value.slice(0, start) + (block ? block.slice(1) : "") + value.slice(range.end)
}

function handBoundPalette(records, binds) {
  return !binds.palette && (records || []).some(function(record) {
    return record.arg.indexOf("io.github.terrifiedbug.omacast") >= 0 && record.combo !== CLIPBOARD_CHORD
  })
}

function barButtonSetting(shellConfig, id) {
  var layout = shellConfig && shellConfig.bar && shellConfig.bar.layout
  if (!layout) return null
  var sections = ["left", "center", "right"]
  for (var s = 0; s < sections.length; s++) {
    var entries = Array.isArray(layout[sections[s]]) ? layout[sections[s]] : []
    for (var i = 0; i < entries.length; i++) {
      if (entries[i] && entries[i].id === id) return entries[i].button === true || entries[i].button === "true"
    }
  }
  return null
}

// ---- Settings document

var CONFIG_KEYS = ["searchEngine", "builtinQuicklinks", "hiddenQuicklinks", "quicklinks", "snippets", "commands", "scriptDirs", "preview", "currency", "ai"]
var LIST_KINDS = {
  quicklinks: { fields: ["name", "keyword", "url"], label: "Quicklink" },
  snippets: { fields: ["name", "keyword", "text"], label: "Snippet" },
  commands: { fields: ["name", "keyword", "command", "terminal", "confirm"], label: "Command" }
}

function editableConfig(raw) {
  var doc = raw && typeof raw === "object" && !Array.isArray(raw) ? JSON.parse(JSON.stringify(raw)) : ({})
  doc.searchEngine = typeof doc.searchEngine === "string" ? doc.searchEngine : "g"
  doc.builtinQuicklinks = typeof doc.builtinQuicklinks === "boolean" ? doc.builtinQuicklinks : true
  doc.preview = typeof doc.preview === "boolean" ? doc.preview : true
  doc.currency = doc.currency === true
  doc.ai = doc.ai === true
  ;["hiddenQuicklinks", "scriptDirs"].forEach(function(key) {
    doc[key] = (Array.isArray(doc[key]) ? doc[key] : []).filter(function(value) { return typeof value === "string" })
  })
  Object.keys(LIST_KINDS).forEach(function(kind) {
    doc[kind] = (Array.isArray(doc[kind]) ? doc[kind] : []).filter(function(entry) {
      return entry && typeof entry === "object" && !Array.isArray(entry)
    }).map(function(entry) {
      var out = ({})
      LIST_KINDS[kind].fields.forEach(function(field) {
        out[field] = field === "terminal" || field === "confirm"
          ? entry[field] === true : typeof entry[field] === "string" ? entry[field] : ""
      })
      return out
    })
  })
  return doc
}

function updateConfig(raw, op) {
  var doc = editableConfig(raw)
  if (!op) return doc
  var kind = Object.prototype.hasOwnProperty.call(LIST_KINDS, op.kind) ? op.kind : ""
  var indexed = kind && Number.isInteger(op.index) && op.index >= 0 && op.index < doc[kind].length
  var dirIndex = Number.isInteger(op.index) && op.index >= 0 && op.index < doc.scriptDirs.length
  if (op.op === "set" && ["searchEngine", "preview", "currency", "ai", "builtinQuicklinks"].indexOf(op.key) >= 0) {
    doc[op.key] = op.value
  } else if (op.op === "toggleHidden") {
    var hidden = doc.hiddenQuicklinks.indexOf(op.keyword)
    if (hidden < 0) doc.hiddenQuicklinks.push(op.keyword)
    else doc.hiddenQuicklinks = doc.hiddenQuicklinks.filter(function(keyword) { return keyword !== op.keyword })
  } else if (op.op === "setField" && indexed && LIST_KINDS[kind].fields.indexOf(op.field) >= 0) {
    doc[kind][op.index][op.field] = op.value
  } else if (op.op === "add" && kind) {
    var entry = ({})
    LIST_KINDS[kind].fields.forEach(function(field) { entry[field] = field === "terminal" || field === "confirm" ? false : "" })
    doc[kind].push(entry)
  } else if (op.op === "remove" && indexed) {
    doc[kind].splice(op.index, 1)
  } else if (op.op === "addDir") {
    doc.scriptDirs.push(op.path)
  } else if (op.op === "setDir" && dirIndex) {
    doc.scriptDirs[op.index] = op.path
  } else if (op.op === "removeDir" && dirIndex) {
    doc.scriptDirs.splice(op.index, 1)
  }
  return editableConfig(doc)
}

function serializeConfig(doc) {
  var ordered = ({})
  CONFIG_KEYS.forEach(function(key) { ordered[key] = doc[key] })
  Object.keys(doc).forEach(function(key) {
    if (CONFIG_KEYS.indexOf(key) < 0) Object.defineProperty(ordered, key, { value: doc[key], enumerable: true })
  })
  return JSON.stringify(ordered, null, 2) + "\n"
}

function escapeMultiline(text) {
  return String(text).replace(/\\/g, "\\\\").replace(/\n/g, "\\n")
}

function unescapeMultiline(text) {
  return String(text).replace(/\\(\\|n)/g, function(match, escaped) { return escaped === "n" ? "\n" : "\\" })
}

function validateField(kind, field, text) {
  var value = String(text)
  if (field === "keyword") {
    value = value.toLowerCase()
    if (value && !KEYWORD_PATTERN.test(value)) return { ok: false, error: "Keyword: letters, digits, . and -, up to 16 characters" }
  } else if (kind === "snippets" && field === "text") {
    value = unescapeMultiline(value)
  } else if (["name", "url", "command", "path"].indexOf(field) >= 0) {
    value = value.trim()
  }
  return { ok: true, value: value }
}

function normalizeChord(text) {
  var tokens = String(text || "").toUpperCase().split(/[+\s]+/).filter(function(token) { return !!token })
  if (!tokens.length) return ""
  var key = tokens.pop()
  if (!/^[A-Z0-9]$|^F([1-9]|1[0-9]|2[0-4])$|^(SPACE|RETURN|TAB|ESCAPE|BACKSPACE|DELETE|INSERT|HOME|END|PRIOR|NEXT|LEFT|RIGHT|UP|DOWN|MINUS|EQUAL|COMMA|PERIOD|SLASH|SEMICOLON|APOSTROPHE|GRAVE|BRACKETLEFT|BRACKETRIGHT|BACKSLASH|PRINT)$/.test(key)) return ""
  if (tokens.some(function(token) { return ["SUPER", "CTRL", "ALT", "SHIFT"].indexOf(token) < 0 })) return ""
  return tokens.concat([key]).join(" + ")
}

function normalizeScriptDirs(raw) {
  var values = Array.isArray(raw) ? raw : []
  var out = []
  for (var i = 0; i < values.length; i++) {
    var dir = values[i]
    if (typeof dir !== "string" || !dir.trim() || /[\x00-\x1f]/.test(dir)) continue
    if (out.indexOf(dir.trim()) < 0) out.push(dir.trim())
  }
  return out.slice(0, 8)
}

// `~/` in a configured folder means the user's home.
function expandHome(path, home) {
  var value = String(path || "")
  if (value === "~") return String(home || "")
  if (value.indexOf("~/") === 0) return String(home || "") + value.slice(1)
  return value
}

// The config sits next to Omarchy's own menu JSONC, so it accepts comments and
// trailing commas. Regexes cannot do this safely: every quicklink holds a URL
// with `//` in it, and a snippet can contain anything at all, including `, }`.
// So the scanner tracks whether it is inside a string and only strips what is
// outside one.
function stripJsonComments(raw) {
  var text = String(raw || "")
  var out = ""
  var inString = false
  var escaped = false
  var i = 0

  while (i < text.length) {
    var ch = text.charAt(i)

    if (inString) {
      out += ch
      if (escaped) escaped = false
      else if (ch === "\\") escaped = true
      else if (ch === "\"") inString = false
      i += 1
      continue
    }

    if (ch === "\"") {
      inString = true
      out += ch
      i += 1
      continue
    }

    var next = text.charAt(i + 1)
    if (ch === "/" && next === "/") {
      while (i < text.length && text.charAt(i) !== "\n") i += 1
      continue
    }
    if (ch === "/" && next === "*") {
      i += 2
      while (i < text.length && !(text.charAt(i) === "*" && text.charAt(i + 1) === "/")) i += 1
      i += 2
      continue
    }

    // A comma is trailing when the next thing that closes is `}` or `]`, with
    // only whitespace or comments in between.
    if (ch === ",") {
      var at = i + 1
      while (at < text.length) {
        var ahead = text.charAt(at)
        if (/\s/.test(ahead)) { at += 1; continue }
        if (ahead === "/" && text.charAt(at + 1) === "/") {
          while (at < text.length && text.charAt(at) !== "\n") at += 1
          continue
        }
        if (ahead === "/" && text.charAt(at + 1) === "*") {
          at += 2
          while (at < text.length && !(text.charAt(at) === "*" && text.charAt(at + 1) === "/")) at += 1
          at += 2
          continue
        }
        break
      }
      var after = text.charAt(at)
      if (after === "}" || after === "]") {
        i += 1
        continue
      }
    }

    out += ch
    i += 1
  }
  return out
}

function parseConfig(raw) {
  return parseJson(stripJsonComments(raw))
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
    buildMenuIndex: buildMenuIndex,
    configRows: configRows,
    prepareFields: prepareFields,
    parseConfig: parseConfig,
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
    FILE_FILTERS: FILE_FILTERS,
    FILE_SORTS: FILE_SORTS,
    FILE_LIMITS: FILE_LIMITS,
    FILE_CANDIDATE_LIMIT: FILE_CANDIDATE_LIMIT,
    fileCommand: fileCommand,
    fileStatCommand: fileStatCommand,
    parseFileRecords: parseFileRecords,
    fileRows: fileRows,
    rankFile: rankFile,
    basename: basename,
    dirname: dirname,
    answerRows: answerRows,
    webRows: webRows,
    scopeRows: scopeRows,
    EMPTY_WINDOW_LIMIT: EMPTY_WINDOW_LIMIT,
    helpRows: helpRows,
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
    CONFIG_KEYS: CONFIG_KEYS,
    LIST_KINDS: LIST_KINDS,
    editableConfig: editableConfig,
    updateConfig: updateConfig,
    serializeConfig: serializeConfig,
    escapeMultiline: escapeMultiline,
    unescapeMultiline: unescapeMultiline,
    validateField: validateField,
    normalizeChord: normalizeChord,
    isSettingsScope: isSettingsScope,
    filterSettingsRows: filterSettingsRows,
    settingsRows: settingsRows,
    settingsChoiceRows: settingsChoiceRows,
    settingsBuiltinRows: settingsBuiltinRows,
    settingsListRows: settingsListRows,
    settingsEntryRows: settingsEntryRows,
    settingsDirRows: settingsDirRows,
    BIND_BEGIN: BIND_BEGIN,
    BIND_END: BIND_END,
    CLIPBOARD_CHORD: CLIPBOARD_CHORD,
    renderBindBlock: renderBindBlock,
    bindBlockRange: bindBlockRange,
    parseBindBlock: parseBindBlock,
    replaceBindBlock: replaceBindBlock,
    handBoundPalette: handBoundPalette,
    barButtonSetting: barButtonSetting,
    parseJson: parseJson,
    firstLine: firstLine,
    withinOneEdit: withinOneEdit,
    updateState: updateState,
    toggleHidden: toggleHidden,
    resetUsage: resetUsage,
    rememberQuery: rememberQuery,
    hiddenMap: hiddenMap,
    hiddenRows: hiddenRows,
    dateAnswer: dateAnswer,
    parseDay: parseDay,
    timeZoneRequest: timeZoneRequest,
    timeZoneCommand: timeZoneCommand,
    timeZoneRows: timeZoneRows,
    resolveZone: resolveZone,
    ZONE_CITIES: ZONE_CITIES,
    ZONE_ABBREVIATIONS: ZONE_ABBREVIATIONS,
    parseColour: parseColour,
    colourAnswers: colourAnswers,
    reminderRows: reminderRows,
    parseProcesses: parseProcesses,
    processRows: processRows,
    parseCommandCatalog: parseCommandCatalog,
    buildCommandCatalog: buildCommandCatalog,
    commandCatalogRows: commandCatalogRows,
    parseThemes: parseThemes,
    themeRows: themeRows,
    aiRows: aiRows,
    parseScriptCommand: parseScriptCommand,
    parseScriptRecords: parseScriptRecords,
    splitArguments: splitArguments,
    scriptRows: scriptRows,
    shellQuote: shellQuote,
    lastLine: lastLine,
    rowActions: rowActions,
    currencyRequest: currencyRequest,
    parseEcbRates: parseEcbRates,
    convertCurrency: convertCurrency,
    removeClipboardEntry: removeClipboardEntry,
    previewText: previewText,
    previewCommand: previewCommand,
    cleanPreview: cleanPreview,
    expandHome: expandHome,
    SCRIPT_OUTPUT_LIMIT: SCRIPT_OUTPUT_LIMIT,
    TYPO_SCORE: TYPO_SCORE,
    nearMissScore: nearMissScore
  }
}
