import QtQuick
import Quickshell
import Quickshell.Io
import ".." as Plugin

ShellRoot {
  id: root
  property string fixture: Quickshell.env("OMACAST_STORE_FIXTURE")
  property int lastCommand: -1

  Plugin.ScriptResults {
    id: results
    home: root.fixture
    onStatusChanged: Qt.callLater(root.publish)
  }

  function snapshot() {
    return { records: results.records, status: results.status, error: results.error,
      requestId: results.requestId, sourcePath: results.sourcePath }
  }

  function publish() { console.warn("OMACAST_WATCH " + JSON.stringify(snapshot())) }

  function dispatch() {
    commands.reload()
    var command
    try { command = JSON.parse(commands.text()) } catch (_) { return }
    if (command.id <= root.lastCommand) return
    root.lastCommand = command.id
    var result = null
    try {
      switch (command.op) {
      case "run": result = results.run(root.fixture + "/" + command.file, command.args || []); break
      case "cancel": results.cancel(); break
      case "resolve": result = results.resolve(command.resultId, command.requestId); break
      case "snapshot": break
      default: throw new Error("Unknown operation")
      }
      console.warn("OMACAST_STORE " + JSON.stringify({ id: command.id, result: result, state: snapshot() }))
    } catch (error) {
      console.warn("OMACAST_STORE " + JSON.stringify({ id: command.id, harnessError: String(error) }))
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

  Timer { id: startup; interval: 1; onTriggered: root.dispatch() }
  Component.onCompleted: startup.start()
}
