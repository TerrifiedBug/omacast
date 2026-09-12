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

  readonly property string manifestId: manifest && manifest.id ? manifest.id : "io.github.terrifiedbug.omacast"
  readonly property string scope: scopeStack.length > 0 ? scopeStack[scopeStack.length - 1].scope : "root"

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

  readonly property var targetScreen: {
    var screens = Quickshell.screens
    var focused = Hyprland.focusedMonitor
    var name = focused ? String(focused.name || "") : ""
    for (var s = 0; s < screens.length; s++) if (screens[s].name === name) return screens[s]
    return screens.length > 0 ? screens[0] : null
  }

  // ---- Lifecycle

  function open(payloadJson) {
    var payload = ({})
    try { payload = JSON.parse(payloadJson || "{}") } catch (e) { payload = ({}) }

    root.scopeStack = []
    root.confirmKey = ""
    root.pinnedKey = ""
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
    root.opened = false
    root.confirmKey = ""
    root.ctrlHeld = false
    fdDebounce.stop()
    sources.cancelFiles()
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
        key: root.rows[i].key
      })
    }
    return JSON.stringify({
      opened: root.opened,
      scope: root.scope,
      query: input.text,
      selectedIndex: root.selectedIndex,
      confirmKey: root.confirmKey,
      pins: sources.store.pins,
      rows: out
    })
  }

  // ---- Scopes

  function pushScope(next) {
    var stack = root.scopeStack.slice()
    stack.push({ scope: next, query: input.text })
    root.scopeStack = stack
    root.pinnedKey = ""
    root.confirmKey = ""
    input.text = ""
    rebuild()
  }

  function popScope() {
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
    if (next === "clipboard") sources.loadClipboard()
    else if (next === "emoji") sources.wantEmojis()
    else if (next === "files") { sources.clearFiles(); fdDebounce.restart() }
  }

  function scopeChipText() {
    if (root.scope === "root") return ""
    if (root.scope.indexOf("menu:") === 0) {
      var id = root.scope.slice(5)
      return MenuModel.pathFor(sources.menuItems, id) || id
    }
    return Model.scopeTitle(root.scope)
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

    if (parsed.scope === "clipboard") {
      rows = Model.clipboardRows(sources.clipboardEntries, parsed.rest)
    } else if (parsed.scope === "emoji") {
      rows = Model.emojiRows(sources.emojis, parsed.rest)
    } else if (parsed.scope === "files") {
      var request = Model.fileRequest(parsed, root.home)
      rows = Model.fileRows(sources.filePaths, request.terms.length > 0 ? request.terms[0] : "", root.home)
    } else if (parsed.scope === "windows") {
      // The scope exists to show the ones the root view had to leave out.
      rows = Model.windowRows(sources.toplevels, parsed.rest)
      caps = { windows: Infinity }
    } else if (parsed.scope === "help") {
      rows = Model.helpRows(sources.config, parsed.rest)
    } else if (parsed.scope.indexOf("menu:") === 0) {
      rows = Model.menuRows(sources.menuIndex, parsed.rest, usage, now, parsed.scope)
    } else if (!parsed.trimmed) {
      rows = Model.emptyQueryRows({ byKey: catalogByKey(), windowRows: Model.windowRows(sources.toplevels, "") }, sources.store, now)
      caps = { windows: Model.EMPTY_WINDOW_LIMIT }
    } else {
      rows = rootRows(parsed, usage, now)
    }

    publish(Model.applyCaps(Model.sortRows(rows), caps))
  }

  function rootRows(parsed, usage, now) {
    var query = parsed.rest
    var rows = Model.answerRows(query)
    rows = rows.concat(Model.appRows(appEntries(query), query, usage, sources.runningApps, now))
    rows = rows.concat(Model.windowRows(sources.toplevels, query))
    rows = rows.concat(Model.menuRows(sources.menuIndex, query, usage, now, "root"))
    rows = rows.concat(Model.keybindingRows(sources.keybindingRecords, query))
    rows = rows.concat(Model.quicklinkRows(sources.config.quicklinks, query, usage, now))
    rows = rows.concat(Model.snippetRows(sources.config.snippets, query, usage, now))
    rows = rows.concat(Model.commandRows(sources.config.commands, query, usage, now))
    rows = rows.concat(Model.scopeRows(query))
    rows = rows.concat(Model.webRows(query, sources.config.searchQuicklink))
    return rows
  }

  function appEntries(query) {
    if (!sources.appLibrary) return []
    return sources.appLibrary.sortedEntries(query)
  }

  // Key → row for every static source, so the pinned and recent sections can
  // resolve the keys the state file holds. Rebuilt per empty-query rebuild;
  // that path runs once per open, not per keystroke.
  function catalogByKey() {
    var now = Date.now()
    var usage = sources.store.usage
    var byKey = ({})
    var sets = [
      Model.appRows(appEntries(""), "", usage, sources.runningApps, now),
      Model.menuRows(sources.menuIndex, "", usage, now, "catalog"),
      Model.quicklinkRows(sources.config.quicklinks, "", usage, now),
      Model.snippetRows(sources.config.snippets, "", usage, now),
      Model.commandRows(sources.config.commands, "", usage, now)
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
        subtitle: rows[i].subtitle,
        icon: rows[i].icon,
        iconSource: iconSourceFor(rows[i]),
        accessory: rows[i].accessory,
        rowIndex: i
      })
    }

    resolveCursor()
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
    if (typingGuard.running) return
    if (!pointerGate.moved(item, mouse)) return
    if (index < 0 || index >= root.rows.length) return
    root.selectedIndex = index
    root.pinnedKey = root.rows[index].key
  }

  // ---- Activation

  function activate(index, secondary) {
    if (index < 0 || index >= root.rows.length) return
    var item = root.rows[index]

    if (item.confirm && root.confirmKey !== item.key) {
      root.confirmKey = item.key
      return
    }
    root.confirmKey = ""

    var payload = item.payload
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
    if ((payload.kind === "quicklink" || payload.kind === "snippet" || payload.kind === "command") && payload.complete) {
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
    if (payload.kind === "keybinding" && payload.disabled) return

    if (item.frecencyKey) sources.recordUse(item.frecencyKey)
    run(item, payload, secondary === true)
  }

  // Everything here closes the palette first and defers the work by a turn:
  // the layer surface holds an exclusive keyboard grab, and a window focused
  // while that grab is live does not get the keyboard.
  function run(item, payload, secondary) {
    if (payload.kind === "app") {
      var toplevel = payload.toplevelIndex >= 0 ? sources.toplevelAt(payload.toplevelIndex) : null
      dismiss()
      if (secondary && toplevel) Qt.callLater(function() { toplevel.activate() })
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
        ? [root.omarchyPath + "/bin/omarchy-launch-floating-terminal-with-presentation", "bash", "-lc", payload.command + ' "$@"', "bash"].concat(payload.args)
        : ["bash", "-lc", payload.command + ' "$@"', "bash"].concat(payload.args)
      dismiss()
      Qt.callLater(function() { Quickshell.execDetached(argv) })
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

  onOpenedChanged: if (!root.opened) root.pinnedKey = ""

  Sources {
    id: sources
    omarchyPath: root.omarchyPath
    home: root.home
    opened: root.opened
    onCatalogChanged: if (root.opened) root.rebuild()
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

  Process {
    id: openProc
    onExited: function(exitCode) {
      if (exitCode !== 0) console.warn("omacast: gio open failed with " + exitCode + " for " + openProc.command[2])
    }
  }

  Component.onDestruction: {
    fdDebounce.stop()
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
      width: panel.cardWidth
      height: Math.min(content.implicitHeight + card.contentTopInset + card.contentBottomInset, panel.height - panel.cardTop - Style.gapsOut)
      y: panel.cardTop
      anchors.horizontalCenter: parent.horizontalCenter
      radius: Style.cornerRadius
      color: root.background
      borderSpec: Border.surfaceSpec("menu", "border", Color.menu.border, Math.max(1, Style.space(2)))
      padding: Style.spacing.panelPadding

      MouseArea { anchors.fill: parent; onClicked: {} }

      Column {
        id: content
        anchors.fill: parent
        anchors.topMargin: card.contentTopInset
        anchors.rightMargin: card.contentRightInset
        anchors.bottomMargin: card.contentBottomInset
        anchors.leftMargin: card.contentLeftInset
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
            maximumLength: 512
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
              root.pinnedKey = ""
              typingGuard.restart()
              root.rebuild()
              if (Model.parseQuery(input.text, root.scope).scope === "files") fdDebounce.restart()
            }

            Text {
              textFormat: Text.PlainText
              anchors.fill: parent
              verticalAlignment: Text.AlignVCenter
              visible: input.text.length === 0
              text: Model.scopePlaceholder(root.scope)
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
                anchors.right: rowAccessory.left
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

              Text {
                id: rowAccessory
                textFormat: Text.PlainText
                anchors.right: parent.right
                anchors.rightMargin: Style.spacing.md
                anchors.verticalCenter: parent.verticalCenter
                text: root.ctrlHeld && rowItem.index < 9 ? "⌃" + (rowItem.index + 1) : rowItem.accessory
                font.family: root.glyphFamily
                font.pixelSize: Style.font.caption
                color: root.faintForeground
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
            text: input.text.length > 0 ? "No results" : "Type to search"
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
            visible: root.confirmKey === ""
            text: root.rows.length === 1 ? "1 result" : root.rows.length + " results"
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            color: root.faintForeground
          }

          Text {
            textFormat: Text.PlainText
            anchors.left: parent.left
            anchors.verticalCenter: parent.verticalCenter
            visible: root.confirmKey !== ""
            text: "Press ↵ again to confirm  ·  Esc cancels"
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            color: Color.urgent
          }

          Text {
            textFormat: Text.PlainText
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
            visible: root.confirmKey === "" && root.selectedRow() !== null
            text: {
              var item = root.selectedRow()
              if (!item) return ""
              var primary = item.primaryLabel + "  ↵"
              return item.secondaryLabel ? primary + "     " + item.secondaryLabel + "  ⌃↵" : primary
            }
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            color: root.faintForeground
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
      ctrlTimer.restart()
      return
    }

    if (event.key === Qt.Key_Down || (control && event.key === Qt.Key_N)) {
      moveSelection(1)
      event.accepted = true
    } else if (event.key === Qt.Key_Up || (control && event.key === Qt.Key_P)) {
      moveSelection(-1)
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

  function completeSelection() {
    var item = selectedRow()
    if (!item) return

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
