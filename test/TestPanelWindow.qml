import QtQuick

// Only the layer-window host is replaced; palette content stays unchanged.
QtObject {
  id: proxy
  default property alias data: surface.data
  property alias contentItem: surface
  property bool visible: false
  property color color: "transparent"
  property var screen: null
  property int width: 1000
  property int height: 800
  property int exclusionMode: 0
  property Item surface: Item {
    id: surface
    width: proxy.width
    height: proxy.height
    visible: proxy.visible
  }
}
