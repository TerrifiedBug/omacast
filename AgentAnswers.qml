import QtQuick

Item {
  id: root
  enabled: false
  property var command: []
  property string home: ""
  readonly property string answer: root.answerValue
  readonly property string status: root.statusValue
  readonly property string error: root.errorValue
  property string answerValue: ""
  property string statusValue: enabled ? "empty" : "disabled"
  property string errorValue: ""
  property var pending: null
  property int generation: 0

  function send(prompt) {
    if (!enabled) return false
    cancel()
    pending = {mode: "agent", data: {prompt: String(prompt), command: command.slice()}, generation: generation}
    statusValue = "loading"
    launch()
    return true
  }
  function cancel() {
    generation++
    pending = null
    answerValue = ""
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
  OptionalWorker {
    id: worker
    onCompleted: function(job, result) {
      if (job.generation === root.generation) {
        root.answerValue = result.answer || ""
        root.errorValue = result.error || ""
        root.statusValue = result.status || "failed"
      }
      root.launch()
    }
  }
}
