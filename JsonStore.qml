import QtQuick
import Quickshell.Io

// Keep the last good document through parse/read failures. The owner flushes
// pending edits before destruction; a successful save means committed bytes
// were read back, not merely queued for FileView.
QtObject {
  id: root

  property string path: ""
  property var parse: function(text) { return JSON.parse(text) }
  property var serialize: function(doc) { return JSON.stringify(doc, null, 2) + "\n" }
  property int saveDelay: 0

  readonly property var document: root._document
  readonly property bool ready: root._ready
  readonly property bool writable: root._writable
  readonly property bool dirty: root._dirty
  readonly property string error: root._error
  signal failed(string error)

  property var _document: ({})
  property var _base: ({})
  property bool _ready: false
  property bool _writable: false
  property bool _dirty: false
  property string _error: ""
  property bool _busy: false
  property bool _started: false
  property int _readError: -1
  property int _writeResult: 0

  property FileView _file: FileView {
    path: root.path
    preload: false
    blockAllReads: true
    blockWrites: true
    atomicWrites: true
    watchChanges: true
    printErrors: false
    onLoadFailed: function(error) { root._readError = error }
    onSaved: root._writeResult = 1
    onSaveFailed: function(error) {
      root._writeResult = -1
      root._reject(FileViewError.toString(error))
    }
    onFileChanged: {
      if (!root._busy) root.reload()
    }
  }

  property Timer _save: Timer {
    interval: Math.max(0, root.saveDelay)
    onTriggered: root.flush()
  }

  function _object(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value)
  }

  function _copy(value) {
    return JSON.parse(JSON.stringify(value))
  }

  function _same(a, b) {
    return JSON.stringify(a) === JSON.stringify(b)
  }

  // Only locally changed fields win. External additions, including nested unknown
  // fields, survive a delayed save; arrays are intentional whole-field edits.
  function _rebase(base, desired, disk) {
    var result = _copy(disk)
    var keys = Object.keys(base).concat(Object.keys(desired))
    var seen = ({})
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i]
      if (Object.prototype.hasOwnProperty.call(seen, key)) continue
      Object.defineProperty(seen, key, { value: true, enumerable: true })
      var had = Object.prototype.hasOwnProperty.call(base, key)
      var has = Object.prototype.hasOwnProperty.call(desired, key)
      if (had === has && _same(base[key], desired[key])) continue
      if (!has) {
        delete result[key]
      } else {
        var value = had && _object(base[key]) && _object(desired[key]) && _object(disk[key])
          ? _rebase(base[key], desired[key], disk[key]) : _copy(desired[key])
        Object.defineProperty(result, key, { value: value, enumerable: true, writable: true, configurable: true })
      }
    }
    return result
  }

  function _reject(message) {
    _error = path.slice(path.lastIndexOf("/") + 1) + ": " + message
    _writable = false
    failed(_error)
  }

  function _readDisk() {
    if (!path) {
      _reject("No file path specified")
      return null
    }
    _readError = -1
    _file.reload()
    var text = _file.text()
    _file.waitForJob()
    if (_readError !== -1) {
      if (_readError === FileViewError.FileNotFound) return { document: ({}), text: null }
      _reject(FileViewError.toString(_readError))
      return null
    }
    try {
      var parsed = parse(text)
      if (!_object(parsed)) throw new Error("Expected a JSON object (parser returned a non-object)")
      return { document: _copy(parsed), text: text }
    } catch (e) {
      _reject(String(e))
      return null
    }
  }

  function _acceptDisk(disk) {
    _document = _dirty ? _rebase(_base, _document, disk.document) : _copy(disk.document)
    _base = _copy(disk.document)
    _writable = true
    _error = ""
  }

  function reload() {
    if (_busy) return
    _busy = true
    var disk = _readDisk()
    if (disk) _acceptDisk(disk)
    _ready = true
    _busy = false
    if (disk && _dirty && saveDelay > 0) _save.restart()
  }

  function replace(doc) {
    try {
      if (!_object(doc)) throw new Error("Expected a JSON object")
      var next = _copy(doc)
      if (!_same(next, _document)) {
        _document = next
        _dirty = true
      }
    } catch (e) {
      _reject(String(e))
      return false
    }
    if (saveDelay === 0) return flush()
    if (_dirty) _save.restart()
    return true
  }

  function flush() {
    _save.stop()
    if (_busy) return false
    if (!_dirty) return _writable
    _busy = true
    // A fresh synchronous read closes the watcher-delay window. Never use the
    // FileView cache to decide whether an existing file is safe to overwrite.
    var disk = _readDisk()
    _ready = true
    if (!disk) {
      _busy = false
      return false
    }
    _acceptDisk(disk)
    var text
    try {
      text = serialize(_document)
      if (typeof text !== "string") throw new Error("Serializer did not return text")
    } catch (e) {
      _reject(String(e))
      _busy = false
      return false
    }
    _writeResult = 0
    if (text !== disk.text) {
      _file.setText(text)
      _file.waitForJob()
      if (_writeResult !== 1) {
        if (_writeResult === 0) _reject("Write did not complete")
        _busy = false
        return false
      }
      // Read committed bytes before acknowledging the write. Failed commits
      // must leave pending edits dirty.
      var written = _readDisk()
      if (!written || written.text !== text) {
        if (written) _reject("Written file did not match the requested document")
        _busy = false
        return false
      }
    }
    _base = _copy(_document)
    _dirty = false
    _writable = true
    _error = ""
    _busy = false
    return true
  }

  onPathChanged: {
    if (_started) reload()
  }
  Component.onCompleted: {
    _started = true
    reload()
  }
}
