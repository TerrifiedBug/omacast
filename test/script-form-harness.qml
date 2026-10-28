import QtQuick
import Quickshell
import Quickshell.Io
import ".."

Item {
  id: root
  property string fixture: Quickshell.env("OMACAST_STORE_FIXTURE")
  property int lastId: -1
  property var submitted: null
  property int cancellations: 0
  ScriptForm {
    id: form
    width: 500
    onSubmitted: function(values) { root.submitted = values }
    onCancelled: root.cancellations++
  }
  function snapshot() {
    return { specs: form.specs, values: form.values, error: form.error, submitted: root.submitted, cancellations: root.cancellations }
  }
  function process() {
    var command
    try { command = JSON.parse(request.text()) } catch (e) { return }
    if (command.id === lastId) return
    lastId = command.id
    try {
      if (command.op === "begin") { root.submitted = null; form.begin(command.specs, command.values || []) }
      else if (command.op === "values") form.values = command.values
      else if (command.op === "submit") form.submit()
      else if (command.op === "cancel") form.cancelled()
      console.log("OMACAST_STORE " + JSON.stringify({ id: command.id, state: snapshot() }))
    } catch (e) { console.log("OMACAST_STORE " + JSON.stringify({ id: command.id, harnessError: String(e) })) }
  }
  FileView {
    id: request
    path: root.fixture + "/command.json"
    watchChanges: true
    onLoaded: root.process()
    onFileChanged: reload()
  }
}
