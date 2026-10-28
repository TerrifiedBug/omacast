const test = require("node:test")
const assert = require("node:assert/strict")
const harness = require("./qml-harness")

async function fixture(t) {
  return harness(t, { files: ["ScriptForm.qml", "ScriptModel.js"], harness: "script-form-harness.qml" })
}

test("structured script form blocks invalid required fields and preserves literal submitted values", { timeout: 15000 }, async t => {
  const h = await fixture(t)
  if (!h) return
  await h.command("begin", { specs: [{ type: "text", placeholder: "Name", validation: "^[A-Z].+" }] })
  let result = await h.command("submit")
  assert.equal(result.state.submitted, null)
  assert.ok(result.state.error)
  await h.command("values", { values: ["Alice <b> & $(touch never)"] })
  result = await h.command("submit")
  assert.deepEqual(result.state.submitted, ["Alice <b> & $(touch never)"])
  assert.equal(result.state.error, "")
})

test("structured form displays normalized defaults and rejects choices outside its declared options", { timeout: 15000 }, async t => {
  const h = await fixture(t)
  if (!h) return
  const specs = [{ type: "text", placeholder: "Mode", default: "safe", options: [{ title: "Safe", value: "safe" }, { title: "Fast", value: "fast" }] },
    { type: "text", placeholder: "Note", optional: true }]
  let result = await h.command("begin", { specs })
  assert.deepEqual(result.state.values, ["safe", ""])
  await h.command("values", { values: ["unknown", ""] })
  result = await h.command("submit")
  assert.equal(result.state.submitted, null)
  assert.ok(result.state.error)
  await h.command("values", { values: ["fast", "literal % text"] })
  result = await h.command("submit")
  assert.deepEqual(result.state.submitted, ["fast", "literal % text"])
  result = await h.command("cancel")
  assert.equal(result.state.cancellations, 1)
})
