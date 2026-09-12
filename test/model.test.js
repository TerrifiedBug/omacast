const test = require("node:test")
const assert = require("node:assert/strict")
const Model = require("../Model.js")
const MenuModel = require("../vendor/MenuModel.js")

const HOUR = 3600000
const DAY = 86400000
const NOW = 1770000000000

// A slice of the shipped omarchy-menu.jsonc plus one provider submenu, so the
// menu tests run against the real item shape the vendored parser produces.
const MENU_JSONC = `{
  "apps": {"icon":"a","label":"Apps","provider":"apps"},
  "system": {"icon":"s","label":"System","aliases":["power-menu"]},
  "system.lock": {"icon":"l","label":"Lock","action":"omarchy-system-lock"},
  "system.shutdown": {"icon":"p","label":"Shutdown","action":"omarchy-system-shutdown"},
  "system.hibernate": {"icon":"h","label":"Hibernate","when":"omarchy-hibernation-available","action":"systemctl hibernate"},
  "trigger": {"icon":"t","label":"Trigger"},
  "trigger.capture": {"icon":"c","label":"Capture"},
  "trigger.capture.screenshot": {"icon":"c","label":"Screenshot","action":"omarchy-cmd-screenshot"}
}`

function menu() {
  return MenuModel.mergeMenuSources(MenuModel.parseMenuJsonc(MENU_JSONC), [])
}

function rowsByTitle(rows) {
  const out = {}
  for (const row of rows) out[row.title] = row
  return out
}

test("matchScore ranks prefix over alias, contains, acronym and subsequence", () => {
  const prefix = Model.matchScore("fire", { name: "Firefox", aliases: ["browser"] })
  const aliasPrefix = Model.matchScore("brow", { name: "Firefox", aliases: ["browser"] })
  const contains = Model.matchScore("fox", { name: "Firefox", aliases: [] })
  const acronym = Model.matchScore("vsc", { name: "Visual Studio Code", aliases: [] })
  const subsequence = Model.matchScore("dwnlds", { name: "Downloads", aliases: [] })

  assert.ok(prefix > aliasPrefix)
  assert.ok(aliasPrefix > contains)
  assert.ok(contains > acronym)
  assert.ok(acronym > subsequence)
  assert.ok(subsequence > 0)
})

test("prose text matches on substring only, never as a scattered subsequence", () => {
  const fields = { name: "Arch Wiki", aliases: [], text: "https://wiki.archlinux.org/index.php?search=" }
  assert.ok(Model.matchScore("archlinux", fields) >= 0)
  assert.equal(Model.matchScore("hpsx", fields), -1)
})

test("every query term has to match", () => {
  const fields = { name: "Firefox Developer Edition", aliases: [], text: "" }
  assert.ok(Model.matchScore("firefox edition", fields) >= 0)
  assert.equal(Model.matchScore("firefox chromium", fields), -1)
})

test("frecency never outranks an exact prefix match", () => {
  const usage = { "app:heavy": { count: 1000, last: NOW - 60000 } }
  const learned = 9500 - 3 + Model.frecencyBonus(usage, "app:heavy", NOW)
  assert.ok(Model.frecencyBonus(usage, "app:heavy", NOW) <= Model.FRECENCY_MAX)
  assert.ok(10000 - 12 > learned)
})

test("recentKeys prefers two launches this morning over forty from months ago", () => {
  const usage = {
    "app:today": { count: 2, last: NOW - 4 * HOUR },
    "app:stale": { count: 40, last: NOW - 100 * DAY }
  }
  // Both rank 4 exactly (2 x 2 vs 40 x 0.1); recency breaks the tie.
  assert.deepEqual(Model.recentKeys(usage, NOW, 8, {}), ["app:today", "app:stale"])

  const fresher = { "app:a": { count: 1, last: NOW - HOUR }, "app:b": { count: 1, last: NOW - 3 * HOUR } }
  assert.deepEqual(Model.recentKeys(fresher, NOW, 8, {}), ["app:a", "app:b"])
})

test("normalizeState drops malformed keys, values and pins", () => {
  const state = Model.normalizeState({
    usage: {
      "app:firefox": { count: 3, last: 10 },
      "app:broken": { count: 0, last: 10 },
      "app:float": { count: 1.5, last: 10 },
      "nope:firefox": { count: 3, last: 10 },
      "app:noLast": { count: 3 }
    },
    pins: ["app:firefox", "app:firefox", "menu:system.lock", 7, "bogus"]
  })

  assert.deepEqual(Object.keys(state.usage), ["app:firefox"])
  assert.deepEqual(state.pins, ["app:firefox", "menu:system.lock"])
  assert.equal(state.version, 1)
})

