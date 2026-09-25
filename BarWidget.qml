import QtQuick
import qs.Commons
import qs.Ui

// A bar button that toggles the palette, shaped like the stock menu's
// (shell/plugins/menu/BarWidget.qml). The overlay owns the lifecycle; this
// button only asks the shell to toggle it, so a click and the keybinding do
// exactly the same thing.
//
// Enabling a plugin with a bar-widget kind always gives it a bar slot, so
// "off by default" is a setting: the slot stays empty until `button` is true
// (`omarchy bar set io.github.terrifiedbug.omacast button true`).
BarWidget {
  id: root
  moduleName: "io.github.terrifiedbug.omacast"

  // `omarchy bar set` stores the string "true" unless given --json.
  readonly property bool shown: String(root.setting("button", false)) === "true"

  implicitWidth: root.shown ? button.implicitWidth : 0
  implicitHeight: root.shown ? button.implicitHeight : 0
  visible: root.shown

  WidgetButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: ""  // nf-fa-search
    fontFamily: root.bar ? root.bar.fontFamily : Style.font.family
    horizontalMargin: 7.5
    onPressed: function(button) {
      if (!root.bar) return
      root.bar.run("omarchy-shell shell toggle io.github.terrifiedbug.omacast '{}'")
    }
  }
}
