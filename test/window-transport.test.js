const test = require("node:test")
const assert = require("node:assert/strict")
const net = require("node:net")
const fs = require("node:fs/promises")
const path = require("node:path")
const { spawnSync } = require("node:child_process")
const harness = require("./qml-harness")

async function fixture(t) {
  const sockets = []
  const waiting = []
  const commands = []
  let server
  const h = await harness(t, {
    files: ["NativeHyprlandRequest.qml", "WindowActions.qml", "WindowModel.js"],
    harness: "window-transport-harness.qml",
    env: dir => ({ PATH: path.join(dir, "bin") + ":" + process.env.PATH }),
    prepare: async dir => {
      await fs.mkdir(path.join(dir, ".config/hypr"), { recursive: true })
      await fs.writeFile(path.join(dir, ".config/hypr/hyprland.lua"), "-- user config\nuser_value = 42\n")
      await fs.mkdir(path.join(dir, "bin"))
      for (const name of ["hyprctl", "bash", "sh", "python", "python3"]) {
        const file = path.join(dir, "bin", name)
        await fs.writeFile(file, `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(path.join(dir, "spawned"))}, ${JSON.stringify(name + "\n")}); process.exit(91)\n`, { mode: 0o755 })
      }
      server = net.createServer(socket => {
        sockets.push(socket)
        socket.once("data", data => {
          const entry = { socket, command: data.toString() }
          commands.push(entry.command)
          if (waiting.length) waiting.shift()(entry)
          else queue.push(entry)
        })
        socket.on("error", () => {})
      })
      await new Promise(resolve => server.listen(path.join(dir, "native.sock"), resolve))
    }
  })
  const queue = []
  t.after(async () => {
    for (const socket of sockets) socket.destroy()
    if (server) await new Promise(resolve => server.close(resolve))
  })
  if (!h) return null
  return Object.assign(h, { commands, next: () => queue.length ? Promise.resolve(queue.shift()) : new Promise(resolve => waiting.push(resolve)) })
}

const target = { address: "0x123", stableId: "9007199254740999", workspace: 11 }

test("native transport collects partial bytes through EOF, not optimistically", async t => {
  const h = await fixture(t)
  if (!h) return
  const started = await h.command("request")
  const entry = await h.next()
  assert.equal(entry.command, "j/activewindow")
  entry.socket.write('{"address":')
  assert.equal((await h.command("snapshot")).state.replies.length, 0)
  const finished = h.changed(state => state.replies.length === 1)
  entry.socket.end('"0x123"}')
  const state = await finished
  assert.deepEqual(state.replies, [{ generation: started.result, ok: true, reply: '{"address":"0x123"}' }])
})

test("native transport timeout, stale generations, size bound and unload", async t => {
  const h = await fixture(t)
  if (!h) return
  await h.command("request")
  const old = await h.next()
  const timeout = h.changed(state => state.replies.length === 1)
  await h.command("expire")
  assert.match((await timeout).replies[0].reply, /timed out/)
  const next = await h.command("request")
  const current = await h.next()
  old.socket.end("stale")
  const complete = h.changed(state => state.replies.length === 2)
  current.socket.end("ok")
  assert.equal((await complete).replies[1].generation, next.result)
  await h.command("request", { maxBytes: 32 })
  const large = await h.next()
  const bounded = h.changed(state => state.replies.length === 3)
  large.socket.write("x".repeat(33))
  assert.match((await bounded).replies[2].reply, /size limit/)
  await h.command("unload")
  assert.equal((await h.command("snapshot")).state.replies.length, 3)
})

test("empty EOF and connection errors are errors", async t => {
  const h = await fixture(t)
  if (!h) return
  await h.command("request")
  const entry = await h.next()
  const empty = h.changed(state => state.replies.length === 1)
  entry.socket.end()
  assert.equal((await empty).replies[0].ok, false)
  // Unlinking the listening path makes a fresh connection fail without a sleep.
  await fs.unlink(path.join(h.dir, "native.sock"))
  const failed = h.changed(state => state.replies.length === 2)
  await h.command("request")
  assert.match((await failed).replies[1].reply, /socket error/)
})

