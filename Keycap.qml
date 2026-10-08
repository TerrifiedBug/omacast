import QtQuick
import qs.Commons
import qs.Commons as Commons

// A shortcut hint drawn the way gpui-omarchy draws its keycap: square
// corners, a one-pixel border, faint text in the glyph family. Every colour
// is a palette token the card already uses, so a theme switch restyles it.
Rectangle {
  id: root

  property string text: ""
  property color borderColor: Commons.Color.menu.selectedBorder
  property color textColor: Qt.darker(Commons.Color.menu.text, 1.6)
  property string fontFamily: Style.font.family

  implicitWidth: Math.max(implicitHeight, label.implicitWidth + Style.space(8))
  implicitHeight: label.implicitHeight + Style.space(4)
  radius: 0
  color: "transparent"
  border.width: 1
  border.color: root.borderColor

  Text {
    id: label
    textFormat: Text.PlainText
    anchors.centerIn: parent
    text: root.text
    font.family: root.fontFamily
    font.pixelSize: Style.font.caption
    color: root.textColor
  }
}
