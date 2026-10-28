import QtQuick
import Quickshell
import Quickshell.Io
import ".." as Plugin

ShellRoot {
  id: root
  property string fixture: Quickshell.env("OMACAST_STORE_FIXTURE")
  property var provider: null
  property int lastCommand: -1
  property var expansions: []
  property var notices: []
  property var templateFailures: []
  property var previews: []

  Component {
    id: providerFactory
    Plugin.Sources {}
  }

  Connections {
    target: root.provider
    function onStorageErrorChanged() { root.publish() }
    function onCatalogChanged() { root.publish() }
    function onPreviewResultChanged() {
      root.previews = root.previews.concat([JSON.parse(JSON.stringify(root.provider.previewResult))])
      root.publish()
    }
    function onNotice(text) {
      root.notices = root.notices.concat([text])
      root.publish()
    }
    function onTemplateFailed(text) {
      root.templateFailures = root.templateFailures.concat([text])
      root.publish()
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

  function snapshot() {
    return provider ? {
      config: provider.configDoc, store: provider.store,
      bindingsLoaded: provider.bindingsLoaded, windowBinds: provider.windowBinds,
      error: provider.storageError || "",
      files: provider.filePaths, searching: provider.fileSearching,
      preview: provider.previewResult, content: provider.contentPaths,
      expansions: root.expansions, notices: root.notices, previews: root.previews,
      templateFailures: root.templateFailures
    } : null
  }

  function publish() {
    console.warn("OMACAST_WATCH " + JSON.stringify(snapshot()))
  }

  function reply(id, result) {
    console.warn("OMACAST_STORE " + JSON.stringify({ id: id, result: result, state: snapshot() }))
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
        provider = providerFactory.createObject(root, { home: fixture, omarchyPath: fixture + "/omarchy" })
        if (!provider) throw new Error("Could not create Sources")
        break
      case "config": result = provider.saveConfig(command.edit); break
      case "windowBind": result = provider.saveWindowBind(command.action, command.chord); break
      case "checkShortcut":
      case "checkedWindowBind":
        provider.checkShortcut(command.chord, command.owner, function(error) {
          var saved = false
          if (!error && command.op === "checkedWindowBind")
            saved = provider.saveWindowBind(command.action, command.chord)
          root.reply(command.id, { error: error, saved: saved })
        })
        return
      case "mutateAndDestroy":
        provider.togglePin("app:new")
        provider.toggleHidden("app:hidden")
        provider.recordUse("app:new")
        result = JSON.parse(JSON.stringify(provider.store))
        provider.destroy()
        provider = null
        Qt.callLater(function() { root.reply(command.id, result) })
        return
      case "destroy":
        provider.destroy()
        provider = null
        Qt.callLater(function() { root.reply(command.id, true) })
        return
      case "files": provider.searchFiles(fixture + "/files", command.terms || [], "all"); break
      case "cancelFiles": provider.cancelFiles(); break
      case "content": provider.searchContent(command.term); break
      case "preview": provider.requestPreview(command.key, command.spec); break
      case "cancelPreview": provider.cancelPreview(); break
      case "replacePreview":
        provider.requestPreview(command.key, command.previous)
        provider.cancelPreview()
        provider.requestPreview(command.key, command.spec)
        break
      case "template":
        provider.resolveTemplate(command.template, "", "text", function(text) {
          root.expansions = root.expansions.concat([text])
          root.publish()
        })
        break
      case "snapshot": break
      case "quit": Qt.quit(); return
      default: throw new Error("Unknown operation: " + command.op)
      }
      reply(command.id, result)
    } catch (e) {
      console.warn("OMACAST_STORE " + JSON.stringify({ id: command.id, harnessError: String(e) }))
    }
  }

  Timer {
    interval: 1
    running: true
    onTriggered: root.dispatch()
  }
}
