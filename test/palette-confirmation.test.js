const test = require("node:test")
const assert = require("node:assert/strict")
const { readFile } = require("node:fs/promises")
const path = require("node:path")
const { createHash } = require("node:crypto")
const palette = require("./palette-harness")
const { marker, CONFIG, STATE } = palette

const clearKey = "setting:clearQueryHistory"
const hasClear = state => state.rows.some(row => row.key === clearKey)
const settings = { scope: "settings", query: "Clear learned query choices" }

// Exercise the real palette activation and Escape handlers, including persisted state.
test("clearing learned choices requires fresh confirmation and preserves usage, aliases and current config", { timeout: 20000 }, async t => {
  const key = "cmd:Fixture command"
  const context = createHash("md5").update("root\0fixture").digest("hex")
  const usage = { [key]: { count: 7, last: 1700000000000 } }
  const aliases = { [key]: "fixture-alias" }
  const queryHistory = { [context]: { [key]: { count: 3, last: 1700000000000 } } }
  const h = await palette(t, {
    config: { queryLearning: false, commands: [{ name: "Fixture command", command: "true" }] },
    state: { usage, aliases, queryHistory }
  })
  if (!h) return
  const stored = async () => JSON.parse(await readFile(path.join(h.dir, STATE), "utf8"))
  const assertRetained = async () => {
    const state = await stored()
    assert.deepEqual(state.queryHistory, queryHistory)
    assert.deepEqual(state.usage, usage)
    assert.deepEqual(state.aliases, aliases)
  }

  await h.until(hasClear, "open", { payload: settings })
  let reply = await h.command("activate", { key: clearKey })
  assert.equal(reply.state.opened, true)
  assert.equal(reply.state.confirmKey, clearKey)
  await assertRetained()

  reply = await h.command("escape")
  assert.equal(reply.state.opened, true)
  assert.equal(reply.state.confirmKey, "")
  assert.deepEqual(reply.state.rows.map(row => row.key), [clearKey])
  await assertRetained()

  reply = await h.command("activate", { key: clearKey })
  assert.equal(reply.state.confirmKey, clearKey)
  await assertRetained()

  const currentConfig = { currency: false, ai: false, preview: false, queryLearning: false,
    commands: [{ name: "Fixture command", command: "printf current" }] }
  const reloaded = h.changed(state => state.configDoc.commands[0]?.command === "printf current")
  await h.put(CONFIG, JSON.stringify(currentConfig))
  await reloaded
  await h.command("close")
  const reopened = await h.until(hasClear, "open", { payload: settings })
  assert.equal(reopened.confirmKey, "")
  assert.equal(reopened.configDoc.commands.find(entry => entry.name === "Fixture command").command, "printf current")

  reply = await h.command("activate", { key: clearKey })
  assert.equal(reply.state.confirmKey, clearKey)
  await assertRetained()
  const cleared = marker(h.dir, STATE, text => {
    const state = JSON.parse(text)
    return !Object.hasOwn(state.queryHistory, context)
  })
  reply = await h.command("activate", { key: clearKey })
  assert.equal(reply.state.opened, true)
  assert.equal(reply.state.confirmKey, "")
  const persisted = JSON.parse(await cleared)
  assert.deepEqual(persisted.queryHistory, {})
  assert.deepEqual(persisted.usage, usage)
  assert.deepEqual(persisted.aliases, aliases)
  assert.equal(reply.state.configDoc.commands.find(entry => entry.name === "Fixture command").command, "printf current")
  assert.equal(reply.state.configDoc.queryLearning, false)
  assert.deepEqual(JSON.parse(await readFile(path.join(h.dir, CONFIG), "utf8")), currentConfig)
})
