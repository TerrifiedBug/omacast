pragma ComponentBehavior: Bound

import QtQuick
import Quickshell.Io
import Quickshell.Hyprland

// A fresh socket owns each generation. Replies are complete only at EOF.
QtObject {
  id: root
  property string socketPath: Hyprland.requestSocketPath
  property int timeoutMs: 2500
  property int maxBytes: 2097152
  readonly property bool busy: _active !== null
  property var _active: null
  property int _generation: 0
  signal finished(int generation, bool ok, string reply)

  function request(command) {
    cancel()
    var generation = ++_generation
    if (!socketPath || !command || command.length > maxBytes) {
      Qt.callLater(function() { if (generation === root._generation) root.finished(generation, false, "Invalid native socket path or request") })
      return generation
    }
    var job = socketComponent.createObject(root, { requestGeneration: generation, command: command, path: socketPath })
    _active = job
    job.deadline.start()
    job.connected = true
    return generation
  }

  function cancel() {
    ++_generation
    var job = _active
    _active = null
    if (job) { job.deadline.stop(); job.connected = false; job.destroy() }
  }

  function complete(job, ok, reply) {
    if (_active !== job || job.requestGeneration !== _generation) return
    var generation = job.requestGeneration
    _active = null
    job.deadline.stop()
    job.connected = false
    job.destroy()
    finished(generation, ok, reply)
  }

  property Component socketComponent: Component {
    Socket {
      id: socket
      property int requestGeneration: 0
      property string command: ""
      property bool sent: false
      parser: StdioCollector {
        id: output
        waitForEnd: false
        onDataChanged: {
          if (output.text.length > root.maxBytes) root.complete(socket, false, "Native reply exceeded the size limit")
        }
      }
      onConnectionStateChanged: {
        if (socket.connected && !socket.sent) {
          socket.sent = true
          socket.write(socket.command)
          socket.flush()
        } else if (!socket.connected && socket.sent) {
          root.complete(socket, output.text.length > 0, output.text.length ? output.text : "Native socket closed without a reply")
        }
      }
      // RemoteHostClosedError is the normal Hyprland one-shot EOF; connection
      // state handles it after collecting all bytes. Other errors fail closed.
      // qmllint disable signal-handler-parameters
      onError: function(error) {
        if (Number(error) !== 1) root.complete(socket, false, "Native socket error " + String(error))
      }
      // qmllint enable signal-handler-parameters
      property Timer deadline: Timer {
        interval: Math.max(1, root.timeoutMs)
        onTriggered: root.complete(socket, false, "Native request timed out; its outcome may be unknown")
      }
    }
  }
  Component.onDestruction: cancel()
}
