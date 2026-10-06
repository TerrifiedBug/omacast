import QtQuick
import Quickshell
import Quickshell.Hyprland
import Quickshell.Io
import Quickshell.Wayland
import qs.Commons
import qs.Ui
import "Model.js" as Model
import "vendor/MenuModel.js" as MenuModel

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
  property bool ctrlHeld: false
  property var scopeStack: []
  property string lastEffectiveScope: "root"
  // Ctrl+K: the selected row's actions, captured when the panel opens so a
  // late landing cannot swap them under the user.
  property bool actionsOpen: false
  property var actionRow: null
  property var actionItems: []
  property int actionIndex: 0
  // What the preview pane shows for the selected row, or null to hide it.
  property var previewState: null

  property var editing: null
  property string notice: ""

  readonly property string manifestId: manifest && manifest.id ? manifest.id : "io.github.terrifiedbug.omacast"
  readonly property string scope: scopeStack.length > 0 ? scopeStack[scopeStack.length - 1].scope : "root"
  readonly property string configPath: root.home + "/.config/omarchy/omacast.json"
  // Where this plugin was installed, so the Config row can seed the file from
  // the example shipped beside it.
  readonly property string pluginDir: String(Qt.resolvedUrl(".")).replace(/^file:\/\//, "")

  readonly property color background: Color.menu.background
  readonly property color foreground: Color.menu.text
  readonly property color faintForeground: Qt.darker(Color.menu.text, 1.6)
  readonly property color selectedBackground: Color.menu.selectedBackground
  readonly property color selectedText: Color.menu.selectedText
  readonly property color selectedBorder: Color.menu.selectedBorder
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
    root.opened = true
    sources.onOpen()
    typingGuard.restart()
    pointerGate.reset()
    rebuild()
    Qt.callLater(function() { input.forceActiveFocus() })
  }

  function close() {
    root.editing = null
    // ↑ in an empty field brings this back next time. A pushed scope's query
    // only means something inside that scope, so it is not kept.
    if (root.opened && root.scopeStack.length === 0) sources.rememberQuery(input.text)
    root.opened = false
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
    if (root.opened) dismiss()
    else open("{}")
  }

  // ---- Dev/test IPC: `omarchy-shell shell call <id> setQuery '12*7+3'`

  function setQuery(arg): string {
    input.text = String(arg === undefined || arg === null ? "" : arg)
    rebuild()
    return "ok"
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
      binds: sources.binds,
      configDoc: sources.configDoc,
      barButton: sources.barButton,
      actions: selected ? Model.rowActions(selected, sources.store).map(function(a) { return a.id + ":" + a.label }) : [],
      preview: root.previewState ? { kind: root.previewState.kind, text: root.previewText.slice(0, 400), source: root.previewState.source || "" } : null,
      cardWidth: card.width,
      scripts: sources.scripts.length,
      rows: out
    })
  }

  // `select 3` moves the cursor; `runAction copy-path` runs one of the
  // selected row's Ctrl+K actions by id.
  function select(arg): string {
    var index = parseInt(String(arg), 10)
    if (!(index >= 0 && index < root.rows.length)) return "out of range"
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
    sources.wantProcesses(next === "kill")
    if (next === "clipboard") sources.loadClipboard()
    else if (next === "emoji") sources.wantEmojis()
    else if (next === "files") { sources.clearFiles(); fdDebounce.restart() }
    else if (next === "content") contentDebounce.restart()
  }

  function scopeChipText() {
    if (root.editing) return root.editing.label
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

  function rebuild() {
    var parsed = Model.parseQuery(input.text, root.scope)
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
    } else if (parsed.scope === "clipboard") {
      rows = Model.clipboardRows(sources.clipboardEntries, parsed.rest)
    } else if (parsed.scope === "emoji") {
      rows = Model.emojiRows(sources.emojis, parsed.rest)
    } else if (parsed.scope === "files") {
      var request = Model.fileRequest(parsed, root.home)
      rows = Model.fileRows(sources.filePaths, request.terms.length > 0 ? request.terms[0] : "", root.home)
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

    publish(Model.applyCaps(Model.sortRows(rows), caps))
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
    if (!parts[1]) return Model.settingsRows(doc, ctx, query)
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
    rows = rows.concat(Model.menuRows(sources.menuIndex, query, usage, now, "root"))
    rows = rows.concat(Model.commandCatalogRows(sources.commandCatalog, query, usage, now))
    rows = rows.concat(Model.themeRows(sources.themes, query, usage, now))
    rows = rows.concat(Model.keybindingRows(sources.keybindingRecords, query))
    rows = rows.concat(Model.quicklinkRows(sources.config.quicklinks, query, usage, now))
    rows = rows.concat(Model.snippetRows(sources.config.snippets, query, usage, now))
    rows = rows.concat(Model.commandRows(sources.config.commands, query, usage, now))
    rows = rows.concat(Model.scriptRows(sources.scripts, query, usage, now, sources.inlineOutputs))
    rows = rows.concat(Model.scopeRows(query))
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
    if (q.length < 4) return sorted

    var seen = ({})
    for (var i = 0; i < sorted.length; i++) seen[sorted[i].entry.id] = true
    var all = sources.appLibrary.sortedEntries("")
    var extra = []
    for (var a = 0; a < all.length; a++) {
      var entry = all[a].entry
      if (!entry || seen[entry.id]) continue
      var score = Model.nearMissScore(q, String(entry.name || ""))
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
      Model.scriptRows(sources.scripts, "", usage, now, sources.inlineOutputs, true)
    ]

    for (var s = 0; s < sets.length; s++) {
      for (var i = 0; i < sets[s].length; i++) byKey[sets[s][i].key] = sets[s][i]
    }
    return byKey
  }

  function publish(rows) {
    root.rows = rows
    displayModel.clear()

    for (var i = 0; i < rows.length; i++) {
      displayModel.append({
        section: rows[i].section,
        title: rows[i].title,
        subtitle: root.editing && rows[i].key === root.editing.key ? input.text || "(empty)" : rows[i].subtitle,
        icon: rows[i].icon,
        iconSource: iconSourceFor(rows[i]),
        accessory: rows[i].accessory,
        swatch: String(rows[i].payload.swatch || ""),
        rowIndex: i
      })
    }

    resolveCursor()
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
    var payload = item.payload
    if ((payload.kind === "keybinding" || payload.kind === "reminder" || payload.kind === "script") && payload.disabled) return

    if (item.confirm && root.confirmKey !== item.key) {
      root.confirmKey = item.key
      return
    }
    root.confirmKey = ""

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
      sources.signalProcess(payload.pid, secondary === true)
      return
    }
    if (payload.kind === "fetchRates") {
      sources.fetchRates(true)
      return
    }
    if (payload.kind === "script" && payload.mode === "inline") {
      if (item.frecencyKey) sources.recordUse(item.frecencyKey)
      sources.rerunInline(payload.path)
      return
    }

    if (item.frecencyKey) sources.recordUse(item.frecencyKey)
    run(item, payload, secondary === true)
  }

  // Settings stays in the palette; every text field borrows the search input.
  function runSetting(item, action) {
    if (!action || action.type === "none") return
    root.pinnedKey = item.key
    if (action.type === "push") {
      pushScope(action.scope)
    } else if (action.type === "config") {
      sources.saveConfig(action.op)
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
        key: item.key, label: "Open palette", value: sources.binds.palette || "ALT + SPACE",
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
          sources.saveConfig({ op: "setField", kind: action.kind, index: action.index, field: action.field, value: value.value })
          return { ok: true }
        }
      })
    } else if (action.type === "editDir") {
      beginEdit({
        key: item.key, label: action.index < 0 ? "Add folder" : "Script folder", value: action.value,
        commit: function(text) {
          var path = text.trim()
          if (!path) return { ok: false, error: "Folder path is empty" }
          sources.saveConfig(action.index < 0 ? { op: "addDir", path: path } : { op: "setDir", index: action.index, path: path })
          return { ok: true }
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
    var result = root.editing.commit(input.text)
    if (!result.ok) { showNotice(result.error); return }
    endEdit()
  }

  function cancelEdit() { endEdit() }

  function endEdit() {
    var key = root.editing.key
    root.editing = null
    input.text = ""
    root.pinnedKey = key
    rebuild()
  }

  function showNotice(text) {
    root.notice = text
    noticeTimer.restart()
  }

  // Everything here closes the palette first and defers the work by a turn:
  // the layer surface holds an exclusive keyboard grab, and a window focused
  // while that grab is live does not get the keyboard.
  function run(item, payload, secondary) {
    if (payload.kind === "app") {
      var toplevel = payload.toplevelIndex >= 0 ? sources.toplevelAt(payload.toplevelIndex) : null
      dismiss()
      if (toplevel && !secondary) Qt.callLater(function() { toplevel.activate() })
      else Qt.callLater(function() { if (sources.appLibrary) sources.appLibrary.launch(payload.desktopId, payload.name) })
      return
    }

    if (payload.kind === "window") {
      var target = sources.toplevelAt(payload.index)
      dismiss()
      if (!target) return
      if (secondary) Qt.callLater(function() { target.close() })
      else Qt.callLater(function() { target.activate() })
      return
    }

    if (payload.kind === "menu") {
      dismiss()
      var action = payload.action
      Qt.callLater(function() { sources.runMenuAction(action) })
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
      var argv = payload.terminal
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
      dismiss()
      if (payload.mode === "silent") Qt.callLater(function() { Quickshell.execDetached(scriptArgv) })
      else if (payload.mode === "compact") sources.runCompact(payload.path, payload.args, payload.title)
      else Qt.callLater(function() { Quickshell.execDetached([root.floatingTerminal, scriptArgv.map(Model.shellQuote).join(" ")]) })
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
    root.actionItems = Model.rowActions(item, sources.store)
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
    var payload = item.payload

    if (id === "primary" || id === "secondary") {
      activateItem(item, id === "secondary")
      return
    }
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
      var line = payload.kind === "script" ? [payload.path].concat(payload.args).map(Model.shellQuote).join(" ") : commandLine(payload.command, payload.args)
      if (item.frecencyKey) sources.recordUse(item.frecencyKey)
      dismiss()
      Qt.callLater(function() { Quickshell.execDetached([root.floatingTerminal, line]) })
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

    if (preview.type === "image") {
      sources.cancelPreview()
      root.previewState = { key: key, kind: "image", source: Util.fileUrl(preview.path) }
      return
    }
    var argv = Model.previewCommand(preview)
    if (argv) {
      root.previewState = { key: key, kind: "process" }
      sources.requestPreview(key, argv)
      return
    }
    sources.cancelPreview()
    root.previewState = { key: key, kind: "text", text: Model.previewText(preview, Date.now()) }
  }

  onOpenedChanged: if (!root.opened) root.pinnedKey = ""
  onSelectedIndexChanged: updatePreview()
  onPreviewAllowedChanged: updatePreview()

  Sources {
    id: sources
    omarchyPath: root.omarchyPath
    home: root.home
    opened: root.opened
    onCatalogChanged: if (root.opened) root.rebuild()
  }

  Connections {
    target: sources
    function onNotice(text) { root.showNotice(text) }
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
      var parsed = Model.parseQuery(input.text, root.scope)
      if (parsed.scope !== "files") return
      var request = Model.fileRequest(parsed, root.home)
      sources.searchFiles(request.dir, request.terms)
    }
  }

  // Time zone answers cost one `date` run; wait for the typing to settle.
  Timer {
    id: tzDebounce
    interval: 120
    onTriggered: {
      var parsed = Model.parseQuery(input.text, root.scope)
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
      var parsed = Model.parseQuery(input.text, root.scope)
      if (parsed.scope !== "content") return
      sources.searchContent(parsed.rest)
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

    // The card sits at a fixed fraction of the screen and grows downward, so
    // rows landing late lengthen the list instead of sliding the field.
    readonly property int cardTop: Math.round(height * 0.18)
    readonly property int cardWidth: Math.min(Style.space(640), width - Style.gapsOut * 2)

    Rectangle {
      anchors.fill: parent
      color: Color.menu.scrim
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
      // The list keeps its width and position; the preview pane opens to the
      // right of it, so the field never slides when the pane comes and goes.
      readonly property int previewSpace: root.previewState !== null ? root.previewWidth + Style.spacing.md : 0
      width: panel.cardWidth + previewSpace
      height: Math.min(content.implicitHeight + card.contentTopInset + card.contentBottomInset, panel.height - panel.cardTop - Style.gapsOut)
      x: Math.max(Style.gapsOut, Math.min(Math.round((panel.width - panel.cardWidth) / 2), panel.width - width - Style.gapsOut))
      y: panel.cardTop
      radius: Style.cornerRadius
      color: root.background
      borderSpec: Border.surfaceSpec("menu", "border", Color.menu.border, Math.max(1, Style.space(2)))
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

            Keys.priority: Keys.BeforeItem
            Keys.onPressed: function(event) { root.handleKey(event) }
            Keys.onReleased: function(event) {
              if (event.key === Qt.Key_Control) {
                ctrlTimer.stop()
                root.ctrlHeld = false
              }
            }

            onTextChanged: {
              root.confirmKey = ""
              if (!root.editing) root.pinnedKey = ""
              root.closeActions()
              typingGuard.restart()
              root.rebuild()
              if (root.editing) return
              var typedScope = Model.parseQuery(input.text, root.scope).scope
              if (typedScope === "files") fdDebounce.restart()
              else if (typedScope === "content") contentDebounce.restart()
              else if (typedScope === "root") tzDebounce.restart()
            }

            Text {
              textFormat: Text.PlainText
              anchors.fill: parent
              verticalAlignment: Text.AlignVCenter
              visible: input.text.length === 0
              text: root.editing ? "" : Model.scopePlaceholder(root.scope)
              font.family: root.fontFamily
              font.pixelSize: Style.font.title
              color: root.faintForeground
              elide: Text.ElideRight
            }
          }
        }

        PanelSeparator {
          width: parent.width
          foreground: root.foreground
        }

        // ---- Results

        Item {
          width: parent.width
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
            anchors.verticalCenter: parent.verticalCenter
            visible: root.confirmKey === "" && root.notice === ""
            text: root.rows.length === 1 ? "1 result" : root.rows.length + " results"
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
            visible: root.notice !== "" || root.confirmKey !== ""
            text: root.notice || "Press ↵ again to confirm  ·  Esc cancels"
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            color: Color.urgent
          }

          Text {
            id: footerVerbs
            textFormat: Text.PlainText
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
            visible: root.confirmKey === "" && root.selectedRow() !== null
            text: {
              if (root.editing) return "Save  ↵     Cancel  Esc"
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
      if (root.confirmKey) root.confirmKey = ""
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
    var parsed = Model.parseQuery(input.text, root.scope)
    if (parsed.scope === "content" && parsed.rest.length < 3) return "Type at least three characters"
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
