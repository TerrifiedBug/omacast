import QtQuick
import Quickshell
import Quickshell.Io
import ".." as Plugin

ShellRoot {
  id: root
  property string fixture: Quickshell.env("OMACAST_STORE_FIXTURE")
  property int lastCommand: -1
  property var events: []

  Plugin.PathPolicy {
    id: policy
    home: root.fixture
    onResolved: function(key, allowed, canonicalPath, message) {
      root.events = root.events.concat([{ key: key, allowed: allowed, path: canonicalPath, message: message }])
      root.publish()
    }
  }

  FileView {
    id: commands
    path: root.fixture + "/command.json"
    blockAllReads: true
    printErrors: false
    watchChanges: true
    onFileChanged: root.dispatch()
  }

  function snapshot() { return { events: events, busy: policy.busy } }
  function publish() { console.warn("OMACAST_WATCH " + JSON.stringify(snapshot())) }
  function dispatch() {
    commands.reload()
    var command
    try { command = JSON.parse(commands.text()) } catch (e) { return }
    if (command.id <= lastCommand) return
    lastCommand = command.id
    try {
      switch (command.op) {
      case "inspect": policy.inspect(command.key, command.path, command.rootPath || fixture, command.purpose || "preview"); break
      case "replace":
        policy.inspect("obsolete", command.oldPath, fixture, "preview")
        policy.inspect(command.key, command.path, fixture, command.purpose || "preview")
        break
      case "cancel": policy.cancel(); break
      case "cancelRequest":
        policy.inspect(command.key, command.path, fixture, "preview")
        policy.cancel()
        break
      case "config": policy.config = command.config; break
      case "snapshot": break
      case "quit": Qt.quit(); return
      default: throw new Error("Unknown operation")
      }
      console.warn("OMACAST_STORE " + JSON.stringify({ id: command.id, result: true, state: snapshot() }))
    } catch (e) {
      console.warn("OMACAST_STORE " + JSON.stringify({ id: command.id, harnessError: String(e) }))
    }
  }

  Timer { interval: 1; running: true; onTriggered: root.dispatch() }
}
