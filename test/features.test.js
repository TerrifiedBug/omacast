const test = require("node:test")
const assert = require("node:assert/strict")
const Model = require("../Model.js")

// Friday 25 September 2026, 14:00 local time. Built from local components so
// the tests hold in any zone the suite runs in.
const NOW = new Date(2026, 8, 25, 14, 0, 0).getTime()

function titles(rows) {
  return rows.map((row) => row.title)
}

// ---- State

test("state updates keep fields they do not touch", () => {
  let state = Model.normalizeState({ usage: { "app:a.desktop": { count: 2, last: 5 } }, pins: ["app:a.desktop"], hidden: ["app:b.desktop"], lastQuery: "12*7" })
  state = Model.updateState(state, { usage: {} })
  assert.deepEqual(state.pins, ["app:a.desktop"])
  assert.deepEqual(state.hidden, ["app:b.desktop"])
  assert.equal(state.lastQuery, "12*7")
  state = Model.togglePin(state, "menu:system.lock")
  assert.deepEqual(state.hidden, ["app:b.desktop"])
  assert.equal(state.lastQuery, "12*7")
})

test("hiding a row unpins it and keeps it out of the empty palette", () => {
  const byKey = {
    "app:a.desktop": Model.row({ key: "app:a.desktop", title: "A", section: "apps" }),
    "app:b.desktop": Model.row({ key: "app:b.desktop", title: "B", section: "apps" })
  }
  let state = Model.normalizeState({ pins: ["app:a.desktop"], usage: { "app:b.desktop": { count: 3, last: NOW } } })
  state = Model.toggleHidden(state, "app:a.desktop")
  state = Model.toggleHidden(state, "app:b.desktop")
  assert.deepEqual(state.pins, [])
  assert.deepEqual(Model.emptyQueryRows({ byKey, windowRows: [] }, state, NOW), [])

  const hiddenList = Model.hiddenRows(byKey, state, "")
  assert.deepEqual(titles(hiddenList), ["A", "B"])
  assert.equal(hiddenList[0].primaryLabel, "Unhide")

  const apps = Model.appRows([{ entry: { id: "a.desktop", name: "A" }, score: 100 }], "a", {}, {}, NOW, Model.hiddenMap(state))
  assert.equal(apps.length, 0)
})

test("reset ranking forgets one key and nothing else", () => {
  const state = Model.resetUsage({ usage: { "app:a": { count: 4, last: 1 }, "app:b": { count: 1, last: 1 } } }, "app:a")
  assert.deepEqual(Object.keys(state.usage), ["app:b"])
})

test("the last query is remembered, capped, and an empty close keeps the old one", () => {
  let state = Model.rememberQuery({}, "  10 km to miles ")
  assert.equal(state.lastQuery, "10 km to miles")
  state = Model.rememberQuery(state, "   ")
  assert.equal(state.lastQuery, "10 km to miles")
  assert.equal(Model.rememberQuery({}, "x".repeat(500)).lastQuery.length, 240)
})

// ---- Running apps

test("a running app focuses first and launches a new instance second", () => {
  const entries = [{ entry: { id: "firefox.desktop", name: "Firefox" }, score: 9000 }, { entry: { id: "gimp.desktop", name: "GIMP" }, score: 8000 }]
  const rows = Model.appRows(entries, "", {}, { "firefox.desktop": 2 }, NOW)
  assert.equal(rows[0].primaryLabel, "Focus")
  assert.equal(rows[0].secondaryLabel, "Launch new")
  assert.equal(rows[0].payload.toplevelIndex, 2)
  assert.equal(rows[1].primaryLabel, "Open")
  assert.equal(rows[1].secondaryLabel, "")
})

// ---- Typo tolerance

test("one typo still finds the name, below every correctly spelled tier", () => {
  const firefox = { name: "Firefox", aliases: [], text: "" }
  for (const query of ["frfx", "firfox", "fierfox", "firefx", "firefoz"]) {
    assert.ok(Model.matchScore(query, firefox) > 0, query)
  }
  assert.ok(Model.matchScore("fierfox", firefox) < Model.matchScore("dwnlds", { name: "Downloads", aliases: [] }))
  assert.equal(Model.matchScore("chrome", { name: "Chromium", aliases: [], text: "" }), -1)
  assert.equal(Model.matchScore("fox", { name: "Fix", aliases: [], text: "" }), -1, "terms under four letters never take the typo tier")
  assert.equal(Model.matchScore("firefoz", { name: "Thunderbird", aliases: [], text: "firefox" }), -1, "prose never takes the typo tier")
})

