import QtQuick
import Quickshell
import Quickshell.Io
import Quickshell.Wayland
import "Model.js" as Model
import "vendor/MenuModel.js" as MenuModel
import "ActionPolicy.js" as ActionPolicy
import "FilePolicy.js" as FilePolicy
import "ScriptModel.js" as ScriptModel
import "Navigation.js" as Navigation
import "WindowModel.js" as WindowModel

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
  property var windowController: null
  property int nextWindowIdentity: 1
  property var windowBinds: ({})

  // Application library, loaded from the running shell rather than
  // reimplemented: same hidden-entry filtering, same icon index, same launch
  // feedback as the menu's Apps list.
  readonly property var appLibrary: libraryLoader.item

  readonly property var configDoc: Model.editableConfig(configStore.document)
  readonly property var config: Model.normalizeConfig(configDoc)
  property var barButton: null
  readonly property var store: Model.normalizeState(stateStore.document)
  readonly property string storageError: configStore.error || stateStore.error
  property bool shuttingDown: false
  readonly property var navigation: navigationSource
  readonly property var scriptResults: resultsSource
  readonly property var picker: pickerSource
  readonly property var agentAnswers: answersSource
  readonly property var semanticSearch: semanticSource
  readonly property var sourceStatuses: providerStatuses()
  property var previewAuthorization: null
  property var fileAuthorization: null
  property var contentAuthorization: null
  property bool learningPrivate: false
  property int learningPrivacyGeneration: 0
  property var preparedMenu: null
  property var pendingQueryUses: []

  property var menuItems: ({})
  property var menuOrder: []
  // Flattened, visibility-resolved menu, rebuilt when the JSONC or the guards
  // change. Scoring 300-odd rows per keystroke is cheap; walking the tree for
  // each of them is not.
  property var menuIndex: []
  property var whenResults: ({})
  property var checkedResults: ({})
  property bool guardsPending: false
  property bool defaultMenuReadFailed: false
  property bool userMenuReadFailed: false

  property var keybindingRecords: []
  readonly property string bindingsPath: root.home + "/.config/hypr/bindings.lua"
  property var binds: ({ palette: "", clipboard: false, found: false })
  property bool bindingsLoaded: false
  property bool bindingsWriteFailed: false
  property string bindsBackup: ""
  property var pendingShortcutCheck: null
  property var toplevels: []
  property var runningApps: ({})
  property var clipboardEntries: []
  property var emojis: []
  property bool emojiWanted: false
  property var fileRecords: ({ paths: [], mtimes: ({}) })
  property bool fileSearching: false
  property string fileStatus: ""
  readonly property var filePaths: root.fileRecords.paths
  readonly property var fileMtimes: root.fileRecords.mtimes
  property string fileRootPath: ""
  property string contentRootPath: ""

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
  property int previewGeneration: 0
  property bool previewRunActive: false

  // Content search mirrors fd: one rg run, a queued follow-up, a kill timer.
  property var contentPaths: []
  property string contentTerm: ""
  property var pendingContent: null
  property string contentStatus: ""
  property bool contentRunActive: false
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
  property double iconsRunAt: 0

  property var pendingFiles: null
  property int fileGeneration: 0
  property int fileActiveGeneration: 0
  property bool fileRunActive: false
  property var pendingFileStat: null
  property int fileStatGeneration: 0

  property var pendingTemplate: null
  property string pasteStage: ""
  property double openedAt: 0
  property int pasteGeneration: 0
  property bool pasteRunActive: false

  signal catalogChanged()
  signal notice(string text)
  signal templateFailed(string text)
  signal operationFinished(string key, bool ok, string status, string message)
  signal menuPrepared(string id, string token)

  function saveConfig(op) {
    if (!configStore.writable) {
      root.notice(configStore.error || "Configuration is still loading")
      return false
    }
    var before = root.configDoc
    var after = Model.updateConfig(before, op)
    var doc = JSON.parse(JSON.stringify(configStore.document))
    // View defaults aren't edits. Persist only the changed fields so repair
    // or an external save can add entries without our defaults erasing them.
    Object.keys(after).forEach(function(key) {
      if (JSON.stringify(after[key]) !== JSON.stringify(before[key])
        || (op && op.op === "set" && op.key === key)) doc[key] = after[key]
    })
    return configStore.replace(doc)
  }

  function saveWindowConfig(value) {
    if (!configStore.writable) { root.notice(configStore.error || "Configuration is still loading"); return false }
    var doc = JSON.parse(JSON.stringify(configStore.document))
    doc.windowManagement = value
    return configStore.replace(doc)
  }

  function windowHandle(payload) {
    return WindowModel.resolveHandle(root.toplevels, payload)
  }

  function checkShortcut(chord, owner, callback) {
    if (root.pendingShortcutCheck || shortcutCheckProc.running) {
      callback("Another shortcut check is in progress; try again")
      return
    }
    var normalized = Model.normalizeChord(chord)
    if (!normalized) { callback("Invalid shortcut"); return }
    if (owner !== "palette" && owner !== "clipboard" && String(owner).indexOf("window:") !== 0) {
      callback("Unknown shortcut owner")
      return
    }
    root.pendingShortcutCheck = { chord: normalized, owner: owner, callback: callback }
    shortcutCheckProc.output = ""
    shortcutCheckProc.timedOut = false
    shortcutCheckProc.running = true
    shortcutCheckTimeout.restart()
  }

  function finishShortcutCheck(request, error) {
    if (!request || root.pendingShortcutCheck !== request) return
    shortcutCheckTimeout.stop()
    root.pendingShortcutCheck = null
    request.callback(error)
  }

  function saveWindowBind(action, chord) {
    if (!root.bindingsLoaded) { root.notice("~/.config/hypr/bindings.lua not found"); return false }
    var next = Object.assign({}, root.windowBinds)
    next[action] = chord
    var current = bindingsFile.text(), out
    try { out = WindowModel.replaceBindings(current, next) }
    catch (error) { root.notice(String(error)); return false }
    if (out === current) return true
    root.bindsBackup = current
    root.bindingsWriteFailed = false
    bindingsFile.setText(out)
    if (root.bindingsWriteFailed) {
      bindingsFile.reload()
      bindingsFile.waitForJob()
      return false
    }
    root.windowBinds = next
    hyprReloadProc.running = true
    root.catalogChanged()
    return true
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
    openRefresh.restart()
  }

  function refreshOnOpen() {
    if (!root.opened || root.shuttingDown) return
    configStore.reload()
    stateStore.reload()
    cancelTemplate()
    var now = Date.now()
    if (root.appLibrary && now - root.iconsRunAt > 60000) {
      root.appLibrary.refreshIcons()
      root.iconsRunAt = now
    }
    refreshToplevels()
    if (now - root.guardsRunAt > 30000) evaluateGuards()
    if (now - root.bindsRunAt > 60000) loadKeybindings()
    if (now - root.commandsRunAt > 60000) loadCommandCatalog()
    if (now - root.themesRunAt > 60000) loadThemes()
    scanScripts()
    queueInlineScripts()
    if (root.config.currency) fetchRates(false)
    if (root.config.ai) loadAgent()
    ensureLearningPrivacy(true)
    refreshOptional()
  }

  // ---- Frecency state

  function contextHash(query, scope) {
    return Qt.md5(Model.normalizeSearch(scope || "root") + "\0" + Model.normalizeSearch(query || ""))
  }

  function recordUse(key, query, scope) {
    if (!key) return
    var now = Date.now()
    var next = Model.updateState(root.store, { usage: Model.pruneUsage(Model.bump(root.store.usage, key, now), now, 400) })
    setStore(next)
    if (root.config.queryLearning && query && !/^(clip|clipboard|content|proc|process|agent|ai|picker|scriptResult|semantic):/.test(key)
        && ["clipboard", "content", "processes", "agent", "picker", "scriptResults"].indexOf(scope) < 0) {
      var use = { key: key, hash: contextHash(query, scope), now: now }
      if (root.learningPrivate) {
        setStore(Model.recordQueryUse(root.store, use.key, use.hash, use.now))
      } else {
        root.pendingQueryUses = root.pendingQueryUses.concat([use]).slice(-64)
        ensureLearningPrivacy(false)
      }
    }
  }

  function setAlias(key, text) {
    var reserved = ["f", "#", "proj", "ssh", "bm", "panel", "kill", "ask", "settings"]
    ;["quicklinks", "snippets", "commands"].forEach(function(kind) {
      (root.config[kind] || []).forEach(function(entry) { if (entry.keyword) reserved.push(entry.keyword) })
    })
    root.scripts.forEach(function(script) { reserved.push(script.keyword) })
    var result = Model.setAlias(root.store, key, text, reserved)
    if (result.ok && !setStore(result.state)) return { ok: false, error: root.storageError || "Could not save alias" }
    if (result.ok) root.catalogChanged()
    return result
  }

  function clearAlias(key) { setStore(Model.clearAlias(root.store, key)); root.catalogChanged() }
  function clearQueryLearning() {
    root.pendingQueryUses = []
    setStore(Model.clearQueryHistory(root.store))
    root.catalogChanged()
  }

  function setStore(next) {
    // Normalisation only exposes known state fields; keep future/user fields
    // in the persisted document when one of those fields changes.
    var doc = JSON.parse(JSON.stringify(stateStore.document))
    for (var key in next) doc[key] = next[key]
    return stateStore.replace(doc)
  }

  function ensureLearningPrivacy(recheck) {
    if (!root.config.queryLearning || root.shuttingDown) return
    if (recheck) root.learningPrivate = false
    if (root.learningPrivate || learningPrivacyWorker.busy) return
    root.learningPrivacyGeneration += 1
    var script = [
      "import os,stat,sys",
      "path=sys.argv[1]",
      "os.makedirs(os.path.dirname(path),mode=0o700,exist_ok=True)",
      "flags=os.O_RDWR|os.O_NOFOLLOW|os.O_NONBLOCK",
      "created=False",
      "try:",
      " fd=os.open(path,flags|os.O_CREAT|os.O_EXCL,0o600); created=True",
      "except FileExistsError:",
      " fd=os.open(path,flags)",
      "try:",
      " info=os.fstat(fd)",
      " if not stat.S_ISREG(info.st_mode) or info.st_uid!=os.getuid(): raise PermissionError('State file must be a regular file owned by the current user')",
      " os.fchmod(fd,0o600)",
      " if created: os.write(fd,b'{}\\n'); os.fsync(fd)",
      " info=os.fstat(fd)",
      " if stat.S_IMODE(info.st_mode)!=0o600: raise PermissionError('Could not make query-learning storage private')",
      "finally:",
      " os.close(fd)"
    ].join("\n")
    learningPrivacyWorker.run(String(root.learningPrivacyGeneration),
      ["python3", "-c", script, root.home + "/.local/state/omarchy/omacast-state.json"], 3000)
  }

  function cancelPendingLearning() {
    root.pendingQueryUses = []
    root.learningPrivate = false
    root.learningPrivacyGeneration += 1
    learningPrivacyWorker.cancel()
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
    root.pendingQueryUses = root.pendingQueryUses.filter(function(use) { return use.key !== key })
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
    var merged = MenuModel.mergeMenuSources(MenuModel.parseMenuJsonc(root.defaultMenuReadFailed ? "" : defaultMenuFile.text()), MenuModel.parseMenuJsonc(root.userMenuReadFailed ? "" : userMenuFile.text()))
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

  function signalProcess(pid, force, startTime) {
    var argv = ActionPolicy.signalCommand(pid, force, startTime)
    return argv.length > 0 && runOwnedAction("process:" + pid, argv, 3000)
  }

  function runOwnedAction(key, argv, timeoutMs) {
    if (actionWorker.busy) {
      root.operationFinished(key, false, "busy", "Another action is still running")
      return false
    }
    return actionWorker.run(key, argv, timeoutMs)
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

  function requestPreview(key, spec) {
    root.previewGeneration += 1
    root.previewWantedKey = key || ""
    root.pendingPreview = null
    root.previewAuthorization = null
    previewPolicy.cancel()
    if (previewProc.running) previewProc.running = false
    root.previewResult = { key: "", text: "", kind: "text", path: "" }
    if (!key || !spec || !spec.path) return
    var request = { key: key, spec: spec, generation: root.previewGeneration }
    root.previewAuthorization = request
    var rootPath = spec.rootPath || root.home
    if (!spec.rootPath && key === "sc:" + spec.path) {
      var best = ""
      for (var d = 0; d < root.scriptDirs.length; d++) {
        var directory = FilePolicy.normalizePath(root.scriptDirs[d], root.home)
        if (FilePolicy.contains(directory, FilePolicy.normalizePath(spec.path, root.home)) && directory.length > best.length) best = directory
      }
      if (best) rootPath = best
    }
    previewPolicy.inspect(String(request.generation), spec.path, rootPath, spec.type === "image" ? "image" : "preview")
  }

  function startPendingPreview() {
    if (root.shuttingDown || root.previewRunActive || previewProc.running) return
    var next = root.pendingPreview
    root.pendingPreview = null
    if (!next || next.generation !== root.previewGeneration) return
    previewProc.runKey = next.key
    previewProc.generation = next.generation
    previewProc.output = ""
    previewProc.timedOut = false
    previewProc.command = next.argv
    root.previewRunActive = true
    previewProc.running = true
    previewKill.restart()
  }

  function cancelPreview() {
    previewKill.stop()
    root.previewGeneration += 1
    previewPolicy.cancel()
    root.previewAuthorization = null
    root.previewWantedKey = ""
    root.pendingPreview = null
    previewProc.running = false
  }

  // ---- Content search

  function searchContent(term, rootPath) {
    root.contentGeneration += 1
    root.pendingContent = null
    root.contentAuthorization = null
    contentPolicy.cancel()
    if (rgProc.running) rgProc.running = false
    root.contentPaths = []
    root.contentTerm = term
    root.contentStatus = term.length < 3 ? "" : "Checking search root"
    root.catalogChanged()
    if (term.length < 3) return
    var request = { term: term, rootPath: rootPath || root.home, generation: root.contentGeneration }
    root.contentAuthorization = request
    contentPolicy.inspect(String(request.generation), request.rootPath, request.rootPath, "content")
  }

  function runContentSearch(request) {
    if (!request || request.generation !== root.contentGeneration || root.shuttingDown) return
    root.contentActiveGeneration = request.generation
    root.contentTerm = request.term
    root.contentStatus = ""
    rgProc.command = Model.boundedCommand("records", FilePolicy.contentCommand(request.dir, request.term, contentPolicy.canonicalHome, contentPolicy.canonicalConfig), 262144, 200, false)
    root.contentRunActive = true
    rgProc.timedOut = false
    rgProc.running = true
    rgKill.restart()
  }

  function cancelContent() {
    rgKill.stop()
    contentPolicy.cancel()
    root.contentAuthorization = null
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

  function menuInPlace(id) {
    var entry = root.menuItems[id]
    if (!entry) return false
    var command = String(entry.action || "").trim()
    // A checkmark alone says nothing about whether an action opens a window.
    return /^omarchy-toggle-(animations|bar|idle|notification-silencing|nightlight|screensaver|crash-capture|theme-sync|touchpad|touchscreen)$/.test(command)
      || /^omarchy-default-(agent|browser|dictation|terminal|editor) [A-Za-z0-9_-]+$/.test(command)
      || /^omarchy-(?:bar background (?:opaque|glassy|none)|dock position (?:top|bottom|left|right)|hyprland-corners (?:theme|sharp|rounded)|hyprland-window-transparency (?:opaque|transparent|glassy)|hyprland-workspace-layout-default (?:dwindle|scrolling|floating)|font-cjk (?:default|jp|kr|sc|tc|hk)|dns (?:DHCP|Cloudflare|Google))$/.test(command)
  }

  function guardedMenuScript(id, action) {
    var guards = menuGuards(id)
    var script = ""
    for (var i = 0; i < guards.length; i++)
      if (guards[i].when) script += "if ! ( " + guards[i].when + " ); then printf '%s\\n' 'Action is unavailable' >&2; exit 125; fi\n"
    return script + (action || ":")
  }

  function executeMenu(id, expectedToken, keepOpen) {
    var result = resolveAction({ key: "menu:" + id, payload: { kind: "menu", id: id } })
    if (!result.ok || result.token !== expectedToken) {
      root.operationFinished("menu:" + id, false, "stale", result.error || "Action changed; confirm again")
      return false
    }
    var entry = root.menuItems[id]
    if (!entry || !entry.action) return false
    if (menuInPlace(id))
      return runOwnedAction("menu:" + id, ["bash", "-lc", guardedMenuScript(id, entry.action)], 10000)
    if (menuPreparationWorker.busy) {
      root.operationFinished("menu:" + id, false, "busy", "Another action is still running")
      return false
    }
    root.preparedMenu = { id: id, token: expectedToken, ready: false }
    return menuPreparationWorker.run("menu:" + id, ["bash", "-lc", guardedMenuScript(id, "")], 5000)
  }

  function launchPreparedMenu(id, expectedToken, beforeLaunch) {
    var prepared = root.preparedMenu
    root.preparedMenu = null
    if (!prepared || !prepared.ready || prepared.id !== id || prepared.token !== expectedToken) return false
    var result = resolveAction({ key: "menu:" + id, payload: { kind: "menu", id: id } })
    if (!result.ok || result.token !== expectedToken) {
      root.operationFinished("menu:" + id, false, "stale", result.error || "Action changed; confirm again")
      return false
    }
    var script = guardedMenuScript(id, root.menuItems[id].action)
    if (typeof beforeLaunch === "function") beforeLaunch()
    Qt.callLater(function() { Quickshell.execDetached(["bash", "-lc", script]) })
    return true
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
      var identity = root.nextWindowIdentity++
      for (var previous = 0; previous < root.toplevels.length; previous++)
        if (root.toplevels[previous].toplevel === top) { identity = root.toplevels[previous].identity; break }
      values.push({ index: i, identity: identity, title: String(top.title || ""), appId: String(top.appId || ""), activated: top.activated === true, toplevel: top, target: root.windowController ? root.windowController.targetForToplevel(top) : null })
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

  function searchFiles(dir, terms, filter, rootPath) {
    root.fileGeneration += 1
    root.pendingFiles = null
    root.pendingFileStat = null
    filePolicy.cancel()
    root.fileSearching = true
    root.fileRecords = { paths: [], mtimes: ({}) }
    if (fdProc.running) fdProc.running = false
    if (fileStatProc.running) fileStatProc.running = false
    var request = { dir: dir, rootPath: rootPath || root.home, terms: terms, filter: filter || "all", generation: root.fileGeneration }
    root.fileAuthorization = request
    filePolicy.inspect(String(request.generation), dir, request.rootPath, "root")
  }

  function runFileSearch(request) {
    if (!request || request.generation !== root.fileGeneration) return
    if (root.fileRunActive || fdProc.running) {
      root.pendingFiles = request
      return
    }
    root.pendingFiles = null
    fdProc.command = Model.fileCommand(request.dir, request.terms, request.filter)
    fdProc.timedOut = false
    root.fileActiveGeneration = request.generation
    root.fileRunActive = true
    root.fileSearching = true
    root.fileStatus = ""
    fdProc.running = true
    fdKill.interval = 3000
    fdKill.restart()
  }

  function finishFileSearch() {
    root.fileRunActive = false
    var pending = root.pendingFiles
    root.pendingFiles = null
    if (pending && pending.generation === root.fileGeneration) root.runFileSearch(pending)
    else root.fileSearching = false
  }

  function clearFiles() {
    root.fileRecords = { paths: [], mtimes: ({}) }
  }

  // Closing the palette ends the search with it: a run that lands afterwards
  // would publish rows nobody asked for and keep a process alive for nothing.
  function cancelFiles() {
    fdKill.stop()
    filePolicy.cancel()
    root.fileAuthorization = null
    root.pendingFiles = null
    root.pendingFileStat = null
    root.fileGeneration += 1
    root.fileSearching = false
    if (fdProc.running) fdProc.running = false
    if (fileStatProc.running) fileStatProc.running = false
  }

  // ---- Template expansion
  //
  // {clipboard} and {selection} are the only tokens that need a subprocess, so
  // a template without them expands synchronously and the palette closes in
  // the same frame.

  function resolveTemplate(template, argument, mode, done) {
    cancelTemplate()
    var ctx = { argument: argument || "", clipboard: "", selection: "", now: Date.now() }
    var wantsClipboard = Model.needsClipboard(template)
    var wantsSelection = Model.needsSelection(template)
    if (!wantsClipboard && !wantsSelection) {
      done(Model.expandTemplate(template, ctx, mode))
      return
    }
    root.pendingTemplate = {
      template: template, mode: mode, ctx: ctx, done: done,
      wantsSelection: wantsSelection, generation: root.pasteGeneration,
      stage: wantsClipboard ? "clipboard" : "selection"
    }
    if (!root.pasteRunActive && !pasteProc.running) readPaste(root.pendingTemplate.stage)
  }

  function cancelTemplate() {
    pasteKill.stop()
    root.pasteGeneration += 1
    root.pendingTemplate = null
    root.pasteStage = ""
    if (pasteProc.running) pasteProc.running = false
  }

  function readPaste(stage) {
    if (!root.pendingTemplate || root.shuttingDown) return
    root.pasteStage = stage
    pasteProc.generation = root.pendingTemplate.generation
    pasteProc.output = ""
    pasteProc.timedOut = false
    pasteProc.command = Model.pasteCommand(stage === "selection")
    root.pasteRunActive = true
    pasteProc.running = true
    pasteKill.restart()
  }

  function finishTemplate(text) {
    var pending = root.pendingTemplate
    if (!pending || pending.generation !== root.pasteGeneration) return
    if (root.pasteStage === "clipboard") {
      pending.ctx.clipboard = text
      if (pending.wantsSelection) {
        pending.stage = "selection"
        return
      }
    } else {
      pending.ctx.selection = text
    }
    root.pendingTemplate = null
    root.pasteStage = ""
    pending.done(Model.expandTemplate(pending.template, pending.ctx, pending.mode))
  }

  function outputStatus(exitCode) {
    if (exitCode === 0) return ""
    if (exitCode === 3) return "Result limit reached; showing partial matches"
    if (exitCode === 124 || exitCode === 137) return "Search timed out; showing partial matches"
    return "Search failed; showing available matches"
  }

  function refreshOptional() {
    if (root.shuttingDown) return
    if (!root.config.inlineAi) answersSource.cancel()
    if (!root.config.semantic) semanticSource.cancel()
    if (!root.config.currency) { ratesProc.running = false; root.rates = null }
    if (!root.config.ai) { agentProc.running = false; root.agentName = "" }
    if (root.config.queryLearning) ensureLearningPrivacy(false)
    else cancelPendingLearning()
  }

  function statusEntry(state, message) {
    return { state: state === "recording" ? "loading" : state === "cancelled" || state === "idle" ? "empty" : state,
      message: message || "", retryable: false }
  }

  function searchStatus(message, loading, count) {
    if (loading) return statusEntry("loading", message)
    if (message && count > 0) return statusEntry("ready", message)
    if (/limit reached/i.test(message)) return statusEntry("ready", message)
    if (/timed out/i.test(message)) return statusEntry("timeout", message)
    return statusEntry(message ? "failed" : count ? "ready" : "empty", message)
  }

  function providerStatuses() {
    var out = ({})
    var statuses = navigationSource.statuses || ({})
    Object.keys(statuses).forEach(function(key) { out[key] = statuses[key] })
    out.files = searchStatus(root.fileStatus, root.fileSearching, root.filePaths.length)
    out.content = searchStatus(root.contentStatus, root.contentRunActive || root.contentAuthorization !== null, root.contentPaths.length)
    out.scriptResults = statusEntry(resultsSource.status === "truncated" ? "failed" : resultsSource.status, resultsSource.error)
    out.picker = statusEntry(pickerSource.status, pickerSource.error)
    out.agent = statusEntry(root.config.inlineAi ? answersSource.status : "disabled", answersSource.error)
    out.semantic = statusEntry(root.config.semantic ? semanticSource.status : "disabled", semanticSource.error)
    return out
  }

  function retrySource(id) {
    if (Object.prototype.hasOwnProperty.call(navigationSource.statuses, id)) { navigationSource.retry(id); return true }
    return false
  }

  function menuGuards(id) {
    var guards = []
    var seen = ({})
    var entry = root.menuItems[id]
    while (entry && !seen[entry.id]) {
      seen[entry.id] = true
      guards.push({ id: entry.id, when: entry.when || "", checked: entry.checked || "" })
      entry = root.menuItems[entry.parent]
    }
    return guards
  }

  function refreshTrustedMenu() {
    defaultMenuFile.reload()
    userMenuFile.reload()
    defaultMenuFile.waitForJob()
    userMenuFile.waitForJob()
    var merged = MenuModel.mergeMenuSources(MenuModel.parseMenuJsonc(root.defaultMenuReadFailed ? "" : defaultMenuFile.text()), MenuModel.parseMenuJsonc(root.userMenuReadFailed ? "" : userMenuFile.text()))
    root.menuItems = merged.items
    root.menuOrder = merged.itemOrder
    reindexMenu()
  }

  function resolveAction(item) {
    if (!item || !item.payload || !item.key) return { ok: false, error: "Action is unavailable" }
    var p = item.payload
    var rows = []
    var now = Date.now()
    var found = null
    if (p.kind === "windowAction") {
      var available = WindowModel.catalog(root.configDoc.windowManagement).some(function(action) { return action.id === p.action && (!action.needsWindow || WindowModel.targetFromClient(p.target)) })
      return available ? { ok: true, error: "", item: item, token: ActionPolicy.identity(item) } : { ok: false, error: "Window action is no longer available" }
    }
    if (p.kind === "window") {
      // QObject handles are authority for switch/close, not JSON intent metadata.
      return root.windowHandle(p) ? { ok: true, error: "", item: item, token: "window:" + item.key }
        : { ok: false, error: "This window has closed" }
    }
    if (p.kind === "menu") {
      refreshTrustedMenu()
      var entry = root.menuItems[p.id]
      rows = Model.menuRows(root.menuIndex, "", root.store.usage, now, "catalog")
      for (var m = 0; m < rows.length; m++) if (rows[m].key === item.key) { found = rows[m]; break }
      if (found && entry) {
        found.payload.guards = menuGuards(entry.id)
        found.payload.checked = entry.checked || ""
      }
    } else if (["project", "ssh", "bookmark", "pluginPanel"].indexOf(p.kind) >= 0) {
      var descriptor = navigationSource.resolve(item.key)
      if (descriptor) found = Model.row({ key: item.key, title: descriptor.title, section: item.section, payload: descriptor })
    } else if (p.kind === "scriptResult") {
      var result = resultsSource.resolve(p.id, p.requestId)
      if (result) found = Model.row({ key: result.key, title: result.title, confirm: result.needsConfirmation,
        payload: { kind: "scriptResult", id: result.id, requestId: result.requestId, action: result.action } })
    } else {
      rows = rows.concat(Model.appRows(root.appLibrary ? root.appLibrary.sortedEntries("") : [], "", root.store.usage, root.runningApps, now),
        Model.windowRows(root.toplevels, ""), Model.keybindingRows(root.keybindingRecords, ""),
        Model.commandCatalogRows(root.commandCatalog, "", root.store.usage, now, true),
        Model.themeRows(root.themes, "", root.store.usage, now, true), Model.processRows(root.processes, ""))
      ;["quicklinks", "snippets", "commands"].forEach(function(kind) {
        var builder = kind === "quicklinks" ? Model.quicklinkRows : kind === "snippets" ? Model.snippetRows : Model.commandRows
        ;(root.config[kind] || []).forEach(function(entry) {
          var generated = builder([entry], "", root.store.usage, now)
          for (var c = 0; c < generated.length; c++) {
            var candidate = generated[c]
            if (candidate.key === item.key) {
              if (p.argument !== undefined) candidate.payload.argument = String(p.argument)
              if (p.kind === "command" && Array.isArray(p.args)) candidate.payload.args = p.args.slice()
              candidate.payload.complete = p.complete === true
            }
            rows.push(candidate)
          }
        })
      })
      root.scripts.forEach(function(script) {
        if (p.kind !== "script" || item.key !== "sc:" + script.path) return
        scriptDefinitionFile.path = script.path
        scriptDefinitionFile.reload()
        scriptDefinitionFile.waitForJob()
        var meta = Model.parseScriptCommand(scriptDefinitionFile.text().slice(0, 8192))
        if (!meta) return
        var fresh = Object.assign({}, script, { meta: meta })
        var values = Array.isArray(p.rawArgs) ? p.rawArgs : Array.isArray(p.args) ? p.args : []
        var validation = ScriptModel.validateArguments(meta.arguments, values)
        var generated = Model.scriptRows([fresh], "", root.store.usage, now, root.inlineOutputs, true, root.config.scriptForms)
        if (!generated.length) return
        var candidate = generated[0]
        candidate.payload.rawArgs = values.slice()
        candidate.payload.args = validation.args
        candidate.payload.needsForm = root.config.scriptForms && meta.arguments.length > 0 && (p.needsForm === true || !validation.ok)
        candidate.payload.complete = !candidate.payload.needsForm && p.complete === true
        candidate.payload.disabled = !fresh.executable || (!candidate.payload.complete && !candidate.payload.needsForm && !validation.ok)
        candidate.confirm = meta.needsConfirmation && !candidate.payload.complete && !candidate.payload.needsForm && !candidate.payload.disabled
        rows.push(candidate)
      })
      if (p.kind === "file") rows = rows.concat(Model.fileRows(root.filePaths.concat(root.contentPaths), "", root.home, "", {}))
      if (p.kind === "clipboard") rows = rows.concat(Model.clipboardRows(root.clipboardEntries, ""))
      if (p.kind === "emoji") rows = rows.concat(Model.emojiRows(root.emojis, ""))
      if (["answer", "url", "web", "scope", "setting", "help", "reminder", "fetchRates", "config", "scriptsFolder", "ai", "unhide"].indexOf(p.kind) >= 0)
        found = item
    }
    if (!found) for (var i = 0; i < rows.length; i++) if (rows[i].key === item.key) { found = rows[i]; break }
    if (!found) return { ok: false, error: "Action is no longer available" }
    if (p.kind === "command" && Array.isArray(p.args)) found.payload.args = p.args.slice()
    return { ok: true, error: "", item: found, token: ActionPolicy.identity(found) }
  }

  function prepareNavigation(item, token) {
    var current = resolveAction(item)
    if (!current.ok || current.token !== token) return { ok: false, error: current.error || "Action changed; confirm again" }
    var p = current.item.payload
    // Load opted-in SSH integration after shell rc overrides; keep the host in argv.
    var argv = p.kind === "project" ? ["xdg-open", p.path]
      : p.kind === "bookmark" ? ["xdg-open", p.url]
      : p.kind === "ssh" ? [
        "omarchy-launch-terminal", "-e", "bash", "-ic",
        "if [[ ${GHOSTTY_SHELL_FEATURES:-} == *ssh-* && -n ${GHOSTTY_RESOURCES_DIR:-} " +
          "&& -r \"$GHOSTTY_RESOURCES_DIR/shell-integration/bash/ghostty.bash\" ]]; then " +
          "builtin source \"$GHOSTTY_RESOURCES_DIR/shell-integration/bash/ghostty.bash\"; fi; " +
          "ssh -- \"$1\"",
        "omacast-ssh", p.host
      ]
      : p.kind === "pluginPanel" ? Navigation.activationCommand(p.pluginId, navigationSource.pluginCli) : []
    return { ok: argv.length > 0, error: argv.length ? "" : "Navigation action is unavailable", argv: argv }
  }

  onConfigChanged: {
    refreshOptional()
    cancelPreview()
    cancelFiles()
    cancelContent()
  }
  onOpenedChanged: if (!opened) {
    openRefresh.stop()
    resultsSource.cancel()
    pickerSource.cancel()
    answersSource.cancel()
    semanticSource.cancel()
    actionWorker.cancel()
    menuPreparationWorker.cancel()
    if (root.preparedMenu && !root.preparedMenu.ready) root.preparedMenu = null
  }

  Timer {
    id: openRefresh
    interval: 0
    onTriggered: root.refreshOnOpen()
  }

  NavigationSources {
    id: navigationSource
    home: root.home
    config: root.config
    opened: root.opened
    onChanged: root.catalogChanged()
  }
  ScriptResults {
    id: resultsSource
    home: root.home
    onRecordsChanged: root.catalogChanged()
    onStatusChanged: root.catalogChanged()
  }
  Picker {
    id: pickerSource
    onChanged: root.catalogChanged()
  }
  AgentAnswers {
    id: answersSource
    home: root.home
    enabled: root.config.inlineAi
    command: root.config.agentCommand || []
  }
  SemanticSearch {
    id: semanticSource
    enabled: root.config.semantic
    endpoint: root.config.semanticEndpoint
    model: root.config.semanticModel
  }

  ActionRunner {
    id: learningPrivacyWorker
    onFinished: function(key, ok, status, message) {
      if (key !== String(root.learningPrivacyGeneration)) {
        if (root.config.queryLearning && !root.shuttingDown) Qt.callLater(function() { root.ensureLearningPrivacy(false) })
        return
      }
      if (!root.config.queryLearning || root.shuttingDown) return
      if (!ok) {
        root.pendingQueryUses = []
        root.notice("Query learning could not use private storage: " + message)
        return
      }
      root.learningPrivate = true
      stateStore.reload()
      var pending = root.pendingQueryUses
      root.pendingQueryUses = []
      var next = root.store
      for (var i = 0; i < pending.length; i++)
        next = Model.recordQueryUse(next, pending[i].key, pending[i].hash, pending[i].now)
      if (pending.length) setStore(next)
    }
  }
  ActionRunner {
    id: menuPreparationWorker
    onFinished: function(key, ok, status, message) {
      var prepared = root.preparedMenu
      if (!prepared || key !== "menu:" + prepared.id) return
      if (!ok) {
        root.preparedMenu = null
        root.operationFinished(key, false, status, message)
        return
      }
      prepared.ready = true
      root.preparedMenu = prepared
      root.menuPrepared(prepared.id, prepared.token)
    }
  }
  ActionRunner {
    id: actionWorker
    onFinished: function(key, ok, status, message) {
      root.operationFinished(key, ok, status, message)
      if (ok && key.indexOf("menu:") === 0) root.evaluateGuards()
      if (ok && key.indexOf("process:") === 0) procRefresh.restart()
      if (!ok && status !== "cancelled") root.notice(message || "Operation failed")
    }
  }
  PathPolicy {
    id: filePolicy
    home: root.home
    config: root.config
    onResolved: function(key, allowed, path, message) {
      var request = root.fileAuthorization
      if (!request || key !== String(root.fileGeneration) || request.generation !== root.fileGeneration) return
      root.fileAuthorization = null
      if (!allowed) { root.fileSearching = false; root.fileStatus = message; root.catalogChanged(); return }
      request.dir = path
      root.fileRootPath = filePolicy.canonicalRootPath
      root.runFileSearch(request)
    }
  }
  PathPolicy {
    id: contentPolicy
    home: root.home
    config: root.config
    onResolved: function(key, allowed, path, message) {
      var request = root.contentAuthorization
      if (!request || key !== String(root.contentGeneration) || request.generation !== root.contentGeneration) return
      root.contentAuthorization = null
      if (!allowed) { root.contentStatus = message; root.catalogChanged(); return }
      request.dir = path
      root.contentRootPath = contentPolicy.canonicalRootPath
      if (root.contentRunActive || rgProc.running) root.pendingContent = request
      else root.runContentSearch(request)
    }
  }
  PathPolicy {
    id: previewPolicy
    home: root.home
    config: root.config
    onResolved: function(key, allowed, path, message) {
      var request = root.previewAuthorization
      if (!request || key !== String(root.previewGeneration) || request.generation !== root.previewGeneration) return
      root.previewAuthorization = null
      if (!allowed) { root.previewResult = { key: request.key, kind: "text", text: message, path: "" }; return }
      if (request.spec.type === "image") { root.previewResult = { key: request.key, kind: "image", text: "", path: path }; return }
      var spec = JSON.parse(JSON.stringify(request.spec))
      spec.path = path
      var argv = Model.previewCommand(spec)
      if (!argv) return
      root.pendingPreview = { key: request.key, argv: argv, generation: request.generation }
      root.startPendingPreview()
    }
  }

  FileView {
    id: scriptDefinitionFile
    path: ""
    blockAllReads: true
    printErrors: false
  }

  Component.onCompleted: {
    loadKeybindings()
    refreshToplevels()
  }

  Component.onDestruction: {
    root.shuttingDown = true
    configStore.flush()
    stateStore.flush()
    cancelTemplate()
    cancelPreview()
    fdKill.stop()
    root.fileGeneration += 1
    root.contentGeneration += 1
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
    navigationSource.cancel()
    resultsSource.cancel()
    pickerSource.cancel()
    answersSource.cancel()
    semanticSource.cancel()
    actionWorker.cancel()
    filePolicy.cancel()
    contentPolicy.cancel()
    previewPolicy.cancel()
    cancelPendingLearning()
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

  JsonStore {
    id: configStore
    path: root.home + "/.config/omarchy/omacast.json"
    parse: function(text) {
      var doc = Model.parseConfig(text)
      if (!doc || Array.isArray(doc)) throw new Error("Invalid JSONC object; repair this file to resume saving")
      return doc
    }
    serialize: Model.serializeConfig
    saveDelay: 0
    onDocumentChanged: root.catalogChanged()
    onFailed: function(error) { root.notice(error) }
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

  JsonStore {
    id: stateStore
    path: root.home + "/.local/state/omarchy/omacast-state.json"
    saveDelay: 500
    onDocumentChanged: root.catalogChanged()
    onFailed: function(error) { root.notice(error) }
  }

  // ---- Menu sources

  FileView {
    id: defaultMenuFile
    path: root.omarchyPath + "/default/omarchy/omarchy-menu.jsonc"
    watchChanges: true
    blockAllReads: true
    printErrors: false
    onLoaded: { root.defaultMenuReadFailed = false; root.rebuildMenu() }
    onFileChanged: reload()
    onLoadFailed: { root.defaultMenuReadFailed = true; root.rebuildMenu() }
  }

  FileView {
    id: userMenuFile
    path: root.home + "/.config/omarchy/extensions/omarchy-menu.jsonc"
    watchChanges: true
    blockAllReads: true
    printErrors: false
    onLoaded: { root.userMenuReadFailed = false; root.rebuildMenu() }
    onFileChanged: reload()
    onLoadFailed: { root.userMenuReadFailed = true; root.rebuildMenu() }
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
      root.windowBinds = WindowModel.parseBindings(text())
      root.catalogChanged()
    }
    onFileChanged: reload()
    onLoadFailed: {
      root.bindingsLoaded = false
      root.binds = { palette: "", clipboard: false, found: false }
      root.catalogChanged()
    }
    onSaveFailed: function(error) { root.bindingsWriteFailed = true; root.notice("Could not write bindings.lua: " + error) }
  }

  Process {
    id: shortcutCheckProc
    // The menu helper's sourced entrypoint also reads records. Disable its
    // disk cache, then request unlocalized records for exact description joins.
    command: ["bash", "-c", "hyprctl -j binds || exit $?; printf '\\nOMACAST_BIND_RECORDS\\n'; export XDG_CACHE_HOME=/dev/null; if source \"$0\" --print >/dev/null 2>&1; then translate_binding_records() { cat; }; output_binding_records_uncached; fi; true", root.omarchyPath + "/bin/omarchy-menu-keybindings"]
    property string output: ""
    property bool timedOut: false
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: shortcutCheckProc.output = text
    }
    onExited: function(exitCode, exitStatus) {
      var request = root.pendingShortcutCheck
      Qt.callLater(function() {
        if (!request || root.pendingShortcutCheck !== request) return
        var error = shortcutCheckProc.timedOut
          ? "Could not inspect Hyprland shortcuts (timed out); shortcut was not saved"
          : "Could not inspect Hyprland shortcuts; shortcut was not saved"
        if (exitCode === 0 && exitStatus === 0 && !shortcutCheckProc.timedOut) {
          try {
            var sections = shortcutCheckProc.output.split("\nOMACAST_BIND_RECORDS\n")
            error = Model.shortcutConflict(request.chord, request.owner,
              JSON.parse(sections[0]), root.windowBinds, root.binds, Model.parseKeybindingRecords(sections[1] || ""))
          } catch (e) {}
        }
        root.finishShortcutCheck(request, error)
      })
    }
  }

  Timer {
    id: shortcutCheckTimeout
    interval: 30000
    onTriggered: {
      if (!shortcutCheckProc.running) {
        root.finishShortcutCheck(root.pendingShortcutCheck, "Could not inspect Hyprland shortcuts; shortcut was not saved")
      } else {
        shortcutCheckProc.timedOut = true
        shortcutCheckProc.running = false
      }
    }
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
        root.windowBinds = WindowModel.parseBindings(root.bindsBackup)
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
    property bool timedOut: false
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        if (root.fileActiveGeneration !== root.fileGeneration) return
        var paths = Model.parseFilePaths(text)
        if (paths.length) {
          root.pendingFileStat = { paths: paths, generation: root.fileActiveGeneration }
        } else {
          root.fileRecords = { paths: [], mtimes: ({}) }
          root.catalogChanged()
        }
      }
    }
    onExited: function(exitCode) {
      fdKill.stop()
      // Keep the run occupied until its final stream callbacks have drained.
      Qt.callLater(function() {
        if (root.shuttingDown) return
        if (root.fileActiveGeneration === root.fileGeneration && (exitCode !== 0 || fdProc.timedOut))
          root.fileStatus = root.outputStatus(fdProc.timedOut ? 124 : exitCode)
        var metadata = root.pendingFileStat
        root.pendingFileStat = null
        if (metadata && metadata.generation === root.fileGeneration) {
          root.fileStatGeneration = metadata.generation
          fileStatProc.command = Model.fileStatCommand(metadata.paths)
          fileStatProc.timedOut = false
          fileStatProc.running = true
          // Keep partial matches from a timed-out walk, then bound metadata
          // collection separately so a slow filesystem cannot hold the slot.
          fdKill.interval = 1000
          fdKill.restart()
        } else {
          root.finishFileSearch()
        }
      })
    }
  }

  Process {
    id: fileStatProc
    property bool timedOut: false
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        if (root.fileStatGeneration !== root.fileGeneration) return
        root.fileRecords = Model.parseFileRecords(text)
        root.catalogChanged()
      }
    }
    onExited: function(exitCode) {
      fdKill.stop()
      Qt.callLater(function() {
        if (root.shuttingDown) return
        if (root.fileStatGeneration === root.fileGeneration && (exitCode !== 0 || fileStatProc.timedOut))
          root.fileStatus = root.outputStatus(fileStatProc.timedOut ? 124 : exitCode)
        root.finishFileSearch()
      })
    }
  }

  // fd on a cold cache can walk a very large tree; three seconds is already
  // past useful for a palette, so the run is killed rather than awaited.
  Timer {
    id: fdKill
    interval: 3000
    onTriggered: {
      root.pendingFileStat = null
      if (fdProc.running) { fdProc.timedOut = true; fdProc.running = false }
      if (fileStatProc.running) { fileStatProc.timedOut = true; fileStatProc.running = false }
    }
  }

  // ---- Clipboard and selection reads for templates

  Process {
    id: pasteProc
    property int generation: 0
    property string output: ""
    property bool timedOut: false
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: pasteProc.output = text
    }
    onExited: function(exitCode) {
      pasteKill.stop()
      Qt.callLater(function() {
        if (root.shuttingDown) return
        root.pasteRunActive = false
        var pending = root.pendingTemplate
        if (pending && pending.generation === pasteProc.generation) {
          if (exitCode !== 0 || pasteProc.timedOut) {
            root.pendingTemplate = null
            root.pasteStage = ""
            root.templateFailed(pasteProc.timedOut || exitCode === 124 || exitCode === 137
              ? "Clipboard read timed out; action cancelled"
              : exitCode === 3 ? "Clipboard exceeds 64 KiB; action cancelled"
              : "Could not read clipboard; action cancelled")
          } else {
            root.finishTemplate(pasteProc.output)
          }
        }
        if (root.pendingTemplate && !pasteProc.running) root.readPaste(root.pendingTemplate.stage)
      })
    }
  }

  Timer {
    id: pasteKill
    interval: 3000
    onTriggered: { pasteProc.timedOut = true; pasteProc.running = false }
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
    command: ["bash", "-c", 'self=$PPID; parent=$(ps -o ppid= -p "$self" | tr -d " "); echo "$self $parent $$"; ps -u "$(id -u)" -o pid=,pcpu=,pmem=,comm= --sort=-pcpu | while read -r pid cpu mem comm; do stat=$(cat "/proc/$pid/stat" 2>/dev/null) || continue; rest=${stat##*) }; read -ra fields <<< "$rest"; printf "%s\\t%s\\t%s\\t%s\\t%s\\n" "$pid" "$cpu" "$mem" "${fields[19]}" "$comm"; done']
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
    property int generation: 0
    property string output: ""
    property bool timedOut: false
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: previewProc.output = text
    }
    onExited: function(exitCode) {
      previewKill.stop()
      Qt.callLater(function() {
        if (root.shuttingDown) return
        root.previewRunActive = false
        if (previewProc.generation === root.previewGeneration && previewProc.runKey === root.previewWantedKey) {
          var text = Model.cleanPreview(previewProc.output)
          if (previewProc.timedOut || exitCode === 124 || exitCode === 137)
            text += (text ? "\n\n" : "") + "[Preview timed out]"
          else if (exitCode !== 0 && exitCode !== 3)
            text += (text ? "\n\n" : "") + "[Could not read preview]"
          root.previewResult = { key: previewProc.runKey, text: text, kind: "text", path: "" }
        }
        root.startPendingPreview()
      })
    }
  }


  Timer {
    id: previewKill
    interval: 3000
    onTriggered: { previewProc.timedOut = true; previewProc.running = false }
  }
  // ---- Content search

  Process {
    id: rgProc
    property bool timedOut: false
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        if (root.contentActiveGeneration !== root.contentGeneration) return
        root.contentPaths = Model.parseFilePaths(text)
        root.catalogChanged()
      }
    }
    onExited: function(exitCode) {
      rgKill.stop()
      Qt.callLater(function() {
        if (root.shuttingDown) return
        root.contentRunActive = false
        if (root.contentActiveGeneration === root.contentGeneration && (exitCode !== 0 || rgProc.timedOut))
          root.contentStatus = root.outputStatus(rgProc.timedOut ? 124 : exitCode)
        var pending = root.pendingContent
        root.pendingContent = null
        if (pending) root.runContentSearch(pending)
      })
    }
  }

  // Same budget as fd: past three seconds a palette answer is no answer.
  Timer {
    id: rgKill
    interval: 3000
    onTriggered: { rgProc.timedOut = true; rgProc.running = false }
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
