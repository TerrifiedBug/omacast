const test = require("node:test")
const assert = require("node:assert/strict")
const { mkdir, writeFile, access } = require("node:fs/promises")
const path = require("node:path")
const { createHash } = require("node:crypto")
const palette = require("./palette-harness")
const { marker, CONFIG, STATE } = palette
const has = key => state => state.rows.some(row => row.key === key)

async function script(dir, name = "example", mode = "silent") {
  const file = path.join(dir, ".config/omarchy/omacast/scripts", name + ".sh")
  await writeFile(file, '#!/bin/bash\n# @omacast.schemaVersion 1\n# @omacast.title Example task\n# @omacast.mode ' + mode + '\n# @omacast.argument1 {"type":"text","placeholder":"Value"}\nprintf "%s" "$1" > "$HOME/executed"\n', { mode: 0o700 })
  return file
}

test("disabled optional prefixes preserve configured keywords and ordinary launches dismiss", { timeout: 15000 }, async t => {
  const h = await palette(t, { config: { builtinQuicklinks: false, quicklinks: [{ name: "SSH search", keyword: "ssh", url: "https://example.test/?q={argument}" }] } })
  if (!h) return
  const state = await h.until(has("ql:ssh"), "open", { payload: { query: "ssh literal" } })
  assert.equal(state.sourceStatuses.ssh?.state, "disabled")
  const launched = marker(h.dir, "launch.log", text => text.includes("\nhttps://example.test/?q=literal\n"))
  const activated = await h.command("activate", { key: "ql:ssh" })
  assert.equal(activated.state.opened, false)
  assert.match(await launched, /https:\/\/example\.test\/\?q=literal/)
})

test("name admission completes the keyword without launching, while full-catalog aliases retain arguments", { timeout: 15000 }, async t => {
  const h = await palette(t, { config: { builtinQuicklinks: false, quicklinks: [
    { name: "Lookup fixture", keyword: "lookup", url: "https://example.test/{argument}" },
    { name: "Named resource", url: "https://example.test/named/{argument}" }
  ] }, state: { aliases: { "ql:Named resource": "jump" } } })
  if (!h) return
  await h.until(has("ql:lookup"), "open", { payload: { query: "Lookup fixture" } })
  let result = await h.command("activate", { key: "ql:lookup" })
  assert.equal(result.state.opened, true)
  assert.equal(result.state.query, "lookup ")
  await assert.rejects(access(path.join(h.dir, "launch.log")), { code: "ENOENT" })
  await h.until(has("ql:Named resource"), "query", { query: "jump literal value" })
  const launched = marker(h.dir, "launch.log", text => text.includes("\nhttps://example.test/named/literal%20value\n"))
  result = await h.command("activate", { key: "ql:Named resource" })
  assert.equal(result.state.opened, false)
  assert.match(await launched, /named\/literal%20value/)
})

test("root has no idle provider rows", { timeout: 15000 }, async t => {
  const h = await palette(t)
  if (!h) return
  const result = await h.command("open")
  assert.equal(result.state.rows.some(row => row.section === "status"), false)
})

test("script form retains terminal intent and valid typed arguments skip the form", { timeout: 20000 }, async t => {
  const h = await palette(t, { prepare: dir => script(dir) })
  if (!h) return
  const key = "sc:" + path.join(h.dir, ".config/omarchy/omacast/scripts/example.sh")
  await h.until(has(key), "open", { payload: { query: "Example task" } })
  let result = await h.command("action", { key, action: "run-terminal" })
  assert.equal(result.state.scriptForm, key)
  const terminal = marker(h.dir, "launch.log", text => text.includes("omarchy-launch-floating-terminal-with-presentation\n") && text.includes("literal argument"))
  result = await h.command("form", { values: ["literal argument"] })
  assert.equal(result.state.opened, false, result.state.notice)
  assert.match(await terminal, /omarchy-launch-floating-terminal-with-presentation/)
  await assert.rejects(access(path.join(h.dir, "executed")), { code: "ENOENT" })
  await h.until(has(key), "open", { payload: { query: "example direct" } })
  const executed = marker(h.dir, "executed", text => text === "direct")
  result = await h.command("activate", { key })
  assert.equal(result.state.scriptForm, "")
  assert.equal(result.state.opened, false)
  assert.equal(await executed, "direct")
})

