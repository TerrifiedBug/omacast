import QtQuick
import Quickshell
import Quickshell.Io
import ".." as Plugin
import "../Model.js" as Model

ShellRoot {
  id: root
  property string fixture: Quickshell.env("OMACAST_STORE_FIXTURE")
  property int lastCommand: -1
  property var operations: []
  property bool autoLaunchMenu: false
  Plugin.Sources {
    id: provider
    home: root.fixture
    omarchyPath: root.fixture + "/omarchy"
    onCatalogChanged: root.publish()
    onPreviewResultChanged: root.publish()
    onSourceStatusesChanged: root.publish()
    onOperationFinished: function(key, ok, status, message) {
      root.operations = root.operations.concat([{key: key, ok: ok, status: status, message: message}])
      root.publish()
    }
    onMenuPrepared: function(id, token) {
      if (root.autoLaunchMenu) provider.launchPreparedMenu(id, token, function() { provider.opened = false })
      root.publish()
    }
    onCheckedResultsChanged: root.publish()
  }
  function snapshot() {
    var disk = ({})
    try { disk = JSON.parse(stateDisk.text()) } catch(e) {}
    return {preview: provider.previewResult, store: provider.store, persisted: disk, statuses: provider.sourceStatuses, operations: operations, opened: provider.opened, childStatus: childStatus ? childStatus.text() : "", guardStatus: guardStatus ? guardStatus.text() : "", nightlightStatus: nightlightStatus ? nightlightStatus.text() : "", checked: provider.checkedResults, files: provider.filePaths, resultCount: provider.scriptResults ? provider.scriptResults.records.length : 0, resultsStatus: provider.scriptResults ? provider.scriptResults.status : "", sshHosts: provider.navigation.sshHosts}
  }
  function publish() { console.warn("OMACAST_WATCH " + JSON.stringify(snapshot())) }
  FileView {
    id: stateDisk
    path: root.fixture + "/.local/state/omarchy/omacast-state.json"
    blockAllReads: true
    printErrors: false
    watchChanges: true
    onFileChanged: { reload(); root.publish() }
  }
  FileView {
    id: childStatus
    path: root.fixture + "/child-status"
    blockAllReads: true
    printErrors: false
    watchChanges: true
    onFileChanged: { reload(); root.publish() }
  }
  FileView {
    id: guardStatus
    path: root.fixture + "/guard-status"
    blockAllReads: true
    printErrors: false
    watchChanges: true
    onFileChanged: { reload(); root.publish() }
  }
  FileView {
    id: nightlightStatus
    path: root.fixture + "/nightlight-status"
    blockAllReads: true
    printErrors: false
    watchChanges: true
    onFileChanged: { reload(); root.publish() }
  }
  FileView {
    id: commands
    path: root.fixture + "/command.json"
    blockAllReads: true
    printErrors: false
    watchChanges: true
    onFileChanged: root.dispatch()
  }
  function dispatch() {
    commands.reload()
    var c
    try { c = JSON.parse(commands.text()) } catch (e) { return }
    if (c.id <= lastCommand) return
    lastCommand = c.id
    var result = null
    try {
      if (c.staleGuardCache) provider.whenResults = ({})
      switch(c.op) {
      case "open": provider.opened = true; break
      case "preview": provider.requestPreview(c.key, c.spec); break
      case "resolve": result = provider.resolveAction(c.item); break
      case "navigation":
        var current = provider.resolveAction(c.item)
        result = provider.prepareNavigation(c.item, c.token || current.token)
        if (result.ok) result = provider.runOwnedAction(c.item.key, result.argv, 3000)
        break
      case "close": provider.opened = false; break
      case "menu":
        root.autoLaunchMenu = c.autoLaunch === true
        result = provider.executeMenu(c.menuId, c.token, true)
        break
      case "config": result = provider.saveConfig(c.edit); break
      case "use": provider.recordUse(c.key, c.query, c.scope); break
      case "alias": result = provider.setAlias(c.key, c.text); break
      case "seedScript": provider.scripts = [{path:c.path,keyword:c.keyword,executable:true,meta:Model.parseScriptCommand(c.text)}]; break
      case "results": result = provider.scriptResults.run(c.path, []); break
      case "files": provider.searchFiles(fixture + "/files", [], "all", fixture); break
      case "busyMenus":
        result = {first:provider.executeMenu(c.menuId,c.token,false),second:provider.executeMenu(c.menuId,c.token,false)}
        break
      case "busyOwned":
        result = {first:provider.runOwnedAction("initial",["true"],3000),signal:provider.signalProcess(2147483647,false,"1"),menu:provider.executeMenu(c.menuId,c.token,true)}
        break
      case "snapshot": break
      case "quit": Qt.quit(); return
      default: throw new Error("Unknown command")
      }
      console.warn("OMACAST_STORE " + JSON.stringify({id:c.id,result:result,state:snapshot()}))
    } catch(e) { console.warn("OMACAST_STORE " + JSON.stringify({id:c.id,harnessError:String(e)})) }
  }
  Timer { interval: 1; running: true; onTriggered: root.dispatch() }
}
