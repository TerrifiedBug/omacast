import QtQuick
import Quickshell.Io
import "ScriptModel.js" as ScriptModel

// A single owned run drains before its replacement starts. Each publication and
// resolution is bound to both the script path and a monotonically changing ID.
Item {
  id: root

  property string home: ""
  readonly property var records: root.currentRecords
  readonly property string status: root.currentStatus
  readonly property string error: root.currentError
  readonly property int requestId: root.generation
  readonly property string sourcePath: root.currentPath
  property var currentRecords: []
  property string currentStatus: "empty"
  property string currentError: ""
  property int generation: 0
  property string currentPath: ""
  property var pending: null
  property bool active: false
  property bool shuttingDown: false

  function run(path, args) {
    var command = ScriptModel.resultsCommand(path, args)
    root.generation += 1
    root.currentRecords = []
    root.currentPath = typeof path === "string" ? path : ""
    root.currentError = ""
    root.pending = command ? { command: command, generation: root.generation, path: path } : null
    root.currentStatus = command ? "loading" : "failed"
    if (!command) root.currentError = "Invalid script path or arguments"
    if (runner.running) runner.running = false
    if (!root.active) startPending()
    return command !== null
  }

  function startPending() {
    if (root.shuttingDown || root.active || runner.running || !root.pending) return
    var next = root.pending
    root.pending = null
    if (next.generation !== root.generation) return
    root.active = true
    runner.generation = next.generation
    runner.path = next.path
    runner.output = ""
    runner.command = next.command
    runner.running = true
  }

  function cancel() {
    root.generation += 1
    root.pending = null
    root.currentRecords = []
    root.currentError = ""
    root.currentStatus = "cancelled"
    root.currentPath = ""
    if (runner.running) runner.running = false
  }

  function resolve(id, expectedRequestId) {
    if (root.currentStatus !== "ready") return null
    return ScriptModel.resolveRecord(root.currentRecords, id, expectedRequestId, root.currentPath, root.generation)
  }

  function finish(code, exitStatus) {
    root.active = false
    if (!root.shuttingDown && runner.generation === root.generation) {
      if (code === 124 || code === 137) {
        root.currentStatus = "timeout"
        root.currentError = "Script exceeded 10 seconds"
      } else if (code === 123) {
        root.currentStatus = "truncated"
        root.currentError = "Script output exceeded 64 KiB"
      } else if (code !== 0 || exitStatus !== 0) {
        root.currentStatus = "failed"
        root.currentError = code === 126 ? "Script is missing or not executable" : "Script exited unsuccessfully"
      } else {
        var result = ScriptModel.parseResults(runner.output, runner.path, runner.generation)
        root.currentRecords = result.records
        root.currentStatus = result.ok ? (result.records.length ? "ready" : "empty") : "failed"
        root.currentError = result.error
      }
    }
    startPending()
  }

  Component.onDestruction: {
    root.shuttingDown = true
    root.cancel()
  }

  Process {
    id: runner
    property int generation: 0
    property string path: ""
    property string output: ""
    workingDirectory: ScriptModel.validPath(root.home) ? root.home : "/"
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: runner.output = text
    }
    onExited: function(code, exitStatus) {
      // Process exit and stream completion are separate signals. Keep this run
      // occupied until final stdout is delivered before reusing the collector.
      Qt.callLater(function() { root.finish(code, exitStatus) })
    }
  }
}
