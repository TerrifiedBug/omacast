const test = require("node:test")
const assert = require("node:assert/strict")
const { mkdir, writeFile } = require("node:fs/promises")
const path = require("node:path")
const palette = require("./palette-harness")

test("semantic shortlist is query-ranked and shares its cap across the actual catalog sections", { timeout: 20000 }, async t => {
  const h = await palette(t, { config: { builtinQuicklinks: false,
    quicklinks: [{ name: "Visible link", keyword: "visible", url: "https://example.test/" }, { name: "Hidden link", keyword: "hidden", url: "https://example.test/hidden" }],
    commands: [{ name: "Visible command", keyword: "visiblecmd", command: "true" }] },
    state: { hidden: ["ql:hidden"] }, prepare: async dir => {
      for (let index = 0; index < 40; index++) {
        const name = index === 39 ? "Preferred fixture" : "Application fixture " + index
        await writeFile(path.join(dir, "data/applications/fixture-" + index + ".desktop"),
          "[Desktop Entry]\nType=Application\nName=" + name + "\nExec=true\nTerminal=false\n")
      }
    } })
  if (!h) return
  await h.until(state => state.rows.some(row => row.section === "apps" && row.title === "Preferred fixture"), "open", { payload: { query: "Preferred fixture" } })
  const { candidates } = await h.command("semanticCandidates")
  assert.equal(candidates.length, 32)
  assert.equal(candidates.filter(row => row.key.startsWith("app:"))[0].title, "Preferred fixture")
  assert.ok(candidates.some(row => row.key === "ql:visible"))
  assert.ok(candidates.some(row => row.key === "cmd:Visible command"))
  assert.equal(candidates.some(row => row.key === "ql:hidden"), false)
})

test("picker title filtering works without a subtitle and never indexes undefined as content", { timeout: 15000 }, async t => {
  const h = await palette(t, { prepare: async dir => {
    const folder = path.join(dir, "runtime/omacast-palette-picker")
    await mkdir(folder, { mode: 0o700 })
    await writeFile(path.join(folder, "request.json"), JSON.stringify({ version: 1, id: "1".repeat(32),
      deadline: Date.now() / 1000 + 120, prompt: "Pick a fixture", items: [{ id: "one", title: "Alpha choice", value: "literal value" }] }), { mode: 0o600 })
  } })
  if (!h) return
  await h.until(state => state.picker.status === "ready" && state.rows.some(row => row.section === "picker"), "open",
    { payload: { pickerPath: path.join(h.dir, "runtime/omacast-palette-picker/request.json") } })
  let result = await h.command("query", { query: "Alpha" })
  assert.equal(result.state.rows.filter(row => row.section === "picker").length, 1)
  result = await h.command("query", { query: "undefined" })
  assert.equal(result.state.rows.filter(row => row.section === "picker").length, 0)
  result = await h.command("escape")
  assert.equal(result.state.opened, false)
})

