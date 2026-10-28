import QtQuick

Item {
  id: root
  enabled: false
  property string endpoint: "http://127.0.0.1:11434"
  property string model: ""
  readonly property var suggestions: root.rows
  readonly property string status: root.statusValue
  readonly property string error: root.errorValue
  property var rows: []
  property string statusValue: enabled ? "empty" : "disabled"
  property string errorValue: ""
  property var pending: null
  property int generation: 0

  function search(query, candidates) {
    cancel()
    if (!enabled) return false
    if (!model.trim()) {
      errorValue = "Select an installed local embedding model"
      statusValue = "failed"
      return false
    }
    if (!String(query).trim()) return false
    var bounded = []
    for (var i = 0; i < Math.min(32, candidates.length); i++) {
      var row = candidates[i]
      bounded.push({ id: row.id || row.key, key: row.key || row.id,
        title: String(row.title || "").slice(0, 256), subtitle: String(row.subtitle || "").slice(0, 256) })
    }
    pending = {mode: "semantic", data: {query: String(query), candidates: bounded, endpoint: endpoint, model: model}, generation: generation}
    statusValue = "loading"
    launch()
    return true
  }
  function cancel() {
    generation++
    pending = null
    rows = []
    errorValue = ""
    statusValue = enabled ? "empty" : "disabled"
    worker.cancel()
  }
  function launch() {
    if (worker.active || !pending) return
    var job = pending
    pending = null
    worker.run(job)
  }
  onEnabledChanged: cancel()
  onEndpointChanged: cancel()
  onModelChanged: cancel()
  OptionalWorker {
    id: worker
    onCompleted: function(job, result) {
      if (job.generation === root.generation) {
        root.rows = result.suggestions || []
        root.errorValue = result.error || ""
        root.statusValue = result.status || "failed"
      }
      root.launch()
    }
  }
}
