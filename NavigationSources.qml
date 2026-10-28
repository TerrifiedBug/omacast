import QtQuick
import Quickshell.Io
import "Model.js" as Model
import "Navigation.js" as Navigation

// Opt-in discovery has one owned process slot. Generations prevent cancelled
// streams from publishing after a close or a configuration replacement.
Item {
  id: root

  property string home: ""
  property var config: ({})
  property bool opened: false
  property string pluginCli: "omarchy"
  readonly property var projects: Navigation.projects(root.projectRecords.concat(root.zoxideRecords))
  readonly property var sshHosts: root.hostRecords
  readonly property var bookmarks: root.bookmarkRecords
  readonly property var pluginPanels: root.panelRecords
  readonly property var statuses: root.sourceStates
  property var projectRecords: []
  property var zoxideRecords: []
  property var hostRecords: []
  property var bookmarkRecords: []
  property var panelRecords: []
  property var sourceStates: ({})
  property var queue: []
  property int generation: 0
  property bool occupied: false
  property bool shuttingDown: false
  property var signatures: ({})
  property var refreshedAt: ({})
  property var settledStates: ({})
  readonly property var sourceNames: ["projects", "zoxide", "ssh", "bookmarks", "plugins"]
  readonly property string discoveryPath: decodeURIComponent(Qt.resolvedUrl("NavigationDiscovery.py").toString().replace(/^file:\/\//, ""))

  signal changed()

  function enabled(source) {
    if (source === "projects") return root.config.projectsEnabled === true
    if (source === "zoxide") return root.config.projectsEnabled === true && root.config.zoxideEnabled === true
    if (source === "ssh") return root.config.sshEnabled === true
    if (source === "bookmarks") return root.config.bookmarksEnabled === true
    if (source === "plugins") return root.config.pluginPanelsEnabled === true
    return false
  }

  function setStatus(source, state, message) {
    var next = Object.assign({}, root.sourceStates)
    next[source] = { state: state, message: message || "", retryable: state === "failed" || state === "timeout" }
    root.sourceStates = next
  }

  function clear(source) {
    if (source === "projects") root.projectRecords = []
    if (source === "zoxide") root.zoxideRecords = []
    if (source === "ssh") root.hostRecords = []
    if (source === "bookmarks") root.bookmarkRecords = []
    if (source === "plugins") root.panelRecords = []
  }

  function cancel() {
    refreshTimer.stop()
    root.generation += 1
    root.queue = []
    if (discoverProc.running) discoverProc.running = false
    var next = Object.assign({}, root.sourceStates), changed = false
    root.sourceNames.forEach(function(source) {
      if (next[source] && next[source].state === "loading") {
        next[source] = root.settledStates[source] || { state: "empty", message: "Discovery cancelled", retryable: false }
        changed = true
      }
    })
    if (changed) { root.sourceStates = next; root.changed() }
  }

  function signature(source) {
    return JSON.stringify([root.enabled(source), root.home,
      source === "projects" ? root.config.projectRoots || [] :
      source === "ssh" ? root.config.sshConfigFiles || [] :
      source === "bookmarks" ? root.config.bookmarkFiles || [] :
      source === "plugins" ? root.pluginCli : ""])
  }

  // Unrelated settings must not discard catalogs or restart discovery.
  // Disabling a source, however, removes its rows before returning.
  function reconcile() {
    var signatures = Object.assign({}, root.signatures)
    var times = Object.assign({}, root.refreshedAt)
    var settled = Object.assign({}, root.settledStates)
    var states = Object.assign({}, root.sourceStates), changed = false
    root.sourceNames.forEach(function(source) {
      var signature = root.signature(source)
      if (signatures[source] === signature) return
      signatures[source] = signature
      delete times[source]
      delete settled[source]
      root.clear(source)
      states[source] = { state: root.enabled(source) ? "empty" : "disabled", message: "", retryable: false }
      root.queue = root.queue.filter(function(value) { return value !== source })
      if (root.occupied && discoverProc.source === source) {
        root.generation += 1
        if (discoverProc.running) discoverProc.running = false
      }
      changed = true
    })
    root.signatures = signatures
    root.refreshedAt = times
    root.settledStates = settled
    if (changed) { root.sourceStates = states; root.changed() }
    root.refresh()
  }

  function refresh() {
    if (root.opened && !root.shuttingDown) refreshTimer.restart()
  }

  function refreshStale() {
    if (!root.opened || root.shuttingDown) return
    var next = root.queue.slice(), states = Object.assign({}, root.sourceStates), changed = false
    var now = Date.now()
    root.sourceNames.forEach(function(source) {
      if (!root.enabled(source) || next.indexOf(source) >= 0 ||
          (root.occupied && discoverProc.source === source && discoverProc.generation === root.generation)) return
      if (root.refreshedAt[source] !== undefined && now - root.refreshedAt[source] < 60000) return
      states[source] = { state: "loading", message: "", retryable: false }
      next.push(source)
      changed = true
    })
    root.queue = next
    if (changed) { root.sourceStates = states; root.changed() }
    root.startNext()
  }

  function retry(source) {
    if (!root.opened || !root.enabled(source) || root.shuttingDown) return false
    if (root.occupied && discoverProc.source === source && discoverProc.generation === root.generation) return false
    if (root.queue.indexOf(source) < 0) root.queue = root.queue.concat([source])
    root.setStatus(source, "loading", "")
    root.changed()
    root.startNext()
    return true
  }

  function startNext() {
    if (root.occupied || discoverProc.running || !root.opened || root.shuttingDown || !root.queue.length) return
    var next = root.queue.slice(), source = next.shift()
    root.queue = next
    if (!root.enabled(source)) { Qt.callLater(root.startNext); return }
    var options = { pluginCli: root.pluginCli }
    if (source === "projects") options.projectRoots = (root.config.projectRoots || []).slice(0, 32)
    if (source === "ssh") options.sshConfigFiles = (root.config.sshConfigFiles || []).slice(0, 32)
    if (source === "bookmarks") options.bookmarkFiles = (root.config.bookmarkFiles || []).slice(0, 32)
    discoverProc.source = source
    discoverProc.generation = root.generation
    discoverProc.signature = root.signatures[source]
    discoverProc.output = ""
    discoverProc.command = Model.boundedCommand("text", ["python3", root.discoveryPath, source, JSON.stringify(options), root.home], source === "bookmarks" ? 4194304 : 1572864, 0, false)
    root.occupied = true
    discoverProc.running = true
  }

  function publish(source, text, exitCode) {
    var doc, values = []
    try {
      doc = JSON.parse(text)
      if (source === "projects" || source === "zoxide") values = Navigation.projects(doc.data)
      if (source === "ssh") values = Navigation.sshHosts(doc.data)
      if (source === "bookmarks") values = Navigation.bookmarks(doc.data)
      if (source === "plugins") values = Navigation.pluginPanels(doc.data)
      if (source === "projects") root.projectRecords = values
      if (source === "zoxide") root.zoxideRecords = values
      if (source === "ssh") root.hostRecords = values
      if (source === "bookmarks") root.bookmarkRecords = values
      if (source === "plugins") root.panelRecords = values
      var errors = doc.errors || []
      root.setStatus(source, doc.timeout || exitCode === 124 || exitCode === 137 ? "timeout" : exitCode !== 0 || errors.length ? "failed" : values.length ? "ready" : "empty", errors.join("; ") || (exitCode ? "Discovery failed (" + exitCode + ")" : ""))
    } catch (error) {
      root.clear(source)
      root.setStatus(source, exitCode === 124 || exitCode === 137 ? "timeout" : "failed", String(error))
    }
    var settled = Object.assign({}, root.settledStates)
    settled[source] = root.sourceStates[source]
    root.settledStates = settled
    if (settled[source].state === "ready" || settled[source].state === "empty") {
      var times = Object.assign({}, root.refreshedAt)
      times[source] = Date.now()
      root.refreshedAt = times
    }
    root.changed()
  }

  function resolve(key) {
    if (!root.opened) return null
    var all = root.projects.concat(root.sshHosts, root.bookmarks, root.pluginPanels)
    for (var i = 0; i < all.length; i++) if (all[i].id === key) return all[i]
    return null
  }

  onOpenedChanged: { if (root.opened) root.refresh(); else root.cancel() }
  onConfigChanged: root.reconcile()
  onHomeChanged: root.reconcile()
  onPluginCliChanged: root.reconcile()
  Component.onCompleted: root.reconcile()
  Component.onDestruction: { root.shuttingDown = true; root.cancel() }

  Timer {
    id: refreshTimer
    interval: 0
    onTriggered: root.refreshStale()
  }

  Process {
    id: discoverProc
    property string source: ""
    property int generation: 0
    property string signature: ""
    property string output: ""
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: discoverProc.output = text
    }
    onExited: function(exitCode) {
      var source = discoverProc.source, generation = discoverProc.generation
      var signature = discoverProc.signature, output = discoverProc.output
      Qt.callLater(function() {
        if (!root.shuttingDown && root.opened && generation === root.generation &&
            signature === root.signatures[source] && root.enabled(source)) root.publish(source, output, exitCode)
        root.occupied = false
        root.startNext()
      })
    }
  }
}
