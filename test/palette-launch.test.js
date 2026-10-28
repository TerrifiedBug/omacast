const test = require("node:test")
const assert = require("node:assert/strict")
const { writeFile, access } = require("node:fs/promises")
const path = require("node:path")
const palette = require("./palette-harness")
const { marker } = palette
const has = key => state => state.rows.some(row => row.key === key)

for (const type of ["open", "url", "argv"]) {
  test("typed script " + type + " result dismisses and launches without an owned GUI lifetime", { timeout: 20000 }, async t => {
    const h = await palette(t, { prepare: async dir => {
      const action = type === "open" ? { type, path: path.join(dir, "literal path") }
        : type === "url" ? { type, url: "https://example.test/literal" }
          : { type, argv: ["bash", "-c", 'printf launched > "$HOME/executed"'] }
      const output = [{ version: 1 }, { id: "chosen", title: "Chosen typed result", action }].map(JSON.stringify).join("\n") + "\n"
      await writeFile(path.join(dir, ".config/omarchy/omacast/scripts/results.sh"),
        '#!/bin/bash\n# @omacast.schemaVersion 1\n# @omacast.title Fixture results\n# @omacast.mode results\nprintf "%s" ' + "'" + output.replace(/'/g, "'\\''") + "'\n", { mode: 0o700 })
    } })
    if (!h) return
    const scriptKey = "sc:" + path.join(h.dir, ".config/omarchy/omacast/scripts/results.sh")
    await h.until(has(scriptKey), "open", { payload: { query: "results" } })
    const ready = h.changed(state => state.scriptResults.status === "ready" && state.rows.some(row => row.section === "scriptResults"))
    await h.command("activate", { key: scriptKey })
    const state = await ready
    const key = state.rows.find(row => row.section === "scriptResults").key
    const filtered = await h.command("query", { query: "Chosen" })
    assert.ok(filtered.state.rows.some(row => row.key === key))
    if (type === "argv") {
      const armed = await h.command("activate", { key })
      assert.equal(armed.state.opened, true)
      assert.equal(armed.state.confirmKey, key)
      await assert.rejects(access(path.join(h.dir, "executed")), { code: "ENOENT" })
    }
    const launched = marker(h.dir, type === "argv" ? "executed" : "launch.log", text =>
      type === "argv" ? text === "launched"
        : text.includes("\n" + (type === "open" ? path.join(h.dir, "literal path") : "https://example.test/literal") + "\n"))
    const result = await h.command("activate", { key })
    assert.equal(result.state.opened, false)
    const text = await launched
    if (type === "open") assert.match(text, /literal path/)
    else if (type === "url") assert.match(text, /https:\/\/example\.test\/literal/)
    else assert.equal(text, "launched")
  })
}

test("a real in-place toggle keeps query and selection while refreshing its checkmark", { timeout: 20000 }, async t => {
  const h = await palette(t, { menu: { nightlight: { label: "Nightlight fixture", action: "omarchy-toggle-nightlight", checked: '[ -f "$HOME/toggled" ]' } },
    prepare: dir => writeFile(path.join(dir, "bin/omarchy-toggle-nightlight"), '#!/bin/bash\nprintf toggled > "$HOME/toggled"\n', { mode: 0o700 }) })
  if (!h) return
  await h.until(has("menu:nightlight"), "open", { payload: { query: "Nightlight fixture" } })
  const checked = h.changed(state => state.rows.some(row => row.key === "menu:nightlight" && row.title.includes("✓")))
  await h.command("activate", { key: "menu:nightlight" })
  const state = await checked
  assert.equal(state.opened, true)
  assert.equal(state.query, "Nightlight fixture")
  assert.equal(state.rows[state.selectedIndex].key, "menu:nightlight")
})

test("Unicode app fallback admits a folded name from the real desktop catalog", { timeout: 20000 }, async t => {
  const h = await palette(t, { prepare: dir => writeFile(path.join(dir, "data/applications/unicode-fixture.desktop"),
    "[Desktop Entry]\nType=Application\nName=Café fixture\nExec=true\nTerminal=false\n") })
  if (!h) return
  const state = await h.until(state => state.rows.some(row => row.section === "apps" && row.title === "Café fixture"),
    "open", { payload: { query: "Cafe fixture" } })
  assert.ok(state.rows.some(row => row.section === "apps" && row.title === "Café fixture"))
})
