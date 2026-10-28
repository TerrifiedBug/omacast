import QtQuick
import Quickshell
import Quickshell.Hyprland
import Quickshell.Io
import Quickshell.Wayland
import qs.Commons
import qs.Commons as Commons
import qs.Ui
import "Model.js" as Model
import "vendor/MenuModel.js" as MenuModel
import "Navigation.js" as Navigation
import "ScriptModel.js" as ScriptModel
import "FilePolicy.js" as FilePolicy
import "WindowModel.js" as WindowModel

// One overlay card that answers a query: applications, open windows, the whole
// Omarchy menu as flat actions, keybindings, arithmetic and unit conversion,
// quicklinks, snippets, shell commands, clipboard history, emoji and files.
//
// Three rules shape the code:
//   * Sections publish in a fixed order (Model.SECTIONS) and never interleave,
//     so a keystroke can reorder rows inside a section but never shuffle the
//     list wholesale.
//   * Asynchronous landings — fd results, menu guards, keybindings, toplevel
//     changes — may repaint the list but must never move the cursor. Only
//     arrows, page keys and a real pointer move set root.pinnedKey.
//   * The text field is created once and keeps focus for the whole session.
//     Rebuilding it under the user is how a palette loses a keystroke.
Item {
  id: root

  property string omarchyPath: Quickshell.env("OMARCHY_PATH")
  property string home: Quickshell.env("HOME")
  property var shell: null
  property var manifest: null

  property bool opened: false
  // Plain JS rows carry payloads; displayModel holds only what the delegates
  // draw. Putting payload objects in a ListModel turns them into QML value
  // types and loses the live toplevel handles.
  property var rows: []
  property int selectedIndex: -1
  // Set by explicit navigation only, and cleared on every query change, so an
  // async landing can never steal the row under the user's finger.
  property string pinnedKey: ""
  property string confirmKey: ""
  property string confirmToken: ""
  property int sessionGeneration: 0
  property var windowSession: ({ generation: 0, pending: false, target: null })
  property var windowTarget: null
  property int queryGeneration: 0
  property int queuedRebuildGeneration: -1
  property string selectedRoot: ""
  property var scriptFormRow: null
  property bool scriptFormSecondary: false
  property var scriptFormValues: null
  property string scriptValuesKey: ""
  property var pendingMenu: null
  readonly property var fileRoots: FilePolicy.normalizeRoots(sources.config, root.home)
  property bool ctrlHeld: false
  property var scopeStack: []
  property string lastEffectiveScope: "root"
  property string fileFilter: "all"
  property string fileSort: "relevance"
  property int fileLimit: 60
  property int fileMatchCount: 0
  readonly property bool filesActive: !root.editing && root.parsedInput().scope === "files"
  // Ctrl+K: the selected row's actions, captured when the panel opens so a
  // late landing cannot swap them under the user.
  property bool actionsOpen: false
  property var actionRow: null
  property var actionItems: []
  property int actionIndex: 0
  // What the preview pane shows for the selected row, or null to hide it.
  property var previewState: null

  property var editing: null
  property bool shortcutCheckPending: false
  readonly property var shortcutKeyNames: {
    var names = {}
    var keys = ["Space", "Return", "Enter", "Tab", "Backtab", "Escape", "Backspace", "Delete", "Insert", "Home", "End", "PageUp", "PageDown", "Left", "Right", "Up", "Down", "Minus", "Equal", "Comma", "Period", "Slash", "Semicolon", "Apostrophe", "QuoteLeft", "BracketLeft", "BracketRight", "Backslash", "Print"]
    var aliases = { Enter: "RETURN", Backtab: "TAB", PageUp: "PRIOR", PageDown: "NEXT", QuoteLeft: "GRAVE" }
    keys.forEach(function(key) { names[Qt["Key_" + key]] = aliases[key] || key.toUpperCase() })
    return names
  }
  property string notice: ""
  readonly property string footerNotice: root.confirmKey !== ""
    ? "Press ↵ again to confirm  ·  Esc cancels"
    : root.notice || sources.storageError || windowActions.error
      || (root.filesActive ? sources.fileStatus
        : root.parsedInput().scope === "content" ? sources.contentStatus : "")

  readonly property string manifestId: manifest && manifest.id ? manifest.id : "io.github.terrifiedbug.omacast"
  readonly property string scope: scopeStack.length > 0 ? scopeStack[scopeStack.length - 1].scope : "root"
  readonly property string configPath: root.home + "/.config/omarchy/omacast.json"
  // Where this plugin was installed, so the Config row can seed the file from
  // the example shipped beside it.
  readonly property string pluginDir: String(Qt.resolvedUrl(".")).replace(/^file:\/\//, "")

  readonly property color background: Commons.Color.menu.background
  readonly property color foreground: Commons.Color.menu.text
  readonly property color faintForeground: Qt.darker(Commons.Color.menu.text, 1.6)
  readonly property color selectedBackground: Commons.Color.menu.selectedBackground
  readonly property color selectedText: Commons.Color.menu.selectedText
  readonly property color selectedBorder: Commons.Color.menu.selectedBorder
  readonly property string fontFamily: Style.font.menuFamily
  // Nerd Font glyphs come from the bar family; OMARCHY_MENU_FONT may point
  // menuFamily at a text font with no glyph coverage.
  readonly property string glyphFamily: Style.font.family

  readonly property int rowHeight: Style.space(40)
  readonly property int headerHeight: Style.space(52)
  readonly property int footerHeight: Style.space(36)
  readonly property int maxListHeight: Style.space(400)
  readonly property int iconSlot: Style.space(24)
  readonly property int previewWidth: Style.space(280)
  // The pane needs room beside a 640 px card, and the user can say no.
  readonly property bool previewAllowed: sources.config.preview === true && root.targetScreen !== null && root.targetScreen.width >= 1400
  readonly property string previewText: {
    var state = root.previewState
    if (!state || state.kind === "image") return ""
    if (state.kind === "text") return state.text
    return sources.previewResult.key === state.key ? sources.previewResult.text : "…"
  }
  readonly property string floatingTerminal: root.omarchyPath + "/bin/omarchy-launch-floating-terminal-with-presentation"

  readonly property var targetScreen: {
    var screens = Quickshell.screens
    var focused = Hyprland.focusedMonitor
    var name = focused ? String(focused.name || "") : ""
    for (var s = 0; s < screens.length; s++) if (screens[s].name === name) return screens[s]
    return screens.length > 0 ? screens[0] : null
  }

  // ---- Lifecycle

  function open(payloadJson) {
    root.sessionGeneration++
    root.scriptFormRow = null
    root.scriptValuesKey = ""
    root.pendingMenu = null
    root.scriptFormValues = null
    root.editing = null
    var payload = ({})
    try { payload = JSON.parse(payloadJson || "{}") } catch (e) { payload = ({}) }

    root.scopeStack = []
    root.confirmKey = ""
    root.pinnedKey = ""
    root.previewState = null
    root.lastEffectiveScope = ""
    closeActions()
    // Clear before pushing: pushScope remembers the field's current text as
    // what Esc should restore, and last session's query is not that.
    input.text = ""

    var requested = String((payload && payload.scope) || "")
    if (Model.SCOPES.indexOf(requested) >= 0) pushScope(requested)

    input.text = String((payload && payload.query) || "")
    if (root.opened) { completeOpen(payload); return }
    var ticket = WindowModel.beginSession(root.windowSession)
    windowActions.capture(function(target) {
      if (!WindowModel.finishCapture(root.windowSession, ticket, target)) return
      root.windowTarget = root.windowSession.target
      sources.refreshToplevels()
      completeOpen(payload)
    })
  }

  function completeOpen(payload) {
    root.opened = true
    if (payload.pickerPath || payload.picker) {
      sources.picker.open(String(payload.pickerPath || payload.picker))
      pushScope("picker")
    }
    sources.onOpen()
    typingGuard.restart()
    pointerGate.reset()
    rebuild()
    Qt.callLater(function() { input.forceActiveFocus() })
  }

  function close() {
    WindowModel.cancelSession(root.windowSession)
    root.windowTarget = null
    root.sessionGeneration++
    var remember = root.opened && root.scopeStack.length === 0
    root.opened = false
    if (remember) sources.rememberQuery(input.text)
    root.editing = null
    root.scriptFormRow = null
    root.scriptFormValues = null
    semanticDebounce.stop()
    root.pendingMenu = null
    root.confirmKey = ""
    root.ctrlHeld = false
    fdDebounce.stop()
    tzDebounce.stop()
    contentDebounce.stop()
    sources.cancelFiles()
    sources.cancelContent()
    sources.cancelPreview()
    sources.wantProcesses(false)
    closeActions()
    ctrlTimer.stop()
  }

  function dismiss() {
    close()
    if (root.shell && typeof root.shell.hide === "function") root.shell.hide(root.manifestId)
  }

  function toggle() {
    if (root.opened || root.windowSession.pending) dismiss()
    else open("{}")
  }

  // ---- Dev/test IPC: `omarchy-shell shell call <id> setQuery '12*7+3'`

  function setQuery(arg): string {
    input.text = String(arg === undefined || arg === null ? "" : arg)
    rebuild()
    return "ok"
  }

  function openPicker(path): string {
    if (!root.opened) open("{}")
    sources.picker.open(String(path))
    root.scopeStack = []
    pushScope("picker")
    return sources.picker.status
  }

  function inspect(arg): string {
    var out = []
    for (var i = 0; i < root.rows.length; i++) {
      out.push({
        section: root.rows[i].section,
        title: root.rows[i].title,
        subtitle: root.rows[i].subtitle,
        primaryLabel: root.rows[i].primaryLabel,
        secondaryLabel: root.rows[i].secondaryLabel,
        key: root.rows[i].key,
        accessory: root.rows[i].accessory
      })
    }
    var selected = selectedRow()
    return JSON.stringify({
      opened: root.opened,
      scope: root.scope,
      query: input.text,
      selectedIndex: root.selectedIndex,
      confirmKey: root.confirmKey,
      pins: sources.store.pins,
      hidden: sources.store.hidden,
      lastQuery: sources.store.lastQuery,
      configPath: root.configPath,
      pluginDir: root.pluginDir,
      actionsOpen: root.actionsOpen,
      ctrlHeld: root.ctrlHeld,
      editing: root.editing ? root.editing.label : "",
      notice: root.notice,
      selectedRoot: root.selectedRoot,
      sourceStatuses: sources.sourceStatuses,
      scriptForm: root.scriptFormRow ? root.scriptFormRow.key : "",
      scriptResults: { status: sources.scriptResults.status, requestId: sources.scriptResults.requestId },
      picker: { status: sources.picker.status, requestId: sources.picker.requestId },
      agent: sources.agentAnswers.status,
      semantic: sources.semanticSearch.status,
      binds: sources.binds,
      configDoc: sources.configDoc,
      barButton: sources.barButton,
      windowManagement: { ready: windowActions.ready, busy: windowActions.busy, error: windowActions.error, target: root.windowTarget, socketPath: windowActions.socketPath },
      actions: selected ? Model.rowActions(selected, sources.store, sources.configDoc.windowManagement, WindowModel.catalog(sources.configDoc.windowManagement)).map(function(a) { return a.id + ":" + a.label }) : [],
      preview: root.previewState ? { kind: root.previewState.kind, text: root.previewText.slice(0, 400), source: root.previewState.source || "" } : null,
      cardWidth: card.width,
      cardX: card.x,
      screenWidth: panel.width,
      scripts: sources.scripts.length,
      fileSearch: {
        active: root.filesActive, filter: root.fileFilter, sort: root.fileSort, limit: root.fileLimit,
        candidates: sources.filePaths.length, matches: root.fileMatchCount, searching: sources.fileSearching
      },
      rows: out
    })
  }

  // `select 3` moves the cursor; `runAction copy-path` runs one of the
  // selected row's Ctrl+K actions by id.
  function select(arg): string {
    var index = parseInt(String(arg), 10)
    if (!(index >= 0 && index < root.rows.length)) return "out of range"
    pointerGate.reset()
    root.selectedIndex = index
    root.pinnedKey = root.rows[index].key
    return "ok"
  }

  function runAction(arg): string {
    var item = selectedRow()
    if (!item) return "no row"
    performAction(item, String(arg))
    return "ok"
  }

  // ---- Scopes

  function pushScope(next) {
    root.editing = null
    var stack = root.scopeStack.slice()
    stack.push({ scope: next, query: input.text })
    root.scopeStack = stack
    root.pinnedKey = ""
    root.confirmKey = ""
    input.text = ""
    rebuild()
  }

  function popScope() {
    root.editing = null
    if (root.scopeStack.length === 0) return
    var stack = root.scopeStack.slice()
    var top = stack.pop()
    root.scopeStack = stack
    root.pinnedKey = ""
    root.confirmKey = ""
    input.text = String(top.query || "")
    rebuild()
  }

  // Entering a scope is what pays for its data: the clipboard store is re-read
  // so paste indices are fresh, the emoji table is parsed once, and fd starts.
  // Inline prefixes (`cb `, `:`, `~/`) enter the same way a pushed scope does.
  function enterScope(next) {
    if (next !== "files") {
      fdDebounce.stop()
      sources.cancelFiles()
    }
    sources.wantProcesses(next === "kill")
    if (next === "clipboard") sources.loadClipboard()
    else if (next === "emoji") sources.wantEmojis()
    else if (next === "files") { sources.clearFiles(); fdDebounce.restart() }
    else if (next === "content") contentDebounce.restart()
  }

  function parsedInput() {
    var parsed = Model.parseQuery(input.text, root.scope)
    var flags = { projects: "projectsEnabled", ssh: "sshEnabled", bookmarks: "bookmarksEnabled", plugins: "pluginPanelsEnabled" }
    if (root.scope === "root" && flags[parsed.scope] && !sources.config[flags[parsed.scope]])
      return { raw: parsed.raw, trimmed: parsed.trimmed, scope: "root", prefix: "", rest: parsed.trimmed }
    return parsed
  }

  function recordRowUse(item) {
    var key = item.frecencyKey || (["project", "ssh", "bookmark", "pluginPanel"].indexOf(item.payload.kind) >= 0 ? item.key : "")
    if (!key) return
    var parsed = parsedInput()
    sources.recordUse(key, parsed.rest, parsed.scope)
  }

  function cycleRoot(direction): string {
    var names = root.fileRoots.map(function(r) { return r.name })
    if (!names.length) return ""
    var parsed = parsedInput()
    var at = names.indexOf(Model.fileRequest(parsed, root.home, root.fileRoots, root.selectedRoot).rootName)
    root.selectedRoot = names[(at + (direction < 0 ? -1 : 1) + names.length) % names.length]
    var explicit = parsed.scope === "files" ? parsed.rest.match(/^@(\S+)(?:\s|$)/) : null
    if (explicit && names.some(function(name) { return name.toLowerCase() === explicit[1].toLowerCase() }))
      input.text = input.text.replace(/@\S+/, "@" + root.selectedRoot)
    sources.cancelFiles()
    sources.cancelContent()
    sources.clearFiles()
    root.confirmKey = ""
    root.pinnedKey = ""
    rebuild()
    if (root.lastEffectiveScope === "content") contentDebounce.restart()
    else fdDebounce.restart()
    return root.selectedRoot
  }

  function navigationRows(scope, query) {
    return Navigation.rows({ projects: sources.navigation.projects, sshHosts: sources.navigation.sshHosts,
      bookmarks: sources.navigation.bookmarks, pluginPanels: sources.navigation.pluginPanels }, scope, query, Model.matchScore).map(Model.row)
  }

  function aliasRow(item, argument) {
    var payload = Object.assign({}, item.payload)
    if (["quicklink", "snippet"].indexOf(payload.kind) >= 0) { payload.argument = argument; payload.complete = false }
    if (payload.kind === "command") { payload.args = Model.splitArguments(argument); payload.complete = false }
    if (payload.kind === "script") { payload.rawArgs = Model.splitArguments(argument); payload.args = payload.rawArgs; payload.complete = false }
    return Object.assign({}, item, { promoted: true, score: 100000, payload: payload })
  }

  function scriptResultRows(query) {
    return sources.scriptResults.records.filter(function(r) { return !query || Model.matchScore(query, { name: r.title, text: String(r.subtitle || "") }) >= 0 }).map(function(r) {
      return Model.row({ key: r.key, section: "scriptResults", title: r.title, subtitle: r.subtitle,
        confirm: r.needsConfirmation, primaryLabel: r.action.type === "copy" ? "Copy" : "Run",
        payload: { kind: "scriptResult", id: r.id, requestId: r.requestId, needsConfirmation: r.needsConfirmation } })
    })
  }

  function pickerRows(query) {
    return sources.picker.items.filter(function(r) { return !query || Model.matchScore(query, { name: r.title, text: String(r.subtitle || "") }) >= 0 }).map(function(r) {
      return Model.row({ key: "picker:" + sources.picker.requestId + ":" + r.id, section: "picker", title: r.title,
        subtitle: r.subtitle, primaryLabel: "Select", payload: { kind: "pickerItem", id: r.id, requestId: sources.picker.requestId } })
    })
  }

  function agentRows(query, sendOnly) {
    if (!sources.config.inlineAi) return []
    var rows = []
    if (query.trim()) rows.push(Model.row({ key: "agent:send", section: "agent", title: "Send to agent", subtitle: query,
      primaryLabel: "Send", payload: { kind: "agentSend", prompt: query } }))
    if (sendOnly) return rows
    if (sources.agentAnswers.status === "loading") rows.push(Model.row({ key: "agent:cancel", section: "agent", title: "Cancel answer", payload: { kind: "agentCancel" } }))
    if (sources.agentAnswers.answer) rows.push(Model.row({ key: "agent:answer", section: "agent", title: "Copy agent answer",
      subtitle: sources.agentAnswers.answer, primaryLabel: "Copy", payload: { kind: "agentCopy" } }))
    return rows
  }

  function semanticRows() {
    if (!sources.config.semantic) return []
    var catalog = catalogByKey(false)
    var hidden = Model.hiddenMap(sources.store)
    return sources.semanticSearch.suggestions.filter(function(s) { return !!catalog[s.key || s.id] && !hidden[s.key || s.id] }).map(function(s) {
      var target = catalog[s.key || s.id]
      return Model.row({ key: "semantic:" + target.key, section: "semantic", title: target.title, subtitle: "Semantic suggestion · " + target.subtitle,
        primaryLabel: target.primaryLabel, payload: { kind: "semanticResult", targetKey: target.key } })
    })
  }

  function semanticCandidates() {
    var catalog = catalogByKey(false)
    var hidden = Model.hiddenMap(sources.store)
    var query = parsedInput().rest
    var groups = ({})
    var sections = []
    Object.keys(catalog).forEach(function(key) {
      if (hidden[key]) return
      var item = catalog[key]
      if (!groups[item.section]) { groups[item.section] = []; sections.push(item.section) }
      groups[item.section].push({ key: key, title: item.title, subtitle: item.subtitle,
        score: Model.matchScore(query, { name: item.title, text: item.subtitle }) })
    })
    sections.forEach(function(section) {
      groups[section].sort(function(a, b) { return b.score - a.score || a.key.localeCompare(b.key) })
    })
    // Round-robin sections so a large app catalog cannot exclude other sources.
    var out = []
    for (var round = 0; out.length < 32; round++) {
      var added = false
      for (var s = 0; s < sections.length && out.length < 32; s++) {
        var candidate = groups[sections[s]][round]
        if (!candidate) continue
        out.push({ key: candidate.key, title: candidate.title, subtitle: candidate.subtitle })
        added = true
      }
      if (!added) break
    }
    return out
  }

  function statusRows(scope) {
    var rows = []
    var statuses = sources.sourceStatuses
    Object.keys(statuses).forEach(function(id) {
      var status = statuses[id]
      if (!status || (status.state !== "failed" && status.state !== "timeout" && !status.retryable)) return
      if (scope === "root" || id !== scope) return
      rows.push(Model.row({ key: "status:" + id, section: "status", title: id + ": " + status.state,
        subtitle: status.message || "", primaryLabel: status.retryable ? "Retry" : "",
        payload: { kind: "providerStatus", id: id, retryable: status.retryable } }))
    })
    return rows
  }

  function handleIntegratedAction(item, payload, token) {
    if (payload.kind === "providerStatus") {
      var currentStatus = sources.sourceStatuses[payload.id]
      if (currentStatus && currentStatus.retryable) sources.retrySource(payload.id)
      return true
    }
    if (payload.kind === "semanticResult") {
      var current = catalogByKey(false)[payload.targetKey]
      if (current) activateItem(current, false)
      return true
    }
    if (["project", "ssh", "bookmark", "pluginPanel"].indexOf(payload.kind) >= 0) {
      var prepared = sources.prepareNavigation(item, token)
      if (!prepared.ok) { showNotice(prepared.error); return true }
      recordRowUse(item)
      dismiss()
      Qt.callLater(function() { Quickshell.execDetached(prepared.argv) })
      return true
    }
    if (payload.kind === "pickerItem") {
      if (String(payload.requestId) !== String(sources.picker.requestId)) { showNotice("Picker request changed"); return true }
      if (!sources.picker.select(payload.id)) showNotice("Picker selection is no longer available")
      return true
    }
    if (payload.kind === "agentSend") { sources.agentAnswers.send(Model.parseQuery(input.text, root.scope).rest); if (root.scope !== "agent") pushScope("agent"); rebuild(); return true }
    if (payload.kind === "agentCancel") { sources.agentAnswers.cancel(); rebuild(); return true }
    if (payload.kind === "agentCopy") { Util.execArgv(["wl-copy", "--", sources.agentAnswers.answer]); return true }
    if (payload.kind === "script" && payload.mode === "results") {
      sources.scriptResults.run(payload.path, payload.args || [])
      root.scriptFormRow = null
      root.scriptFormValues = null
      pushScope("scriptResults")
      return true
    }
    if (payload.kind === "scriptResult") {
      var result = sources.scriptResults.resolve(payload.id, payload.requestId)
      if (!result) { showNotice("Script result expired"); return true }
      var action = result.action
      if (action.type === "copy") Util.execArgv(["wl-copy", "--", action.text])
      else if (action.type === "open") { dismiss(); openPath(action.path) }
      else if (action.type === "url") { dismiss(); openDestination(action.url) }
      else if (action.type === "argv") { dismiss(); Qt.callLater(function() { Quickshell.execDetached(action.argv) }) }
      return true
    }
    return false
  }

  // File controls keep the query and its focus; only a type change needs a
  // fresh walk. Sorting and limit changes reuse the complete candidate set.
  function cycleFileFilter(direction): string {
    if (!root.filesActive) return "not in Files"
    var index = Model.FILE_FILTERS.map(function(f) { return f.id }).indexOf(root.fileFilter)
    var step = Number(direction) < 0 ? -1 : 1
    root.fileFilter = Model.FILE_FILTERS[(index + step + Model.FILE_FILTERS.length) % Model.FILE_FILTERS.length].id
    root.pinnedKey = ""
    root.confirmKey = ""
    closeActions()
    sources.cancelFiles()
    sources.clearFiles()
    rebuild()
    fdDebounce.restart()
    input.forceActiveFocus()
    return root.fileFilter
  }

  function cycleFileSort(direction): string {
    if (!root.filesActive) return "not in Files"
    var index = Model.FILE_SORTS.map(function(s) { return s.id }).indexOf(root.fileSort)
    var step = Number(direction) < 0 ? -1 : 1
    root.fileSort = Model.FILE_SORTS[(index + step + Model.FILE_SORTS.length) % Model.FILE_SORTS.length].id
    root.pinnedKey = ""
    root.confirmKey = ""
    closeActions()
    rebuild()
    input.forceActiveFocus()
    return root.fileSort
  }

  function cycleFileLimit(direction): string {
    if (!root.filesActive) return "not in Files"
    var index = Model.FILE_LIMITS.indexOf(root.fileLimit)
    var step = Number(direction) < 0 ? -1 : 1
    root.fileLimit = Model.FILE_LIMITS[(index + step + Model.FILE_LIMITS.length) % Model.FILE_LIMITS.length]
    rebuild()
    input.forceActiveFocus()
    return String(root.fileLimit)
  }

  function scopeChipText() {
    if (root.editing) return root.editing.label
    if (root.scope === "picker") return sources.picker.prompt || "Picker"
    if (root.scope === "root") return ""
    if (root.scope.indexOf("menu:") === 0) {
      var id = root.scope.slice(5)
      return MenuModel.pathFor(sources.menuItems, id) || id
    }
    return Model.scopeTitle(root.scope, sources.configDoc)
  }

  // ---- Rebuild
  //
  // The single funnel: parse the query, collect rows from every provider the
  // scope allows, sort, cap, publish, then resolve the cursor.

  // Collapse a provider's related changes into one surface update per turn.
  function queueRebuild() {
    if (!root.opened) return
    root.queuedRebuildGeneration = root.sessionGeneration
    Qt.callLater(root.flushRebuild)
  }

  function flushRebuild() {
    var generation = root.queuedRebuildGeneration
    root.queuedRebuildGeneration = -1
    if (root.opened && generation === root.sessionGeneration) root.rebuild()
  }

  function rebuild() {
    root.queuedRebuildGeneration = -1
    if (!root.opened) return
    var parsed = parsedInput()
    if (parsed.scope !== root.lastEffectiveScope) {
      root.lastEffectiveScope = parsed.scope
      enterScope(parsed.scope)
    }

    var now = Date.now()
    var usage = sources.store.usage
    var rows = []
    var caps = ({})

    if (Model.isSettingsScope(parsed.scope)) {
      rows = settingsRowsFor(parsed.scope, root.editing ? "" : parsed.rest)
    } else if (["projects", "ssh", "bookmarks", "plugins"].indexOf(parsed.scope) >= 0) {
      rows = navigationRows(parsed.scope, parsed.rest)
    } else if (parsed.scope === "scriptResults") {
      rows = scriptResultRows(parsed.rest)
    } else if (parsed.scope === "picker") {
      rows = pickerRows(parsed.rest)
    } else if (parsed.scope === "agent") {
      rows = agentRows(parsed.rest)
    } else if (parsed.scope === "clipboard") {
      rows = Model.clipboardRows(sources.clipboardEntries, parsed.rest)
    } else if (parsed.scope === "emoji") {
      rows = Model.emojiRows(sources.emojis, parsed.rest)
    } else if (parsed.scope === "files") {
      var request = Model.fileRequest(parsed, root.home, root.fileRoots, root.selectedRoot)
      rows = Model.fileRows(sources.filePaths, request.terms.join(" "), root.home, "", { sort: root.fileSort, mtimes: sources.fileMtimes })
      root.fileMatchCount = rows.length
      caps = { files: root.fileLimit }
    } else if (parsed.scope === "content") {
      // The last landing stays up while the next rg runs, tagged with the
      // term it matched so the preview greps for the right thing.
      rows = Model.fileRows(sources.contentPaths, "", root.home, sources.contentTerm)
    } else if (parsed.scope === "windows") {
      // The scope exists to show the ones the root view had to leave out.
      rows = Model.windowRows(sources.toplevels, parsed.rest)
      caps = { windows: Infinity }
    } else if (parsed.scope === "kill") {
      rows = Model.processRows(sources.processes, parsed.rest)
      caps = { processes: Infinity }
    } else if (parsed.scope === "hidden") {
      rows = Model.hiddenRows(catalogByKey(true), sources.store, parsed.rest)
    } else if (parsed.scope === "help") {
      rows = Model.helpRows(sources.config, parsed.rest, { scripts: sources.scripts, scriptDir: sources.scriptDir, hiddenCount: sources.store.hidden.length })
    } else if (parsed.scope.indexOf("menu:") === 0) {
      rows = Model.menuRows(sources.menuIndex, parsed.rest, usage, now, parsed.scope)
    } else if (!parsed.trimmed) {
      rows = Model.emptyQueryRows({ byKey: catalogByKey(false), windowRows: Model.windowRows(sources.toplevels, "") }, sources.store, now)
      caps = { windows: Model.EMPTY_WINDOW_LIMIT }
    } else {
      rows = rootRows(parsed, usage, now)
    }

    if (parsed.scope === "root" && parsed.rest) {
      var alias = Model.aliasTarget(parsed.raw, sources.store)
      var target = alias ? catalogByKey(false)[alias.key] : null
      if (target) {
        target = aliasRow(target, alias.argument)
        rows = rows.filter(function(r) { return r.key !== target.key })
        rows.unshift(target)
      }
      if (sources.config.queryLearning) rows = Model.personalizeRows(rows, sources.store, sources.contextHash(parsed.rest, parsed.scope), now)
      rows = rows.concat(semanticRows())
    }
    rows = rows.concat(statusRows(parsed.scope))
    publish(Model.applyCaps(Model.sortRows(rows), caps))
  }

  function windowSettingsRows(parts, query) {
    var config = WindowModel.normalize(sources.configDoc.windowManagement), specs = []
    function add(id, title, subtitle, action, accessory) {
      var label = action.type === "windowAddSize" ? "Add" : action.type === "windowDeleteSize" ? "Delete" : action.type === "windowLayout" ? "Use" : action.type === "push" ? "Open" : "Change"
      specs.push({ key: "setting:windows:" + id, section: "settingsEntries", title: title, subtitle: subtitle || "", accessory: accessory || "", primaryLabel: label, confirm: action.type === "windowDeleteSize", action: action })
    }
    if (parts[0] === "layouts") {
      config.layouts.forEach(function(layout) {
        var selected = root.windowTarget && config.workspaces[String(root.windowTarget.workspace)] === layout.id
        add("layout:" + layout.id, layout.name, "Current captured workspace · " + layout.kind + " · " + layout.underfill, root.windowTarget && config.enabled ? { type: "windowLayout", id: layout.id } : { type: "none" }, selected ? "✓" : "")
      })
    } else if (parts[0] === "size") {
      var size = config.customSizes.filter(function(item) { return item.id === parts[1] })[0]
      if (!size) return []
      ;["name", "width", "height", "anchor", "offsetX", "offsetY"].forEach(function(field) {
        add(size.id + ":" + field, field === "anchor" ? "Anchor" : field.charAt(0).toUpperCase() + field.slice(1), String(size[field]) + (field === "anchor" ? " · " + WindowModel.ANCHORS.join(", ") : ""), { type: "windowSizeField", size: size, field: field })
      })
      add(size.id + ":delete", "Delete custom size", size.name, { type: "windowDeleteSize", id: size.id })
    } else {
      add("enabled", "Enable window management", "Owned tiling presets and explicit floating commands", { type: "windowEnabled", value: !config.enabled }, config.enabled ? "On" : "Off")
      add("layouts", "Current-workspace tiling preset", !config.enabled ? "Enable window management first" : root.windowTarget ? "Workspace " + root.windowTarget.workspace : "Open OmaCast from a window to capture its workspace", { type: "push", scope: "settings:windows:layouts" })
      config.customSizes.forEach(function(size) { add("size:" + size.id, size.name, size.width + " × " + size.height + " · " + size.anchor, { type: "push", scope: "settings:windows:size:" + size.id }) })
      add("add", "Add custom floating size", "Dimensions accept logical pixels or percentages", { type: "windowAddSize" })
      WindowModel.SHORTCUTS.forEach(function(id) { add("shortcut:" + id, "Shortcut: " + id.replace(/-/g, " "), sources.windowBinds[id] || "Not bound", { type: "windowShortcut", id: id }) })
    }
    return Model.filterSettingsRows(specs, query)
  }

  function settingsRowsFor(scope, query) {
    var parts = scope.split(":")
    var doc = sources.configDoc
    var ctx = {
      config: sources.config,
      binds: sources.binds,
      handBound: Model.handBoundPalette(sources.keybindingRecords, sources.binds),
      barButton: sources.barButton,
      configPath: root.configPath,
      scriptDir: sources.scriptDir
    }
    if (!parts[1]) {
      var rows = Model.settingsRows(doc, ctx, query)
      return rows
    }
    if (parts[1] === "windows") return windowSettingsRows(parts.slice(2), query)
    if (parts[1] === "engine") return Model.settingsChoiceRows(sources.config, doc, query)
    if (parts[1] === "builtins") return Model.settingsBuiltinRows(doc, query)
    if (parts[1] === "scriptDirs") return Model.settingsDirRows(doc, sources.scriptDir, query)
    if (Object.prototype.hasOwnProperty.call(Model.LIST_KINDS, parts[1])) {
      return parts[2] === undefined ? Model.settingsListRows(doc, parts[1], query)
        : Model.settingsEntryRows(doc, parts[1], parseInt(parts[2], 10), query)
    }
    return []
  }

  function rootRows(parsed, usage, now) {
    var query = parsed.rest
    var ctx = { now: now, currency: { enabled: sources.config.currency, rates: sources.rates } }
    var rows = Model.answerRows(query, ctx)
    var zone = Model.timeZoneRequest(query, now)
    if (zone && sources.tzResult.key === zone.key) rows = rows.concat(Model.timeZoneRows(zone, sources.tzResult.output))
    rows = rows.concat(Model.reminderRows(query, now))
    rows = rows.concat(Model.appRows(appEntries(query), query, usage, sources.runningApps, now, Model.hiddenMap(sources.store)))
    rows = rows.concat(Model.windowRows(sources.toplevels, query))
    rows = rows.concat(WindowModel.rows(sources.configDoc.windowManagement, query, root.windowTarget, Model.matchScore).map(Model.row))
    rows = rows.concat(Model.menuRows(sources.menuIndex, query, usage, now, "root"))
    rows = rows.concat(Model.commandCatalogRows(sources.commandCatalog, query, usage, now))
    rows = rows.concat(Model.themeRows(sources.themes, query, usage, now))
    rows = rows.concat(Model.keybindingRows(sources.keybindingRecords, query))
    rows = rows.concat(Model.quicklinkRows(sources.config.quicklinks, query, usage, now))
    rows = rows.concat(Model.snippetRows(sources.config.snippets, query, usage, now))
    rows = rows.concat(Model.commandRows(sources.config.commands, query, usage, now))
    rows = rows.concat(Model.scriptRows(sources.scripts, query, usage, now, sources.inlineOutputs, false, sources.config.scriptForms))
    rows = rows.concat(navigationRows("root", query))
    if (sources.config.inlineAi) rows = rows.concat(agentRows(query, true))
    var optionalScopes = { projects: "projectsEnabled", ssh: "sshEnabled", bookmarks: "bookmarksEnabled", plugins: "pluginPanelsEnabled", agent: "inlineAi" }
    rows = rows.concat(Model.scopeRows(query).filter(function(r) { return !optionalScopes[r.payload.scope] || sources.config[optionalScopes[r.payload.scope]] }))
    rows = rows.concat(Model.configRows(query, root.configPath, sources.scriptDir))
    if (sources.config.ai) rows = rows.concat(Model.aiRows(query, sources.agentName))
    rows = rows.concat(Model.webRows(query, sources.config.searchQuicklink))
    return rows
  }

  // AppSearch has no typo tier and no subsequence walk, so a near miss
  // (`fierfox`, `firfox`) is appended below everything AppSearch found.
  // Nothing else is borrowed: the app ranking stays the launcher's.
  function appEntries(query) {
    if (!sources.appLibrary) return []
    var sorted = sources.appLibrary.sortedEntries(query)
    var q = String(query || "").trim()
    if (!q) return sorted

    var seen = ({})
    for (var i = 0; i < sorted.length; i++) seen[sorted[i].entry.id] = true
    var all = sources.appLibrary.sortedEntries("")
    var extra = []
    for (var a = 0; a < all.length; a++) {
      var entry = all[a].entry
      if (!entry || seen[entry.id]) continue
      var folded = Model.matchScore(q, { name: String(entry.name || "") })
      var score = folded > 0 ? folded : (q.length >= 4 ? Model.nearMissScore(q, String(entry.name || "")) : 0)
      if (score > 0) extra.push({ entry: entry, score: score })
    }
    extra.sort(function(x, y) { return y.score - x.score })
    return sorted.concat(extra)
  }

  // Key → row for every static source, so the pinned and recent sections can
  // resolve the keys the state file holds. Rebuilt per empty-query rebuild;
  // that path runs once per open, not per keystroke.
  function catalogByKey(includeHidden) {
    var now = Date.now()
    var usage = sources.store.usage
    var byKey = ({})
    var sets = [
      Model.appRows(appEntries(""), "", usage, sources.runningApps, now, includeHidden ? ({}) : Model.hiddenMap(sources.store)),
      Model.menuRows(sources.menuIndex, "", usage, now, "catalog"),
      Model.commandCatalogRows(sources.commandCatalog, "", usage, now, true),
      Model.themeRows(sources.themes, "", usage, now, true),
      Model.quicklinkRows(sources.config.quicklinks, "", usage, now),
      Model.snippetRows(sources.config.snippets, "", usage, now),
      Model.commandRows(sources.config.commands, "", usage, now),
      Model.scriptRows(sources.scripts, "", usage, now, sources.inlineOutputs, true, sources.config.scriptForms),
      navigationRows("catalog", "")
    ]

    for (var s = 0; s < sets.length; s++) {
      for (var i = 0; i < sets[s].length; i++) byKey[sets[s][i].key] = sets[s][i]
    }
    return byKey
  }

  function publish(rows) {
    pointerGate.reset()
    var sameKeys = displayModel.count === rows.length
    if (sameKeys) {
      for (var index = 0; index < rows.length; index++) {
        if (displayModel.get(index).key !== rows[index].key) { sameKeys = false; break }
      }
    }
    root.rows = rows
    if (!sameKeys) displayModel.clear()

    for (var i = 0; i < rows.length; i++) {
      var display = {
        key: rows[i].key,
        section: rows[i].section,
        title: rows[i].title,
        subtitle: root.editing && rows[i].key === root.editing.key ? input.text || "(empty)" : rows[i].subtitle,
        icon: rows[i].icon,
        iconSource: iconSourceFor(rows[i]),
        accessory: rows[i].accessory,
        swatch: String(rows[i].payload.swatch || ""),
        rowIndex: i
      }
      if (!sameKeys) displayModel.append(display)
      else {
        var current = displayModel.get(i)
        for (var role in display)
          if (current[role] !== display[role]) displayModel.setProperty(i, role, display[role])
      }
    }

    resolveCursor()
    if (!root.pinnedKey) list.positionViewAtBeginning()
    updatePreview()
  }

  function resolveCursor() {
    if (root.rows.length === 0) {
      root.selectedIndex = -1
      return
    }

    if (root.pinnedKey) {
      for (var i = 0; i < root.rows.length; i++) {
        if (root.rows[i].key === root.pinnedKey) {
          root.selectedIndex = i
          return
        }
      }
    }
    root.selectedIndex = 0
  }

  // Themed icons come from the shell's own index; everything else draws a
  // Nerd Font glyph, which needs no file lookup at all.
  function iconSourceFor(item) {
    if (!sources.appLibrary) return ""
    var payload = item.payload
    if (payload.kind === "app") return sources.appLibrary.iconSource(payload.icon)
    if (payload.kind === "window") {
      var entry = DesktopEntries.heuristicLookup(String(payload.appId || ""))
      if (entry) return sources.appLibrary.iconSource(entry.icon)
      return ""
    }
    if (payload.kind === "clipboard" && payload.entryType === "image") return Util.fileUrl(payload.path)
    return ""
  }

  function selectedRow() {
    if (root.selectedIndex < 0 || root.selectedIndex >= root.rows.length) return null
    return root.rows[root.selectedIndex]
  }

  // ---- Cursor

  function moveSelection(delta) {
    if (root.rows.length === 0) return
    var next = root.selectedIndex + delta
    pointerGate.reset()
    if (next < 0) next = 0
    if (next >= root.rows.length) next = root.rows.length - 1
    root.selectedIndex = next
    root.pinnedKey = root.rows[next].key
    list.positionViewAtIndex(next, ListView.Contain)
  }

  function selectFromPointer(index, item, mouse) {
    if (root.editing) return
    if (typingGuard.running) return
    if (!pointerGate.moved(item, mouse)) return
    if (index < 0 || index >= root.rows.length) return
    root.selectedIndex = index
    root.pinnedKey = root.rows[index].key
  }

  // ---- Activation

  function activate(index, secondary) {
    if (index < 0 || index >= root.rows.length) return
    activateItem(root.rows[index], secondary)
  }

  function activateItem(item, secondary) {
    if (root.editing) return
    if (["providerStatus", "semanticResult", "pickerItem", "agentSend", "agentCancel", "agentCopy"].indexOf(item.payload.kind) >= 0) {
      handleIntegratedAction(item, item.payload, "")
      return
    }
    if (item.payload.kind === "script" && root.scriptValuesKey === item.key && root.scriptFormValues)
      item = Object.assign({}, item, { payload: Object.assign({}, item.payload, { rawArgs: root.scriptFormValues.slice(), needsForm: false }) })
    var resolved = sources.resolveAction(item)
    if (!resolved.ok) { showNotice(resolved.error || "This action is no longer available"); root.confirmKey = ""; return }
    item = resolved.item
    var payload = item.payload
    if ((payload.kind === "keybinding" || payload.kind === "reminder" || payload.kind === "script") && payload.disabled) {
      showNotice("This action is disabled")
      return
    }
    if (payload.kind === "script" && root.scriptValuesKey === item.key) secondary = secondary === true || root.scriptFormSecondary
    var token = String(resolved.token || "") + "|" + root.sessionGeneration + "|" + root.queryGeneration + "|" + root.scope + "|" + (secondary ? "secondary" : "primary")
    if (payload.kind === "script" && sources.config.scriptForms && payload.needsForm && root.scriptValuesKey !== item.key) {
      root.scriptFormRow = item
      root.scriptFormSecondary = secondary === true
      scriptForm.begin(payload.argumentSpecs, payload.rawArgs || [])
      return
    }
    if (payload.kind === "script" && root.scriptValuesKey === item.key && root.scriptFormValues) {
      var built = ScriptModel.buildArgv(payload.path, payload.argumentSpecs || [], root.scriptFormValues)
      if (!built.ok) {
        root.scriptFormRow = item
        root.scriptFormSecondary = secondary === true
        scriptForm.begin(payload.argumentSpecs, root.scriptFormValues)
        root.scriptValuesKey = ""
        showNotice(built.error)
        return
      }
      payload = Object.assign({}, payload, { args: built.args, complete: false, disabled: false })
      item = Object.assign({}, item, { payload: payload })
      token += "|" + JSON.stringify(built.argv)
    }

    if ((item.confirm || payload.needsConfirmation) && (root.confirmKey !== item.key || root.confirmToken !== token)) {
      root.confirmKey = item.key
      root.confirmToken = token
      return
    }
    root.confirmKey = ""
    if (handleIntegratedAction(item, payload, resolved.token)) return

    if (payload.kind === "scope") {
      pushScope(payload.scope)
      return
    }
    // The cheat sheet types a token into the field, so it has to leave its own
    // scope first: a pushed scope wins over every prefix, and `cb ` typed
    // inside Keywords would just filter the cheat sheet.
    if (payload.kind === "help") {
      if (root.scope === "help") popScope()
      input.text = payload.insert
      input.cursorPosition = input.text.length
      rebuild()
      return
    }
    if (payload.kind === "setting") {
      runSetting(item, secondary ? payload.secondaryAction : payload.action)
      return
    }
    if ((payload.kind === "quicklink" || payload.kind === "snippet" || payload.kind === "command" || payload.kind === "script") && payload.complete) {
      input.text = payload.keyword + " "
      input.cursorPosition = input.text.length
      return
    }
    if (payload.kind === "menu" && payload.itemKind === "menu") {
      pushScope("menu:" + payload.id)
      return
    }
    if (payload.kind === "menu" && payload.itemKind === "link") {
      pushScope("menu:" + payload.target)
      return
    }

    // These act and keep the palette open: the user is still looking at the
    // list they changed.
    if (payload.kind === "unhide") {
      sources.toggleHidden(payload.key)
      return
    }
    if (payload.kind === "process") {
      sources.signalProcess(payload.pid, secondary === true, payload.startTime)
      return
    }
    if (payload.kind === "fetchRates") {
      sources.fetchRates(true)
      return
    }
    if (payload.kind === "script" && payload.mode === "inline") {
      recordRowUse(item)
      sources.rerunInline(payload.path)
      return
    }

    recordRowUse(item)
    run(item, payload, secondary === true, resolved.token)
  }

  // Settings stays in the palette; every text field borrows the search input.
  function runSetting(item, action) {
    if (!action || action.type === "none") return
    if (action.type === "windowEnabled") {
      sources.saveWindowConfig(WindowModel.update(sources.configDoc.windowManagement, { type: "enabled", value: action.value }))
      return
    }
    if (action.type === "windowLayout") { windowActions.setWorkspaceLayout(action.id, root.windowTarget); return }
    if (action.type === "windowDeleteSize") {
      if (sources.saveWindowConfig(WindowModel.update(sources.configDoc.windowManagement, { type: "deleteSize", id: action.id }))) popScope()
      return
    }
    if (action.type === "windowAddSize") {
      var id = "size-" + Date.now()
      try {
        if (sources.saveWindowConfig(WindowModel.update(sources.configDoc.windowManagement, { type: "size", value: { id: id, name: "Custom size", width: "50%", height: "50%", anchor: "center", offsetX: 0, offsetY: 0 } }))) pushScope("settings:windows:size:" + id)
      } catch (error) { showNotice(String(error)) }
      return
    }
    if (action.type === "windowSizeField") {
      beginEdit({ key: item.key, label: action.field, value: String(action.size[action.field]),
        commit: function(text) {
          var size = Object.assign({}, action.size)
          size[action.field] = action.field === "offsetX" || action.field === "offsetY" ? (text.trim() ? Number(text) : NaN) : text
          try {
            var value = WindowModel.update(sources.configDoc.windowManagement, { type: "size", value: size })
            return sources.saveWindowConfig(value) ? { ok: true } : { ok: false, error: sources.storageError || "Could not save configuration" }
          } catch (error) { return { ok: false, error: String(error) } }
        } })
      return
    }
    if (action.type === "windowShortcut") {
      beginEdit({ key: item.key, label: action.id + " shortcut", value: sources.windowBinds[action.id] || "", shortcut: true, bindingOwner: "window:" + action.id,
        commit: function(text) {
          var chord = text.trim() ? Model.normalizeChord(text) : ""
          if (text.trim() && !chord) return { ok: false, error: "Use a chord such as SUPER + ALT + LEFT" }
          return sources.saveWindowBind(action.id, chord) ? { ok: true } : { ok: false, error: root.notice || "Could not save window shortcut" }
        } })
      return
    }
    if (action.type === "clear-query-history") { sources.clearQueryLearning(); rebuild(); return }
    root.pinnedKey = item.key
    if (action.type === "push") {
      pushScope(action.scope)
    } else if (action.type === "config") {
      if (!sources.saveConfig(action.op)) return
      if (action.pop) popScope()
      else if (action.pushIndex) pushScope("settings:" + action.op.kind + ":" + (sources.configDoc[action.op.kind].length - 1))
      else rebuild()
    } else if (action.type === "barButton") {
      sources.setBarButton(action.value)
    } else if (action.type === "binds") {
      sources.saveBinds(action.patch)
      rebuild()
    } else if (action.type === "editChord") {
      beginEdit({
        key: item.key, label: "Open palette", value: sources.binds.palette || "ALT + SPACE", shortcut: true, bindingOwner: "palette",
        commit: function(text) {
          var chord = Model.normalizeChord(text)
          if (!chord) return { ok: false, error: "Not a key chord, e.g. ALT + SPACE or SUPER + SHIFT + P" }
          sources.saveBinds({ palette: chord })
          return { ok: true }
        }
      })
    } else if (action.type === "editField") {
      beginEdit({
        key: item.key, label: action.label, value: action.value,
        commit: function(text) {
          var value = Model.validateField(action.kind, action.field, text)
          if (!value.ok) return value
          var saved = sources.saveConfig({ op: "setField", kind: action.kind, index: action.index, field: action.field, value: value.value })
          return saved ? { ok: true } : { ok: false, error: sources.storageError || "Could not save configuration" }
        }
      })
    } else if (action.type === "editDir") {
      beginEdit({
        key: item.key, label: action.index < 0 ? "Add folder" : "Script folder", value: action.value,
        commit: function(text) {
          var path = text.trim()
          if (!path) return { ok: false, error: "Folder path is empty" }
          var saved = sources.saveConfig(action.index < 0 ? { op: "addDir", path: path } : { op: "setDir", index: action.index, path: path })
          return saved ? { ok: true } : { ok: false, error: sources.storageError || "Could not save configuration" }
        }
      })
    }
  }

  function beginEdit(spec) {
    closeActions()
    root.editing = spec
    root.pinnedKey = spec.key
    input.text = spec.value
    input.selectAll()
    rebuild()
  }

  function commitEdit() {
    if (!root.editing || root.shortcutCheckPending) return
    var spec = root.editing, text = input.text
    if (!spec.shortcut || !text.trim()) {
      var result = spec.commit(text)
      if (!result.ok) { showNotice(result.error); return }
      endEdit()
      return
    }
    var generation = root.sessionGeneration
    root.shortcutCheckPending = true
    sources.checkShortcut(text, spec.bindingOwner, function(error) {
      root.shortcutCheckPending = false
      // A cancelled editor or a newly captured chord must never save an old check.
      if (!root.opened || root.editing !== spec || input.text !== text || root.sessionGeneration !== generation) return
      if (error) { showNotice(error); return }
      var result = spec.commit(text)
      if (!result.ok) { showNotice(result.error); return }
      endEdit()
    })
  }

  function cancelEdit() { endEdit() }

  function endEdit() {
    var key = root.editing.key
    root.editing = null
    input.text = ""
    root.pinnedKey = key
    rebuild()
  }

  function captureShortcut(event) {
    event.accepted = true
    if (event.isAutoRepeat) return
    var modifiers = event.modifiers & (Qt.MetaModifier | Qt.ControlModifier | Qt.AltModifier | Qt.ShiftModifier)
    if (!modifiers && (event.key === Qt.Key_Return || event.key === Qt.Key_Enter)) { commitEdit(); return }
    if (!modifiers && event.key === Qt.Key_Escape) { cancelEdit(); return }
    if (!modifiers && event.key === Qt.Key_Backspace) { input.text = ""; return }
    if ([Qt.Key_Meta, Qt.Key_Control, Qt.Key_Alt, Qt.Key_Shift, Qt.Key_AltGr].indexOf(event.key) >= 0) return
    var key = event.key >= Qt.Key_A && event.key <= Qt.Key_Z || event.key >= Qt.Key_0 && event.key <= Qt.Key_9
      ? String.fromCharCode(event.key)
      : event.key >= Qt.Key_F1 && event.key <= Qt.Key_F24 ? "F" + (event.key - Qt.Key_F1 + 1) : root.shortcutKeyNames[event.key]
    if (!key) { showNotice("That key is not supported as a shortcut"); return }
    var parts = []
    if (modifiers & Qt.MetaModifier) parts.push("SUPER")
    if (modifiers & Qt.ControlModifier) parts.push("CTRL")
    if (modifiers & Qt.AltModifier) parts.push("ALT")
    if (modifiers & Qt.ShiftModifier) parts.push("SHIFT")
    parts.push(key)
    input.text = parts.join(" + ")
    root.notice = ""
  }

  function showNotice(text) {
    root.notice = text
    noticeTimer.restart()
  }

  // Everything here closes the palette first and defers the work by a turn:
  // the layer surface holds an exclusive keyboard grab, and a window focused
  // while that grab is live does not get the keyboard.
  function run(item, payload, secondary, expectedToken) {
    if (payload.kind === "windowAction") {
      if (!WindowModel.normalize(sources.configDoc.windowManagement).enabled) { showNotice("Window management is disabled"); return }
      windowActions.run(payload.action, payload.target)
      return
    }
    if (payload.kind === "app") {
      var toplevel = payload.toplevelIndex >= 0 ? sources.toplevelAt(payload.toplevelIndex) : null
      dismiss()
      if (toplevel && !secondary) Qt.callLater(function() { toplevel.activate() })
      else Qt.callLater(function() { if (sources.appLibrary) sources.appLibrary.launch(payload.desktopId, payload.name) })
      return
    }

    if (payload.kind === "window") {
      var target = sources.windowHandle(payload)
      if (!target) { showNotice("This window has closed"); return }
      dismiss()
      Qt.callLater(function() {
        var live = sources.windowHandle(payload)
        if (!live) return
        if (secondary) live.close()
        else live.activate()
      })
      return
    }

    if (payload.kind === "menu") {
      var keepOpen = sources.menuInPlace(payload.id)
      root.pinnedKey = item.key
      if (!keepOpen) root.pendingMenu = { id: payload.id, token: expectedToken, generation: root.sessionGeneration, queryGeneration: root.queryGeneration }
      if (!sources.executeMenu(payload.id, expectedToken, keepOpen)) root.pendingMenu = null
      return
    }

    if (payload.kind === "keybinding") {
      var dispatcher = payload.dispatcher
      var arg = payload.arg
      dismiss()
      Qt.callLater(function() { sources.dispatchBinding(dispatcher, arg) })
      return
    }

    if (payload.kind === "quicklink") {
      dismiss()
      sources.resolveTemplate(payload.url, payload.argument, "url", function(url) { openDestination(url) })
      return
    }

    if (payload.kind === "snippet") {
      dismiss()
      sources.resolveTemplate(payload.text, payload.argument, "text", function(text) {
        if (secondary) Util.execArgv(["wl-copy", "--", text])
        else Qt.callLater(function() { Quickshell.execDetached([root.omarchyPath + "/bin/omarchy-menu-emoji-insert", text]) })
      })
      return
    }

    if (payload.kind === "command") {
      var argv = payload.terminal || secondary
        ? [root.floatingTerminal, commandLine(payload.command, payload.args)]
        : ["bash", "-lc", payload.command + ' "$@"', "bash"].concat(payload.args)
      dismiss()
      Qt.callLater(function() { Quickshell.execDetached(argv) })
      return
    }

    if (payload.kind === "omarchyCommand") {
      var route = payload.route.split(" ")
      dismiss()
      Qt.callLater(function() { Quickshell.execDetached(route) })
      return
    }

    if (payload.kind === "theme") {
      var theme = payload.name
      dismiss()
      Qt.callLater(function() { Quickshell.execDetached(["omarchy", "theme", "set", theme]) })
      return
    }

    if (payload.kind === "reminder") {
      var reminder = ["omarchy", "reminder", String(payload.minutes)].concat(payload.text ? [payload.text] : [])
      dismiss()
      Qt.callLater(function() { Quickshell.execDetached(reminder) })
      return
    }

    if (payload.kind === "script") {
      var scriptArgv = [payload.path].concat(payload.args)
      var checkedArgv = ["bash", "-c", 'test -f "$1" && test -x "$1" && exec "$@"', "bash"].concat(scriptArgv)
      dismiss()
      if (payload.mode === "silent" && !secondary) Qt.callLater(function() { Quickshell.execDetached(checkedArgv) })
      else if (payload.mode === "compact" && !secondary) sources.runCompact(payload.path, payload.args, payload.title)
      else Qt.callLater(function() { Quickshell.execDetached([root.floatingTerminal, checkedArgv.map(Model.shellQuote).join(" ")]) })
      return
    }

    if (payload.kind === "ai") {
      var prompt = payload.prompt
      dismiss()
      Qt.callLater(function() { Quickshell.execDetached(["omarchy", "agent", "prompt", prompt]) })
      return
    }

    if (payload.kind === "scriptsFolder") {
      var folder = payload.path
      dismiss()
      Qt.callLater(function() { Quickshell.execDetached(["bash", "-c", 'mkdir -p "$1" && exec gio open "$1"', "bash", folder]) })
      return
    }

    if (payload.kind === "clipboard") {
      dismiss()
      pasteClipboard(payload, secondary)
      return
    }

    if (payload.kind === "emoji") {
      var emoji = payload.emoji
      dismiss()
      if (secondary) Util.execArgv(["wl-copy", "--", emoji])
      else Qt.callLater(function() { Quickshell.execDetached([root.omarchyPath + "/bin/omarchy-menu-emoji-insert", emoji]) })
      return
    }

    if (payload.kind === "file") {
      dismiss()
      openPath(secondary ? payload.dir : payload.path)
      return
    }

    if (payload.kind === "answer") {
      dismiss()
      Util.execArgv(["wl-copy", "--", payload.copyText])
      return
    }

    if (payload.kind === "url") {
      dismiss()
      openDestination(payload.url)
      return
    }

    if (payload.kind === "web") {
      var link = sources.config.searchQuicklink
      var query = payload.query
      dismiss()
      if (!link) return
      sources.resolveTemplate(link.url, query, "url", function(url) { openDestination(url) })
      return
    }

    // First open creates the file from the shipped example. Paths ride in as
    // positional parameters so nothing in them is re-parsed by the shell.
    if (payload.kind === "config") {
      var script = 'mkdir -p "$(dirname "$1")"; [ -f "$1" ] || cp "$2" "$1"; exec omarchy-launch-config-editor "$1"'
      var args = ["bash", "-lc", script, "bash", root.configPath, root.pluginDir + "omacast.example.json"]
      dismiss()
      Qt.callLater(function() { Quickshell.execDetached(args) })
      return
    }
  }

  function pasteClipboard(payload, copyOnly) {
    var bin = root.omarchyPath + "/bin/"
    if (payload.entryType === "image") {
      var imageArgs = copyOnly
        ? [bin + "omarchy-clipboard-paste-file", "--copy-only", payload.mime, payload.path]
        : [bin + "omarchy-clipboard-paste-file", payload.mime, payload.path]
      Qt.callLater(function() { Quickshell.execDetached(imageArgs) })
      return
    }

    var textArgs = copyOnly
      ? [bin + "omarchy-clipboard-paste-text", "--copy-only", "--history-index", String(payload.historyIndex)]
      : [bin + "omarchy-clipboard-paste-text", "--shift-insert", "--history-index", String(payload.historyIndex)]
    Qt.callLater(function() { Quickshell.execDetached(textArgs) })
  }

  function openDestination(url) {
    if (Model.destinationKind(url) === "web") {
      Quickshell.execDetached([root.omarchyPath + "/bin/omarchy-launch-browser", url])
      return
    }
    openPath(url)
  }

  // gio rather than xdg-open: xdg-open silently does nothing for handlers with
  // Terminal=true. A non-zero exit is worth a log line, so this runs as a
  // Process instead of a detached command.
  function openPath(path) {
    if (openProc.running) return
    openProc.command = ["gio", "open", String(path)]
    openProc.running = true
  }

  // The floating terminal joins its arguments into one bash -c string, so
  // everything handed to it is quoted here rather than passed as argv.
  function commandLine(command, args) {
    var tail = (args || []).map(Model.shellQuote).join(" ")
    return "bash -lc " + Model.shellQuote(command + ' "$@"') + " bash" + (tail ? " " + tail : "")
  }

  function copyAndClose(text) {
    dismiss()
    Util.execArgv(["wl-copy", "--", String(text)])
  }

  // ---- Actions panel

  function openActions() {
    var item = selectedRow()
    if (!item) return
    root.confirmKey = ""
    root.actionRow = item
    root.actionItems = Model.rowActions(item, sources.store, sources.configDoc.windowManagement, WindowModel.catalog(sources.configDoc.windowManagement))
    root.actionIndex = 0
    root.actionsOpen = true
  }

  function closeActions() {
    root.actionsOpen = false
    root.actionRow = null
    root.actionItems = []
    root.actionIndex = 0
  }

  function moveAction(delta) {
    var count = root.actionItems.length
    if (count === 0) return
    root.actionIndex = Math.max(0, Math.min(count - 1, root.actionIndex + delta))
  }

  function performAction(item, id) {
    closeActions()
    if (!item) return
    if (id.indexOf("window:") === 0 && item.payload.kind === "window") {
      if (!WindowModel.normalize(sources.configDoc.windowManagement).enabled) { showNotice("Window management is disabled"); return }
      windowActions.run(id.slice(7), item.payload.target)
      return
    }
    if (id === "primary" || id === "secondary") { activateItem(item, id === "secondary"); return }
    var fresh = sources.resolveAction(item)
    if (!fresh.ok) { showNotice(fresh.error || "This action is no longer available"); return }
    item = fresh.item
    var payload = item.payload
    if (id === "set-alias") {
      beginEdit({ key: item.key, label: "Alias", value: sources.store.aliases[item.key] || "",
        commit: function(text) { return sources.setAlias(item.key, text) } })
      return
    }
    if (id === "remove-alias") { sources.clearAlias(item.key); return }

    if (id === "pin") { sources.togglePin(item.key); return }
    if (id === "reset-ranking") { sources.resetUsage(item.frecencyKey); return }
    if (id === "hide") { sources.toggleHidden(item.key); return }
    if (id === "delete-entry") { sources.deleteClipboardEntry(payload.historyIndex); return }

    if (id === "copy-id") copyAndClose(payload.desktopId)
    else if (id === "copy-combo") copyAndClose(payload.combo)
    else if (id === "copy-path") copyAndClose(payload.path)
    else if (id === "copy-command") copyAndClose(payload.kind === "menu" ? payload.action : (payload.kind === "omarchyCommand" ? payload.route : payload.command))
    else if (id === "copy-expression") copyAndClose(payload.expression + " = " + payload.copyText)
    else if (id === "copy-url") {
      dismiss()
      sources.resolveTemplate(payload.url, payload.argument, "url", function(url) { Util.execArgv(["wl-copy", "--", url]) })
    } else if (id === "terminal-here") {
      // fd rows don't say whether they are folders; ask the disk.
      var target = Model.shellQuote(payload.path)
      dismiss()
      Qt.callLater(function() { Quickshell.execDetached([root.floatingTerminal, "p=" + target + '; [ -d "$p" ] || p=$(dirname -- "$p"); cd -- "$p" && exec "${SHELL:-bash}"']) })
    } else if (id === "reveal") {
      // FileManager1.ShowItems opens the folder with the file selected,
      // which gio cannot do.
      var uri = "['file://" + String(payload.path).replace(/'/g, "%27") + "']"
      dismiss()
      Qt.callLater(function() {
        Quickshell.execDetached(["gdbus", "call", "--session", "--dest", "org.freedesktop.FileManager1", "--object-path", "/org/freedesktop/FileManager1",
          "--method", "org.freedesktop.FileManager1.ShowItems", uri, ""])
      })
    } else if (id === "run-terminal") {
      activateItem(item, true)
    } else if (id === "preview-theme") {
      var name = payload.name
      dismiss()
      Qt.callLater(function() { Quickshell.execDetached([root.floatingTerminal, "omarchy dev theme preview " + Model.shellQuote(name)]) })
    }
  }

  // ---- Section jumps (Ctrl+↑ / Ctrl+↓)

  function jumpSection(direction) {
    if (root.rows.length === 0) return
    var current = Math.max(0, root.selectedIndex)
    var section = root.rows[current].section
    var target = -1

    if (direction > 0) {
      for (var i = current + 1; i < root.rows.length; i++) {
        if (root.rows[i].section !== section) { target = i; break }
      }
    } else {
      var start = current
      while (start > 0 && root.rows[start - 1].section === section) start -= 1
      if (start > 0) {
        target = start - 1
        var previous = root.rows[target].section
        while (target > 0 && root.rows[target - 1].section === previous) target -= 1
      }
    }
    if (target < 0) return
    pointerGate.reset()
    root.selectedIndex = target
    root.pinnedKey = root.rows[target].key
    list.positionViewAtIndex(target, ListView.Contain)
  }

  // ---- Preview
  //
  // Text the row already carries renders at once; a file head or a content
  // match asks Sources for one process, cancelled when the cursor moves on.

  function updatePreview() {
    var item = selectedRow()
    var preview = item && root.previewAllowed && root.opened ? item.payload.preview : null
    if (!preview) {
      root.previewState = null
      sources.cancelPreview()
      return
    }
    var key = item.key + "|" + (preview.term || "")
    if (root.previewState && root.previewState.key === key) return
    if (preview.path && item.payload.kind === "file")
      preview = Object.assign({}, preview, { rootPath: item.payload.preview && item.payload.preview.term ? sources.contentRootPath : sources.fileRootPath })

    if (preview.type === "image" || Model.previewCommand(preview)) {
      root.previewState = { key: key, kind: "process" }
      sources.requestPreview(key, preview)
      return
    }
    sources.cancelPreview()
    root.previewState = { key: key, kind: "text", text: Model.previewText(preview, Date.now()) }
  }

  onOpenedChanged: if (!root.opened) { root.pinnedKey = ""; root.queuedRebuildGeneration = -1 }
  onSelectedIndexChanged: updatePreview()
  onPreviewAllowedChanged: updatePreview()

  WindowActions {
    id: windowActions
    home: root.home
    pluginDir: root.pluginDir
    config: sources.configDoc.windowManagement || ({})
    onConfigurationChanged: function(config) { sources.saveWindowConfig(config) }
    onFinished: function(ok, message) {
      // Keep errors on the current session; an old reply must never reopen a dismissed palette.
      if (root.opened) root.showNotice(ok ? message || "Window action completed" : message || "Window action failed")
    }
  }

  Sources {
    id: sources
    omarchyPath: root.omarchyPath
    home: root.home
    opened: root.opened
    windowController: windowActions
    onCatalogChanged: root.queueRebuild()
  }

  Connections {
    target: sources
    function onNotice(text) { root.showNotice(text) }
    function onPreviewResultChanged() {
      var result = sources.previewResult
      if (root.previewState && result.key === root.previewState.key && result.kind === "image")
        root.previewState = { key: result.key, kind: "image", source: Util.fileUrl(result.path) }
    }
    function onOperationFinished(key, ok, status, message) {
      if (!ok) root.showNotice(message || status)
      root.queueRebuild()
    }
    function onMenuPrepared(id, token) {
      var pending = root.pendingMenu
      root.pendingMenu = null
      if (!pending || !root.opened || pending.id !== id || pending.token !== token
          || pending.generation !== root.sessionGeneration || pending.queryGeneration !== root.queryGeneration) return
      sources.launchPreparedMenu(id, token, function() { root.dismiss() })
    }
    function onTemplateFailed(text) {
      root.showNotice(text)
      // Template actions dismiss the palette before reading the clipboard.
      if (!root.opened) Quickshell.execDetached(["omarchy", "notification", "send", "OmaCast", text])
    }
  }

  Connections {
    target: sources.scriptResults
    function onStatusChanged() { root.queueRebuild() }
    function onRecordsChanged() { root.queueRebuild() }
  }
  Connections {
    target: sources.picker
    function onChanged() { root.queueRebuild() }
    function onFinished() { if (root.opened && root.scope === "picker" && sources.picker.status === "ready") root.dismiss() }
  }
  Connections {
    target: sources.agentAnswers
    function onAnswerChanged() { root.queueRebuild() }
    function onStatusChanged() { root.queueRebuild() }
  }
  Connections {
    target: sources.semanticSearch
    function onSuggestionsChanged() { root.queueRebuild() }
  }
  Timer {
    id: semanticDebounce
    interval: 350
    onTriggered: {
      if (!root.opened || !sources.config.semantic || root.parsedInput().scope !== "root") return
      sources.semanticSearch.search(input.text, root.semanticCandidates())
    }
  }

  Timer {
    id: noticeTimer
    interval: 3000
    onTriggered: root.notice = ""
  }

  ListModel { id: displayModel }

  PointerMoveGate {
    id: pointerGate
    referenceItem: pointerFrame
  }

  // Typing hides the pointer's opinion for a moment: results move under a
  // resting cursor, and a synthetic hover would otherwise yank the selection.
  Timer {
    id: typingGuard
    interval: 400
  }

  Timer {
    id: ctrlTimer
    interval: 400
    onTriggered: root.ctrlHeld = true
  }

  // fd is the only provider that costs a process per keystroke.
  Timer {
    id: fdDebounce
    interval: 160
    onTriggered: {
      var parsed = parsedInput()
      if (parsed.scope !== "files") return
      var request = Model.fileRequest(parsed, root.home, root.fileRoots, root.selectedRoot)
      if (request.error) { root.showNotice(request.error); return }
      sources.searchFiles(request.dir, request.terms, root.fileFilter, request.rootPath)
    }
  }

  // Time zone answers cost one `date` run; wait for the typing to settle.
  Timer {
    id: tzDebounce
    interval: 120
    onTriggered: {
      var parsed = parsedInput()
      if (parsed.scope !== "root") return
      var request = Model.timeZoneRequest(parsed.rest, Date.now())
      if (request) sources.requestTimeZone(request)
    }
  }

  // ripgrep over $HOME is heavier than fd, so it waits a little longer.
  Timer {
    id: contentDebounce
    interval: 250
    onTriggered: {
      var parsed = parsedInput()
      if (parsed.scope !== "content") return
      var request = Model.fileRequest(parsed, root.home, root.fileRoots, root.selectedRoot)
      if (request.error) { root.showNotice(request.error); return }
      sources.searchContent(parsed.rest, request.rootPath)
    }
  }

  Process {
    id: openProc
    onExited: function(exitCode) {
      if (exitCode !== 0) console.warn("omacast: gio open failed with " + exitCode + " for " + openProc.command[2])
    }
  }

  Component.onDestruction: {
    fdDebounce.stop()
    tzDebounce.stop()
    contentDebounce.stop()
    typingGuard.stop()
    ctrlTimer.stop()
    openProc.running = false
  }

  PanelWindow {
    id: panel
    screen: root.targetScreen
    visible: root.opened
    anchors { top: true; bottom: true; left: true; right: true }
    color: "transparent"
    WlrLayershell.namespace: "omarchy-omacast"
    WlrLayershell.layer: WlrLayer.Overlay
    WlrLayershell.keyboardFocus: WlrKeyboardFocus.Exclusive
    exclusionMode: ExclusionMode.Ignore

    ShortcutInhibitor {
      window: panel
      enabled: root.opened && !!root.editing && root.editing.shortcut === true
      onCancelled: {
        if (!root.editing || !root.editing.shortcut) return
        root.cancelEdit()
        root.showNotice("Shortcut capture was cancelled by the compositor")
      }
    }

    // The card sits at a fixed fraction of the screen and grows downward, so
    // rows landing late lengthen the list instead of sliding the field.
    readonly property int cardTop: Math.round(height * 0.18)
    readonly property int cardWidth: Math.min(Style.space(640), width - Style.gapsOut * 2)

    Rectangle {
      anchors.fill: parent
      color: Commons.Color.menu.scrim
    }

    // Screen-fixed frame the pointer gate measures against: a delegate moves
    // under the mouse on every rebuild, the window does not.
    Item {
      id: pointerFrame
      anchors.fill: parent
    }

    MouseArea {
      anchors.fill: parent
      onClicked: root.dismiss()
    }

    BorderSurface {
      id: card
      // Center the complete card as the preview opens; the list keeps its width.
      readonly property int previewSpace: root.previewState !== null ? root.previewWidth + Style.spacing.md : 0
      width: panel.cardWidth + previewSpace
      height: Math.min(content.implicitHeight + card.contentTopInset + card.contentBottomInset, panel.height - panel.cardTop - Style.gapsOut)
      x: Math.max(Style.gapsOut, Math.min(Math.round((panel.width - width) / 2), panel.width - width - Style.gapsOut))
      y: panel.cardTop
      radius: Style.cornerRadius
      color: root.background
      borderSpec: Border.surfaceSpec("menu", "border", Commons.Color.menu.border, Math.max(1, Style.space(2)))
      padding: Style.spacing.panelPadding

      MouseArea { anchors.fill: parent; onClicked: {} }

      Column {
        id: content
        anchors.left: parent.left
        anchors.top: parent.top
        anchors.bottom: parent.bottom
        anchors.topMargin: card.contentTopInset
        anchors.bottomMargin: card.contentBottomInset
        anchors.leftMargin: card.contentLeftInset
        width: panel.cardWidth - card.contentLeftInset - card.contentRightInset
        spacing: Style.spacing.sm

        // ---- Header: leading glyph, scope chip, live field

        Item {
          id: header
          width: parent.width
          height: root.headerHeight

          Text {
            id: leadingGlyph
            textFormat: Text.PlainText
            anchors.left: parent.left
            anchors.verticalCenter: parent.verticalCenter
            text: root.scope === "root" ? "" : ""  // nf-fa-search / nf-fa-arrow_left
            font.family: root.glyphFamily
            font.pixelSize: Style.font.icon
            color: root.faintForeground
          }

          Rectangle {
            id: scopeChip
            anchors.left: leadingGlyph.right
            anchors.leftMargin: Style.spacing.sm
            anchors.verticalCenter: parent.verticalCenter
            visible: root.scope !== "root"
            width: visible ? scopeLabel.implicitWidth + Style.spacing.md : 0
            height: Style.space(24)
            radius: Style.space(6)
            color: Util.alpha(root.foreground, 0.12)

            Text {
              id: scopeLabel
              textFormat: Text.PlainText
              anchors.centerIn: parent
              text: root.scopeChipText()
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              color: root.foreground
            }
          }

          TextInput {
            id: input
            anchors.left: scopeChip.visible ? scopeChip.right : leadingGlyph.right
            anchors.leftMargin: Style.spacing.md
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
            maximumLength: root.editing ? 2147483647 : 512
            font.family: root.fontFamily
            font.pixelSize: Style.font.title
            color: root.foreground
            selectionColor: Util.alpha(root.foreground, 0.3)
            selectedTextColor: root.foreground
            selectByMouse: true
            clip: true
            focus: true
            readOnly: !!root.editing && root.editing.shortcut === true

            Keys.priority: Keys.BeforeItem
            Keys.onPressed: function(event) { root.handleKey(event) }
            Keys.onReleased: function(event) {
              if (event.key === Qt.Key_Control) {
                ctrlTimer.stop()
                root.ctrlHeld = false
              }
            }

            onTextChanged: {
              root.queryGeneration++
              root.confirmKey = ""
              root.scriptValuesKey = ""
              root.scriptFormValues = null
              sources.semanticSearch.cancel()
              if (!root.editing) root.pinnedKey = ""
              root.closeActions()
              typingGuard.restart()
              root.rebuild()
              if (root.editing) return
              var typedScope = root.parsedInput().scope
              if (typedScope === "files") fdDebounce.restart()
              else if (typedScope === "content") contentDebounce.restart()
              else if (typedScope === "root") tzDebounce.restart()
              if (sources.config.semantic) semanticDebounce.restart()
            }

            Text {
              textFormat: Text.PlainText
              anchors.fill: parent
              verticalAlignment: Text.AlignVCenter
              visible: input.text.length === 0
              text: root.editing ? root.editing.shortcut ? "Press shortcut · Backspace clears" : "" : Model.scopePlaceholder(root.scope)
              font.family: root.fontFamily
              font.pixelSize: Style.font.title
              color: root.faintForeground
              elide: Text.ElideRight
            }
          }
        }
        ScriptForm {
          id: scriptForm
          visible: root.scriptFormRow !== null
          width: parent.width
          height: visible ? implicitHeight : 0
          foreground: root.foreground
          fontFamily: root.fontFamily
          onSubmitted: function(values) {
            var item = root.scriptFormRow
            root.scriptFormRow = null
            // A QML signal may wrap its list as a sequence, not a JS Array.
            root.scriptFormValues = Array.prototype.slice.call(values)
            root.scriptValuesKey = item.key
            input.forceActiveFocus()
            root.activateItem(item, root.scriptFormSecondary)
          }
          onCancelled: {
            root.scriptFormRow = null
            root.scriptFormValues = null
            root.scriptValuesKey = ""
            input.forceActiveFocus()
          }
        }
        Text {
          visible: root.lastEffectiveScope === "agent" && !!sources.agentAnswers.answer
          width: parent.width
          height: visible ? Math.min(implicitHeight, root.maxListHeight) : 0
          textFormat: Text.PlainText
          text: sources.agentAnswers.answer
          color: root.foreground
          font.family: root.fontFamily
          wrapMode: Text.Wrap
          clip: true
        }
        Button {
          visible: root.filesActive || root.lastEffectiveScope === "content"
          width: parent.width
          height: visible ? Style.space(30) : 0
          text: "Root: " + Model.fileRequest(root.parsedInput(), root.home, root.fileRoots, root.selectedRoot).rootName + "  ·  Ctrl+R"
          foreground: root.foreground
          onClicked: root.cycleRoot(1)
        }

        PanelSeparator {
          width: parent.width
          foreground: root.foreground
        }

        Row {
          id: fileControls
          visible: root.filesActive
          width: parent.width
          height: visible ? Style.space(32) : 0
          spacing: Style.spacing.sm

          Button {
            width: (fileControls.width - fileControls.spacing * 2) / 3
            height: fileControls.height
            text: {
              for (var i = 0; i < Model.FILE_FILTERS.length; i++) {
                if (Model.FILE_FILTERS[i].id === root.fileFilter) return Model.FILE_FILTERS[i].label + "  Ctrl+F"
              }
              return ""
            }
            foreground: root.foreground
            fontFamily: root.fontFamily
            fontSize: Style.font.caption
            tooltipText: "Cycle file type. Shift+Ctrl+F or right-click goes back."
            Accessible.role: Accessible.Button
            Accessible.name: "File type: " + root.fileFilter
            Accessible.onPressAction: root.cycleFileFilter(1)
            onClicked: root.cycleFileFilter(1)
            onRightClicked: root.cycleFileFilter(-1)
          }

          Button {
            width: (fileControls.width - fileControls.spacing * 2) / 3
            height: fileControls.height
            text: {
              for (var i = 0; i < Model.FILE_SORTS.length; i++) {
                if (Model.FILE_SORTS[i].id === root.fileSort) return Model.FILE_SORTS[i].label + "  Ctrl+S"
              }
              return ""
            }
            foreground: root.foreground
            fontFamily: root.fontFamily
            fontSize: Style.font.caption
            tooltipText: "Cycle relevance, date and name sorting. Shift+Ctrl+S or right-click goes back."
            Accessible.role: Accessible.Button
            Accessible.name: "File sort: " + root.fileSort
            Accessible.onPressAction: root.cycleFileSort(1)
            onClicked: root.cycleFileSort(1)
            onRightClicked: root.cycleFileSort(-1)
          }

          Button {
            width: (fileControls.width - fileControls.spacing * 2) / 3
            height: fileControls.height
            text: "Limit " + root.fileLimit + "  Ctrl+L"
            foreground: root.foreground
            fontFamily: root.fontFamily
            fontSize: Style.font.caption
            tooltipText: "Cycle 20, 40, 60, 100 and 200 results. Shift+Ctrl+L or right-click goes back."
            Accessible.role: Accessible.Button
            Accessible.name: "File result limit: " + root.fileLimit
            Accessible.onPressAction: root.cycleFileLimit(1)
            onClicked: root.cycleFileLimit(1)
            onRightClicked: root.cycleFileLimit(-1)
          }
        }

        // ---- Results

        Item {
          width: parent.width
          visible: root.scriptFormRow === null
          height: displayModel.count > 0 ? Math.min(list.contentHeight, root.maxListHeight) : root.rowHeight

          ListView {
            id: list
            anchors.fill: parent
            model: displayModel
            clip: true
            visible: displayModel.count > 0
            cacheBuffer: 0
            highlightMoveDuration: 0
            boundsBehavior: Flickable.StopAtBounds

            section.property: "section"
            section.criteria: ViewSection.FullString
            section.delegate: Item {
              id: sectionRow
              required property string section
              width: list.width
              height: Style.space(22)

              Text {
                textFormat: Text.PlainText
                anchors.left: parent.left
                anchors.bottom: parent.bottom
                anchors.bottomMargin: Style.space(2)
                text: Model.sectionTitle(sectionRow.section)
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
                color: root.faintForeground
              }
            }

            delegate: Item {
              id: rowItem
              required property int index
              required property string title
              required property string subtitle
              required property string icon
              required property string iconSource
              required property string accessory
              required property string swatch

              // Holding Ctrl for a moment swaps the accessory for the row's
              // Ctrl+N keycap.
              readonly property bool showKeycap: root.ctrlHeld && index < 9

              readonly property bool current: index === root.selectedIndex
              width: list.width
              height: root.rowHeight

              Rectangle {
                anchors.fill: parent
                anchors.rightMargin: Style.space(2)
                radius: Style.space(6)
                color: rowItem.current ? root.selectedBackground : "transparent"
                border.width: rowItem.current ? 1 : 0
                border.color: root.selectedBorder
              }

              Item {
                id: iconSlot
                anchors.left: parent.left
                anchors.leftMargin: Style.spacing.sm
                anchors.verticalCenter: parent.verticalCenter
                width: root.iconSlot
                height: root.iconSlot

                Image {
                  anchors.fill: parent
                  visible: rowItem.iconSource.length > 0
                  source: rowItem.iconSource
                  asynchronous: true
                  fillMode: Image.PreserveAspectFit
                  sourceSize.width: root.iconSlot * 2
                  sourceSize.height: root.iconSlot * 2
                }

                OpticalGlyph {
                  anchors.fill: parent
                  visible: rowItem.iconSource.length === 0 && rowItem.icon.length > 0
                  text: rowItem.icon
                  fontFamily: root.glyphFamily
                  fontSize: Style.font.icon
                  color: rowItem.current ? root.selectedText : root.foreground
                }
              }

              Text {
                id: rowTitle
                textFormat: Text.PlainText
                anchors.left: iconSlot.right
                anchors.leftMargin: Style.spacing.md
                anchors.right: rowSubtitle.left
                anchors.rightMargin: Style.spacing.sm
                anchors.verticalCenter: parent.verticalCenter
                text: rowItem.title
                font.family: root.fontFamily
                font.pixelSize: Style.font.body
                color: rowItem.current ? root.selectedText : root.foreground
                elide: Text.ElideRight
              }

              Text {
                id: rowSubtitle
                textFormat: Text.PlainText
                anchors.right: accessorySlot.left
                anchors.rightMargin: Style.spacing.md
                anchors.verticalCenter: parent.verticalCenter
                // Half the row at most: the title is what the user is reading,
                // the subtitle only says where the row came from.
                width: Math.min(implicitWidth, rowItem.width * 0.5)
                horizontalAlignment: Text.AlignRight
                text: rowItem.subtitle
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
                color: root.faintForeground
                elide: Text.ElideLeft
              }

              Item {
                id: accessorySlot
                anchors.right: parent.right
                anchors.rightMargin: Style.spacing.md
                anchors.verticalCenter: parent.verticalCenter
                width: rowItem.showKeycap ? keycap.implicitWidth : (rowItem.swatch ? swatchBox.width : rowAccessory.implicitWidth)
                height: parent.height

                Text {
                  id: rowAccessory
                  textFormat: Text.PlainText
                  anchors.right: parent.right
                  anchors.verticalCenter: parent.verticalCenter
                  visible: !rowItem.showKeycap && !rowItem.swatch
                  text: rowItem.accessory
                  font.family: root.glyphFamily
                  font.pixelSize: Style.font.caption
                  color: root.faintForeground
                }

                // The colour inspector's swatch; the value is the answer's
                // own hex, not a theme colour.
                Rectangle {
                  id: swatchBox
                  anchors.right: parent.right
                  anchors.verticalCenter: parent.verticalCenter
                  visible: !rowItem.showKeycap && rowItem.swatch.length > 0
                  width: Style.space(18)
                  height: Style.space(18)
                  color: rowItem.swatch.length > 0 ? rowItem.swatch : "transparent"
                  border.width: 1
                  border.color: root.selectedBorder
                }

                Keycap {
                  id: keycap
                  anchors.right: parent.right
                  anchors.verticalCenter: parent.verticalCenter
                  visible: rowItem.showKeycap
                  text: "⌃" + (rowItem.index + 1)
                  borderColor: root.selectedBorder
                  textColor: root.faintForeground
                  fontFamily: root.glyphFamily
                }
              }

              MouseArea {
                anchors.fill: parent
                hoverEnabled: true
                acceptedButtons: Qt.LeftButton
                onPositionChanged: function(mouse) { root.selectFromPointer(rowItem.index, rowItem, mouse) }
                onClicked: function(mouse) { root.activate(rowItem.index, (mouse.modifiers & Qt.ControlModifier) !== 0) }
              }
            }
          }

          Text {
            textFormat: Text.PlainText
            anchors.centerIn: parent
            visible: displayModel.count === 0
            text: root.emptyHint()
            font.family: root.fontFamily
            font.pixelSize: Style.font.body
            color: root.faintForeground
          }
        }

        PanelSeparator {
          width: parent.width
          foreground: root.foreground
        }

        // ---- Footer: result count on the left, the selected row's verbs on
        // the right, and the confirm warning in place of both.

        Item {
          width: parent.width
          height: root.footerHeight

          Text {
            textFormat: Text.PlainText
            anchors.left: parent.left
            anchors.right: footerVerbs.left
            anchors.rightMargin: Style.spacing.md
            elide: Text.ElideRight
            anchors.verticalCenter: parent.verticalCenter
            visible: root.confirmKey === "" && root.footerNotice === ""
            text: root.filesActive
              ? (sources.fileSearching ? "Searching…" : root.rows.length + " of " + root.fileMatchCount + " files" + (sources.filePaths.length >= Model.FILE_CANDIDATE_LIMIT ? " (scan cap)" : ""))
              : (root.rows.length === 1 ? "1 result" : root.rows.length + " results")
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            color: root.faintForeground
          }

          Text {
            textFormat: Text.PlainText
            anchors.left: parent.left
            anchors.right: footerVerbs.left
            anchors.rightMargin: Style.spacing.md
            elide: Text.ElideRight
            anchors.verticalCenter: parent.verticalCenter
            visible: root.footerNotice !== ""
            text: root.footerNotice
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            color: Commons.Color.urgent
          }

          Text {
            id: footerVerbs
            textFormat: Text.PlainText
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
            visible: root.confirmKey === "" && root.selectedRow() !== null
            text: {
              if (root.editing) return root.shortcutCheckPending ? "Checking shortcut…" : root.editing.shortcut ? "Press shortcut   Save  ↵   Clear  ⌫   Cancel  Esc" : "Save  ↵     Cancel  Esc"
              var item = root.selectedRow()
              if (!item || !item.primaryLabel) return ""
              var primary = item.primaryLabel + "  ↵"
              var verbs = item.secondaryLabel ? primary + "     " + item.secondaryLabel + "  Ctrl+↵" : primary
              return verbs + "     Actions  Ctrl+K"
            }
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            color: root.faintForeground
          }
        }
      }

      // ---- Preview pane: beside the list, never over it

      Item {
        id: previewPane
        visible: root.previewState !== null
        x: content.x + content.width + Style.spacing.md
        y: content.y
        width: root.previewWidth
        height: content.height

        Rectangle {
          anchors.left: parent.left
          anchors.top: parent.top
          anchors.bottom: parent.bottom
          width: 1
          color: Util.alpha(root.foreground, 0.15)
        }

        Image {
          anchors.fill: parent
          anchors.leftMargin: Style.spacing.md
          visible: root.previewState !== null && root.previewState.kind === "image"
          source: visible ? root.previewState.source : ""
          asynchronous: true
          fillMode: Image.PreserveAspectFit
          sourceSize.width: 512
        }

        Text {
          textFormat: Text.PlainText
          anchors.fill: parent
          anchors.leftMargin: Style.spacing.md
          visible: root.previewState !== null && root.previewState.kind !== "image"
          text: root.previewText
          font.family: root.glyphFamily
          font.pixelSize: Style.font.caption
          color: root.foreground
          wrapMode: Text.WrapAnywhere
          clip: true
        }
      }

      // ---- Actions panel (Ctrl+K): above the footer, right-aligned to the list

      Rectangle {
        id: actionsPanel
        visible: root.actionsOpen
        width: Style.space(300)
        height: actionsColumn.implicitHeight + Style.spacing.sm * 2
        x: content.x + content.width - width
        y: content.y + content.height - root.footerHeight - height - Style.spacing.sm
        radius: 0
        color: root.background
        border.width: 1
        border.color: root.selectedBorder

        MouseArea { anchors.fill: parent; onClicked: {} }

        Column {
          id: actionsColumn
          anchors.left: parent.left
          anchors.right: parent.right
          anchors.top: parent.top
          anchors.margins: Style.spacing.sm

          Repeater {
            model: root.actionItems

            delegate: Item {
              id: actionRowItem
              required property var modelData
              required property int index
              readonly property bool current: index === root.actionIndex
              width: actionsColumn.width
              height: Style.space(32)

              Rectangle {
                anchors.fill: parent
                radius: 0
                color: actionRowItem.current ? root.selectedBackground : "transparent"
                border.width: actionRowItem.current ? 1 : 0
                border.color: root.selectedBorder
              }

              Text {
                textFormat: Text.PlainText
                anchors.left: parent.left
                anchors.leftMargin: Style.spacing.md
                anchors.right: actionKeycap.left
                anchors.rightMargin: Style.spacing.sm
                anchors.verticalCenter: parent.verticalCenter
                text: actionRowItem.modelData.label
                font.family: root.fontFamily
                font.pixelSize: Style.font.body
                color: actionRowItem.current ? root.selectedText : root.foreground
                elide: Text.ElideRight
              }

              Keycap {
                id: actionKeycap
                anchors.right: parent.right
                anchors.rightMargin: Style.spacing.md
                anchors.verticalCenter: parent.verticalCenter
                visible: actionRowItem.modelData.shortcut.length > 0
                text: actionRowItem.modelData.shortcut
                borderColor: root.selectedBorder
                textColor: root.faintForeground
                fontFamily: root.glyphFamily
              }

              MouseArea {
                anchors.fill: parent
                hoverEnabled: true
                onEntered: root.actionIndex = actionRowItem.index
                onClicked: root.performAction(root.actionRow, actionRowItem.modelData.id)
              }
            }
          }
        }
      }
    }
  }

  // ---- Keys
  //
  // One handler on the field with BeforeItem priority: navigation and verbs
  // are taken here, every other key falls through and edits the text.

  function handleKey(event) {
    var control = (event.modifiers & Qt.ControlModifier) !== 0
    var shift = (event.modifiers & Qt.ShiftModifier) !== 0
    if (input.inputMethodComposing && event.key !== Qt.Key_Escape) return
    if (root.editing && root.editing.shortcut) { captureShortcut(event); return }
    if (control && event.key === Qt.Key_R && (root.filesActive || root.lastEffectiveScope === "content")) {
      cycleRoot(shift ? -1 : 1)
      event.accepted = true
      return
    }

    if (event.key === Qt.Key_Control) {
      // A held key repeats; restarting on every repeat would keep the badge
      // timer from ever firing.
      if (!event.isAutoRepeat) ctrlTimer.restart()
      return
    }

    if (root.editing) {
      if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter) commitEdit()
      else if (event.key === Qt.Key_Escape) cancelEdit()
      else if ([Qt.Key_Tab, Qt.Key_Backtab, Qt.Key_Up, Qt.Key_Down, Qt.Key_PageUp, Qt.Key_PageDown].indexOf(event.key) >= 0
        || (control && ([Qt.Key_K, Qt.Key_N, Qt.Key_P, Qt.Key_U, Qt.Key_Period].indexOf(event.key) >= 0
          || (event.key >= Qt.Key_1 && event.key <= Qt.Key_9)))) {
        // Keep navigation and palette commands out of the borrowed editor.
      } else return
      event.accepted = true
      return
    }

    // The actions panel takes navigation, Enter and Esc while it is open.
    // Anything else closes it and falls through, so typing still types.
    if (root.actionsOpen) {
      if (event.key === Qt.Key_Down || (control && event.key === Qt.Key_N)) moveAction(1)
      else if (event.key === Qt.Key_Up || (control && event.key === Qt.Key_P)) moveAction(-1)
      else if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter) {
        var chosen = root.actionItems[root.actionIndex]
        if (chosen) performAction(root.actionRow, chosen.id)
      } else if (event.key === Qt.Key_Escape || (control && event.key === Qt.Key_K)) closeActions()
      else {
        closeActions()
        if (event.key !== Qt.Key_Tab && event.key !== Qt.Key_Backtab) return
      }
      event.accepted = true
      return
    }

    if (root.filesActive && control && [Qt.Key_F, Qt.Key_S, Qt.Key_L].indexOf(event.key) >= 0) {
      var direction = shift ? -1 : 1
      if (event.key === Qt.Key_F) cycleFileFilter(direction)
      else if (event.key === Qt.Key_S) cycleFileSort(direction)
      else cycleFileLimit(direction)
      event.accepted = true
      return
    }

    if (control && event.key === Qt.Key_K) {
      openActions()
      event.accepted = true
    } else if (control && (event.key === Qt.Key_Down || event.key === Qt.Key_Up)) {
      jumpSection(event.key === Qt.Key_Down ? 1 : -1)
      event.accepted = true
    } else if (event.key === Qt.Key_Down || (control && event.key === Qt.Key_N)) {
      moveSelection(1)
      event.accepted = true
    } else if (event.key === Qt.Key_Up || (control && event.key === Qt.Key_P)) {
      // ↑ on the first row of an empty field recalls the last query.
      if (input.text.length === 0 && root.selectedIndex <= 0 && root.scopeStack.length === 0 && sources.store.lastQuery) {
        input.text = sources.store.lastQuery
        input.cursorPosition = input.text.length
      } else {
        moveSelection(-1)
      }
      event.accepted = true
    } else if (event.key === Qt.Key_PageDown) {
      moveSelection(6)
      event.accepted = true
    } else if (event.key === Qt.Key_PageUp) {
      moveSelection(-6)
      event.accepted = true
    } else if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter) {
      activate(root.selectedIndex, control || shift)
      event.accepted = true
    } else if (event.key === Qt.Key_Backtab || (event.key === Qt.Key_Tab && shift)) {
      // Swallowed on purpose. Left unhandled, Qt would move focus backwards
      // out of the field, and the palette has nowhere else for focus to go.
      event.accepted = true
    } else if (event.key === Qt.Key_Tab) {
      completeSelection()
      event.accepted = true
    } else if (event.key === Qt.Key_Escape) {
      if (root.scope === "picker") { sources.picker.cancel(); dismiss() }
      else if (root.confirmKey) root.confirmKey = ""
      else if (input.text.length > 0) input.text = ""
      else if (root.scopeStack.length > 0) popScope()
      else dismiss()
      event.accepted = true
    } else if (event.key === Qt.Key_Backspace && input.text.length === 0 && root.scopeStack.length > 0) {
      popScope()
      event.accepted = true
    } else if (control && event.key === Qt.Key_U) {
      input.text = ""
      event.accepted = true
    } else if (control && event.key === Qt.Key_Period) {
      pinSelection()
      event.accepted = true
    } else if (control && event.key >= Qt.Key_1 && event.key <= Qt.Key_9) {
      activate(event.key - Qt.Key_1, false)
      event.accepted = true
    }
  }

  function emptyHint() {
    var parsed = parsedInput()
    if (parsed.scope === "content" && parsed.rest.length < 3) return "Type at least three characters"
    if (parsed.scope === "files" && sources.fileSearching) return "Searching…"
    return input.text.length > 0 ? "No results" : "Type to search"
  }

  function completeSelection() {
    var item = selectedRow()
    if (!item) return
    if (item.payload.kind === "setting") return

    if (item.payload.kind === "scope") {
      pushScope(item.payload.scope)
      return
    }
    if (item.keyword) {
      input.text = item.keyword + " "
      input.cursorPosition = input.text.length
      return
    }
    if (item.payload.kind === "app") {
      input.text = item.title
      input.cursorPosition = input.text.length
    }
  }

  function pinSelection() {
    var item = selectedRow()
    if (!item || !item.pinnable) return
    sources.togglePin(item.key)
    rebuild()
  }
}
