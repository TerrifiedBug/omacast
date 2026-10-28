const { spawn } = require("node:child_process")
const { mkdtemp, writeFile, readFile, copyFile, rename, mkdir, rm } = require("node:fs/promises")
const { tmpdir } = require("node:os")
const path = require("node:path")
const readline = require("node:readline")

// Windowless, offscreen qs hosts the real, statically linked FileView module.
// Every HOME/XDG path and staged QML import is confined to this test fixture.
module.exports = async function harness(t, options = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "omacast-qml-"))
  let child = null
  let closed = null
  let stopping = false
  t.after(async () => {
    stopping = true
    if (child) {
      child.kill("SIGTERM")
      const escalation = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
      }, 1000)
      try { await closed } finally { clearTimeout(escalation) }
    }
    await rm(dir, { recursive: true, force: true })
  })
  await mkdir(path.join(dir, "runtime"), { mode: 0o700 })
  const configRoot = path.join(dir, "harness")
  await mkdir(configRoot)
  for (const file of options.files || ["JsonStore.qml"]) {
    const destination = path.join(configRoot, file)
    await mkdir(path.dirname(destination), { recursive: true })
    await copyFile(path.join(__dirname, "..", file), destination)
  }
  const harnessFile = options.harness || "persistence-harness.qml"
  const harnessName = path.basename(harnessFile)
  await mkdir(path.join(configRoot, "test"))
  await copyFile(path.join(__dirname, harnessFile), path.join(configRoot, "test", harnessName))
  await writeFile(path.join(configRoot, "shell.qml"),
    `import QtQuick\nimport Quickshell\nShellRoot { Loader { source: ${JSON.stringify("test/" + harnessName)}; onStatusChanged: if (status === Loader.Error) Qt.quit() } }\n`)
  await writeFile(path.join(dir, "command.json"), JSON.stringify({ id: 0, op: "snapshot" }))
  if (options.prepare) await options.prepare(dir)
  const overrides = typeof options.env === "function" ? options.env(dir) : options.env
  const env = { ...process.env, ...overrides, HOME: dir, XDG_CONFIG_HOME: path.join(dir, "config"),
    XDG_STATE_HOME: path.join(dir, "state"), XDG_CACHE_HOME: path.join(dir, "cache"),
    XDG_RUNTIME_DIR: path.join(dir, "runtime"), OMACAST_STORE_FIXTURE: dir,
    PYTHONDONTWRITEBYTECODE: "1",
    QT_QPA_PLATFORM: "offscreen", QT_QPA_PLATFORMTHEME: "", QT_QUICK_CONTROLS_STYLE: "Basic" }
  delete env.DISPLAY
  delete env.WAYLAND_DISPLAY
  delete env.HYPRLAND_INSTANCE_SIGNATURE
  child = spawn("qs", ["-p", path.join(configRoot, "shell.qml")], { env })
  closed = new Promise(resolve => child.once("close", resolve))
  let id = 0
  let failure = null
  let diagnostics = ""
  const replies = new Map()
  const watchers = new Set()
  let initialResolve, initialReject
  const initial = new Promise((resolve, reject) => { initialResolve = resolve; initialReject = reject })
  function fail(error) {
    if (stopping) return
    failure = error
    initialReject(error)
    for (const pending of replies.values()) pending.reject(error)
    replies.clear()
    for (const pending of watchers) pending.reject(error)
    watchers.clear()
  }
  function line(text) {
    text = text.replace(/\u001b\[[0-9;]*m/g, "")
    diagnostics = (diagnostics + text + "\n").slice(-16384)
    const marker = text.indexOf("OMACAST_STORE ")
    if (marker !== -1) {
      const reply = JSON.parse(text.slice(marker + "OMACAST_STORE ".length))
      if (reply.id === 0) initialResolve(reply)
      const pending = replies.get(reply.id)
      if (pending) {
        replies.delete(reply.id)
        if (reply.harnessError) pending.reject(new Error(reply.harnessError))
        else pending.resolve(reply)
      }
    }
    const watch = text.indexOf("OMACAST_WATCH ")
    if (watch !== -1) {
      const state = JSON.parse(text.slice(watch + "OMACAST_WATCH ".length))
      for (const pending of watchers) {
        if (pending.predicate(state)) {
          watchers.delete(pending)
          pending.resolve(state)
        }
      }
    }
  }
  readline.createInterface({ input: child.stdout }).on("line", line)
  readline.createInterface({ input: child.stderr }).on("line", line)
  child.on("error", fail)
  child.on("exit", (code, signal) => fail(new Error(`QML harness exited (${code}, ${signal}):\n${diagnostics}`)))
  try {
    await initial
  } catch (error) {
    if (error.code === "ENOENT") {
      t.skip("qs executable is not installed")
      return null
    }
    throw error
  }
  async function command(op, fields = {}) {
    if (failure) throw failure
    const next = ++id
    const reply = new Promise((resolve, reject) => replies.set(next, { resolve, reject }))
    const temporary = path.join(dir, "command.next")
    await writeFile(temporary, JSON.stringify({ id: next, op, ...fields }))
    await rename(temporary, path.join(dir, "command.json"))
    return reply
  }
  async function bytes(file) { return readFile(path.join(dir, file), "utf8") }
  async function put(file, text) {
    const target = path.join(dir, file)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target + ".next", text)
    await rename(target + ".next", target)
  }
  function changed(predicate) {
    if (failure) return Promise.reject(failure)
    return new Promise((resolve, reject) => watchers.add({ predicate, resolve, reject }))
  }
  return { dir, command, bytes, put, changed }
}

module.exports.sourceFiles = [
  "Sources.qml", "Model.js", "WindowModel.js", "Learning.js", "JsonStore.qml", "vendor/MenuModel.js",
  "ActionPolicy.js", "ActionRunner.qml", "FilePolicy.js", "PathPolicy.qml",
  "Navigation.js", "NavigationSources.qml", "NavigationDiscovery.py",
  "ScriptModel.js", "ScriptResults.qml", "Picker.qml",
  "AgentAnswers.qml", "SemanticSearch.qml", "OptionalWorker.qml", "bin/omacast_adapter.py"
]
