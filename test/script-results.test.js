const test = require("node:test")
const assert = require("node:assert/strict")
const { writeFile, access, readFile } = require("node:fs/promises")
const { watch } = require("node:fs")
const path = require("node:path")
const harness = require("./qml-harness")

const quote = value => "'" + String(value).replace(/'/g, "'\\''") + "'"
const protocol = rows => [{ version: 1 }, ...rows].map(JSON.stringify).join("\n") + "\n"
const copy = text => ({ id: "answer", title: "<b>plain result</b>", action: { type: "copy", text } })
const files = ["ScriptResults.qml", "ScriptModel.js"]
async function fixture(t, prepare) {
  return harness(t, { files, harness: "script-results-harness.qml", prepare })
}
async function script(dir, name, body, mode = 0o700) {
  await writeFile(path.join(dir, name), "#!/bin/bash\n" + body + "\n", { mode })
}
function output(rows) { return "printf '%s' " + quote(protocol(rows)) }

// Register before inspecting to avoid missing a fast process-created marker.
function marker(dir, name) {
  return new Promise((resolve, reject) => {
    let stopped = false
    const watcher = watch(dir, () => check())
    const deadline = setTimeout(() => finish(new Error("Missing process marker: " + name)), 5000)
    function finish(error, text) {
      if (stopped) return
      stopped = true
      watcher.close()
      clearTimeout(deadline)
      if (error) reject(error)
      else resolve(text)
    }
    async function check() {
      try { finish(null, await readFile(path.join(dir, name), "utf8")) }
      catch (error) { if (error.code !== "ENOENT") finish(error) }
    }
    check()
  })
}

test("real results are selectable plain records, never automatic returned actions", { timeout: 15000 }, async t => {
  const h = await fixture(t, async dir => script(dir, "results", output([
    copy("literal"), { id: "command", title: "Do not run yet", action: { type: "argv", argv: ["touch", path.join(dir, "executed")] } }
  ])))
  if (!h) return
  const ready = h.changed(state => state.status === "ready")
  const started = await h.command("run", { file: "results" })
  assert.equal(started.result, true)
  const state = await ready
  assert.equal(state.records[0].title, "<b>plain result</b>")
  const resolved = await h.command("resolve", { resultId: "command", requestId: state.requestId })
  assert.equal(resolved.result.needsConfirmation, true)
  assert.deepEqual(resolved.result.action.argv, ["touch", path.join(h.dir, "executed")])
  await assert.rejects(access(path.join(h.dir, "executed")))
  await h.command("cancel")
  assert.equal((await h.command("resolve", { resultId: "command", requestId: state.requestId })).result, null)
})

test("replacement cancels the actual old process group and rejects old result identity", { timeout: 15000 }, async t => {
  const h = await fixture(t, async dir => {
    await script(dir, "old", "trap " + quote("printf stopped > " + quote(path.join(dir, "stopped")) + "; exit 0") + " TERM\n"
      + output([copy("old")]) + "\nprintf ready > " + quote(path.join(dir, "started")) + "\nsleep 30")
    await script(dir, "new", output([copy("new")]))
  })
  if (!h) return
  const begun = marker(h.dir, "started")
  const first = await h.command("run", { file: "old" })
  await begun
  const stopped = marker(h.dir, "stopped")
  const ready = h.changed(state => state.status === "ready")
  await h.command("run", { file: "new" })
  const state = await ready
  await stopped
  assert.equal(state.records[0].action.text, "new")
  assert.equal((await h.command("resolve", { resultId: "answer", requestId: first.state.requestId })).result, null)
  assert.equal((await h.command("resolve", { resultId: "answer", requestId: state.requestId })).result.action.text, "new")
})

test("explicit cancellation terminates an active group and invalidates its identity", { timeout: 15000 }, async t => {
  const h = await fixture(t, dir => script(dir, "waiting",
    "trap " + quote("printf stopped > " + quote(path.join(dir, "stopped")) + "; exit 0") + " TERM\n"
    + output([copy("cancelled output")]) + "\nprintf ready > " + quote(path.join(dir, "started")) + "\nsleep 30"))
  if (!h) return
  const begun = marker(h.dir, "started")
  const initial = await h.command("run", { file: "waiting" })
  await begun
  const stopped = marker(h.dir, "stopped")
  const cancelled = await h.command("cancel")
  await stopped
  assert.equal(cancelled.state.status, "cancelled")
  assert.deepEqual(cancelled.state.records, [])
  assert.ok(cancelled.state.requestId > initial.state.requestId)
  assert.equal((await h.command("resolve", { resultId: "answer", requestId: initial.state.requestId })).result, null)
})

test("nonexecutable, malformed, oversize and failed script output publishes no actions", { timeout: 20000 }, async t => {
  const h = await fixture(t, async dir => {
    await script(dir, "disabled", output([copy("bad")]), 0o600)
    await script(dir, "broken", "printf '%s' " + quote(protocol([copy("partial")]) + "not json\n"))
    await script(dir, "large", "head -c 100000 /dev/zero")
    await script(dir, "failed", output([copy("bad")]) + "\nexit 17")
  })
  if (!h) return
  for (const [file, status] of [["disabled", "failed"], ["broken", "failed"], ["large", "truncated"], ["failed", "failed"]]) {
    const done = h.changed(state => state.status === status)
    await h.command("run", { file })
    const state = await done
    assert.deepEqual(state.records, [])
    assert.ok(state.error)
    if (file === "failed") assert.doesNotMatch(state.error, /122/)
  }
})

test("ten second deadline terminates an actual stalled script without publishing its output", { timeout: 20000 }, async t => {
  const h = await fixture(t, dir => script(dir, "stalled", output([copy("must not publish")]) + "\nsleep 30"))
  if (!h) return
  const timedOut = h.changed(state => state.status === "timeout")
  await h.command("run", { file: "stalled" })
  const state = await timedOut
  assert.deepEqual(state.records, [])
  assert.match(state.error, /10 seconds/)
})

test("scripts run in the configured home directory", { timeout: 15000 }, async t => {
  const h = await fixture(t, dir => script(dir, "cwd",
    "printf '%s\\n' '{\"version\":1}'\n"
    + "printf '{\"id\":\"cwd\",\"title\":\"Directory\",\"action\":{\"type\":\"copy\",\"text\":\"%s\"}}\\n' \"$PWD\""))
  if (!h) return
  const ready = h.changed(state => state.status === "ready")
  await h.command("run", { file: "cwd" })
  const state = await ready
  assert.equal(state.records[0].action.text, h.dir)
})
