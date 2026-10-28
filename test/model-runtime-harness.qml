import QtQuick
import Quickshell
import Quickshell.Io
import "../Model.js" as Model

ShellRoot {
  id: root
  property int lastCommand: -1
  FileView {
    id: commands
    path: Quickshell.env("OMACAST_STORE_FIXTURE") + "/command.json"
    blockAllReads: true
    printErrors: false
    watchChanges: true
    onFileChanged: root.dispatch()
  }
  function dispatch() {
    commands.reload()
    var command
    try { command = JSON.parse(commands.text()) } catch (e) { return }
    if (command.id <= lastCommand) return
    lastCommand = command.id
    try {
      var result = null
      if (command.op === "search") {
        result = {
          accented: Model.matchScore("resume", { name: "Résumé", aliases: [], text: "" }),
          decomposed: Model.matchScore("résumé", { name: "Re\u0301sume\u0301", aliases: [], text: "" }),
          transliterated: Model.matchScore("strasse", { name: "Straße", aliases: [], text: "" }),
          prepared: Model.matchScore("resume", Model.prepareFields("Résumé", [], "")),
          exact: Model.matchScore("firefox", { name: "Firefox", aliases: [], text: "" }),
          typo: Model.matchScore("fierfox", { name: "Firefox", aliases: [], text: "" })
        }
      }
      console.warn("OMACAST_STORE " + JSON.stringify({ id: command.id, result: result, state: null }))
    } catch (e) {
      console.warn("OMACAST_STORE " + JSON.stringify({ id: command.id, harnessError: String(e) }))
    }
  }
  Timer { interval: 1; running: true; onTriggered: root.dispatch() }
}
