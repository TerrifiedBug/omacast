import QtQuick
import Quickshell.Io

// The run token remains fixed until exit and both collectors have drained.
Item {
  id: root
  readonly property bool active: root.owned
  property bool owned: false
  property int serial: 0
  property int token: 0
  property var job: null
  property bool exited: false
  property bool stdoutDone: false
  property bool stderrDone: false
  property string output: ""
  property int exitCode: 0
  property bool started: false
  property string input: ""
  property bool cancelRequested: false
  signal completed(var job, var result)

  function run(next) {
    if (owned) return false
    owned = true
    job = next
    token = ++serial
    exited = false
    stdoutDone = false
    started = false
    input = ""
    cancelRequested = false
    stderrDone = false
    output = ""
    worker.command = ["python3", Qt.resolvedUrl("bin/omacast_adapter.py").toString().replace(/^file:\/\//, ""), next.mode, JSON.stringify(next.data)]
    worker.running = true
    return true
  }
  function cancel() {
    if (!owned) return
    cancelRequested = true
    if (started) worker.signal(15)
  }
  function write(text) {
    if (!owned) return
    if (started) worker.write(text)
    else input += text
  }
  function settle() {
    if (!owned || !exited || !stdoutDone || !stderrDone) return
    var expected = token
    Qt.callLater(function() {
      if (!root.owned || root.token !== expected || !root.exited || !root.stdoutDone || !root.stderrDone) return
      var finishedJob = root.job
      var result
      try { result = JSON.parse(root.output) }
      catch (e) { result = {status: "failed", error: "Optional adapter did not return a complete response (exit " + root.exitCode + ")"} }
      root.job = null
      root.owned = false
      root.completed(finishedJob, result)
    })
  }
  Component.onDestruction: cancel()
  Process {
    id: worker
    stdinEnabled: true
    onStarted: {
      root.started = true
      if (root.cancelRequested) worker.signal(15)
      if (root.input) { worker.write(root.input); root.input = "" }
    }
    stdout: StdioCollector {
      onStreamFinished: { root.output = text; root.stdoutDone = true; root.settle() }
    }
    stderr: StdioCollector {
      onStreamFinished: { root.stderrDone = true; root.settle() }
    }
    onExited: function(code, exitStatus) { root.exitCode = code; root.exited = true; root.settle() }
  }
}
