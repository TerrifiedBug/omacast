import QtQuick
import Quickshell
import Quickshell.Io
import ".."

Item {
  id: root
  property string fixture: Quickshell.env("OMACAST_STORE_FIXTURE")
  property int lastId: -1
  function snapshot() {
    return { picker: {items: picker.items, requestId: picker.requestId, status: picker.status, error: picker.error},
      agent: {status: agent.status, error: agent.error, answer: agent.answer},
      semantic: {status: semantic.status, error: semantic.error, suggestions: semantic.suggestions} }
  }
  function watch() { console.log("OMACAST_WATCH " + JSON.stringify(snapshot())) }
  function handle() {
    try {
      var command = JSON.parse(input.text())
      if (command.id === lastId) return
      lastId = command.id
      if (command.op === "picker") picker.open(command.path)
      else if (command.op === "select") picker.select(command.selection)
      else if (command.op === "cancelPicker") picker.cancel()
      else if (command.op === "agent") { agent.enabled = command.enabled; agent.command = command.command || []; agent.send(command.prompt || "") }
      else if (command.op === "cancelAgent") agent.cancel()
      else if (command.op === "semantic") { semantic.enabled = command.enabled; semantic.endpoint = command.endpoint || "http://127.0.0.1:11434"; semantic.model = command.model || ""; semantic.search(command.query || "", command.candidates || []) }
      else if (command.op === "cancelSemantic") semantic.cancel()
      console.log("OMACAST_STORE " + JSON.stringify(Object.assign({id: command.id}, snapshot())))
    } catch (e) { console.log("OMACAST_STORE " + JSON.stringify({id: lastId, harnessError: String(e)})) }
  }
  Picker { id: picker; onChanged: root.watch() }
  AgentAnswers { id: agent; onStatusChanged: root.watch() }
  SemanticSearch { id: semantic; onStatusChanged: root.watch() }
  FileView { id: input; path: root.fixture + "/command.json"; watchChanges: true; onLoaded: root.handle(); onFileChanged: reload() }
}
