pragma ComponentBehavior: Bound

import QtQuick
import Quickshell
import Quickshell.Io
import ".." as Plugin

ShellRoot {
  id: root
  property string fixture: Quickshell.env("OMACAST_STORE_FIXTURE")
  property int lastCommand: -1
  property var replies: []
  property var captures: []
  property var results: []
  property var configurations: []
  property var unloadedRequest: null
  Plugin.NativeHyprlandRequest {
    id: request
    socketPath: root.fixture + "/native.sock"
    timeoutMs: 60000
    onFinished: function(generation, ok, reply) { root.replies.push({ generation: generation, ok: ok, reply: reply }); root.changed() }
  }
  Plugin.WindowActions {
    id: actions
    home: root.fixture
    pluginDir: root.fixture + "/plugin"
    socketPath: root.fixture + "/native.sock"
    timeoutMs: 60000
    onFinished: function(ok, message) { root.results.push({ ok: ok, message: message }); root.changed() }
    onConfigurationChanged: function(config) { root.configurations.push(config); root.changed() }
    onReadyChanged: root.changed()
    onBusyChanged: Qt.callLater(root.changed)
  }
  Component { id: transientComponent; Plugin.NativeHyprlandRequest { socketPath: root.fixture + "/native.sock" } }
  function snapshot() { return { replies: replies, captures: captures, results: results, configurations: configurations, ready: actions.ready, busy: actions.busy, target: actions.target, error: actions.error } }
  function changed() { console.warn("OMACAST_WATCH " + JSON.stringify(snapshot())) }
  function dispatch() {
    commands.reload()
    var command
    try { command = JSON.parse(commands.text()) } catch (e) { return }
    if (command.id <= lastCommand) return
    lastCommand = command.id
    var result = null
    try {
      if (command.op === "request") { request.maxBytes = command.maxBytes || 2097152; result = request.request(command.command || "j/activewindow") }
      else if (command.op === "cancel") request.cancel()
      else if (command.op === "expire") request._active.deadline.triggered()
      else if (command.op === "capture") { var ticket = command.ticket; actions.capture(function(target) { root.captures.push({ ticket: ticket, target: target }); root.changed() }) }
      else if (command.op === "configure") actions.config = command.config
      else if (command.op === "run") actions.run(command.action, command.target)
      else if (command.op === "layout") actions.setWorkspaceLayout(command.layout, command.target)
      else if (command.op === "map") result = actions.targetForToplevel(command.toplevel)
      else if (command.op === "unload") { unloadedRequest = transientComponent.createObject(root); unloadedRequest.request("j/clients"); unloadedRequest.destroy(); unloadedRequest = null }
    } catch (e) {
      console.warn("OMACAST_STORE " + JSON.stringify({ id: command.id, harnessError: String(e) }))
      return
    }
    console.warn("OMACAST_STORE " + JSON.stringify({ id: command.id, result: result, state: snapshot() }))
  }
  FileView { id: commands; path: root.fixture + "/command.json"; blockAllReads: true; printErrors: false; watchChanges: true; onFileChanged: root.dispatch() }
  Timer { interval: 1; running: true; onTriggered: root.dispatch() }
}
