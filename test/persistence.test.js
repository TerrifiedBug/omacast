const assert = require("node:assert/strict")
const { chmod, mkdir, rm } = require("node:fs/promises")
const path = require("node:path")
const harness = require("./qml-harness.js")
const test = require("node:test")

// A very long saveDelay prevents real time from deciding lifecycle outcomes.
// Each transition is driven by a command acknowledgement, watch event, or flush.
test('JsonStore protects real files and flushes deferred mutations', { timeout: 30000 }, async t => {
  const h = await harness(t)
  if (!h) return
  const open = (file, delay = 0, extra = {}) => h.command('open', { file, delay, ...extra })
  const replace = document => h.command('replace', { document })
  const close = () => h.command('destroy')

  await t.test('only an actual missing file starts with writable defaults', async () => {
    let reply = await open('missing.json')
    assert.equal(reply.state.ready, true)
    assert.equal(reply.state.writable, true)
    assert.deepEqual(reply.state.document, {})
    reply = await replace({ custom: { preserved: true } })
    assert.equal(reply.result, true)
    assert.equal(reply.state.dirty, false)
    assert.deepEqual(JSON.parse(await h.bytes('missing.json')), { custom: { preserved: true } })
    await close()
  })

  await t.test('malformed and non-object files are never replaced with defaults', async () => {
    for (const text of ['{"broken":', '[]', 'null', '42', '']) {
      await h.put('invalid.json', text)
      let reply = await open('invalid.json')
      assert.equal(reply.state.writable, false)
      assert.ok(reply.state.error)
      reply = await replace({ pins: ['app:test'] })
      assert.equal(reply.result, false)
      assert.equal(reply.state.dirty, true)
      assert.equal(await h.bytes('invalid.json'), text)
      await close()
      assert.equal(await h.bytes('invalid.json'), text)
    }
  })

  await t.test('a custom parser returning null is explicitly rejected', async () => {
    const text = '{"custom":true}'
    await h.put('custom-parser.json', text)
    const reply = await open('custom-parser.json', 0, { parser: 'null' })
    assert.equal(reply.state.writable, false)
    assert.match(reply.state.error, /non-object/)
    assert.equal((await replace({ custom: false })).result, false)
    assert.equal(await h.bytes('custom-parser.json'), text)
    await close()
  })

  await t.test('last-good state and pending edits survive syntax damage and repair', async () => {
    const original = { pins: [], hidden: [], usage: {}, custom: { original: 1 } }
    await h.put('pending.json', JSON.stringify(original))
    await open('pending.json', 3600000)
    const desired = { ...original, pins: ['app:test'], hidden: ['file:hidden'],
      usage: { test: { count: 2 } }, custom: { original: 3 } }
    let reply = await replace(desired)
    assert.equal(reply.result, true)
    assert.equal(reply.state.dirty, true)
    await h.put('pending.json', '{"damaged":')
    reply = await h.command('flush')
    assert.equal(reply.result, false)
    assert.equal(reply.state.writable, false)
    assert.equal(reply.state.dirty, true)
    assert.deepEqual(reply.state.document, desired)
    assert.equal(await h.bytes('pending.json'), '{"damaged":')
    const repaired = h.changed(state => state && state.writable && state.document.external === 7)
    await h.put('pending.json', JSON.stringify({ ...original, external: 7, custom: { original: 1, future: 2 } }))
    const state = await repaired
    assert.equal(state.dirty, true)
    assert.deepEqual(state.document.pins, desired.pins)
    reply = await close()
    assert.equal(reply.result, true)
    assert.deepEqual(JSON.parse(await h.bytes('pending.json')), {
      ...desired, external: 7, custom: { original: 3, future: 2 }
    })
  })

  await t.test('settings commit checks freshness even before watcher delivery', async () => {
    await h.put('freshness.json', '{"keep":1}')
    await open('freshness.json')
    const reply = await h.command('damageThenReplace', {
      file: 'freshness.json', text: '{"not complete"', document: { keep: 2 }
    })
    assert.equal(reply.result, false)
    assert.equal(reply.state.dirty, true)
    assert.equal(await h.bytes('freshness.json'), '{"not complete"')
    await close()
  })

  await t.test('read errors retain last-good values and never write a directory', async () => {
    await h.put('io.json', '{"keep":3}')
    await open('io.json', 3600000)
    await replace({ keep: 4 })
    await rm(path.join(h.dir, 'io.json'))
    await mkdir(path.join(h.dir, 'io.json'))
    let reply = await h.command('flush')
    assert.equal(reply.result, false)
    assert.equal(reply.state.writable, false)
    assert.equal(reply.state.dirty, true)
    assert.deepEqual(reply.state.document, { keep: 4 })
    await rm(path.join(h.dir, 'io.json'), { recursive: true })
    await h.put('io.json', '{"keep":3,"external":true}')
    reply = await h.command('flush')
    assert.equal(reply.result, true)
    assert.equal(reply.state.dirty, false)
    assert.deepEqual(JSON.parse(await h.bytes('io.json')), { keep: 4, external: true })
    await close()
  })

  await t.test('read permission errors do not erase last-good or pending state', async t => {
    if (process.getuid && process.getuid() === 0) {
      t.skip('root bypasses filesystem read permissions')
      return
    }
    await h.put('unreadable.json', '{"keep":8}')
    await open('unreadable.json', 3600000)
    await replace({ keep: 9 })
    await chmod(path.join(h.dir, 'unreadable.json'), 0o000)
    try {
      const reply = await h.command('flush')
      assert.equal(reply.result, false)
      assert.equal(reply.state.writable, false)
      assert.equal(reply.state.dirty, true)
      assert.deepEqual(reply.state.document, { keep: 9 })
    } finally {
      await chmod(path.join(h.dir, 'unreadable.json'), 0o600)
    }
    assert.equal(await h.bytes('unreadable.json'), '{"keep":8}')
    assert.equal((await h.command('flush')).result, true)
    await close()
  })

  await t.test('failed atomic save stays dirty and explicit retry persists it', async t => {
    if (process.getuid && process.getuid() === 0) {
      t.skip('root bypasses filesystem write permissions')
      return
    }
    await h.put('readonly.json', '{"keep":5}')
    await open('readonly.json')
    await chmod(path.join(h.dir, 'readonly.json'), 0o400)
    try {
      const reply = await replace({ keep: 6 })
      assert.equal(reply.result, false)
      assert.equal(reply.state.dirty, true)
      assert.equal(reply.state.writable, false)
      assert.ok(reply.state.error)
      assert.equal(await h.bytes('readonly.json'), '{"keep":5}')
    } finally {
      await chmod(path.join(h.dir, 'readonly.json'), 0o600)
    }
    const reply = await h.command('flush')
    assert.equal(reply.result, true)
    assert.equal(reply.state.dirty, false)
    assert.deepEqual(JSON.parse(await h.bytes('readonly.json')), { keep: 6 })
    await close()
  })

  await t.test('latest pin hidden and usage mutation is durable before destruction', async () => {
    await h.put('teardown.json', '{"pins":[],"hidden":[],"usage":{}}')
    await open('teardown.json', 3600000)
    await replace({ pins: ['old'], hidden: [], usage: {} })
    const latest = { pins: ['latest'], hidden: ['hidden'], usage: { latest: { count: 3, last: 1234 } } }
    await replace(latest)
    assert.deepEqual(JSON.parse(await h.bytes('teardown.json')), { pins: [], hidden: [], usage: {} })
    assert.equal((await close()).result, true)
    assert.deepEqual(JSON.parse(await h.bytes('teardown.json')), latest)
  })
})
