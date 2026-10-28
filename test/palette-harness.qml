import QtQuick
import QtQuick.Window
import QtTest
import Quickshell
import Quickshell.Io
import ".."

ShellRoot {
  id: root
  property string fixture: Quickshell.env("OMACAST_STORE_FIXTURE")
  property int lastId: -1
  property bool ready: false
  property int renderedFrames: 0
  property bool initialReplyPending: false
  property var pendingCapture: null
  Window {
    id: host
    width: 1000
    height: 800
    visible: true
    TestEvent { id: keyboard }
    color: "transparent"
    onFrameSwapped: {
      root.renderedFrames++
      if (root.initialReplyPending) {
        root.initialReplyPending = false
        frameDeadline.stop()
        root.ready = true
        root.reply(0)
      }
      if (root.pendingCapture && root.renderedFrames >= root.pendingCapture.frame)
        Qt.callLater(root.captureFrame)
    }
    Omacast {
      id: palette
      home: root.fixture
      omarchyPath: root.fixture + "/omarchy"
      onRowsChanged: root.watch()
      onOpenedChanged: root.watch()
      onNoticeChanged: root.watch()
    }
  }
  function resultsList() {
    function find(item) {
      if (typeof item.positionViewAtIndex === "function" && item.count === palette.rows.length) return item
      var children = item.children || []
      for (var i = 0; i < children.length; i++) { var found = find(children[i]); if (found) return found }
      return null
    }
    return find(host.contentItem)
  }
  function state() {
    var value = JSON.parse(palette.inspect("{}"))
    var list = resultsList()
    value.viewport = list ? { contentY: list.contentY, height: list.height } : null
    return value
  }
  function watch() { if (root.ready) console.log("OMACAST_WATCH " + JSON.stringify(state())) }
  function reply(id, extra) { console.log("OMACAST_STORE " + JSON.stringify(Object.assign({ id: id, state: state() }, extra || {}))) }
  function captureDiagnostic() {
    return "visible=" + host.visible + ",visibility=" + host.visibility + ",frames=" + root.renderedFrames
      + ",window=" + host.width + "x" + host.height + ",content=" + host.contentItem.width + "x" + host.contentItem.height
  }
  function visualRows() {
    var rows = ({})
    function visit(item) {
      if (!item || !item.visible) return
      var row = typeof item.index === "number" ? palette.rows[item.index] : null
      if (row && item.title === row.title && typeof item.current === "boolean") {
        var point = item.mapToItem(host.contentItem, 0, 0)
        rows[row.key] = { x: point.x, y: point.y, width: item.width, height: item.height }
      }
      var children = item.children || []
      for (var i = 0; i < children.length; i++) visit(children[i])
    }
    visit(host.contentItem)
    return rows
  }
  function captureFrame() {
    var capture = root.pendingCapture
    if (!capture) return
    root.pendingCapture = null
    frameDeadline.stop()
    if (!host.contentItem.grabToImage(function(image) {
      reply(capture.id, { png: capture.path, saved: image.saveToFile(capture.path),
        visualRows: root.visualRows(), windowWidth: host.width, windowHeight: host.height })
    }))
      reply(capture.id, { harnessError: "Window capture unavailable: " + captureDiagnostic() })
  }
  function attach() {
    for (var i = 0; i < palette.data.length; i++) {
      var candidate = palette.data[i]
      if (candidate && candidate.contentItem !== undefined) {
        candidate.contentItem.parent = host.contentItem
        candidate.width = host.width
        candidate.height = host.height
      }
    }
  }
  function scriptForm() {
    var seen = []
    function walk(node) {
      if (!node || seen.indexOf(node) >= 0) return null
      seen.push(node)
      if (typeof node.submit === "function" && node.specs !== undefined) return node
      var children = node.data || node.children || []
      for (var i = 0; i < children.length; i++) { var found = walk(children[i]); if (found) return found }
      if (node.contentItem !== undefined) return walk(node.contentItem)
      return null
    }
    return walk(palette)
  }
  function process() {
    var command
    try { command = JSON.parse(request.text()) } catch (e) { return }
    if (command.id === lastId) return
    lastId = command.id
    try {
      attach()
      if (command.id === 0 && !root.renderedFrames) {
        root.initialReplyPending = true
        frameDeadline.restart()
        host.update()
        return
      }
      root.ready = true
      if (command.op === "open") palette.open(JSON.stringify(command.payload || {}))
      else if (command.op === "profileOpen") {
        var started = Date.now()
        palette.open(JSON.stringify(command.payload || {}))
        reply(command.id, { openMs: Date.now() - started })
        return
      }
      else if (command.op === "close") palette.close()
      else if (command.op === "query") palette.setQuery(command.query)
      else if (command.op === "root") palette.cycleRoot(command.direction || 1)
      else if (command.op === "semanticCandidates") { reply(command.id, { candidates: palette.semanticCandidates() }); return }
      else if (command.op === "pointerMove") {
        var pointerIndex = palette.rows.map(function(row) { return row.key }).indexOf(command.key)
        if (pointerIndex < 0) throw new Error("Row not available: " + command.key)
        var pointerItem = resultsList()
        if (!pointerItem) throw new Error("Results list unavailable")
        command.points.forEach(function(point) { palette.selectFromPointer(pointerIndex, pointerItem, point) })
      }
      else if (command.op === "enter") palette.handleKey({ key: Qt.Key_Return, modifiers: Qt.NoModifier, isAutoRepeat: false, accepted: false })
      else if (command.op === "key") {
        var modifiers = Qt.NoModifier
        ;(command.modifiers || []).forEach(function(name) { modifiers |= Qt[name + "Modifier"] })
        if (!keyboard.keyClick(Qt["Key_" + command.key], modifiers, 0)) throw new Error("Palette window could not receive key input")
      }
      else if (command.op === "scrollTo" || command.op === "select" || command.op === "activate" || command.op === "action") {
        var index = palette.rows.map(function(row) { return row.key }).indexOf(command.key)
        if (index < 0) throw new Error("Row not available: " + command.key)
        palette.select(String(index))
        if (command.op === "scrollTo") {
          var list = resultsList()
          if (!list) throw new Error("Results list unavailable")
          list.forceLayout()
          list.positionViewAtIndex(index, ListView.Contain)
        }
        if (command.op === "activate") palette.activate(index, command.secondary === true)
        else if (command.op === "action") palette.runAction(command.action)
      } else if (command.op === "form") {
        var form = scriptForm()
        if (!form || !palette.scriptFormRow) throw new Error("No open script form")
        form.values = command.values
        form.submit()
      } else if (command.op === "escape") palette.handleKey({ key: Qt.Key_Escape, modifiers: Qt.NoModifier, isAutoRepeat: false, accepted: false })
      else if (command.op === "capture") {
        var name = String(command.name || "palette").replace(/[^a-zA-Z0-9_-]/g, "_")
        var path = root.fixture + "/" + name + ".png"
        root.pendingCapture = { id: command.id, path: path, frame: root.renderedFrames + 1 }
        frameDeadline.restart()
        host.update()
        return
      }
      reply(command.id)
    } catch (e) { console.log("OMACAST_STORE " + JSON.stringify({ id: command.id, harnessError: String(e) })) }
  }
  Timer {
    id: frameDeadline
    interval: 5000
    onTriggered: {
      if (root.initialReplyPending) {
        console.error("Initial Window frame unavailable: " + root.captureDiagnostic())
        Qt.exit(5)
        return
      }
      var id = root.pendingCapture ? root.pendingCapture.id : 0
      root.pendingCapture = null
      root.initialReplyPending = false
      root.reply(id, { harnessError: "Window did not render a requested frame: " + root.captureDiagnostic() })
    }
  }
  FileView {
    id: request
    path: root.fixture + "/command.json"
    watchChanges: true
    onLoaded: Qt.callLater(root.process)
    onFileChanged: reload()
  }
}