test("withinOneEdit covers swap, substitution, insertion and deletion only", () => {
  assert.ok(Model.withinOneEdit("fierfox", "firefox"))
  assert.ok(Model.withinOneEdit("firefax", "firefox"))
  assert.ok(Model.withinOneEdit("fireefox", "firefox"))
  assert.ok(Model.withinOneEdit("firfox", "firefox"))
  assert.ok(!Model.withinOneEdit("fiefx", "firefox"))
  assert.ok(!Model.withinOneEdit("chrome", "chromium"))
})

test("a near miss for apps is a typo or a subsequence skipping at most two letters", () => {
  assert.ok(Model.nearMissScore("firfox", "Firefox") > 0)
  assert.ok(Model.nearMissScore("fierfox", "Firefox") > 0)
  assert.equal(Model.nearMissScore("term", "Telegram Desktop"), -1, "scattered letters are not a near miss")
  assert.equal(Model.nearMissScore("fire", "Firefox"), -1, "a real match is AppSearch's to rank")
})

// ---- Dates

test("date answers count days, add periods and name the next weekday", () => {
  assert.match(Model.dateAnswer("days until dec 25", NOW).display, /^91 days until Fri 25 Dec 2026$/)
  assert.equal(Model.dateAnswer("days until dec 25", NOW).copyText, "91")
  assert.match(Model.dateAnswer("days until sep 1", NOW).display, /Sep 2027$/, "a passed date rolls to next year")
  assert.match(Model.dateAnswer("days since 2026-09-20", NOW).display, /^5 days since/)
  assert.equal(Model.dateAnswer("today + 90 days", NOW).display, "Thu 24 Dec 2026")
  assert.equal(Model.dateAnswer("today - 3 weeks", NOW).display, "Fri 4 Sep 2026")
  assert.equal(Model.dateAnswer("2026-01-31 + 1 month", NOW).display, "Sat 28 Feb 2026")
  assert.equal(Model.dateAnswer("dec 25 + 1 week", NOW).display, "Fri 1 Jan 2027")
  assert.equal(Model.dateAnswer("monday", NOW).display, "Mon 28 Sep 2026")
  assert.equal(Model.dateAnswer("friday", NOW).display, "Fri 2 Oct 2026", "today's weekday means next week")
  assert.equal(Model.dateAnswer("now", NOW).display, String(Math.floor(NOW / 1000)))
  assert.equal(Model.dateAnswer(String(Math.floor(NOW / 1000)), NOW).copyText, "2026-09-25 14:00:00")
  assert.equal(Model.dateAnswer(String(NOW), NOW).copyText, "2026-09-25 14:00:00")
  assert.equal(Model.dateAnswer("days until feb 30", NOW), null)
  assert.equal(Model.dateAnswer("firefox", NOW), null)
})

test("date answers reach the answer section", () => {
  const rows = Model.answerRows("days until dec 25", { now: NOW })
  assert.equal(rows[0].section, "answer")
  assert.equal(rows[0].payload.copyText, "91")
})

// ---- Time zones

test("time zone questions become one date batch", () => {
  const now = Model.timeZoneRequest("now in tokyo", NOW)
  assert.deepEqual(now.zones, ["Asia/Tokyo"])
  assert.equal(now.epoch, Math.floor(NOW / 1000))
  assert.equal(now.source, "")

  const between = Model.timeZoneRequest("3pm ist in pst", NOW)
  assert.equal(between.source, "Asia/Kolkata")
  assert.equal(between.wall, "2026-09-25 15:00")
  assert.deepEqual(between.zones, ["America/Los_Angeles"])

  const spaced = Model.timeZoneRequest("3 pm ist to pst", NOW)
  assert.equal(spaced.source, "Asia/Kolkata")

  const local = Model.timeZoneRequest("9am in new york", NOW)
  assert.equal(local.epoch, Math.floor(new Date(2026, 8, 25, 9, 0).getTime() / 1000))
  assert.deepEqual(local.zones, ["America/New_York"])

  assert.deepEqual(Model.timeZoneRequest("time in berlin, tokyo", NOW).zones, ["Europe/Berlin", "Asia/Tokyo"])
  assert.deepEqual(Model.timeZoneRequest("tokyo time", NOW).zones, ["Asia/Tokyo"])
  assert.deepEqual(Model.timeZoneRequest("now in europe/berlin", NOW).zones, ["Europe/Berlin"])

  assert.equal(Model.timeZoneRequest("10 km to miles", NOW), null)
  assert.equal(Model.timeZoneRequest("3 in pst", NOW), null, "a bare number is not a time")
  assert.equal(Model.timeZoneRequest("docker in atlantis", NOW), null)
})

