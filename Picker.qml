import QtQuick
import Quickshell

Item {
  id: root
  readonly property var items: root.rows
  readonly property string prompt: root.promptValue
  readonly property string requestId: root.identity
  readonly property string status: root.statusValue
  readonly property string error: root.errorValue
  property var rows: []
  property string promptValue: ""
  property string identity: ""
  property string requestPath: ""
  property string statusValue: "empty"
  property string errorValue: ""
  property int generation: 0
  property var jobs: []
  property double deadline: 0
  signal changed()
  signal finished()

  function open(path) {
    cancel()
    requestPath = String(path)
    statusValue = "loading"
    enqueue({mode: "picker-read", data: {path: requestPath}, generation: generation})
    return true
  }
  function select(id) {
    if (statusValue !== "ready" || !identity) return false
    var found = rows.some(function(row) { return row.id === id })
    if (!found) return false
    statusValue = "loading"
    enqueue({mode: "picker-answer", data: {path: requestPath, requestId: identity, selection: id}, generation: generation})
    return true
  }
  function cancel() {
    var hadRequest = !!identity || statusValue === "loading"
    if (identity && statusValue === "ready") enqueue({mode: "picker-answer", data: {path: requestPath, requestId: identity, selection: null}, generation: -1})
    generation++
    rows = []
    promptValue = ""
    identity = ""
    requestPath = ""
    errorValue = ""
    statusValue = "empty"
    changed()
    if (hadRequest) finished()
  }
  function enqueue(job) {
    jobs = jobs.concat([job])
    launch()
  }
  function launch() {
    if (worker.active || !jobs.length) return
    var job = jobs[0]
    jobs = jobs.slice(1)
    worker.run(job)
  }
  Component.onDestruction: {
    if (identity) Quickshell.execDetached(["python3", Qt.resolvedUrl("bin/omacast_adapter.py").toString().replace(/^file:\/\//, ""), "picker-answer", JSON.stringify({path: requestPath, requestId: identity, selection: null})])
    worker.cancel()
  }
  Timer {
    interval: 250
    running: root.statusValue === "ready" && !!root.identity
    repeat: true
    onTriggered: {
      if (Date.now() >= root.deadline) {
        root.cancel()
        root.errorValue = "Picker request expired"
        root.statusValue = "timeout"
        root.changed()
      }
    }
  }
  OptionalWorker {
    id: worker
    onCompleted: function(job, result) {
      if (job.generation !== root.generation) {
        if (job.mode === "picker-read" && result.id) root.enqueue({mode: "picker-answer", data: {path: job.data.path, requestId: result.id, selection: null}, generation: -1})
      } else {
        root.errorValue = result.error || ""
        if (job.mode === "picker-read" && result.status === "ready") {
          root.identity = result.id
          root.promptValue = result.prompt
          root.rows = result.items
          root.deadline = result.deadline * 1000
        } else if (job.mode === "picker-answer") {
          root.rows = []
          root.identity = ""
        }
        root.statusValue = result.status || "failed"
        if (job.mode === "picker-answer") root.finished()
        root.changed()
      }
      root.launch()
    }
  }
}
