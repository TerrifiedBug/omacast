const test = require("node:test")
const assert = require("node:assert/strict")
const { readFile } = require("node:fs/promises")
const { inflateSync } = require("node:zlib")
const palette = require("./palette-harness")

// Decode Qt's non-interlaced RGB(A) captures without a new image dependency.
function pixels(png) {
  let width, height, channels
  const chunks = []
  for (let at = 8; at < png.length;) {
    const size = png.readUInt32BE(at)
    const type = png.toString("ascii", at + 4, at + 8)
    const data = png.subarray(at + 8, at + 8 + size)
    if (type === "IHDR") {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      channels = data[9] === 6 ? 4 : data[9] === 2 ? 3 : 0
      if (data[8] !== 8 || !channels || data[12] !== 0) throw Error("Unsupported Qt capture pixel layout")
    } else if (type === "IDAT") chunks.push(data)
    at += size + 12
  }
  const packed = inflateSync(Buffer.concat(chunks))
  const stride = width * channels
  const decoded = Buffer.alloc(stride * height)
  let input = 0
  for (let y = 0; y < height; y++) {
    const filter = packed[input++]
    for (let x = 0; x < stride; x++) {
      const at = y * stride + x
      const left = x >= channels ? decoded[at - channels] : 0
      const above = y ? decoded[at - stride] : 0
      const corner = y && x >= channels ? decoded[at - stride - channels] : 0
      let prediction = 0
      if (filter === 1) prediction = left
      else if (filter === 2) prediction = above
      else if (filter === 3) prediction = Math.floor((left + above) / 2)
      else if (filter === 4) {
        const p = left + above - corner
        const dl = Math.abs(p - left), da = Math.abs(p - above), dc = Math.abs(p - corner)
        prediction = dl <= da && dl <= dc ? left : da <= dc ? above : corner
      } else if (filter !== 0) throw Error("Unsupported Qt capture row filter")
      decoded[at] = (packed[input++] + prediction) & 255
    }
  }
  return { width, height, color(x, y) {
    const at = (Math.floor(y) * width + Math.floor(x)) * channels
    return [...decoded.subarray(at, at + 3), channels === 4 ? decoded[at + 3] : 255]
  } }
}

async function capture(h, name) {
  const frame = await h.command("capture", { name })
  return { ...frame, pixels: pixels(await readFile(frame.png)) }
}

function background(frame, row) {
  return frame.pixels.color(
    (row.x + row.width - 3) * frame.pixels.width / frame.windowWidth,
    (row.y + row.height / 2) * frame.pixels.height / frame.windowHeight)
}

test("rendered highlight follows selection and the palette disappears on close", { timeout: 15000 }, async t => {
  const h = await palette(t, { config: { builtinQuicklinks: false, quicklinks: [
    { name: "Visual Alpha", keyword: "alpha", url: "https://example.test/alpha" },
    { name: "Visual Beta", keyword: "beta", url: "https://example.test/beta" }
  ] } })
  if (!h) return
  const state = await h.until(s => s.opened && s.selectedIndex >= 0 && s.selectedIndex < s.rows.length && s.rows.some(row => row.key === "ql:alpha") && s.rows.some(row => row.key === "ql:beta"),
    "open", { payload: { query: "visual" } })
  const first = state.rows[state.selectedIndex].key
  const second = first === "ql:alpha" ? "ql:beta" : "ql:alpha"
  const before = await capture(h, "selection-before")
  const firstBounds = before.visualRows[first]
  const secondBounds = before.visualRows[second]
  const selected = background(before, firstBounds)
  const ordinary = background(before, secondBounds)
  assert.notDeepEqual(selected, ordinary, "The selected row must be visibly distinct")

  await h.command("select", { key: second })
  const after = await capture(h, "selection-after")
  assert.deepEqual(background(after, firstBounds), ordinary)
  assert.deepEqual(background(after, secondBounds), selected)

  await h.command("close")
  const closed = await capture(h, "closed")
  assert.notDeepEqual(background(closed, firstBounds), ordinary)
  assert.notDeepEqual(background(closed, secondBounds), selected)
})

test("toggling a scrolled setting retains the visible highlight and viewport", { timeout: 15000 }, async t => {
  const h = await palette(t)
  if (!h) return
  const key = "setting:semantic"
  await h.until(s => s.rows.some(row => row.key === key), "open", { payload: { scope: "settings" } })
  const pointerKey = "setting:scriptForms"
  const pointerDeadline = Date.now() + 5000
  for (;;) {
    const primed = await h.command("pointerMove", { key: pointerKey, points: [{ x: 10, y: 10 }, { x: 30, y: 10 }] })
    if (primed.state.rows[primed.state.selectedIndex].key === pointerKey) break
    assert.ok(Date.now() < pointerDeadline, "Pointer selection must become available after the typing guard")
  }
  await h.command("scrollTo", { key })
  const queuedHover = await h.command("pointerMove", { key: pointerKey, points: [{ x: 40, y: 10 }] })
  assert.equal(queuedHover.state.rows[queuedHover.state.selectedIndex].key, key, "Keyboard selection ignores the first stale hover sample")
  const before = await capture(h, "setting-before")
  const bounds = before.visualRows[key]
  assert.ok(before.state.viewport.contentY > 0, "The exercised setting must be below the initial viewport")
  const selectedColor = background(before, bounds)
  const oldValue = before.state.configDoc.semantic

  await h.command("enter")
  const refreshedHover = await h.command("pointerMove", { key: pointerKey, points: [{ x: 50, y: 10 }] })
  assert.equal(refreshedHover.state.rows[refreshedHover.state.selectedIndex].key, key, "Refreshing a setting re-primes pointer selection")
  const after = await capture(h, "setting-after")
  assert.equal(after.state.configDoc.semantic, !oldValue)
  assert.equal(after.state.rows[after.state.selectedIndex].key, key)
  assert.equal(after.state.viewport.contentY, before.state.viewport.contentY)
  assert.equal(after.visualRows[key].y, bounds.y)
  assert.deepEqual(background(after, after.visualRows[key]), selectedColor)
  const moved = await h.command("pointerMove", { key: pointerKey, points: [{ x: 60, y: 10 }, { x: 80, y: 10 }] })
  assert.equal(moved.state.rows[moved.state.selectedIndex].key, pointerKey, "Deliberate pointer movement can take selection back")
})
