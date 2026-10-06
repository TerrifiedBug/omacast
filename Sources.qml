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
  property var configDoc: Model.editableConfig(null)
  property var barButton: null
  property var store: Model.normalizeState(null)

  property var menuItems: ({})
  property var menuOrder: []
  // Flattened, visibility-resolved menu, rebuilt when the JSONC or the guards
  // change. Scoring 300-odd rows per keystroke is cheap; walking the tree for
  // each of them is not.
  property var menuIndex: []
  property var whenResults: ({})
  property var checkedResults: ({})
  property bool guardsPending: false

  property var keybindingRecords: []
  readonly property string bindingsPath: root.home + "/.config/hypr/bindings.lua"
  property var binds: ({ palette: "", clipboard: false, found: false })
  property bool bindingsLoaded: false
  property string bindsBackup: ""
  property var toplevels: []
  property var runningApps: ({})
  property var clipboardEntries: []
  property var emojis: []
  property bool emojiWanted: false
  property var filePaths: []

  // `kill ` scope: the process list, polled every 2 s while the scope is open.
  property bool processesWanted: false
  property var processes: []

  // `omarchy commands --json`, filtered to argument-free commands, and the
  // same list with menu duplicates dropped and match fields prepared.
  property var commandList: []
  property var commandCatalog: []
  property double commandsRunAt: 0

  property var themes: ({ current: "", names: [] })
  property double themesRunAt: 0

  // One `date` batch at a time; its answer is keyed by the request's query so
  // a landing for an older query is ignored rather than shown.
  property var tzResult: ({ key: "", output: "" })
  property var pendingZone: null

  // One preview process at a time, keyed by the selected row.
  property var previewResult: ({ key: "", text: "" })
  property string previewWantedKey: ""
  property var pendingPreview: null

  // Content search mirrors fd: one rg run, a queued follow-up, a kill timer.
  property var contentPaths: []
  property string contentTerm: ""
  property var pendingContent: null
  property int contentGeneration: 0
  property int contentActiveGeneration: 0

  // Script commands: the folders' fingerprint, the parsed scripts, and the
  // first stdout line of each inline script with when it ran.
  readonly property string scriptDir: root.home + "/.config/omarchy/omacast/scripts"
  readonly property var scriptDirs: {
    var out = [root.scriptDir]
    var extra = root.config.scriptDirs || []
    for (var i = 0; i < extra.length; i++) out.push(Model.expandHome(extra[i], root.home))
    return out
  }
  property string scriptSignature: ""
  property var scripts: []
  property var inlineOutputs: ({})
  property var inlineRunAt: ({})
  property var inlineQueue: []
  property string inlineActivePath: ""

  // Opt-in network and agent state.
  readonly property string ratesPath: root.home + "/.cache/omarchy/omacast-rates.xml"
  property var rates: null
  property string agentName: ""

  // Milliseconds of the last successful run; the open path re-runs only what
  // has gone stale so a summon never waits on bash.
  property double guardsRunAt: 0
  property double bindsRunAt: 0

  property var pendingFiles: null
  property int fileGeneration: 0
  property int fileActiveGeneration: 0

  property var pendingTemplate: null
  property string pasteStage: ""
  property double openedAt: 0

  signal catalogChanged()
  signal notice(string text)

  function saveConfig(op) {
    var next = Model.updateConfig(root.configDoc, op)
    root.configDoc = next
    root.config = Model.normalizeConfig(next)
    root.catalogChanged()
    configFile.setText(Model.serializeConfig(next))
  }

  function saveBinds(patch) {
    if (!root.bindingsLoaded) { root.notice("~/.config/hypr/bindings.lua not found"); return }
    var next = {
      palette: patch.palette !== undefined ? patch.palette : root.binds.palette,
      clipboard: patch.clipboard !== undefined ? patch.clipboard : root.binds.clipboard
    }
    var current = bindingsFile.text()
    var out = Model.replaceBindBlock(current, Model.renderBindBlock(next))
    if (out === null) { root.notice("bindings.lua has an OmaCast begin marker without an end marker; fix it by hand"); return }
    root.bindsBackup = current
    root.binds = { palette: next.palette, clipboard: next.clipboard, found: out.indexOf(Model.BIND_BEGIN) >= 0 }
    bindingsFile.setText(out)
    hyprReloadProc.running = true
    root.catalogChanged()
  }

  function setBarButton(on) {
    Quickshell.execDetached(["omarchy", "bar", "set", "io.github.terrifiedbug.omacast", "button", on ? "true" : "false", "--json"])
  }

  function onOpen() {
    root.openedAt = Date.now()
    if (root.appLibrary) root.appLibrary.refreshIcons()
    refreshToplevels()
    var now = Date.now()
    if (now - root.guardsRunAt > 30000) evaluateGuards()
    if (now - root.bindsRunAt > 60000) loadKeybindings()
    if (now - root.commandsRunAt > 60000) loadCommandCatalog()
    if (now - root.themesRunAt > 60000) loadThemes()
    scanScripts()
    queueInlineScripts()
    if (root.config.currency) fetchRates(false)
    if (root.config.ai) loadAgent()
  }

  // ---- Frecency state

  function recordUse(key) {
    if (!key) return
    var now = Date.now()
    var usage = Model.pruneUsage(Model.bump(root.store.usage, key, now), now, 400)
    setStore(Model.updateState(root.store, { usage: usage }))
  }

  function setStore(next) {
    root.store = next
    saveTimer.restart()
  }

  function togglePin(key) {
    if (!key) return
    setStore(Model.togglePin(root.store, key))
    root.catalogChanged()
  }

  function toggleHidden(key) {
    if (!key) return
    setStore(Model.toggleHidden(root.store, key))
    root.catalogChanged()
  }

  function resetUsage(key) {
    if (!key) return
    setStore(Model.resetUsage(root.store, key))
    root.catalogChanged()
  }

  // Saved on close, so ↑ in an empty field can bring back what was typed.
  function rememberQuery(text) {
    var next = Model.rememberQuery(root.store, text)
    if (next.lastQuery !== root.store.lastQuery) setStore(next)
  }

  function isPinned(key) {
    return root.store.pins.indexOf(key) >= 0
  }

  // ---- Menu

  function rebuildMenu() {
    var merged = MenuModel.mergeMenuSources(MenuModel.parseMenuJsonc(defaultMenuFile.text()), MenuModel.parseMenuJsonc(userMenuFile.text()))
    root.menuItems = merged.items
    root.menuOrder = merged.itemOrder
    reindexMenu()
    evaluateGuards()
    root.catalogChanged()
  }

  function reindexMenu() {
    root.menuIndex = Model.buildMenuIndex(root.menuItems, root.menuOrder, root.whenResults, root.checkedResults, MenuModel)
    rebuildCommandCatalog()
  }

  // ---- omarchy commands and themes, refreshed on open once they are a
  // minute old

  function loadCommandCatalog() {
    if (commandsProc.running) return
    commandsProc.running = true
  }

  function rebuildCommandCatalog() {
    root.commandCatalog = Model.buildCommandCatalog(root.commandList, root.menuIndex)
  }

  function loadThemes() {
    if (themesProc.running) return
    themesProc.running = true
  }

  // ---- Processes

  function wantProcesses(wanted) {
    root.processesWanted = wanted === true
    if (!root.processesWanted) root.processes = []
  }

  function loadProcesses() {
    if (processProc.running) return
    processProc.running = true
  }

  function signalProcess(pid, force) {
    if (!/^\d+$/.test(String(pid))) return
    Quickshell.execDetached(force ? ["kill", "-KILL", String(pid)] : ["kill", String(pid)])
    procRefresh.restart()
  }

  // ---- Time zones

  function requestTimeZone(request) {
    if (!request) return
    if (request.key === root.tzResult.key) return
    if (zoneProc.running) {
      if (request.key !== zoneProc.runKey) root.pendingZone = request
      return
    }
    zoneProc.runKey = request.key
    zoneProc.command = Model.timeZoneCommand(request)
    zoneProc.running = true
  }

  // ---- Preview
  //
  // Selecting another row kills the running preview and queues the new one,
  // which starts from onExited. A killed run's output carries its own key,
  // so it can never land under the row selected after it.

  function requestPreview(key, argv) {
    if (key === root.previewResult.key) {
      root.previewWantedKey = key
      root.pendingPreview = null
      return
    }
    if (key === root.previewWantedKey) return
    root.previewWantedKey = key
    root.pendingPreview = argv ? { key: key, argv: argv } : null
    if (previewProc.running) {
      previewProc.running = false
      return
    }
    startPendingPreview()
  }

  function startPendingPreview() {
    var next = root.pendingPreview
    root.pendingPreview = null
    if (!next || previewProc.running) return
    previewProc.runKey = next.key
    previewProc.command = next.argv
    previewProc.running = true
  }

  function cancelPreview() {
    root.previewWantedKey = ""
    root.pendingPreview = null
    previewProc.running = false
  }

  // ---- Content search

  function searchContent(term) {
    root.contentGeneration += 1
    var request = { term: term, generation: root.contentGeneration }
    if (term.length < 3) {
      root.contentPaths = []
      root.contentTerm = term
      root.catalogChanged()
      return
    }
    if (rgProc.running) {
      root.pendingContent = request
      return
    }
    runContentSearch(request)
  }

  function runContentSearch(request) {
    root.contentActiveGeneration = request.generation
    root.contentTerm = request.term
    rgProc.command = ["rg", "--files-with-matches", "--max-count", "1", "--max-filesize", "2M", "--ignore-case", "--fixed-strings", "--hidden",
      "--glob", "!.git", "--glob", "!node_modules", "--glob", "!.cache", "--", request.term, root.home]
    rgProc.running = true
    rgKill.restart()
  }

  function cancelContent() {
    rgKill.stop()
    root.pendingContent = null
    root.contentGeneration += 1
    if (rgProc.running) rgProc.running = false
  }

  // ---- Script commands
  //
  // Each open fingerprints the folders (path, mtime and mode of every file)
  // and only re-reads the headers when that changes.

  function scanScripts() {
    if (scriptsProc.running) return
    var script = 'prev=$1; shift; sig=$(find "$@" -maxdepth 1 -type f -printf "%p %T@ %m\\n" 2>/dev/null | sort | md5sum | cut -d" " -f1); '
      + 'printf "%s\\n" "$sig"; [ "$sig" = "$prev" ] && exit 0; '
      + 'find "$@" -maxdepth 1 -type f -print0 2>/dev/null | sort -z | while IFS= read -r -d "" f; do x=0; [ -x "$f" ] && x=1; printf "\\036%s\\037%s\\037" "$f" "$x"; head -c 8192 -- "$f"; done'
    scriptsProc.command = ["bash", "-c", script, "bash", root.scriptSignature].concat(root.scriptDirs)
    scriptsProc.running = true
  }

  function queueInlineScripts() {
    var now = Date.now()
    var queue = []
    for (var i = 0; i < root.scripts.length; i++) {
      var s = root.scripts[i]
      if (s.meta.mode !== "inline" || !s.executable) continue
      var ranAt = root.inlineRunAt[s.path] || 0
      // Without a refreshTime an inline script runs once per open.
      var fresh = s.meta.refreshMs > 0 ? now - ranAt < s.meta.refreshMs : ranAt >= root.openedAt
      var queued = queue.indexOf(s.path) >= 0 || root.inlineQueue.indexOf(s.path) >= 0 || root.inlineActivePath === s.path
      if (!fresh && !queued) queue.push(s.path)
    }
    root.inlineQueue = root.inlineQueue.concat(queue)
    runNextInline()
  }

  function runNextInline() {
    if (inlineProc.running || root.inlineQueue.length === 0) return
    var queue = root.inlineQueue.slice()
    root.inlineActivePath = queue.shift()
    root.inlineQueue = queue
    inlineProc.command = ["bash", "-c", 'timeout 10 "$0" 2>/dev/null | head -c ' + Model.SCRIPT_OUTPUT_LIMIT, root.inlineActivePath]
    inlineProc.running = true
  }

  function rerunInline(path) {
    var at = ({})
    for (var k in root.inlineRunAt) if (k !== path) at[k] = root.inlineRunAt[k]
    root.inlineRunAt = at
    root.inlineQueue = root.inlineQueue.concat([path])
    runNextInline()
  }

  // Compact mode: run with a 10 s cap and hand the last stdout line to a
  // notification, the way Raycast shows it in its HUD.
  function runCompact(path, args, title) {
    if (compactProc.running) return
    compactProc.title = title
    compactProc.command = ["bash", "-c", 'set -o pipefail; timeout 10 "$0" "$@" 2>/dev/null | head -c ' + Model.SCRIPT_OUTPUT_LIMIT, path].concat(args || [])
    compactProc.running = true
  }

  // ---- Currency (opt-in): one ECB request a day at most, gated on the
  // cached file's age, printed back so the same process delivers the rates.

  function fetchRates(force) {
    if (ratesProc.running) return
    var script = 'f=$1; force=$2; mkdir -p "$(dirname "$f")"; '
      + 'if [ "$force" = 1 ] || [ ! -s "$f" ] || [ -n "$(find "$f" -mmin +1440 2>/dev/null)" ]; then '
      + 'curl -fsSL --max-time 10 -o "$f.tmp" "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml" && mv -f "$f.tmp" "$f"; rm -f "$f.tmp"; fi; '
      + '[ -s "$f" ] && cat "$f"'
    ratesProc.command = ["bash", "-c", script, "bash", root.ratesPath, force ? "1" : "0"]
    ratesProc.running = true
  }

  function loadAgent() {
    if (agentProc.running) return
    agentProc.running = true
  }

  // ---- Clipboard edits, written the way the stock clipboard writes them

  function deleteClipboardEntry(historyIndex) {
    var next = Model.removeClipboardEntry(clipboardFile.text(), historyIndex)
    if (next === null) return
    clipboardFile.setText(next)
    root.clipboardEntries = Model.parseClipboard(next)
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

  // Closing the palette ends the search with it: a run that lands afterwards
  // would publish rows nobody asked for and keep a process alive for nothing.
  function cancelFiles() {
    fdKill.stop()
    root.pendingFiles = null
    root.fileGeneration += 1
    if (fdProc.running) fdProc.running = false
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
    procPoll.stop()
    procRefresh.stop()
    rgKill.stop()
    processProc.running = false
    commandsProc.running = false
    themesProc.running = false
    zoneProc.running = false
    previewProc.running = false
    rgProc.running = false
    scriptsProc.running = false
    inlineProc.running = false
    compactProc.running = false
    ratesProc.running = false
    agentProc.running = false
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
    atomicWrites: true
    printErrors: false
    onLoaded: {
      var parsed = Model.parseConfig(text())
      root.configDoc = Model.editableConfig(parsed)
      root.config = Model.normalizeConfig(parsed)
      root.catalogChanged()
    }
    onFileChanged: reload()
    onLoadFailed: {
      root.configDoc = Model.editableConfig(null)
      root.config = Model.normalizeConfig(null)
      root.catalogChanged()
    }
    onSaveFailed: function(error) { root.notice("Could not save omacast.json: " + error) }
  }

  FileView {
    id: shellConfigFile
    path: root.home + "/.config/omarchy/shell.json"
    watchChanges: true
    printErrors: false
    onLoaded: {
      root.barButton = Model.barButtonSetting(Model.parseJson(text()), "io.github.terrifiedbug.omacast")
      root.catalogChanged()
    }
    onFileChanged: reload()
    onLoadFailed: { root.barButton = null; root.catalogChanged() }
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
      root.reindexMenu()
      root.catalogChanged()
      if (root.guardsPending) Qt.callLater(function() { root.evaluateGuards() })
    }
  }

  // ---- Hyprland bindings

  FileView {
    id: bindingsFile
    path: root.bindingsPath
    watchChanges: true
    atomicWrites: true
    // Reload must see the completed write, including a rejected-change restore.
    blockWrites: true
    printErrors: false
    onLoaded: {
      root.bindingsLoaded = true
      root.binds = Model.parseBindBlock(text())
      root.catalogChanged()
    }
    onFileChanged: reload()
    onLoadFailed: {
      root.bindingsLoaded = false
      root.binds = { palette: "", clipboard: false, found: false }
      root.catalogChanged()
    }
    onSaveFailed: function(error) { root.notice("Could not write bindings.lua: " + error) }
  }

  Process {
    id: hyprReloadProc
    command: ["bash", "-c", "hyprctl reload >/dev/null 2>&1; hyprctl configerrors"]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        var errors = text.trim()
        if (!errors || errors === "ok") { bindsProc.running = true; return }
        root.notice("Hyprland rejected the change, restored: " + errors.split("\n")[0])
        bindingsFile.setText(root.bindsBackup)
        root.binds = Model.parseBindBlock(root.bindsBackup)
        root.catalogChanged()
        Quickshell.execDetached(["hyprctl", "reload"])
      }
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
    atomicWrites: true
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

  // ---- omarchy commands, themes

  Process {
    id: commandsProc
    command: ["omarchy", "commands", "--json"]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        var list = Model.parseCommandCatalog(text)
        if (list.length === 0) return
        root.commandList = list
        root.commandsRunAt = Date.now()
        root.rebuildCommandCatalog()
        root.catalogChanged()
      }
    }
  }

  Process {
    id: themesProc
    command: ["bash", "-c", "omarchy theme current; echo ---; omarchy theme list"]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        var parsed = Model.parseThemes(text)
        if (parsed.names.length === 0) return
        root.themes = parsed
        root.themesRunAt = Date.now()
        root.catalogChanged()
      }
    }
  }

  // ---- Processes: the first line is the pids never to list, the shell
  // itself ($PPID of this bash), its parent, and this helper.

  Process {
    id: processProc
    command: ["bash", "-c", 'self=$PPID; parent=$(ps -o ppid= -p "$self" | tr -d " "); echo "$self $parent $$"; exec ps -u "$USER" -o pid=,pcpu=,pmem=,comm= --sort=-pcpu']
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        if (!root.processesWanted) return
        root.processes = Model.parseProcesses(text)
        root.catalogChanged()
      }
    }
  }

  Timer {
    id: procPoll
    interval: 2000
    repeat: true
    triggeredOnStart: true
    running: root.processesWanted && root.opened
    onTriggered: root.loadProcesses()
  }

  // A signalled process takes a moment to go; look again shortly after.
  Timer {
    id: procRefresh
    interval: 300
    onTriggered: root.loadProcesses()
  }

  // ---- Time zones

  Process {
    id: zoneProc
    property string runKey: ""
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        root.tzResult = { key: zoneProc.runKey, output: text }
        root.catalogChanged()
      }
    }
    onExited: {
      var pending = root.pendingZone
      root.pendingZone = null
      if (pending) Qt.callLater(function() { root.requestTimeZone(pending) })
    }
  }

  // ---- Preview

  Process {
    id: previewProc
    property string runKey: ""
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        if (previewProc.runKey !== root.previewWantedKey) return
        root.previewResult = { key: previewProc.runKey, text: Model.cleanPreview(text) }
      }
    }
    onExited: Qt.callLater(function() { root.startPendingPreview() })
  }

  // ---- Content search

  Process {
    id: rgProc
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        if (root.contentActiveGeneration !== root.contentGeneration) return
        var lines = text.split("\n")
        var out = []
        for (var i = 0; i < lines.length && out.length < 200; i++) if (lines[i]) out.push(lines[i])
        root.contentPaths = out
        root.catalogChanged()
      }
    }
    onExited: {
      rgKill.stop()
      var pending = root.pendingContent
      root.pendingContent = null
      if (pending) Qt.callLater(function() { root.runContentSearch(pending) })
    }
  }

  // Same budget as fd: past three seconds a palette answer is no answer.
  Timer {
    id: rgKill
    interval: 3000
    onTriggered: rgProc.running = false
  }

  // ---- Script commands

  Process {
    id: scriptsProc
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        var cut = text.indexOf("\n")
        var signature = cut >= 0 ? text.slice(0, cut) : text.trim()
        if (!signature || signature === root.scriptSignature) return
        root.scriptSignature = signature
        root.scripts = Model.parseScriptRecords(text.slice(cut + 1))
        root.queueInlineScripts()
        root.catalogChanged()
      }
    }
  }

  Process {
    id: inlineProc
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        var path = root.inlineActivePath
        if (!path) return
        var outputs = ({})
        for (var k in root.inlineOutputs) outputs[k] = root.inlineOutputs[k]
        outputs[path] = Model.firstLine(text)
        root.inlineOutputs = outputs
        var at = ({})
        for (var r in root.inlineRunAt) at[r] = root.inlineRunAt[r]
        at[path] = Date.now()
        root.inlineRunAt = at
        root.catalogChanged()
      }
    }
    onExited: {
      root.inlineActivePath = ""
      Qt.callLater(function() { root.runNextInline() })
    }
  }

  Process {
    id: compactProc
    property string title: ""
    property string output: ""
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: compactProc.output = text
    }
    onExited: function(exitCode) {
      var line = Model.lastLine(compactProc.output)
      if (!line) line = exitCode === 0 ? "Done" : "Failed with exit code " + exitCode
      compactProc.output = ""
      Quickshell.execDetached(["omarchy", "notification", "send", compactProc.title, line])
    }
  }

  // ---- Currency and agent

  Process {
    id: ratesProc
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        var parsed = Model.parseEcbRates(text)
        if (!parsed) return
        root.rates = parsed
        root.catalogChanged()
      }
    }
  }

  Process {
    id: agentProc
    command: ["omarchy", "default", "agent"]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        var name = Model.firstLine(text)
        if (name && name !== root.agentName) {
          root.agentName = name
          root.catalogChanged()
        }
      }
    }
  }
}