test("the zone table maps every city and abbreviation to an IANA name", () => {
  const all = Object.assign({}, Model.ZONE_CITIES, Model.ZONE_ABBREVIATIONS)
  assert.ok(Object.keys(all).length >= 80)
  for (const [name, zone] of Object.entries(all)) assert.match(zone, /^(UTC|[A-Z][A-Za-z]+(\/[A-Z][A-Za-z_]+){1,2})$/, name)
})

test("the date batch output renders one answer per zone", () => {
  const request = Model.timeZoneRequest("3pm ist in pst, tokyo", NOW)
  const rows = Model.timeZoneRows(request, "2026-09-25 02:30 PDT\n2026-09-25 18:30 JST\n")
  assert.deepEqual(titles(rows), ["02:30 PDT  ·  Fri 25 Sep", "18:30 JST  ·  Fri 25 Sep"])
  assert.equal(rows[0].subtitle, "PST · from 15:00 IST")
  assert.equal(rows[1].payload.copyText, "18:30 JST")
  const argv = Model.timeZoneCommand(request)
  assert.deepEqual(argv.slice(4), ["-1", "Asia/Kolkata", "2026-09-25 15:00", "America/Los_Angeles", "Asia/Tokyo"])
})

// ---- Colours

test("a colour in any notation answers with HEX, RGB and HSL", () => {
  for (const input of ["#ff8800", "#f80", "rgb(255,136,0)", "rgb(255 136 0)", "hsl(32,100%,50%)"]) {
    const rows = Model.answerRows(input, { now: NOW }).filter((row) => row.payload.swatch)
    assert.deepEqual(rows.map((row) => row.subtitle), ["HEX", "RGB", "HSL"], input)
    assert.equal(rows[0].payload.swatch, "#ff8800", input)
  }
  const rows = Model.answerRows("#ff8800", { now: NOW })
  assert.deepEqual(titles(rows), ["#ff8800", "rgb(255, 136, 0)", "hsl(32, 100%, 50%)"])
  assert.deepEqual(Model.colourAnswers("rgb(300,0,0)"), [])
  assert.deepEqual(Model.colourAnswers("#ggg"), [])
})

test("a lone hex colour is an answer, anything else after # searches contents", () => {
  assert.equal(Model.parseQuery("#f80").scope, "root")
  assert.equal(Model.parseQuery("#ff8800").scope, "root")
  assert.equal(Model.parseQuery("#TODO").scope, "content")
  assert.equal(Model.parseQuery("#TODO").rest, "TODO")
})

// ---- Reminders

test("reminders turn relative and absolute times into minutes", () => {
  const plain = Model.reminderRows("remind 30 check the oven", NOW)[0]
  assert.equal(plain.title, "Remind in 30 min: check the oven")
  assert.deepEqual([plain.payload.minutes, plain.payload.text], [30, "check the oven"])

  assert.equal(Model.reminderRows("remind me in 20m to call", NOW)[0].payload.minutes, 20)
  assert.equal(Model.reminderRows("remind me in 2 hours to stretch", NOW)[0].payload.minutes, 120)

  const at = Model.reminderRows("remind me at 17:30 to leave", NOW)[0]
  assert.equal(at.payload.minutes, 210)
  assert.equal(at.payload.text, "leave")
  assert.equal(at.title, "Remind at 17:30 (in 3 h 30 min): leave")

  const rolled = Model.reminderRows("remind me at 9am to stand up", NOW)[0]
  assert.equal(rolled.payload.minutes, 19 * 60, "a time already passed today means tomorrow")

  const pending = Model.reminderRows("remind me to call mum", NOW)[0]
  assert.equal(pending.payload.disabled, true)
  assert.match(pending.subtitle, /^needs a time/)
  assert.deepEqual(Model.reminderRows("reminders app", NOW), [])
})

