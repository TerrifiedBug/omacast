const test = require("node:test")
const assert = require("node:assert/strict")
const { writeFile } = require("node:fs/promises")
const path = require("node:path")
const palette = require("./palette-harness")
const W = require("../WindowModel")

async function shortcuts(t, records = []) {
  return palette(t, { prepare: async dir => {
    await writeFile(path.join(dir, "bin/hyprctl"), '#!/bin/sh\ncase "$*" in "-j binds") cat "$HOME/live-binds.json";; esac\n', { mode: 0o700 })
    await writeFile(path.join(dir, "live-binds.json"), JSON.stringify(records))
  } })
}

async function openWindows(h) {
  await h.until(s => s.opened && s.rows.some(r => r.key === "setting:windows"), "open", { payload: { scope: "settings" } })
  await h.command("activate", { key: "setting:windows" })
}

const bindingKey = action => "setting:windows:shortcut:" + action

test("pressed shortcuts capture modifiers and persist, while cancel and clear preserve binding ownership", { timeout: 15000 }, async t => {
  const h = await shortcuts(t)
  if (!h) return
  await openWindows(h)
  await h.command("activate", { key: bindingKey("next-display") })
  const modifier = await h.command("key", { key: "Control", modifiers: ["Control"] })
  assert.equal(modifier.state.query, "")
  const captured = await h.command("key", { key: "Right", modifiers: ["Meta", "Control", "Alt"] })
  assert.equal(captured.state.query, "SUPER + CTRL + ALT + RIGHT")
  await h.until(s => !s.editing && s.rows.some(r => r.key === bindingKey("next-display") && r.subtitle === "SUPER + CTRL + ALT + RIGHT"), "enter")
  assert.deepEqual(W.parseBindings(await h.bytes(".config/hypr/bindings.lua")), { "next-display": "SUPER + CTRL + ALT + RIGHT" })
  await h.command("activate", { key: bindingKey("next-display") })
  await h.command("key", { key: "F8", modifiers: ["Alt", "Shift"] })
  await h.command("escape")
  assert.deepEqual(W.parseBindings(await h.bytes(".config/hypr/bindings.lua")), { "next-display": "SUPER + CTRL + ALT + RIGHT" })
  await h.command("activate", { key: bindingKey("next-display") })
  const cleared = await h.command("key", { key: "Backspace" })
  assert.equal(cleared.state.query, "")
  await h.until(s => !s.editing && s.rows.some(r => r.key === bindingKey("next-display") && r.subtitle === "Not bound"), "enter")
  assert.deepEqual(W.parseBindings(await h.bytes(".config/hypr/bindings.lua")), {})
})

test("a conflicting captured chord keeps the editor open and leaves bindings unchanged", { timeout: 15000 }, async t => {
  const h = await shortcuts(t, [{ key: "RETURN", modmask: 64, description: "Terminal", dispatcher: "__lua", arg: "23", submap: "" }])
  if (!h) return
  await openWindows(h)
  const original = await h.bytes(".config/hypr/bindings.lua")
  await h.command("activate", { key: bindingKey("next-display") })
  const captured = await h.command("key", { key: "Return", modifiers: ["Meta"] })
  assert.equal(captured.state.query, "SUPER + RETURN")
  const rejected = await h.until(s => s.notice.includes("Terminal"), "enter")
  assert.notEqual(rejected.editing, "")
  assert.equal(await h.bytes(".config/hypr/bindings.lua"), original)
  await h.command("key", { key: "N", modifiers: ["Meta", "Alt"] })
  await h.until(s => !s.editing && s.rows.some(r => r.key === bindingKey("next-display") && r.subtitle === "SUPER + ALT + N"), "enter")
  assert.deepEqual(W.parseBindings(await h.bytes(".config/hypr/bindings.lua")), { "next-display": "SUPER + ALT + N" })
})

test("palette shortcut capture records function keys instead of invoking palette navigation", { timeout: 15000 }, async t => {
  const h = await shortcuts(t)
  if (!h) return
  await h.until(s => s.rows.some(r => r.key === "setting:palette"), "open", { payload: { scope: "settings" } })
  await h.command("activate", { key: "setting:palette" })
  const captured = await h.command("key", { key: "F8", modifiers: ["Control", "Shift"] })
  assert.equal(captured.state.query, "CTRL + SHIFT + F8")
  await h.until(s => !s.editing && s.binds.palette === "CTRL + SHIFT + F8", "enter")
  const disk = await h.bytes(".config/hypr/bindings.lua")
  assert.equal(require("../Model").parseBindBlock(disk).palette, "CTRL + SHIFT + F8")
})

test("Enter starts window shortcut recording and a modified closing bracket is captured and saved", { timeout: 15000 }, async t => {
  const h = await shortcuts(t)
  if (!h) return
  await openWindows(h)
  await h.command("select", { key: bindingKey("next-display") })
  await h.command("key", { key: "Return" })
  const captured = await h.command("key", { key: "BracketRight", modifiers: ["Control", "Meta", "Alt"] })
  assert.equal(captured.state.query, "SUPER + CTRL + ALT + BRACKETRIGHT")
  await h.until(s => !s.editing && s.rows.some(r => r.key === bindingKey("next-display") && r.subtitle === "SUPER + CTRL + ALT + BRACKETRIGHT"), "enter")
  assert.deepEqual(W.parseBindings(await h.bytes(".config/hypr/bindings.lua")), { "next-display": "SUPER + CTRL + ALT + BRACKETRIGHT" })
})
