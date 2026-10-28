const assert = require("node:assert/strict")
const test = require("node:test")
const harness = require("./qml-harness.js")

async function open(t) {
  const q = await harness(t, { files: ["ActionRunner.qml", "ActionPolicy.js"], harness: "action-runner-harness.qml" })
  if (q) await q.command("open")
  return q
}

async function action(q, key, argv, timeout) {
  const finished = q.changed(state => state.results.some(result => result.key === key))
  const accepted = await q.command("run", { key, argv, timeout })
  assert.equal(accepted.result, true)
  return (await finished).results.find(result => result.key === key)
}

test("runner reports actual exit, bounded literal output and missing executable", { timeout: 15000 }, async t => {
  const q = await open(t)
  if (!q) return
  const literal = "$(false); ' spaces\n"
  const success = await action(q, "literal", ["python3", "-c", "import sys; print(sys.argv[1],end='')", literal])
  assert.equal(success.ok, true)
  assert.equal(success.output, literal)
  assert.equal((await action(q, "missing", ["/nonexistent/omacast-action"])).status, "missing")
  assert.equal((await action(q, "failure", ["python3", "-c", "raise SystemExit(19)"])).status, "nonzero")
  const truncated = await action(q, "cap", ["python3", "-c", "import sys; sys.stderr.write('x'*1000000)"])
  assert.equal(truncated.status, "truncated")
  assert.equal(truncated.ok, false)
  assert.equal(truncated.output.length, 65536)
})

test("runner serializes ownership and never reports scheduling as success", { timeout: 15000 }, async t => {
  const q = await open(t)
  if (!q) return
  const done = q.changed(state => state.results.some(result => result.key === "cancel"))
  const accepted = await q.command("run", { key: "cancel", argv: ["sleep", "30"], timeout: 5000 })
  assert.equal(accepted.result, true)
  assert.equal(accepted.state.busy, true)
  assert.equal(accepted.state.results.length, 0)
  assert.equal((await q.command("run", { key: "replacement", argv: ["true"] })).result, false)
  await q.command("cancel")
  const state = await done
  assert.equal(state.results[0].status, "cancelled")
  assert.equal(state.results[0].ok, false)
  assert.equal(state.busy, false)
  assert.equal((await action(q, "after", ["true"])).status, "success")
  assert.equal((await action(q, "timeout", ["sleep", "30"], 50)).status, "timeout")
})

test("cancellation after process exit cannot replace the real result", { timeout: 15000 }, async t => {
  const q = await open(t)
  if (!q) return
  await q.command("cancelAtCompletion")
  const success = await action(q, "completed", ["true"])
  assert.equal(success.status, "success")
  assert.equal(success.ok, true)
  const failure = await action(q, "failed", ["python3", "-c", "raise SystemExit(2)"])
  assert.equal(failure.status, "nonzero")
  assert.equal(failure.ok, false)
})