// ---- Processes

test("process rows exclude the shell and confirm both signals", () => {
  const text = "100 99 555\n  100  5.0  1.2 quickshell\n  200 12.5  3.4 firefox\n  555  0.0  0.0 ps\n  300  0.1  0.2 foot\n"
  const procs = Model.parseProcesses(text)
  assert.deepEqual(procs.map((p) => p.pid), ["200", "300"])
  const rows = Model.processRows(procs, "fire")
  assert.equal(rows.length, 1)
  assert.equal(rows[0].subtitle, "200 · 12.5% cpu · 3.4% mem")
  assert.deepEqual([rows[0].primaryLabel, rows[0].secondaryLabel, rows[0].confirm], ["Terminate", "Kill", true])
  assert.equal(Model.parseQuery("kill fire").scope, "kill")
  assert.equal(Model.parseQuery("kill fire").rest, "fire")
})

// ---- omarchy commands

test("the command catalog keeps argument-free commands the menu does not already run", () => {
  const json = JSON.stringify({
    commands: [
      { route: "omarchy theme bg next", binary: "omarchy-theme-bg-next", summary: "Cycle to the next background", args: "", requires_sudo: false, hidden: false },
      { route: "omarchy system lock", binary: "omarchy-system-lock", summary: "Lock the computer", args: "", requires_sudo: false, hidden: false },
      { route: "omarchy theme set", binary: "omarchy-theme-set", summary: "Set a theme", args: "<theme-name>", requires_sudo: false, hidden: false },
      { route: "omarchy secret", binary: "omarchy-secret", summary: "Hidden", args: "", requires_sudo: false, hidden: true },
      { route: "omarchy root thing", binary: "omarchy-root-thing", summary: "Needs root", args: "", requires_sudo: true, hidden: false },
      { route: "omarchy remove preinstalls", binary: "omarchy-remove-preinstalls", summary: "Remove preinstalled apps.", args: "", requires_sudo: false, hidden: false }
    ]
  })
  const commands = Model.parseCommandCatalog(json)
  assert.deepEqual(commands.map((c) => c.route), ["omarchy theme bg next", "omarchy system lock", "omarchy remove preinstalls"])

  const catalog = Model.buildCommandCatalog(commands, [{ action: "omarchy-system-lock" }])
  assert.deepEqual(catalog.map((c) => c.route), ["omarchy theme bg next", "omarchy remove preinstalls"])

  const rows = Model.commandCatalogRows(catalog, "bg next", {}, NOW)
  assert.equal(rows[0].title, "Cycle to the next background")
  assert.equal(rows[0].subtitle, "omarchy theme bg next")
  assert.equal(rows[0].frecencyKey, "oc:omarchy theme bg next")
  assert.equal(Model.commandCatalogRows(catalog, "remove pre", {}, NOW)[0].confirm, true)
  assert.deepEqual(Model.commandCatalogRows(catalog, "", {}, NOW), [])
  assert.equal(Model.commandCatalogRows(catalog, "", {}, NOW, true).length, 2)
})

// ---- Themes

test("theme rows match the bare name and mark the current theme", () => {
  const themes = Model.parseThemes("Tokyo Night\n---\nCatppuccin\nTokyo Night\nLumon\n")
  assert.equal(themes.current, "Tokyo Night")
  const byName = Model.themeRows(themes, "lumon", {}, NOW)
  assert.deepEqual(titles(byName), ["Theme: Lumon"])
  const prefixed = Model.themeRows(themes, "theme tokyo", {}, NOW)
  assert.equal(prefixed[0].accessory, "✓")
  assert.equal(prefixed[0].payload.name, "Tokyo Night")
  assert.deepEqual(Model.themeRows(themes, "", {}, NOW), [])
})

// ---- Actions panel

