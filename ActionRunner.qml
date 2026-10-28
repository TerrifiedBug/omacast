import QtQuick
import Quickshell.Io
import "ActionPolicy.js" as ActionPolicy

// The fixed supervisor bounds output before QML sees it and retains group
// ownership through cancellation, timeout and component destruction.
Item {
  id: root

  property int byteLimit: 65536
  property string workingDirectory: "/"
  property bool active: false
  property bool cancelling: false
  property bool completing: false
  property bool shuttingDown: false
  property string activeKey: ""
  property string output: ""
  readonly property bool busy: active

  signal finished(string key, bool ok, string status, string message)

  function run(key, argv, timeoutMs) {
    if (root.active || root.shuttingDown) return false
    var command = ActionPolicy.executionCommand(argv, timeoutMs, root.byteLimit)
    if (!command.length) {
      root.finished(String(key), false, "invalid", "Invalid action arguments")
      return false
    }
    root.activeKey = String(key)
    root.output = ""
    root.cancelling = false
    root.completing = false
    root.active = true
    actionProc.command = command
    actionProc.running = true
    startup.start()
    return true
  }

  function cancel() {
    if (!root.active || root.completing) return
    root.cancelling = true
    if (actionProc.running) actionProc.signal(15)
  }

  function complete(status) {
    if (!root.active || root.shuttingDown) return
    startup.stop()
    if (root.cancelling) status = "cancelled"
    var key = root.activeKey
    var message = root.output.trim()
    if (!message) message = ({ success: "Action completed", missing: "Executable not found (python3 is required)",
      nonzero: "Action exited unsuccessfully", timeout: "Action timed out", truncated: "Action output limit exceeded",
      cancelled: "Action cancelled", invalid: "Action could not be started" })[status] || "Action failed"
    root.active = false
    root.completing = false
    root.activeKey = ""
    root.finished(key, status === "success", status, message)
  }

  Component.onDestruction: {
    root.shuttingDown = true
    root.cancel()
  }

  Timer {
    id: startup
    interval: 250
    onTriggered: {
      if (root.active && !root.completing && !actionProc.running) root.complete("missing")
    }
  }

  Process {
    id: actionProc
    workingDirectory: root.workingDirectory
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.output = text
    }
    onExited: function(exitCode, exitStatus) {
      root.completing = true
      startup.stop()
      var status = ActionPolicy.exitStatus(exitCode, exitStatus !== 0)
      // StreamFinished drains before completion; a new job cannot steal the
      // previous run's output or key while these callbacks are queued.
      Qt.callLater(function() { root.complete(status) })
    }
  }
}
