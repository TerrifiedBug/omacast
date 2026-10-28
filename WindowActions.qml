pragma ComponentBehavior: Bound

import QtQuick
import Quickshell.Io
import Quickshell.Hyprland
import "WindowModel.js" as WindowModel

// Native IPC and two explicitly owned boot files; disabled startup is inert.
QtObject {
  id: root
  property string home: ""
  property string pluginDir: ""
  property var config: ({ enabled: false })
  property string socketPath: Hyprland.requestSocketPath
  property int timeoutMs: 2500
  readonly property bool ready: _ready && WindowModel.normalize(config).enabled
  readonly property bool busy: _running || _configuring
  readonly property string error: _error
  readonly property var target: _target
  signal finished(bool ok, string message)
  signal configurationChanged(var config)

  property bool _ready: false
  property bool _running: false
  property bool _configuring: false
  property bool _owned: false
  property bool _started: false
  property bool _destroyed: false
  property int _captureGeneration: 0
  property bool _configurePending: false
  property string _error: ""
  property var _target: null
  property var _clients: []
  property var _requests: []
  property int _fileError: -1
  property int _saveResult: 0
  property string _begin: "-- BEGIN OMACAST WINDOWS (managed)"
  property string _end: "-- END OMACAST WINDOWS (managed)"

  property Component _requestComponent: Component { NativeHyprlandRequest {} }
  property Timer _configureTimer: Timer { interval: 0; onTriggered: root.configure() }
  property FileView _boot: FileView {
    path: ""
    preload: false
    blockAllReads: true
    blockWrites: true
    atomicWrites: true
    printErrors: false
    onLoadFailed: function(error) { root._fileError = error }
    onSaved: root._saveResult = 1
    onSaveFailed: function(error) { root._saveResult = -1; root._error = FileViewError.toString(error) }
  }
  property FileView _loader: FileView {
    path: ""
    preload: false
    blockAllReads: true
    blockWrites: true
    atomicWrites: true
    printErrors: false
    onLoadFailed: function(error) { root._fileError = error }
    onSaved: root._saveResult = 1
    onSaveFailed: function(error) { root._saveResult = -1; root._error = FileViewError.toString(error) }
  }

  function _request(command, callback) {
    var job = _requestComponent.createObject(root, { socketPath: socketPath, timeoutMs: timeoutMs })
    _requests.push(job)
    job.finished.connect(function(generation, ok, reply) {
      var index = root._requests.indexOf(job)
      if (index >= 0) root._requests.splice(index, 1)
      if (!root._destroyed) callback(ok, reply)
      job.destroy()
    })
    job.request(command)
  }

  function _accepted(ok, reply) { return ok && String(reply).trim() === "ok" }
  function _fail(message) { _error = String(message); finished(false, _error) }

  function _read(file, path, missingAllowed) {
    file.path = path
    _fileError = -1
    file.reload()
    var text = file.text()
    file.waitForJob()
    if (_fileError === FileViewError.FileNotFound && missingAllowed) return ""
    if (_fileError !== -1) throw new Error(path + ": " + FileViewError.toString(_fileError))
    return text
  }

  function _write(file, text) {
    // FileView does not emit saved when setText receives identical bytes.
    if (_read(file, file.path, true) === text) return
    _saveResult = 0
    file.setText(text)
    file.waitForJob()
    if (_saveResult === -1) throw new Error("Could not atomically save " + file.path + ": " + _error)
    var committed = _read(file, file.path, false)
    if (committed !== text) throw new Error("Boot configuration readback differs: " + file.path)
  }

  function _loaderText(text, enabled) {
    var start = text.indexOf(_begin)
    var end = text.indexOf(_end)
    if ((start < 0) !== (end < 0) || (start >= 0 && (end < start || text.indexOf(_begin, start + _begin.length) >= 0 || text.indexOf(_end, end + _end.length) >= 0)))
      throw new Error("OmaCast loader markers are damaged; refusing to modify hyprland.lua")
    if (start >= 0) {
      end += _end.length
      if (text[end] === "\r") end++
      if (text[end] === "\n") end++
      text = text.slice(0, start) + text.slice(end)
    }
    if (!enabled) return text
    var path = WindowModel.luaLiteral(home + "/.config/hypr/omacast-windows.lua")
    return text + (text.length && text[text.length - 1] !== "\n" ? "\n" : "") + _begin + "\ndo\n  local path = " + path + "\n  local file = io.open(path, \"r\")\n  if file then file:close(); dofile(path) end\nend\n" + _end + "\n"
  }

  function _persist(normalized) {
    if (!home || !pluginDir) throw new Error("OmaCast home and plugin directory must be set")
    var loaderPath = home + "/.config/hypr/hyprland.lua"
    var bootPath = home + "/.config/hypr/omacast-windows.lua"
    var text = _read(_loader, loaderPath, false)
    var next = _loaderText(text, normalized.enabled)
    var boot = _read(_boot, bootPath, true)
    var header = "-- OmaCast generated window module; managed by io.github.terrifiedbug.omacast\n"
    if (boot && boot.indexOf(header) !== 0) throw new Error("Refusing to overwrite an unowned omacast-windows.lua")
    // A disabled snippet is harmless even if a reload races the loader update.
    _write(_boot, header + WindowModel.loaderLua(normalized, pluginDir))
    if (next !== text) _write(_loader, next)
  }

  function configure() {
    if (!_started || _destroyed) return
    if (_configuring || _running) { _configurePending = true; return }
    var normalized = WindowModel.normalize(config)
    if (!normalized.enabled && !_owned) { _ready = false; return }
    if (!home || !pluginDir) { _fail("OmaCast window module paths are unavailable"); return }
    if (normalized.enabled) {
      try {
        _loaderText(_read(_loader, home + "/.config/hypr/hyprland.lua", false), true)
        var existingBoot = _read(_boot, home + "/.config/hypr/omacast-windows.lua", true)
        if (existingBoot && existingBoot.indexOf("-- OmaCast generated window module; managed by io.github.terrifiedbug.omacast\n") !== 0)
          throw new Error("Refusing to overwrite an unowned omacast-windows.lua")
      } catch (e) { _ready = false; _fail(e.message); return }
    }
    _ready = false
    _configuring = true
    var command = "eval assert((function()\n" + WindowModel.loaderLua(normalized, pluginDir) + "end)(), \"Native Hyprland window-management API is unavailable\")"
    _request(command, function(ok, reply) {
      root._configuring = false
      if (root._configurePending) { root._configurePending = false; root._configureTimer.restart() }
      if (!root._accepted(ok, reply)) { root._fail("Could not configure window management: " + reply); return }
      // Retain ownership until persistence succeeds so a failed disable can be retried.
      root._owned = true
      try { root._persist(normalized) } catch (e) { root._fail(e.message); return }
      root._owned = normalized.enabled
      root._ready = normalized.enabled
      root._error = ""
      if (JSON.stringify(normalized) !== JSON.stringify(WindowModel.normalize(root.config))) root._configureTimer.restart()
    })
  }

  function capture(callback) {
    var generation = ++_captureGeneration
    _target = null
    _request("j/activewindow", function(ok, reply) {
      if (generation !== root._captureGeneration) { callback(null); return }
      var captured = null
      try { if (ok) captured = WindowModel.targetFromClient(JSON.parse(reply)) } catch (e) { root._error = "Could not capture active window: " + e.message }
      if (!ok) root._error = "Could not capture active window: " + reply
      root._request("j/clients", function(clientsOk, clientsReply) {
        if (generation !== root._captureGeneration) { callback(null); return }
        try {
          var clients = clientsOk ? JSON.parse(clientsReply) : []
          root._clients = Array.isArray(clients) ? clients : []
        } catch (e) { root._clients = [] }
        root._target = captured
        callback(captured)
      })
    })
  }

  function targetForToplevel(toplevel) {
    if (!toplevel) return null
    var native = toplevel.HyprlandToplevel
    var raw = native ? native.lastIpcObject : toplevel.lastIpcObject
    var direct = WindowModel.targetFromClient(raw)
    if (direct) return direct
    var address = native ? native.address : toplevel.address
    if (!address) return null
    var normalizedAddress = String(address).replace(/^0x/, "").toLowerCase()
    for (var i = 0; i < _clients.length; i++) {
      var client = _clients[i]
      if (String(client.address).replace(/^0x/, "").toLowerCase() === normalizedAddress) return WindowModel.targetFromClient(client)
    }
    return null
  }

  function run(action, selectedTarget) {
    if (!ready) { _fail("Enable and configure OmaCast window management first"); return }
    if (busy) { _fail("Another window request is still running"); return }
    var explicit = WindowModel.targetFromClient(selectedTarget)
    if (!explicit && action !== "previous-space" && action !== "next-space") { _fail("The selected window has no stable native identity"); return }
    var command
    try { command = WindowModel.actionLua(action, explicit) } catch (e) { _fail(e.message); return }
    _running = true
    _request(command, function(ok, reply) {
      root._running = false
      if (root._configurePending) { root._configurePending = false; root._configureTimer.restart() }
      if (!root._accepted(ok, reply)) { root._fail("Window action failed: " + reply); return }
      // act validates its resulting geometry/slot before native IPC returns ok.
      root._error = ""
      root.finished(true, "")
    })
  }

  function setWorkspaceLayout(id, selectedTarget) {
    var frozen = WindowModel.targetFromClient(selectedTarget)
    if (!frozen || frozen.workspace === undefined || frozen.workspace === null) { _fail("Capture a window on the destination workspace first"); return }
    var normalized = WindowModel.normalize(config)
    var found = normalized.layouts.some(function(layout) { return layout.id === id })
    if (!found) { _fail("Unknown workspace layout: " + id); return }
    var next = JSON.parse(JSON.stringify(config || {}))
    next.workspaces = JSON.parse(JSON.stringify(next.workspaces || {}))
    next.workspaces[String(frozen.workspace)] = id
    configurationChanged(next)
  }

  onConfigChanged: if (_started) _configureTimer.restart()
  onHomeChanged: if (_started) _configureTimer.restart()
  onPluginDirChanged: if (_started) _configureTimer.restart()
  Component.onCompleted: { _started = true; _configureTimer.restart() }
  Component.onDestruction: {
    _destroyed = true
    ++_captureGeneration
    for (var i = 0; i < _requests.length; i++) _requests[i].cancel()
  }
}
