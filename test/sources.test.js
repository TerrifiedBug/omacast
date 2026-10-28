const test = require("node:test")
const assert = require("node:assert/strict")
const { mkdir, writeFile, chmod } = require("node:fs/promises")
const { execFileSync } = require("node:child_process")
const path = require("node:path")
const harness = require("./qml-harness.js")

const CONFIG = ".config/omarchy/omacast.json"
const STATE = ".local/state/omarchy/omacast-state.json"

async function sources(t, config = "{}") {
  const h = await harness(t, {
    harness: "sources-harness.qml",
    files: harness.sourceFiles,
    env: dir => ({ PATH: `${path.join(dir, "bin")}:${process.env.PATH}` }),
    prepare: async dir => {
      for (const folder of [".config/omarchy", ".config/hypr", ".local/state/omarchy", "files", "bin", "omarchy/bin"])
        await mkdir(path.join(dir, folder), { recursive: true })
      await writeFile(path.join(dir, CONFIG), config)
      await writeFile(path.join(dir, STATE), JSON.stringify({ pins: ["app:initial"], future: { keep: true } }))
      await writeFile(path.join(dir, ".config/hypr/bindings.lua"), "-- unrelated user bindings\n")
      await writeFile(path.join(dir, "binds.json"), "[]")
      await writeFile(path.join(dir, "bin/hyprctl"), '#!/bin/sh\nif [ "$1" = "-j" ] && [ "$2" = "binds" ]; then cat "$HOME/binds.json"; fi\n', { mode: 0o755 })
      await writeFile(path.join(dir, "binding-records"), "")
      await writeFile(path.join(dir, "omarchy/bin/omarchy-menu-keybindings"), 'output_binding_records_uncached() { cat "$HOME/binding-records"; }\n')
      await writeFile(path.join(dir, "paste-mode"), "small\n")
      await writeFile(path.join(dir, "bin/wl-paste"), `#!/bin/bash
IFS= read -r mode < "$HOME/paste-mode"
case "$mode" in
  large) head -c 70000 /dev/zero | tr '\\0' x ;;
  slow) sleep 30; printf obsolete ;;
  *) case " $* " in *" --primary "*) printf selection;; *) printf clipboard;; esac ;;
esac
`, { mode: 0o755 })
    }
  })
  if (h) await h.command("open")
  return h
}

test("Sources refuses malformed config and resumes editing repaired custom entries", { timeout: 15000 }, async t => {
  const broken = '{"quicklinks": [ // unfinished'
  const h = await sources(t, broken)
  if (!h) return
  const reply = await h.command("config", { edit: { op: "set", key: "preview", value: false } })
  assert.equal(await h.bytes(CONFIG), broken)
  assert.equal(reply.result, false)
  assert.ok(reply.state.error)
  assert.deepEqual(reply.state.templateFailures, [])
  const repaired = h.changed(state => state && state.config.quicklinks.length === 1 && !state.error)
  await h.put(CONFIG, JSON.stringify({
    quicklinks: [{ name: "Work", keyword: "work", url: "https://example.test/{argument}", future: { keep: 1 } }],
    future: { keep: 2 }
  }))
  await repaired
  const saved = await h.command("config", { edit: { op: "set", key: "preview", value: false } })
  assert.equal(saved.result, true)
  const disk = JSON.parse(await h.bytes(CONFIG))
  assert.equal(disk.preview, false)
  assert.equal(disk.quicklinks[0].url, "https://example.test/{argument}")
  assert.deepEqual(disk.quicklinks[0].future, { keep: 1 })
  assert.deepEqual(disk.future, { keep: 2 })
})

