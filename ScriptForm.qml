import QtQuick
import "ScriptModel.js" as ScriptModel

// Inputs retain their own focus and IME state until submission or cancellation.
Column {
  id: root
  property var specs: []
  property var values: []
  property string error: ""
  property color foreground: "white"
  property string fontFamily: "sans-serif"
  signal submitted(var values)
  signal cancelled()
  spacing: 8
  function begin(argumentSpecs, initial) {
    specs = ScriptModel.normalizeSpecs(argumentSpecs)
    values = specs.map(function(s, i) { return initial[i] === undefined ? String(s.default || "") : String(initial[i]) })
    error = ""
    Qt.callLater(function() { if (fields.count) fields.itemAt(0).editor.forceActiveFocus() })
  }
  function submit() {
    var checked = ScriptModel.validateArguments(specs, values)
    if (!checked.ok) { error = checked.error; return }
    error = ""
    submitted(values.slice())
  }
  Repeater {
    id: fields
    model: root.specs
    delegate: Column {
      id: field
      required property var modelData
      required property int index
      property alias editor: editor
      width: root.width
      spacing: 4
      Text {
        textFormat: Text.PlainText
        text: String(field.modelData.placeholder || field.modelData.type || "Argument") + (field.modelData.optional ? " (optional)" : " (required)")
        color: root.foreground
        font.family: root.fontFamily
      }
      Rectangle {
        width: parent.width
        height: 36
        color: "transparent"
        border.width: editor.activeFocus ? 2 : 1
        border.color: root.foreground
        TextInput {
          id: editor
          anchors.fill: parent
          anchors.margins: 6
          color: root.foreground
          font.family: root.fontFamily
          text: root.values[field.index] || ""
          selectByMouse: true
          onTextEdited: { var next = root.values.slice(); next[field.index] = text; root.values = next; root.error = "" }
          Keys.onPressed: function(event) {
            if (inputMethodComposing && event.key !== Qt.Key_Escape) return
            if (event.key === Qt.Key_Escape) root.cancelled()
            else if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter) root.submit()
            else if (event.key === Qt.Key_Tab || event.key === Qt.Key_Backtab) {
              var back = event.key === Qt.Key_Backtab || (event.modifiers & Qt.ShiftModifier)
              fields.itemAt((field.index + (back ? -1 : 1) + fields.count) % fields.count).editor.forceActiveFocus()
            } else if ((event.key === Qt.Key_Up || event.key === Qt.Key_Down) && field.modelData.options && field.modelData.options.length) {
              var choices = field.modelData.options
              var at = choices.map(function(c) { return typeof c === "string" ? c : c.value }).indexOf(text)
              var choice = choices[(at + (event.key === Qt.Key_Down ? 1 : -1) + choices.length) % choices.length]
              text = String(typeof choice === "string" ? choice : choice.value)
              var next = root.values.slice(); next[field.index] = text; root.values = next
            } else return
            event.accepted = true
          }
        }
      }
      Text {
        textFormat: Text.PlainText
        visible: !!(field.modelData.options && field.modelData.options.length)
        text: (field.modelData.options || []).map(function(c) { return typeof c === "string" ? c : c.title }).join(" · ") + "  ↑/↓"
        color: root.foreground
        font.family: root.fontFamily
        width: parent.width
        wrapMode: Text.Wrap
      }
    }
  }
  Text {
    textFormat: Text.PlainText
    text: root.error || "Tab: next field · Enter: run · Escape: cancel"
    color: root.foreground
    font.family: root.fontFamily
    width: parent.width
    wrapMode: Text.Wrap
  }
}