test("pruneUsage keeps the 400 highest ranked keys", () => {
  const usage = {}
  for (let i = 0; i < 500; i++) usage["app:" + i] = { count: i + 1, last: NOW - DAY }
  const pruned = Model.pruneUsage(usage, NOW, 400)

  assert.equal(Object.keys(pruned).length, 400)
  assert.ok(pruned["app:499"])
  assert.equal(pruned["app:0"], undefined)
})

test("togglePin adds then removes", () => {
  const pinned = Model.togglePin({ usage: {}, pins: [] }, "app:firefox")
  assert.deepEqual(pinned.pins, ["app:firefox"])
  assert.deepEqual(Model.togglePin(pinned, "app:firefox").pins, [])
})

test("emptyQueryRows resolves pins and recents, and skips dead keys", () => {
  const catalog = {
    byKey: {
      "app:firefox": Model.row({ key: "app:firefox", section: "apps", title: "Firefox" }),
      "app:kitty": Model.row({ key: "app:kitty", section: "apps", title: "Kitty" })
    },
    windowRows: [Model.row({ key: "win:0:kitty", section: "windows", title: "kitty" })]
  }
  const state = { usage: { "app:kitty": { count: 4, last: NOW - HOUR }, "app:gone": { count: 9, last: NOW } }, pins: ["app:firefox"] }
  const rows = Model.emptyQueryRows(catalog, state, NOW)

  assert.deepEqual(rows.map((r) => r.section), ["pinned", "recent", "windows"])
  assert.equal(rows[0].title, "Firefox")
  assert.equal(rows[1].title, "Kitty")
})

test("window caps differ per view: five beside search results, eight on the empty palette, all in the scope", () => {
  const windows = []
  for (let i = 0; i < 12; i++) windows.push({ index: i, title: "win" + i, appId: "app" + i, activated: false })

  const rows = Model.windowRows(windows, "")
  assert.equal(Model.applyCaps(Model.sortRows(rows)).length, Model.SECTION_CAPS.windows)
  assert.equal(Model.applyCaps(Model.sortRows(rows), { windows: Model.EMPTY_WINDOW_LIMIT }).length, 8)
  assert.equal(Model.applyCaps(Model.sortRows(rows), { windows: Infinity }).length, 12)

  const empty = Model.emptyQueryRows({ byKey: {}, windowRows: rows }, { usage: {}, pins: [] }, NOW)
  assert.equal(Model.applyCaps(Model.sortRows(empty), { windows: Model.EMPTY_WINDOW_LIMIT }).length, 8)
})

test("evaluate answers arithmetic, percentages, suffixes and radixes", () => {
  assert.equal(Model.evaluate("12*7+3").display, "87")
  assert.equal(Model.evaluate("sqrt(144)").display, "12")
  assert.equal(Model.evaluate("20% of 250").display, "50")
  assert.equal(Model.evaluate("250 + 10%").display, "275")
  assert.equal(Model.evaluate("10k/4").display, "2500")
  assert.equal(Model.evaluate("0xff").display, "255")
  assert.equal(Model.evaluate("255 to hex").display, "0xff")
  assert.equal(Model.evaluate("2^10").display, "1024")
  assert.equal(Model.evaluate("12 x 7").display, "84")
})

test("evaluate declines versions, clock times, dates, paths and division by zero", () => {
  assert.equal(Model.evaluate("1.2.3"), null)
  assert.equal(Model.evaluate("10:30"), null)
  assert.equal(Model.evaluate("12/05/2024"), null)
  assert.equal(Model.evaluate("~/x/1"), null)
  assert.equal(Model.evaluate("1/0"), null)
  assert.equal(Model.evaluate("firefox"), null)
})

test("convert handles length, temperature, binary data and duration", () => {
  assert.equal(Model.convert("10 km to miles").display, "6.21371 mi")
  assert.equal(Model.convert("72f in c").display, "22.2222 °C")
  assert.equal(Model.convert("5 GiB to MB").display, "5368.71 MB")
  assert.equal(Model.convert("3 hours in min").display, "180 min")
  assert.equal(Model.convert("10 km to kg"), null)
})

