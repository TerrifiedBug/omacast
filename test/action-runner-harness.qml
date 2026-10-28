import QtQuick
import Quickshell
import Quickshell.Io
import ".." as Plugin

ShellRoot {
  id: root
  property string fixture: Quickshell.env("OMACAST_STORE_FIXTURE")
  property int lastCommand: -1
  property var runner: null
  property var results: []
  property bool cancelOnCompleting: false

  Component { id: factory; Plugin.ActionRunner {} }
  Connections {
    target: root.runner
    function onCompletingChanged() {
      if (root.cancelOnCompleting && root.runner.completing) root.runner.cancel()
    }
    function onFinished(key, ok, status, message) {
      root.results = root.results.concat([{ key: key, ok: ok, status: status, message: message, output: root.runner.output }])
      console.warn("OMACAST_WATCH " + JSON.stringify(root.snapshot()))
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

  function snapshot() { return { busy: runner ? runner.busy : false, results: results } }
  function dispatch() {
    commands.reload()
    var command
    try { command = JSON.parse(commands.text()) } catch (error) { return }
    if (command.id <= lastCommand) return
    lastCommand = command.id
    var result = null
    try {
      if (command.op === "open") runner = factory.createObject(root)
      else if (command.op === "run") result = runner.run(command.key, command.argv, command.timeout)
      else if (command.op === "cancel") runner.cancel()
      else if (command.op === "cancelAtCompletion") root.cancelOnCompleting = true
      else if (command.op === "destroy") { runner.destroy(); runner = null }
      console.warn("OMACAST_STORE " + JSON.stringify({ id: command.id, result: result, state: snapshot() }))
    } catch (error) {
      console.warn("OMACAST_STORE " + JSON.stringify({ id: command.id, harnessError: String(error) }))
    }
  }

  Component.onCompleted: dispatch()
}