test("disabled controller is inert; capture freezes native identity and ignores stale sessions", async t => {
  const h = await fixture(t)
  if (!h) return
  assert.equal(h.commands.length, 0)
  await assert.rejects(fs.readFile(path.join(h.dir, ".config/hypr/omacast-windows.lua")), { code: "ENOENT" })
  await h.command("capture", { ticket: 1 })
  const old = await h.next()
  await h.command("capture", { ticket: 2 })
  const current = await h.next()
  old.socket.end(JSON.stringify({ ...target, stableId: "old" }))
  current.socket.end(JSON.stringify(target))
  const clients = await h.next()
  assert.equal(clients.command, "j/clients")
  const captured = h.changed(state => state.captures.length === 2)
  clients.socket.end(JSON.stringify([target]))
  const state = await captured
  assert.deepEqual(state.captures.find(item => item.ticket === 1).target, null)
  assert.deepEqual(state.captures.find(item => item.ticket === 2).target, target)
  assert.deepEqual((await h.command("map", { toplevel: { address: "0x123" } })).result, target)
  await h.command("run", { action: "left-half", target })
  assert.equal((await h.command("snapshot")).state.results[0].ok, false)
  await assert.rejects(fs.readFile(path.join(h.dir, "spawned")), { code: "ENOENT" })
})

test("controller persists guarded boot loader, waits for action result and releases ownership", async t => {
  const h = await fixture(t)
  if (!h) return
  await h.command("configure", { config: { enabled: true } })
  const configure = await h.next()
  assert.match(configure.command, /^eval /)
  const ready = h.changed(state => state.ready || state.results.length > 0)
  configure.socket.end("ok")
  const firstConfiguration = await ready
  assert.equal(firstConfiguration.ready, true, firstConfiguration.error)
  const loader = await h.bytes(".config/hypr/hyprland.lua")
  assert.match(loader, /user_value = 42/)
  assert.match(loader, /BEGIN OMACAST WINDOWS/)
  assert.match(await h.bytes(".config/hypr/omacast-windows.lua"), /WindowActions.lua/)
  await h.command("run", { action: "left-half", target })
  const action = await h.next()
  assert.match(action.command, /9007199254740999/)
  assert.equal((await h.command("snapshot")).state.results.length, 0)
  const rejected = h.changed(state => state.results.length === 1)
  action.socket.end("window disappeared")
  assert.equal((await rejected).results[0].ok, false)
  await h.command("run", { action: "right-half", target })
  const successfulAction = await h.next()
  const accepted = h.changed(state => state.results.length === 2)
  successfulAction.socket.end("ok")
  assert.deepEqual((await accepted).results[1], { ok: true, message: "" })
  await h.command("configure", { config: { enabled: true } })
  const again = await h.next()
  const configuredAgain = h.changed(state => state.ready || state.results.length > 2)
  again.socket.end("ok")
  const repeatedConfiguration = await configuredAgain
  assert.equal(repeatedConfiguration.ready, true, repeatedConfiguration.error)
  assert.equal(await h.bytes(".config/hypr/hyprland.lua"), loader)
  await h.command("layout", { layout: "focus", target })
  assert.equal((await h.command("snapshot")).state.configurations[0].workspaces["11"], "focus")
  await h.command("configure", { config: { enabled: false } })
  const disable = await h.next()
  const released = h.changed(state => !state.busy && !state.ready)
  disable.socket.end("ok")
  await released
  assert.equal(await h.bytes(".config/hypr/hyprland.lua"), "-- user config\nuser_value = 42\n")
  await assert.rejects(fs.readFile(path.join(h.dir, "spawned")), { code: "ENOENT" })
})

test("controller refuses foreign boot files before native configuration", async t => {
  const h = await fixture(t)
  if (!h) return
  await h.put(".config/hypr/omacast-windows.lua", "-- user owned\n")
  const failed = h.changed(state => state.results.length === 1)
  await h.command("configure", { config: { enabled: true } })
  assert.match((await failed).results[0].message, /unowned/)
  assert.equal(h.commands.length, 0)
  assert.equal(await h.bytes(".config/hypr/omacast-windows.lua"), "-- user owned\n")
})

test("controller rejects an unsupported native API instead of claiming readiness", { timeout: 10000 }, async t => {
  const h = await fixture(t)
  if (!h) return
  await fs.mkdir(path.join(h.dir, "plugin"))
  await fs.copyFile(path.join(__dirname, "..", "WindowActions.lua"), path.join(h.dir, "plugin/WindowActions.lua"))
  await h.command("configure", { config: { enabled: true } })
  const request = await h.next()
  const settled = h.changed(state => state.ready || state.results.length > 0)
  const native = spawnSync("lua", ["-"], {
    input: "hl = {}\n" + request.command.slice(5),
    encoding: "utf8",
    env: { ...process.env, XDG_RUNTIME_DIR: "", HYPRLAND_INSTANCE_SIGNATURE: "" }
  })
  assert.equal(native.error, undefined)
  request.socket.end(native.status === 0 ? "ok" : "error: " + native.stderr)
  const state = await settled
  assert.equal(state.ready, false)
  assert.equal(state.results[0].ok, false)
  assert.match(state.results[0].message, /native Hyprland.*API/i)
  await assert.rejects(fs.readFile(path.join(h.dir, ".config/hypr/omacast-windows.lua")), { code: "ENOENT" })
})