test("the actions panel starts with the footer's two verbs and adds per-kind ones", () => {
  const app = Model.appRows([{ entry: { id: "firefox.desktop", name: "Firefox" }, score: 1 }], "", { "app:firefox.desktop": { count: 1, last: NOW } }, { "firefox.desktop": 0 }, NOW)[0]
  const ids = Model.rowActions(app, { usage: { "app:firefox.desktop": { count: 1, last: NOW } }, pins: ["app:firefox.desktop"] }).map((a) => a.label)
  assert.deepEqual(ids, ["Focus", "Launch new", "Copy desktop id", "Unpin", "Reset ranking", "Hide"])

  const file = Model.fileRows(["/home/u/notes.md"], "notes", "/home/u")[0]
  assert.deepEqual(Model.rowActions(file, {}).map((a) => a.id), ["primary", "secondary", "copy-path", "terminal-here", "reveal"])

  const clip = Model.clipboardRows([{ type: "text", text: "hello", historyIndex: 3 }], "")[0]
  assert.deepEqual(Model.rowActions(clip, {}).map((a) => a.id), ["primary", "secondary", "delete-entry"])
})

test("deleting a clipboard entry rewrites the history without that index", () => {
  const raw = JSON.stringify([{ type: "text", text: "a" }, { type: "text", text: "b" }, "c"])
  assert.deepEqual(JSON.parse(Model.removeClipboardEntry(raw, 1)), [{ type: "text", text: "a" }, "c"])
  assert.equal(Model.removeClipboardEntry(raw, 7), null)
  assert.equal(Model.removeClipboardEntry("not json", 0), null)
})

// ---- Preview

test("previews come from the row: text inline, files and matches through a process", () => {
  const image = Model.fileRows(["/p/shot.png"], "", "/p")[0]
  assert.deepEqual(image.payload.preview, { type: "image", path: "/p/shot.png" })
  const dir = Model.fileRows(["/p/src/"], "", "/p")[0]
  assert.equal(dir.payload.preview, null)
  // fd prints folders without a trailing slash, so the same command has to
  // preview both. Run it for real on each.
  const fs = require("node:fs")
  const os = require("node:os")
  const path = require("node:path")
  const { execFileSync } = require("node:child_process")
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "omacast-"))
  fs.writeFileSync(path.join(root, "a.txt"), "hello\n")
  fs.mkdirSync(path.join(root, "sub"))
  const run = (p) => { const [cmd, ...args] = Model.previewCommand(Model.fileRows([p], "", root)[0].payload.preview); return execFileSync(cmd, args, { encoding: "utf8" }) }
  assert.equal(run(path.join(root, "a.txt")), "hello\n")
  assert.equal(run(root), "a.txt\nsub/\n")
  fs.rmSync(root, { recursive: true })
  const match = Model.fileRows(["/p/a.txt"], "", "/p", "TODO")[0]
  assert.deepEqual(Model.previewCommand(match.payload.preview).slice(-3), ["--", "TODO", "/p/a.txt"])

  const snippet = Model.snippetRows([{ name: "Today", keyword: "td", text: "{date format=\"yyyy\"}!" }], "td", {}, NOW)[0]
  assert.equal(Model.previewText(snippet.payload.preview, NOW), "2026!")
  assert.equal(Model.cleanPreview("a\u0000b"), "Binary file")
})

// ---- Script commands

const SCRIPT = `#!/bin/bash
# Required parameters:
# @raycast.schemaVersion 1
# @raycast.title Search Jira
# @raycast.mode silent
# Optional parameters:
# @raycast.icon 🔎
# @raycast.packageName Work
# @raycast.argument1 { "type": "text", "placeholder": "issue" }
# @raycast.argument2 { "type": "text", "placeholder": "note", "optional": true, "percentEncoded": true }
# @raycast.needsConfirmation true
open "https://jira/$1"
`

test("script headers parse exactly as Raycast writes them", () => {
  const meta = Model.parseScriptCommand(SCRIPT)
  assert.equal(meta.title, "Search Jira")
  assert.equal(meta.mode, "silent")
  assert.equal(meta.icon, "🔎")
  assert.equal(meta.packageName, "Work")
  assert.equal(meta.needsConfirmation, true)
  assert.deepEqual(meta.arguments.map((a) => [a.placeholder, a.optional, a.percentEncoded]), [["issue", false, false], ["note", true, true]])

  const js = Model.parseScriptCommand("// @raycast.schemaVersion 1\n// @raycast.title Clock\n// @raycast.mode inline\n// @raycast.refreshTime 1m\n")
  assert.deepEqual([js.mode, js.refreshMs], ["inline", 60000])
  const lua = Model.parseScriptCommand("-- @raycast.schemaVersion 1\n-- @raycast.title Lua one\n-- @raycast.icon ./icon.png\n")
  assert.deepEqual([lua.title, lua.mode, lua.icon], ["Lua one", "fullOutput", ""])
  assert.equal(Model.parseScriptCommand("#!/bin/sh\necho hi\n"), null)
  assert.equal(Model.parseScriptCommand("# @raycast.schemaVersion 2\n# @raycast.title Future\n"), null)
})

