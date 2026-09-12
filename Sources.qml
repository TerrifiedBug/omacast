import QtQuick
import Quickshell
import Quickshell.Io
import Quickshell.Wayland
import "Model.js" as Model
import "vendor/MenuModel.js" as MenuModel

// Every effect OmaCast needs, in one non-visual item: the shell's own
// application library, the two menu JSONC files and their guard batch, the
// keybinding records, the live toplevel list, the clipboard store, the emoji
// table, fd, and the frecency state file. Omacast.qml reads the published
// catalogs and never touches a process itself.
//
// The catalogs land asynchronously — guards take a beat, fd takes longer —
// so every landing emits catalogChanged() and the surface rebuilds. What a
// landing may never do is move the cursor; that rule lives in Omacast.qml.
Item {
  id: root

  property string omarchyPath: ""
  property string home: ""
  property bool opened: false

  // Application library, loaded from the running shell rather than
  // reimplemented: same hidden-entry filtering, same icon index, same launch
  // feedback as the menu's Apps list.
  readonly property var appLibrary: libraryLoader.item

  property var config: Model.normalizeConfig(null)
  property var store: Model.normalizeState(null)

  property var menuItems: ({})
  property var menuOrder: []
  property var whenResults: ({})
  property var checkedResults: ({})
  property bool guardsPending: false

  property var keybindingRecords: []
  property var toplevels: []
  property var runningApps: ({})
  property var clipboardEntries: []
  property var emojis: []
  property bool emojiWanted: false
  property var filePaths: []

  // Milliseconds of the last successful run; the open path re-runs only what
  // has gone stale so a summon never waits on bash.
  property double guardsRunAt: 0
  property double bindsRunAt: 0

  property var pendingFiles: null
  property int fileGeneration: 0
  property int fileActiveGeneration: 0

  property var pendingTemplate: null
  property string pasteStage: ""

  signal catalogChanged()

  function onOpen() {
    if (root.appLibrary) root.appLibrary.refreshIcons()
    refreshToplevels()
    if (Date.now() - root.guardsRunAt > 30000) evaluateGuards()
    if (Date.now() - root.bindsRunAt > 60000) loadKeybindings()
  }

  // ---- Frecency state

  function recordUse(key) {
    if (!key) return
    var now = Date.now()
    var usage = Model.pruneUsage(Model.bump(root.store.usage, key, now), now, 400)
    root.store = { version: 1, usage: usage, pins: root.store.pins }
    saveTimer.restart()
  }

  function togglePin(key) {
    if (!key) return
    root.store = Model.togglePin(root.store, key)
    saveTimer.restart()
    root.catalogChanged()
  }

  function isPinned(key) {
    return root.store.pins.indexOf(key) >= 0
  }

  // ---- Menu

  function rebuildMenu() {
    var merged = MenuModel.mergeMenuSources(MenuModel.parseMenuJsonc(defaultMenuFile.text()), MenuModel.parseMenuJsonc(userMenuFile.text()))
    root.menuItems = merged.items
    root.menuOrder = merged.itemOrder
    evaluateGuards()
    root.catalogChanged()
  }

  // Copied from plugins/menu/Menu.qml: one bash batch answers every `when:`
  // and `checked:`, and a run that was killed keeps the previous answers
  // rather than letting a half-read set hide rows.
  function evaluateGuards() {
    if (guardProc.running) {
      root.guardsPending = true
      return
    }
    root.guardsPending = false

    var script = MenuModel.guardScript(root.menuItems)
    if (!script) {
      root.whenResults = ({})
      root.checkedResults = ({})
      return
    }
    guardProc.collected = ""
    guardProc.command = ["bash", "-lc", script]
    guardProc.running = true
  }

  function runMenuAction(action) {
    var command = String(action || "")
    if (!command) return
    Quickshell.execDetached(["bash", "-lc", command])
  }

  // ---- Keybindings

  function loadKeybindings() {
    if (bindsProc.running) return
    bindsProc.running = true
  }

  function dispatchBinding(dispatcher, arg) {
    if (!dispatcher) return
    Quickshell.execDetached(["bash", "-c", "source \"$0\" --print >/dev/null 2>&1; dispatch_binding \"$1\" \"$2\"", root.omarchyPath + "/bin/omarchy-menu-keybindings", String(dispatcher), String(arg || "")])
  }

  // ---- Windows

  function refreshToplevels() {
    var values = []
    var running = ({})
    var list = []
    try { list = ToplevelManager.toplevels.values || [] } catch (e) { list = [] }

    for (var i = 0; i < list.length; i++) {
      var top = list[i]
      values.push({ index: i, title: String(top.title || ""), appId: String(top.appId || ""), activated: top.activated === true, toplevel: top })
      var entry = DesktopEntries.heuristicLookup(String(top.appId || ""))
      var id = entry ? String(entry.id || "") : ""
      if (id && running[id] === undefined) running[id] = i
    }

    root.toplevels = values
    root.runningApps = running
    root.catalogChanged()
  }

  function toplevelAt(index) {
    var values = root.toplevels
    if (index < 0 || index >= values.length) return null
    return values[index].toplevel
  }

  // ---- Clipboard and emoji, both loaded on first scope entry

  function loadClipboard() {
    clipboardFile.reload()
  }

  function wantEmojis() {
    if (!root.emojiWanted) root.emojiWanted = true
  }

  // ---- Files
  //
  // One fd run at a time. A request that arrives mid-run replaces any earlier
  // pending one and starts from onExited, so a fast typist queues at most one
  // extra process rather than a fan of them.

  function searchFiles(dir, terms) {
    root.fileGeneration += 1
    var request = { dir: dir, terms: terms, generation: root.fileGeneration }
    if (fdProc.running) {
      root.pendingFiles = request
      return
    }
    runFileSearch(request)
  }

  function runFileSearch(request) {
    var command = ["fd", "--ignore-case", "--hidden", "--follow", "--one-file-system", "--type", "f", "--type", "d",
      "--exclude", ".git", "--exclude", "node_modules", "--exclude", ".cache",
      "--max-results", "200", "--threads", "2", "--absolute-path", "--color", "never"]

    var terms = request.terms || []
    if (terms.length > 0) {
      command.push("--fixed-strings")
      for (var i = 1; i < terms.length; i++) command = command.concat(["--and", terms[i]])
    } else {
      command = command.concat(["--max-depth", "1"])
    }
    command = command.concat(["--", terms.length > 0 ? terms[0] : ".", request.dir])

    root.fileActiveGeneration = request.generation
    fdProc.command = command
    fdProc.running = true
    fdKill.restart()
  }

  function clearFiles() {
    root.filePaths = []
  }

  // ---- Template expansion
  //
  // {clipboard} and {selection} are the only tokens that need a subprocess, so
  // a template without them expands synchronously and the palette closes in
  // the same frame.

  function resolveTemplate(template, argument, mode, done) {
    var ctx = { argument: argument || "", clipboard: "", selection: "", now: Date.now() }
    var wantsClipboard = Model.needsClipboard(template)
    var wantsSelection = Model.needsSelection(template)

    if (!wantsClipboard && !wantsSelection) {
      done(Model.expandTemplate(template, ctx, mode))
      return
    }
    if (pasteProc.running) {
      done(Model.expandTemplate(template, ctx, mode))
      return
    }

    root.pendingTemplate = { template: template, mode: mode, ctx: ctx, done: done, wantsSelection: wantsSelection }
    if (wantsClipboard) readPaste("clipboard")
    else readPaste("selection")
  }

  function readPaste(stage) {
    root.pasteStage = stage
    pasteProc.command = stage === "selection"
      ? ["wl-paste", "--primary", "--no-newline"]
      : ["wl-paste", "--no-newline"]
    pasteProc.running = true
  }

  function finishTemplate(text) {
    var pending = root.pendingTemplate
    if (!pending) return

    if (root.pasteStage === "clipboard") {
      pending.ctx.clipboard = text
      if (pending.wantsSelection) {
        readPaste("selection")
        return
      }
    } else {
      pending.ctx.selection = text
    }

    root.pendingTemplate = null
    root.pasteStage = ""
    pending.done(Model.expandTemplate(pending.template, pending.ctx, pending.mode))
  }

  Component.onCompleted: {
    loadKeybindings()
    refreshToplevels()
  }

  Component.onDestruction: {
    fdKill.stop()
    saveTimer.stop()
    fdProc.running = false
    guardProc.running = false
    bindsProc.running = false
    pasteProc.running = false
  }

  Loader {
    id: libraryLoader
    source: root.omarchyPath + "/shell/services/AppLibrary.qml"
    onLoaded: item.omarchyPath = root.omarchyPath
    onStatusChanged: if (status === Loader.Error) console.warn("omacast: cannot load " + root.omarchyPath + "/shell/services/AppLibrary.qml")
  }

  Connections {
    target: root.appLibrary
    function onAppsChanged() { root.catalogChanged() }
  }

  Connections {
    target: ToplevelManager.toplevels
    function onValuesChanged() { root.refreshToplevels() }
  }

  // ---- Config

  FileView {
    id: configFile
    path: root.home + "/.config/omarchy/omacast.json"
    watchChanges: true
    printErrors: false
    onLoaded: { root.config = Model.normalizeConfig(Model.parseJson(text())); root.catalogChanged() }
    onFileChanged: reload()
    onLoadFailed: { root.config = Model.normalizeConfig(null); root.catalogChanged() }
  }

  // ---- State

  FileView {
    id: stateFile
    path: root.home + "/.local/state/omarchy/omacast-state.json"
    atomicWrites: true
    printErrors: false
    onLoaded: { root.store = Model.normalizeState(Model.parseJson(text())); root.catalogChanged() }
    onLoadFailed: root.store = Model.normalizeState(null)
  }

  Timer {
    id: saveTimer
    interval: 500
    onTriggered: stateFile.setText(JSON.stringify(root.store) + "\n")
  }

  // ---- Menu sources

  FileView {
    id: defaultMenuFile
    path: root.omarchyPath + "/default/omarchy/omarchy-menu.jsonc"
    watchChanges: true
    printErrors: false
    onLoaded: root.rebuildMenu()
    onFileChanged: reload()
    onLoadFailed: root.rebuildMenu()
  }

  FileView {
    id: userMenuFile
    path: root.home + "/.config/omarchy/extensions/omarchy-menu.jsonc"
    watchChanges: true
    printErrors: false
    onLoaded: root.rebuildMenu()
    onFileChanged: reload()
    onLoadFailed: root.rebuildMenu()
  }

  Process {
    id: guardProc
    property string collected: ""
    stdout: SplitParser {
      onRead: function(data) { guardProc.collected += data + "\n" }
    }
    onExited: function(exitCode, exitStatus) {
      if (exitCode !== 0 || exitStatus !== 0) {
        if (root.guardsPending) Qt.callLater(function() { root.evaluateGuards() })
        return
      }

      var nextWhen = ({})
      var nextChecked = ({})
      var lines = guardProc.collected.split("\n")
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim()
        if (!line) continue
        var colon = line.lastIndexOf(":")
        if (colon < 0) continue
        var value = line.substring(colon + 1) === "1"
        var rest = line.substring(0, colon)
        var tagAt = rest.lastIndexOf(":")
        if (tagAt < 0) continue
        var id = rest.substring(0, tagAt)
        var tag = rest.substring(tagAt + 1)
        if (tag === "w") nextWhen[id] = value
        else if (tag === "c") nextChecked[id] = value
      }

      root.whenResults = nextWhen
      root.checkedResults = nextChecked
      root.guardsRunAt = Date.now()
      root.catalogChanged()
      if (root.guardsPending) Qt.callLater(function() { root.evaluateGuards() })
    }
  }

  // ---- Keybindings
  //
  // Sourcing the script gives us its record format and its dispatcher for
  // free; --print is redirected away so only output_binding_records prints.

  Process {
    id: bindsProc
    command: ["bash", "-c", "source \"$0\" --print >/dev/null 2>&1; output_binding_records", root.omarchyPath + "/bin/omarchy-menu-keybindings"]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        root.keybindingRecords = Model.parseKeybindingRecords(text)
        root.bindsRunAt = Date.now()
        root.catalogChanged()
      }
    }
  }

  // ---- Clipboard

  FileView {
    id: clipboardFile
    path: root.home + "/.local/state/omarchy/clipboard-history.json"
    printErrors: false
    onLoaded: { root.clipboardEntries = Model.parseClipboard(text()); root.catalogChanged() }
    onLoadFailed: { root.clipboardEntries = []; root.catalogChanged() }
  }

  // ---- Emoji, bound only once a scope asks for it

  FileView {
    id: emojiFile
    path: root.emojiWanted ? root.omarchyPath + "/shell/plugins/emojis/emojis.json" : ""
    printErrors: false
    onLoaded: { root.emojis = Model.parseEmojis(text()); root.catalogChanged() }
    onLoadFailed: root.emojis = []
  }

  // ---- Files

  Process {
    id: fdProc
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        if (root.fileActiveGeneration !== root.fileGeneration) return
        var paths = text.split("\n")
        var out = []
        for (var i = 0; i < paths.length; i++) if (paths[i]) out.push(paths[i])
        root.filePaths = out
        root.catalogChanged()
      }
    }
    onExited: {
      fdKill.stop()
      var pending = root.pendingFiles
      root.pendingFiles = null
      if (pending) Qt.callLater(function() { root.runFileSearch(pending) })
    }
  }

  // fd on a cold cache can walk a very large tree; three seconds is already
  // past useful for a palette, so the run is killed rather than awaited.
  Timer {
    id: fdKill
    interval: 3000
    onTriggered: fdProc.running = false
  }

  // ---- Clipboard and selection reads for templates

  Process {
    id: pasteProc
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.finishTemplate(text)
    }
  }
}