test("Sources pin hide and ranking changes survive immediate destruction and recreation", { timeout: 15000 }, async t => {
  const h = await sources(t)
  if (!h) return
  const reply = await h.command("mutateAndDestroy")
  const disk = JSON.parse(await h.bytes(STATE))
  assert.deepEqual(disk.pins, ["app:initial", "app:new"])
  assert.deepEqual(disk.hidden, ["app:hidden"])
  assert.equal(disk.usage["app:new"].count, 1)
  assert.deepEqual(disk.future, { keep: true })
  assert.deepEqual(reply.result.pins, disk.pins)
  const reopened = await h.command("open")
  assert.deepEqual(reopened.state.store.pins, disk.pins)
  assert.deepEqual(reopened.state.store.hidden, disk.hidden)
  assert.equal(reopened.state.store.usage["app:new"].count, 1)
})

test("Sources transports a newline filename through discovery metadata and preview", { timeout: 15000 }, async t => {
  const h = await sources(t)
  if (!h) return
  const file = path.join(h.dir, "files", "-tab\tand\nnewline.txt")
  await writeFile(file, "needle\n")
  const found = h.changed(state => state && state.files.includes(file))
  await h.command("files")
  const state = await found
  assert.deepEqual(state.files, [file])
  const preview = h.changed(state => state && state.preview.key === "newline")
  await h.command("preview", { key: "newline", spec: { type: "file", path: file } })
  assert.equal((await preview).preview.text, "needle\n")
})

test("Sources cancels oversized and timed-out clipboard templates and accepts the next action", { timeout: 15000 }, async t => {
  const h = await sources(t)
  if (!h) return
  await h.put("paste-mode", "large\n")
  const oversized = h.changed(state => state && state.templateFailures.some(text => /exceeds 64 KiB/.test(text)))
  await h.command("template", { template: "prefix:{clipboard}" })
  assert.deepEqual((await oversized).expansions, [])
  await h.put("paste-mode", "slow\n")
  const timedOut = h.changed(state => state && state.templateFailures.some(text => /timed out/.test(text)))
  await h.command("template", { template: "obsolete:{clipboard}" })
  assert.deepEqual((await timedOut).expansions, [])
  await h.put("paste-mode", "small\n")
  const expanded = h.changed(state => state && state.expansions.length === 1)
  await h.command("template", { template: "{clipboard}/{selection}" })
  assert.deepEqual((await expanded).expansions, ["clipboard/selection"])
})

test("cancelled preview output cannot replace a new request with the same row key", { timeout: 15000 }, async t => {
  const h = await sources(t)
  if (!h) return
  const blocked = path.join(h.dir, "files", "blocked")
  const fresh = path.join(h.dir, "files", "fresh.txt")
  execFileSync("mkfifo", ["--", blocked])
  await writeFile(fresh, "fresh\n")
  const ready = h.changed(state => state && state.preview.key === "same" && state.preview.text === "fresh\n")
  await h.command("replacePreview", {
    key: "same",
    previous: { type: "file", path: blocked },
    spec: { type: "file", path: fresh }
  })
  const state = await ready
  assert.deepEqual(state.previews.filter(preview => preview.key === "same").map(preview => preview.text), ["fresh\n"])
})

test("window shortcut write failure preserves disk and live settings until retry succeeds", { timeout: 15000 }, async t => {
  const h = await sources(t)
  if (!h) return
  const loaded = h.changed(state => state && state.bindingsLoaded)
  if (!(await h.command("snapshot")).state.bindingsLoaded) await loaded
  const bindings = ".config/hypr/bindings.lua"
  const original = await h.bytes(bindings)
  let denied
  await chmod(path.join(h.dir, ".config/hypr"), 0o555)
  try {
    denied = await h.command("windowBind", { action: "place-left", chord: "SUPER + ALT + LEFT" })
  } finally {
    await chmod(path.join(h.dir, ".config/hypr"), 0o755)
  }
  assert.equal(denied.result, false)
  assert.deepEqual(denied.state.windowBinds, {})
  assert.equal(await h.bytes(bindings), original)
  assert.ok(denied.state.notices.some(text => text.includes("Could not write bindings.lua")))
  const retried = await h.command("windowBind", { action: "place-left", chord: "SUPER + ALT + LEFT" })
  assert.equal(retried.result, true)
  assert.equal(retried.state.windowBinds["place-left"], "SUPER + ALT + LEFT")
  assert.ok((await h.bytes(bindings)).startsWith(original))
})

