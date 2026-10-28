const test = require("node:test")
const assert = require("node:assert/strict")
const { mkdtemp, writeFile, rename, rm } = require("node:fs/promises")
const os = require("node:os")
const path = require("node:path")
const { marker } = require("./palette-harness")

function gate() {
  let release
  const reached = new Promise(resolve => { release = resolve })
  return { reached, release }
}

async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "omacast-marker-"))
  const controller = new AbortController()
  t.after(async () => {
    controller.abort()
    await rm(dir, { recursive: true, force: true })
  })
  return { dir, signal: controller.signal }
}

async function observedBeforeCompletion(observed, completed) {
  await Promise.race([
    observed,
    completed.then(() => assert.fail("Marker completed before its consumer data was ready"))
  ])
}

test("marker waits through empty and partial command output for the expected argument", { timeout: 10000 }, async t => {
  const { dir, signal } = await fixture(t)
  const empty = gate()
  const partial = gate()
  const target = "literal argument"
  const completed = marker(dir, "executed", text => {
    if (text === "") empty.release()
    if (text === "literal") partial.release()
    return text === target
  }, { signal })
  // Attach a rejection handler before producing events, including on test failure.
  completed.catch(() => {})
  await writeFile(path.join(dir, "executed"), "")
  await observedBeforeCompletion(empty.reached, completed)
  await writeFile(path.join(dir, "executed"), "literal")
  await observedBeforeCompletion(partial.reached, completed)
  await writeFile(path.join(dir, "executed"), target)
  assert.equal(await completed, target)
})

test("marker tolerates incomplete JSON and replacement until the requested usage is persisted", { timeout: 10000 }, async t => {
  const { dir, signal } = await fixture(t)
  const empty = gate()
  const partial = gate()
  const previous = gate()
  const filename = "state.json"
  const completed = marker(dir, filename, text => {
    if (text === "") empty.release()
    if (text === '{"usage":') partial.release()
    const state = JSON.parse(text)
    if (state.usage?.chosen?.count === 1) previous.release()
    return state.usage?.chosen?.count === 2
  }, { signal })
  completed.catch(() => {})
  await writeFile(path.join(dir, filename), "")
  await observedBeforeCompletion(empty.reached, completed)
  await writeFile(path.join(dir, filename), '{"usage":')
  await observedBeforeCompletion(partial.reached, completed)
  await writeFile(path.join(dir, filename), JSON.stringify({ usage: { chosen: { count: 1 } } }))
  await observedBeforeCompletion(previous.reached, completed)
  await rm(path.join(dir, filename))
  await writeFile(path.join(dir, "replacement.json"), JSON.stringify({ usage: { chosen: { count: 2 } } }))
  await rename(path.join(dir, "replacement.json"), path.join(dir, filename))
  assert.equal(JSON.parse(await completed).usage.chosen.count, 2)
})

test("marker cancellation releases an unfinished wait", { timeout: 10000 }, async t => {
  const { dir, signal } = await fixture(t)
  const controller = new AbortController()
  const observed = gate()
  const completed = marker(dir, "executed", text => {
    if (text === "started") observed.release()
    return text === "finished"
  }, { signal: controller.signal })
  const cancelled = assert.rejects(completed, error => error === controller.signal.reason)
  signal.addEventListener("abort", () => controller.abort(), { once: true })
  await writeFile(path.join(dir, "executed"), "started")
  await observed.reached
  controller.abort(new Error("Fixture cancelled"))
  await cancelled
})
