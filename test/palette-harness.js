const { mkdir, writeFile, readFile, copyFile, symlink } = require("node:fs/promises")
const { watch } = require("node:fs")
const path = require("node:path")
const harness = require("./qml-harness")

const CONFIG = ".config/omarchy/omacast.json"
const STATE = ".local/state/omarchy/omacast-state.json"

module.exports = async function paletteHarness(t, options = {}) {
  const h = await harness(t, {
    harness: "palette-harness.qml",
    files: [...harness.sourceFiles, "Omacast.qml", "WindowActions.qml", "NativeHyprlandRequest.qml", "ScriptForm.qml", "Keycap.qml"],
    env: dir => ({ PATH: path.join(dir, "bin") + ":" + process.env.PATH, QT_QUICK_BACKEND: "software",
      XDG_DATA_HOME: path.join(dir, "data"), XDG_DATA_DIRS: path.join(dir, "data"), OMARCHY_PATH: path.join(dir, "omarchy") }),
    prepare: async dir => {
      const staged = path.join(dir, "harness")
      for (const name of ["Commons", "Ui"])
        await symlink(path.join("/usr/share/omarchy/shell", name), path.join(staged, name), "dir")
      await copyFile(path.join(__dirname, "TestPanelWindow.qml"), path.join(staged, "TestPanelWindow.qml"))
      // Adapt only the native layer-window envelope, never palette logic/content.
      const original = await readFile(path.join(staged, "Omacast.qml"), "utf8")
      const adapted = original.replace("  PanelWindow {", "  TestPanelWindow {")
        .replace(/^    anchors \{ top: true; bottom: true; left: true; right: true \}\n/m, "")
        .replace(/^    WlrLayershell\.(?:namespace|layer|keyboardFocus):[^\n]*\n/gm, "")
      if (adapted === original) throw new Error("Palette layer host was not found")
      await writeFile(path.join(staged, "Omacast.qml"), adapted)
      for (const folder of [".config/omarchy/omacast/scripts", ".config/hypr", ".local/state/omarchy", "bin", "data/applications", "omarchy/bin", "omarchy/default/omarchy"])
        await mkdir(path.join(dir, folder), { recursive: true })
      await symlink("/usr/share/omarchy/shell", path.join(dir, "omarchy/shell"), "dir")
      const config = typeof options.config === "function" ? options.config(dir) : options.config
      await writeFile(path.join(dir, CONFIG), JSON.stringify({ currency: false, ai: false, preview: false, ...config }))
      await writeFile(path.join(dir, STATE), JSON.stringify({ version: 1, ...options.state }))
      await writeFile(path.join(dir, ".config/hypr/bindings.lua"), "")
      await writeFile(path.join(dir, ".bash_profile"), 'export PATH="$HOME/bin:/usr/bin:/bin"\n')
      await writeFile(path.join(dir, "omarchy/default/omarchy/omarchy-menu.jsonc"), JSON.stringify({ items: options.menu || {} }))
      await writeFile(path.join(dir, "bin/omarchy"), '#!/bin/bash\ncase "$1 $2" in "commands --json"|"plugin list") printf "[]";; "theme current") printf Fixture;; "default agent") printf fixture;; esac\n', { mode: 0o700 })
      await writeFile(path.join(dir, "bin/hyprctl"), '#!/bin/bash\ncase "$*" in "-j binds") printf "[]";; esac\n', { mode: 0o700 })
      await writeFile(path.join(dir, "bin/curl"), '#!/bin/bash\nexit 7\n', { mode: 0o700 })
      await writeFile(path.join(dir, "omarchy/bin/omarchy-menu-keybindings"), 'output_binding_records_uncached() { :; }\noutput_binding_records() { output_binding_records_uncached; }\n')
      for (const name of ["gio", "xdg-open", "wl-copy", "omarchy-shell", "omarchy-capture-screenshot", "omarchy-launch-browser", "omarchy-launch-floating-terminal-with-presentation"]) {
        const script = '#!/bin/bash\nlog="$HOME/launch.log"\ntemporary="$HOME/launch.$$.tmp"\n{ [[ ! -f "$log" ]] || cat -- "$log"; printf "%s\\n" ' + JSON.stringify(name) + ' "$@"; } > "$temporary"\nmv -- "$temporary" "$log"\n'
        await writeFile(path.join(dir, "bin", name), script, { mode: 0o700 })
        if (name.startsWith("omarchy-")) await writeFile(path.join(dir, "omarchy/bin", name), script, { mode: 0o700 })
      }
      if (options.prepare) await options.prepare(dir)
      const driver = await readFile(path.join(__dirname, "palette-harness.qml"), "utf8")
      await writeFile(path.join(staged, "shell.qml"), driver.replace('import ".."', 'import "."'))
    }
  })
  if (!h) return null
  h.pngPath = path.join(h.dir, "palette.png")
  h.capture = async (name = "palette") => {
    const captured = await h.command("capture", { name })
    if (!captured.saved) throw new Error("Palette PNG capture failed")
    return captured.png
  }
  h.until = async (predicate, op = "snapshot", fields = {}) => {
    const changed = h.changed(predicate)
    const reply = await h.command(op, fields)
    return predicate(reply.state) ? reply.state : changed
  }
  return h
}

module.exports.CONFIG = CONFIG
module.exports.STATE = STATE
module.exports.marker = function marker(dir, filename, predicate, { signal } = {}) {
  if (typeof predicate !== "function") throw new TypeError("A marker completion predicate is required")
  return new Promise((resolve, reject) => {
    const target = path.join(dir, filename)
    let done = false
    let reading = false
    let dirty = false
    const listener = watch(path.dirname(target), check)
    const deadline = setTimeout(() => finish(new Error("Missing complete marker: " + filename)), 5000)
    function finish(error, text) {
      if (done) return
      done = true
      listener.close()
      clearTimeout(deadline)
      signal?.removeEventListener("abort", abort)
      if (error) reject(error)
      else resolve(text)
    }
    function abort() { finish(signal.reason || new Error("Marker wait aborted")) }
    async function check() {
      if (done) return
      dirty = true
      if (reading) return
      reading = true
      try {
        while (dirty && !done) {
          dirty = false
          try {
            const text = await readFile(target, "utf8")
            if (!done && predicate(text)) finish(null, text)
          } catch (error) {
            // Atomic replacement may briefly remove the file; plain JSON writes
            // may expose an incomplete document before the next change event.
            if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) finish(error)
          }
        }
      } finally { reading = false }
    }
    listener.on("error", finish)
    signal?.addEventListener("abort", abort, { once: true })
    if (signal?.aborted) abort()
    else check()
  })
}
