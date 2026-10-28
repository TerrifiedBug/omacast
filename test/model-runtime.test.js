const test = require("node:test")
const assert = require("node:assert/strict")
const harness = require("./qml-harness.js")

test("V4 search matches Unicode equivalents and keeps exact intent above typo recovery", { timeout: 10000 }, async t => {
  const h = await harness(t, {
    harness: "model-runtime-harness.qml",
    files: ["Model.js", "Learning.js", "ScriptModel.js"]
  })
  if (!h) return
  const { result } = await h.command("search")
  assert.ok(result.accented > 0)
  assert.ok(result.decomposed > 0)
  assert.ok(result.transliterated > 0)
  assert.equal(result.prepared, result.accented)
  assert.ok(result.typo > 0)
  assert.ok(result.exact > result.typo)
})