test("expandTemplate encodes for URLs, honours raw, and leaves unknown tokens", () => {
  const ctx = { argument: "a b&c", now: new Date(2026, 0, 2, 3, 4, 5) }

  assert.equal(Model.expandTemplate("https://x/?q={argument}", ctx, "url"), "https://x/?q=a%20b%26c")
  assert.equal(Model.expandTemplate("{argument | raw}", ctx, "url"), "a b&c")
  assert.equal(Model.expandTemplate('{date format="yyyy"}', ctx, "text"), "2026")
  assert.equal(Model.expandTemplate("{nope}", ctx, "text"), "{nope}")
  assert.match(Model.expandTemplate("{uuid}", ctx, "text"), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  assert.equal(Model.needsArgument("https://x/?q={argument}"), true)
  assert.equal(Model.needsArgument("https://x/"), false)
})

test("normalizeConfig merges user entries over built-ins and drops invalid rows", () => {
  const config = Model.normalizeConfig({
    searchEngine: "nope",
    quicklinks: [{ name: "Work GitHub", keyword: "gh", url: "https://github.example/search?q={argument}" }, { name: "Broken" }],
    commands: [{ name: "Rebuild", command: "make" }, { name: "NoCommand" }],
    snippets: [{ name: "Sig", text: "hi" }]
  })

  const gh = config.quicklinks.filter((q) => q.keyword === "gh")
  assert.equal(gh.length, 1)
  assert.equal(gh[0].name, "Work GitHub")
  assert.equal(config.searchEngine, "g")
  assert.deepEqual(config.commands.map((c) => c.name), ["Rebuild"])
  assert.deepEqual(config.snippets.map((s) => s.name), ["Sig"])
})

test("parseKeybindingRecords splits combo, label, dispatcher and arg", () => {
  const records = Model.parseKeybindingRecords([
    "SUPER F                             → Full screen\tlua\thl.dsp.fullscreen()",
    "SUPER SHIFT M                       → Mute\t\t",
    "garbage line"
  ].join("\n"))

  assert.equal(records.length, 2)
  assert.deepEqual(records[0], { combo: "SUPER F", label: "Full screen", dispatcher: "lua", arg: "hl.dsp.fullscreen()" })
  assert.equal(records[1].dispatcher, "")

  const rows = Model.keybindingRows(records, "full screen")
  assert.equal(rows[0].subtitle, "SUPER F")
  assert.equal(Model.keybindingRows(records, "mute")[0].payload.disabled, true)
})

test("menuRows searches the tree, hides failing guards and skips providers", () => {
  const { items, itemOrder } = menu()
  const rows = Model.menuRows(items, itemOrder, { "system.hibernate": false }, {}, "system", {}, NOW, "root", MenuModel)
  const titles = rows.map((r) => r.title)

  assert.ok(titles.includes("Lock"))
  assert.ok(titles.includes("Shutdown"))
  assert.ok(!titles.includes("Hibernate"))
  assert.ok(!titles.includes("Apps"))
  assert.equal(rowsByTitle(rows)["Lock"].subtitle, "System")
  assert.equal(rowsByTitle(rows)["Shutdown"].confirm, true)
  assert.equal(rowsByTitle(rows)["Lock"].confirm, false)
})

test("menuRows shows a breadcrumb for nested leaves and nothing for an empty root query", () => {
  const { items, itemOrder } = menu()
  const rows = Model.menuRows(items, itemOrder, {}, {}, "screenshot", {}, NOW, "root", MenuModel)

  assert.equal(rows[0].title, "Screenshot")
  assert.equal(rows[0].subtitle, "Trigger › Capture")
  assert.deepEqual(Model.menuRows(items, itemOrder, {}, {}, "", {}, NOW, "root", MenuModel), [])
})

test("menuRows in a submenu scope lists that submenu's direct children", () => {
  const { items, itemOrder } = menu()
  const rows = Model.menuRows(items, itemOrder, {}, {}, "", {}, NOW, "menu:system", MenuModel)

  assert.deepEqual(rows.map((r) => r.title).sort(), ["Hibernate", "Lock", "Shutdown"])
})

test("menuRows marks a checked row and labels submenus Browse", () => {
  const { items, itemOrder } = menu()
  const rows = Model.menuRows(items, itemOrder, {}, {}, "capture", {}, NOW, "root", MenuModel)
  const capture = rowsByTitle(rows)["Capture"]

  assert.equal(capture.primaryLabel, "Browse")
  assert.equal(capture.payload.itemKind, "menu")
  assert.equal(capture.pinnable, false)
})

test("parseQuery maps prefixes to scopes and lets a pushed scope win", () => {
  assert.deepEqual(Model.parseQuery(":smile", "root").scope, "emoji")
  assert.equal(Model.parseQuery(":smile", "root").rest, "smile")
  assert.equal(Model.parseQuery("cb ssh", "root").scope, "clipboard")
  assert.equal(Model.parseQuery("cb ssh", "root").rest, "ssh")
  assert.equal(Model.parseQuery("f omacast", "root").scope, "files")
  assert.equal(Model.parseQuery("firefox", "root").scope, "root")
  const path = Model.parseQuery("~/Down", "root")
  assert.equal(path.scope, "files")
  assert.deepEqual(Model.fileRequest(path, "/home/x"), { dir: "/home/x", terms: ["Down"] })

  const pushed = Model.parseQuery("f omacast", "clipboard")
  assert.equal(pushed.scope, "clipboard")
  assert.equal(pushed.rest, "f omacast")
})

test("every scope has a typed prefix, and win does not steal the w quicklink", () => {
  assert.equal(Model.parseQuery("win chrome", "root").scope, "windows")
  assert.equal(Model.parseQuery("win chrome", "root").rest, "chrome")
  assert.equal(Model.parseQuery("windows ", "root").scope, "windows")
  assert.equal(Model.parseQuery("w quickshell", "root").scope, "root")

  const tokens = Model.helpRows(Model.normalizeConfig(null), "").map((r) => r.title)
  for (const token of ["?", ":", "cb", "f", "win", "~/"]) assert.ok(tokens.includes(token), token)
})


test("a bare prefix with a trailing space still enters its scope", () => {
  assert.equal(Model.parseQuery("cb ", "root").scope, "clipboard")
  assert.equal(Model.parseQuery("cb ", "root").rest, "")
  assert.equal(Model.parseQuery("f ", "root").scope, "files")
  assert.equal(Model.parseQuery("cb", "root").scope, "root")
  assert.equal(Model.parseQuery(":", "root").scope, "emoji")
})

test("fileRequest browses a directory when the query ends in a slash", () => {
  const parsed = Model.parseQuery("~/coding/", "root")
  assert.deepEqual(Model.fileRequest(parsed, "/home/x"), { dir: "/home/x/coding", terms: [] })
})

test("fileRows rank by basename tier first, then depth and hidden penalties", () => {
  const rows = Model.sortRows(Model.fileRows([
    "/home/x/notes.md",
    "/home/x/deep/nested/notes.md",
    "/home/x/.cache/notes.md",
    "/home/x/release-notes.md"
  ], "notes", "/home/x"))

  assert.deepEqual(rows.map((r) => r.payload.path), [
    "/home/x/notes.md",
    "/home/x/deep/nested/notes.md",
    "/home/x/release-notes.md",
    "/home/x/.cache/notes.md"
  ])
  assert.equal(rows[0].subtitle, "~")
  assert.ok(Model.rankFile("/home/x/notes.md", "notes") > Model.rankFile("/home/x/.cache/notes.md", "notes"))
})

test("a directory printed by fd with a trailing slash keeps its name", () => {
  const rows = Model.fileRows(["/home/x/coding/"], "", "/home/x")

  assert.equal(rows[0].title, "coding")
  assert.equal(rows[0].subtitle, "~")
  assert.equal(rows[0].payload.path, "/home/x/coding")
})

test("? opens the cheat sheet, which lists prefixes and configured keywords", () => {
  const parsed = Model.parseQuery("?cb", "root")
  assert.equal(parsed.scope, "help")
  assert.equal(parsed.rest, "cb")

  const config = Model.normalizeConfig({
    snippets: [{ name: "Signature", keyword: "sig", text: "Cheers" }],
    commands: [{ name: "Deploy", command: "deploy.sh" }]
  })
  const rows = Model.helpRows(config, "")
  const tokens = rows.map((r) => r.title)

  assert.ok(tokens.includes("cb"))
  assert.ok(tokens.includes(":"))
  assert.ok(tokens.includes("~/"))
  assert.ok(tokens.includes("gh"))
  assert.ok(tokens.includes("sig"))
  // A command without a keyword has nothing to type, so it stays out.
  assert.ok(!tokens.includes("Deploy"))

  const clipboard = Model.helpRows(config, "cb")[0]
  assert.equal(clipboard.payload.insert, "cb ")
  assert.equal(clipboard.accessory, "Prefix")
})

test("quicklink rows admit a typed keyword above every fuzzy tier", () => {
  const rows = Model.quicklinkRows(Model.DEFAULT_QUICKLINKS, "gh quickshell", {}, NOW)
  assert.equal(rows[0].title, "GitHub: quickshell")
  assert.equal(rows[0].payload.argument, "quickshell")
  assert.ok(rows[0].score >= 12000)

  const browsed = Model.quicklinkRows(Model.DEFAULT_QUICKLINKS, "github", {}, NOW)[0]
  assert.equal(browsed.primaryLabel, "Type keyword")
  assert.equal(browsed.payload.complete, true)
})

test("command rows carry typed arguments and a confirm flag", () => {
  const commands = Model.normalizeConfig({ commands: [{ name: "Deploy", keyword: "dep", command: "deploy.sh", confirm: true, terminal: true }] }).commands
  const row = Model.commandRows(commands, "dep staging now", {}, NOW)[0]

  assert.deepEqual(row.payload.args, ["staging", "now"])
  assert.equal(row.confirm, true)
  assert.match(row.subtitle, / · terminal$/)
})

test("clipboard rows summarise text and keep the store index", () => {
  const entries = Model.parseClipboard(JSON.stringify([
    { type: "text", text: "  \nssh danny@host\nsecond line" },
    { type: "image", path: "/tmp/a.png", mime: "image/png", capturedAt: "12:00" },
    { type: "text", text: "   " }
  ]))

  assert.equal(entries.length, 2)
  const rows = Model.clipboardRows(entries, "ssh")
  assert.equal(rows.length, 1)
  assert.equal(rows[0].title, "ssh danny@host")
  assert.equal(rows[0].subtitle, "3 lines · 29 chars")
  assert.equal(rows[0].payload.historyIndex, 0)
  assert.equal(Model.clipboardRows(entries, "")[1].payload.entryType, "image")
})

test("emoji rows score a keyword-start hit above a mid-word one", () => {
  const emojis = [{ e: "😀", k: "grinning face smile happy" }, { e: "🙈", k: "see no evil monkey" }]
  const rows = Model.emojiRows(emojis, "smile")

  assert.equal(rows.length, 1)
  assert.equal(rows[0].payload.emoji, "😀")
  assert.ok(Model.emojiRows(emojis, "smi")[0].score > Model.emojiRows(emojis, "vil")[0].score)
})

test("detectUrl normalises bare hosts and rejects prose", () => {
  assert.equal(Model.detectUrl("github.com/omacom"), "https://github.com/omacom")
  assert.equal(Model.detectUrl("https://x.dev/a"), "https://x.dev/a")
  assert.equal(Model.detectUrl("localhost:8080"), "https://localhost:8080")
  assert.equal(Model.detectUrl("file.txt"), "")
  assert.equal(Model.detectUrl("hello world"), "")
  assert.equal(Model.destinationKind("~/notes"), "path")
  assert.equal(Model.destinationKind("https://x.dev"), "web")
})

test("sortRows keeps sections in publish order and applyCaps trims each one", () => {
  const rows = [
    Model.row({ section: "web", title: "web", score: 9000 }),
    Model.row({ section: "apps", title: "b", score: 10 }),
    Model.row({ section: "apps", title: "a", score: 20 }),
    Model.row({ section: "answer", title: "87", score: 1 })
  ]
  const sorted = Model.sortRows(rows)
  assert.deepEqual(sorted.map((r) => r.title), ["87", "a", "b", "web"])

  const many = []
  for (let i = 0; i < 12; i++) many.push(Model.row({ section: "apps", title: "app" + i, score: 100 - i }))
  assert.equal(Model.applyCaps(Model.sortRows(many)).length, Model.SECTION_CAPS.apps)
})

test("answerRows publish one calculation and one link row", () => {
  assert.equal(Model.answerRows("12*7+3")[0].title, "87")
  assert.equal(Model.answerRows("10 km to miles")[0].title, "6.21371 mi")
  assert.equal(Model.answerRows("github.com")[0].payload.url, "https://github.com")
  assert.deepEqual(Model.answerRows("firefox"), [])
})

test("webRows only appear for a real query", () => {
  assert.equal(Model.webRows("q", { name: "Google" }).length, 0)
  assert.equal(Model.webRows("quickshell", { name: "Google" })[0].primaryLabel, "Search")
})