test("shortcut checks use fresh compositor bindings and never write on rejection", { timeout: 15000 }, async t => {
  const h = await sources(t)
  if (!h) return
  const bindings = ".config/hypr/bindings.lua"
  const original = await h.bytes(bindings)
  const binding = { key: "Left", modmask: 72, submap: "", description: "Move workspace", dispatcher: "movewindow", arg: "l" }
  await h.put("binds.json", JSON.stringify([binding]))
  const blocked = await h.command("checkedWindowBind", { chord: "ALT + SUPER + LEFT", owner: "window:place-left", action: "place-left" })
  assert.match(blocked.result.error, /ALT \+ SUPER \+ LEFT.*Move workspace/)
  assert.equal(blocked.result.saved, false)
  assert.equal(await h.bytes(bindings), original)
  await h.put("binds.json", "[]")
  const safe = await h.command("checkShortcut", { chord: "SUPER + ALT + LEFT", owner: "window:place-left" })
  assert.equal(safe.result.error, "")
  assert.equal(await h.bytes(bindings), original)
  await h.put("binds.json", "not json")
  const malformed = await h.command("checkedWindowBind", { chord: "SUPER + ALT + LEFT", owner: "window:place-left", action: "place-left" })
  assert.match(malformed.result.error, /Could not inspect/)
  assert.equal(await h.bytes(bindings), original)
  await h.put("bin/hyprctl", "#!/bin/sh\nexit 1\n")
  const failed = await h.command("checkedWindowBind", { chord: "SUPER + ALT + LEFT", owner: "window:place-left", action: "place-left" })
  assert.match(failed.result.error, /Could not inspect/)
  assert.equal(await h.bytes(bindings), original)
})

test("shortcut checks include saved bindings before the compositor reloads", { timeout: 15000 }, async t => {
  const h = await sources(t)
  if (!h) return
  const loaded = h.changed(state => state && state.bindingsLoaded)
  if (!(await h.command("snapshot")).state.bindingsLoaded) await loaded
  const saved = await h.command("checkedWindowBind", { chord: "SUPER + ALT + LEFT", owner: "window:place-left", action: "place-left" })
  assert.equal(saved.result.error, "")
  assert.equal(saved.result.saved, true)
  const own = await h.command("checkShortcut", { chord: "ALT + SUPER + LEFT", owner: "window:place-left" })
  assert.equal(own.result.error, "")
  const other = await h.command("checkShortcut", { chord: "ALT + SUPER + LEFT", owner: "window:next-display" })
  assert.match(other.result.error, /OmaCast place-left/)
})

test("shortcut checks freshly resolve missing Lua keys without flattening submaps", { timeout: 15000 }, async t => {
  const h = await sources(t)
  if (!h) return
  const binding = { key: "", keycode: 0, modmask: 68, submap: "", description: "Bar panel 1", dispatcher: "__lua" }
  await h.put("binds.json", JSON.stringify([binding]))
  await h.put("binding-records", "SUPER + CTRL + 1 → Bar panel 1\t__lua\t\n")
  const conflict = await h.command("checkShortcut", { chord: "SUPER + CTRL + 1", owner: "palette" })
  assert.match(conflict.result.error, /Bar panel 1/)
  await h.put("binding-records", "SUPER + CTRL + 2 → Bar panel 1\t__lua\t\n")
  const fresh = await h.command("checkShortcut", { chord: "SUPER + CTRL + 1", owner: "palette" })
  assert.equal(fresh.result.error, "")
  await h.put("binds.json", JSON.stringify([{ ...binding, submap: "resize" }]))
  await h.put("binding-records", "")
  const unrelated = await h.command("checkShortcut", { chord: "SUPER + CTRL + 1", owner: "palette" })
  assert.equal(unrelated.result.error, "")
})