test("script rows take typed arguments, refuse to run without the required one, and flag non-executables", () => {
  const records = "\x1e/s/jira.sh\x1f1\x1f" + SCRIPT + "\x1e/s/README.md\x1f0\x1f# notes\n\x1e/s/off.sh\x1f0\x1f# @raycast.schemaVersion 1\n# @raycast.title Off\n"
  const scripts = Model.parseScriptRecords(records)
  assert.deepEqual(scripts.map((s) => [s.keyword, s.executable]), [["jira", true], ["off", false]])

  const ready = Model.scriptRows(scripts, 'jira ABC-1 "two words"', {}, NOW)[0]
  assert.deepEqual(ready.payload.args, ["ABC-1", "two%20words"])
  assert.equal(ready.promoted, true)
  assert.equal(ready.confirm, true)
  assert.equal(ready.frecencyKey, "sc:/s/jira.sh")

  const missing = Model.scriptRows(scripts, "jira", {}, NOW)[0]
  assert.equal(missing.payload.disabled, true)
  assert.equal(missing.primaryLabel, "Needs issue")

  const fuzzy = Model.scriptRows(scripts, "search ji", {}, NOW)[0]
  assert.equal(fuzzy.payload.complete, true)

  const off = Model.scriptRows(scripts, "off", {}, NOW)[0]
  assert.equal(off.subtitle, "not executable")
  assert.equal(off.payload.disabled, true)
})

test("splitArguments honours double quotes", () => {
  assert.deepEqual(Model.splitArguments('a "b c" d'), ["a", "b c", "d"])
  assert.deepEqual(Model.shellQuote("it's"), "'it'\\''s'")
})

// ---- Currency

test("ECB rates parse and convert through the euro, labelled with their date", () => {
  const xml = "<Cube time='2026-09-24'><Cube currency='USD' rate='1.1000'/><Cube currency='GBP' rate='0.8500'/><Cube currency='JPY' rate='160.00'/></Cube>"
  const rates = Model.parseEcbRates(xml)
  assert.equal(rates.date, "2026-09-24")
  assert.equal(Model.convertCurrency("100 usd to eur", rates).display, "90.91 EUR")
  assert.equal(Model.convertCurrency("€50 in gbp", rates).display, "42.50 GBP")
  assert.equal(Model.convertCurrency("100 euros in jpy", rates).display, "16000.00 JPY")
  assert.equal(Model.convertCurrency("100 euros in jpy", rates).subtitle, "rates 24 Sep")
  assert.equal(Model.convertCurrency("10 km to miles", rates), null)
  assert.equal(Model.parseEcbRates("<html/>"), null)
})

test("currency answers appear only when enabled, with a fetch row before the first download", () => {
  assert.equal(Model.answerRows("100 usd to eur", { now: NOW }).length, 0)
  const pending = Model.answerRows("100 usd to eur", { now: NOW, currency: { enabled: true, rates: null } })
  assert.equal(pending[0].payload.kind, "fetchRates")
  assert.equal(Model.normalizeConfig({}).currency, false)
  assert.equal(Model.normalizeConfig({ currency: true }).currency, true)
})

// ---- AI

test("the AI row needs three words or ask, and is off by default", () => {
  assert.deepEqual(Model.aiRows("firefox", "claude"), [])
  assert.equal(Model.aiRows("how do tides work", "claude")[0].title, "Ask claude")
  assert.equal(Model.aiRows("ask tides", "")[0].payload.prompt, "tides")
  assert.equal(Model.aiRows("ask tides", "")[0].title, "Ask agent")
  assert.equal(Model.normalizeConfig({}).ai, false)
  const sorted = Model.sortRows(Model.aiRows("how do tides work", "x").concat(Model.webRows("how do tides work", { name: "G", url: "u" })))
  assert.deepEqual(sorted.map((row) => row.payload.kind), ["ai", "web"])
})
