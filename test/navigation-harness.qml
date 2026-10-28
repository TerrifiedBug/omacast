import QtQuick
import Quickshell
import Quickshell.Io
import ".." as Plugin

ShellRoot {
  id: root
  property string fixture: Quickshell.env("OMACAST_STORE_FIXTURE")
  property int lastCommand: -1
  property int notifications: 0
  Plugin.NavigationSources {
    id: navigation
    home: root.fixture
    onChanged: { root.notifications += 1; console.warn("OMACAST_WATCH " + JSON.stringify(root.snapshot())) }
  }
  function snapshot() {
    return { projects: navigation.projects, ssh: navigation.sshHosts, bookmarks: navigation.bookmarks, plugins: navigation.pluginPanels, statuses: navigation.statuses, notifications: root.notifications, discoveryStarted: started.text() }
  }
  function dispatch() {
    commands.reload()
    var command
    try { command = JSON.parse(commands.text()) } catch (error) { return }
    if (command.id <= root.lastCommand) return
    root.lastCommand = command.id
    var result = true
    try {
      if (command.op === "open") { navigation.config = command.config || {}; navigation.opened = true }
      else if (command.op === "config") navigation.config = command.config || {}
      else if (command.op === "retry") result = navigation.retry(command.source)
      else if (command.op === "refresh") navigation.refresh()
      else if (command.op === "snapshot") {}
      else if (command.op === "cancel") navigation.cancel()
      else if (command.op === "close") navigation.opened = false
      else if (command.op === "resolve") result = navigation.resolve(command.key)
    } catch (error) { result = { error: String(error) } }
    console.warn("OMACAST_STORE " + JSON.stringify({ id: command.id, result: result, state: root.snapshot() }))
  }
  FileView {
    id: started
    path: root.fixture + "/discovery-started"
    blockAllReads: true
    printErrors: false
    watchChanges: true
    onFileChanged: { reload(); console.warn("OMACAST_WATCH " + JSON.stringify(root.snapshot())) }
  }
  FileView {
    id: commands
    path: root.fixture + "/command.json"
    blockAllReads: true
    printErrors: false
    watchChanges: true
    onFileChanged: root.dispatch()
  }
  Component.onCompleted: console.warn("OMACAST_STORE_READY")
  Timer {
    interval: 1
    running: true
    onTriggered: root.dispatch()
  }
}
