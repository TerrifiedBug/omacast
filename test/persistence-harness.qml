import QtQuick
import Quickshell
import Quickshell.Io
import ".." as Plugin

ShellRoot {
  id: root
  property string fixture: Quickshell.env("OMACAST_STORE_FIXTURE")
  property var store: null
  property int lastCommand: -1

  Component {
    id: storeFactory
    Plugin.JsonStore {}
  }

  Connections {
    target: root.store
    function onDocumentChanged() { root.publish() }
    function onWritableChanged() { root.publish() }
  }

  function publish() {
    console.warn("OMACAST_WATCH " + JSON.stringify(snapshot()))
  }

  FileView {
    id: commands
    path: root.fixture + "/command.json"
    blockAllReads: true
    printErrors: false
    watchChanges: true
    onFileChanged: root.dispatch()
  }

  FileView {
    id: externalWriter
    blockWrites: true
    atomicWrites: true
    property string writeError: ""
    onSaveFailed: error => { writeError = FileViewError.toString(error) }
  }

  function snapshot() {
    return store ? {
      document: store.document,
      ready: store.ready,
      writable: store.writable,
      dirty: store.dirty,
      error: store.error
    } : null
  }

  function dispatch() {
    commands.reload()
    var command
    try { command = JSON.parse(commands.text()) } catch (e) { return }
    if (command.id <= lastCommand) return
    lastCommand = command.id
    var result = null
    try {
      switch (command.op) {
      case "open":
        if (store) throw new Error("Store already open")
        store = storeFactory.createObject(root, {
          path: fixture + "/" + command.file,
          saveDelay: command.delay || 0
        })
        if (!store) throw new Error("Could not create JsonStore")
        if (command.parser === "null") store.parse = function(text) { return null }
        if (command.parser === "null") store.reload()
        break
      case "replace": result = store.replace(command.document); break
      case "damageThenReplace":
        // No event-loop turn between external syntax damage and the commit.
        externalWriter.path = fixture + "/" + command.file
        externalWriter.writeError = ""
        externalWriter.setText(command.text)
        externalWriter.waitForJob()
        if (externalWriter.writeError) throw new Error(externalWriter.writeError)
        result = store.replace(command.document)
        break
      case "reload": store.reload(); break
      case "flush": result = store.flush(); break
      case "snapshot": break
      case "destroy":
        result = store.flush()
        store.destroy()
        store = null
        break
      case "quit": Qt.quit(); return
      default: throw new Error("Unknown operation: " + command.op)
      }
      console.warn("OMACAST_STORE " + JSON.stringify({ id: command.id, result: result, state: snapshot() }))
    } catch (e) {
      console.warn("OMACAST_STORE " + JSON.stringify({ id: command.id, harnessError: String(e) }))
    }
  }

  Timer {
    id: startup
    interval: 1
    onTriggered: root.dispatch()
  }
  Component.onCompleted: startup.start()
}