test("script completion remains available with forms disabled", { timeout: 15000 }, async t => {
  const h = await palette(t, { config: { scriptForms: false }, prepare: dir => script(dir) })
  if (!h) return
  const key = "sc:" + path.join(h.dir, ".config/omarchy/omacast/scripts/example.sh")
  await h.until(has(key), "open", { payload: { query: "Example task" } })
  const result = await h.command("activate", { key })
  assert.equal(result.state.opened, true)
  assert.equal(result.state.query, "example ")
  assert.equal(result.state.scriptForm, "")
  await assert.rejects(access(path.join(h.dir, "executed")), { code: "ENOENT" })
})

test("project navigation dismisses before its launch and records usage", { timeout: 15000 }, async t => {
  const h = await palette(t, { config: dir => ({ projectsEnabled: true, projectRoots: [path.join(dir, "projects")] }),
    prepare: dir => mkdir(path.join(dir, "projects/alpha"), { recursive: true }) })
  if (!h) return
  const key = "project:" + encodeURIComponent(path.join(h.dir, "projects/alpha"))
  await h.until(has(key), "open", { payload: { query: "proj alpha" } })
  const launched = marker(h.dir, "launch.log", text => text.includes("xdg-open\n" + path.join(h.dir, "projects/alpha") + "\n"))
  const result = await h.command("activate", { key })
  assert.equal(result.state.opened, false)
  assert.match(await launched, /xdg-open/)
  const persisted = await marker(h.dir, STATE, text => JSON.parse(text).usage?.[key]?.count === 1)
  assert.equal(JSON.parse(persisted).usage[key].count, 1)
})

test("checked interactive menu actions dismiss instead of occupying the toggle runner", { timeout: 15000 }, async t => {
  const h = await palette(t, { menu: { capture: { label: "Capture fixture", action: "omarchy-capture-screenshot", checked: "true" } } })
  if (!h) return
  await h.until(has("menu:capture"), "open", { payload: { query: "Capture fixture" } })
  const launched = marker(h.dir, "launch.log", text => text.includes("omarchy-capture-screenshot\n"))
  const closed = h.changed(state => !state.opened)
  await h.command("activate", { key: "menu:capture" })
  await closed
  assert.match(await launched, /omarchy-capture-screenshot/)
})

test("changed command confirmation re-arms and learning uses the ranked trimmed context", { timeout: 20000 }, async t => {
  const command = text => ({ name: "Deploy fixture", keyword: "deploy", command: 'printf "' + text + '" > "$HOME/executed"', confirm: true })
  const h = await palette(t, { config: { queryLearning: true, commands: [command("old")] } })
  if (!h) return
  await h.until(has("cmd:Deploy fixture"), "open", { payload: { query: "  deploy  " } })
  let result = await h.command("activate", { key: "cmd:Deploy fixture" })
  assert.equal(result.state.confirmKey, "cmd:Deploy fixture")
  const fresh = h.changed(state => state.configDoc.commands[0]?.command === command("new").command)
  await h.put(CONFIG, JSON.stringify({ currency: false, ai: false, preview: false, queryLearning: true, commands: [command("new")] }))
  await fresh
  result = await h.command("activate", { key: "cmd:Deploy fixture" })
  assert.equal(result.state.opened, true)
  await assert.rejects(access(path.join(h.dir, "executed")), { code: "ENOENT" })
  const executed = marker(h.dir, "executed", text => text === "new")
  await h.command("activate", { key: "cmd:Deploy fixture" })
  assert.equal(await executed, "new")
  const context = createHash("md5").update("root\0deploy").digest("hex")
  const stored = JSON.parse(await marker(h.dir, STATE, text => JSON.parse(text).queryHistory?.[context]?.["cmd:Deploy fixture"]?.count === 1))
  assert.equal(stored.queryHistory[context]["cmd:Deploy fixture"].count, 1)
})
