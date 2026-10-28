import QtQuick
import Quickshell.Io
import "FilePolicy.js" as FilePolicy

// This gate performs metadata resolution only after an explicit request. Each
// consumer owns an instance so unrelated preview/search lifecycles can't cancel it.
Item {
  id: root

  property string home: ""
  property var config: ({})
  readonly property bool busy: active !== null || pending !== null
  readonly property string canonicalHome: acceptedHome
  readonly property var canonicalConfig: acceptedConfig
  readonly property string canonicalRootPath: acceptedRootPath
  property string acceptedHome: ""
  property var acceptedConfig: ({})
  property string acceptedRootPath: ""
  property int generation: 0
  property var pending: null
  property var active: null
  property bool destroyed: false

  signal resolved(string key, bool allowed, string canonicalPath, string message)

  function inspect(key, path, rootPath, purpose) {
    generation += 1
    pending = null
    var settings = { protectPreviews: config.protectPreviews !== false,
      allowProtectedPaths: FilePolicy.overrides(home, config) }
    // Resolve allowances before applying protection, since an explicit allowance
    // may itself name a symlink. This stage checks only lexical root admission.
    var check = FilePolicy.request(path, rootPath, home,
      { allowProtectedPaths: ["/"] }, purpose)
    if (!check.ok) {
      if (resolver.running) resolver.running = false
      resolved(String(key), false, "", check.message)
      return
    }
    pending = { key: String(key), path: check.path, rootPath: check.rootPath,
      home: FilePolicy.normalizePath(home, home), config: settings,
      purpose: purpose, generation: generation }
    if (resolver.running || active) {
      if (resolver.running) resolver.running = false
      return
    }
    startPending()
  }

  function startPending() {
    if (destroyed || active || resolver.running || !pending) return
    var next = pending
    pending = null
    if (next.generation !== generation) return
    active = next
    resolver.output = ""
    resolver.expired = false
    // NUL records preserve newlines and other legal pathname bytes. Limit the
    // collector before it sees output, and own the subprocess group on timeout.
    resolver.command = ["timeout", "--kill-after=1s", "2s", "bash", "-c",
      'set -o pipefail; { realpath -ze -- "$1" "$2" "$3" || exit; shift 3; if (($#)); then realpath -zm -- "$@"; fi; } | head -c 131073',
      "omacast-realpath", next.path, next.rootPath, next.home].concat(next.config.allowProtectedPaths)
    resolver.running = true
    deadline.restart()
  }

  function complete(exitCode) {
    var request = active
    var text = resolver.output
    active = null
    if (!request || destroyed) return
    if (request.generation === generation) {
      var records = text.split("\u0000")
      var complete = records.pop() === ""
      if (exitCode !== 0 || resolver.expired || text.length > 131072 || !complete || records.length !== 3 + request.config.allowProtectedPaths.length) {
        resolved(request.key, false, "", resolver.expired || exitCode === 124 || exitCode === 137
          ? "Path resolution timed out" : "Could not resolve the file and selected root")
      } else {
        var canonicalSettings = { protectPreviews: request.config.protectPreviews,
          allowProtectedPaths: records.slice(3) }
        var check = FilePolicy.request(records[0], records[1], records[2], canonicalSettings, request.purpose)
        if (check.ok) {
          var lexicalSettings = { protectPreviews: request.config.protectPreviews,
            allowProtectedPaths: request.config.allowProtectedPaths.concat(records.slice(3)) }
          check = FilePolicy.request(request.path, request.rootPath, request.home, lexicalSettings, request.purpose)
        }
        if (check.ok) {
          acceptedHome = records[2]
          acceptedConfig = canonicalSettings
          acceptedRootPath = records[1]
        }
        resolved(request.key, check.ok, check.ok ? records[0] : "", check.message)
      }
    }
    startPending()
  }

  function cancel() {
    generation += 1
    pending = null
    deadline.stop()
    if (resolver.running) resolver.running = false
  }

  onHomeChanged: cancel()
  onConfigChanged: cancel()
  Component.onDestruction: {
    destroyed = true
    cancel()
  }

  Process {
    id: resolver
    property string output: ""
    property bool expired: false
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: resolver.output = text
    }
    stderr: StdioCollector { waitForEnd: true }
    onExited: function(exitCode) {
      deadline.stop()
      Qt.callLater(function() { root.complete(exitCode) })
    }
  }

  Timer {
    id: deadline
    interval: 2800
    onTriggered: {
      resolver.expired = true
      resolver.running = false
    }
  }
}
