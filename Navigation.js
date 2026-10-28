// Navigation descriptors keep display text separate from literal executable arguments.
function stableId(kind, value) {
  var text = String(value), encoded = encodeURIComponent(text)
  if (encoded.length <= 240) return kind + ":" + encoded
  var hashes = [2166136261, 2246822507, 3266489909, 668265263]
  for (var i = 0; i < text.length; i++) {
    for (var j = 0; j < hashes.length; j++) hashes[j] = Math.imul(hashes[j] ^ text.charCodeAt(i), 16777619 + j * 2) >>> 0
  }
  return kind + ":long:" + hashes.map(function(hash) { return ("00000000" + hash.toString(16)).slice(-8) }).join("")
}

function project(path, title) {
  if (typeof path !== "string" || path[0] !== "/" || /[\u0000\r\n]/.test(path)) return null
  path = path.replace(/\/+$/, "") || "/"
  return { id: stableId("project", path), kind: "project", title: title || path.split("/").pop() || path, subtitle: path, path: path }
}

function projects(records) {
  var out = [], seen = {}
  ;(records || []).slice(0, 1000).forEach(function(record) {
    if (!record || (typeof record !== "string" && typeof record !== "object")) return
    var item = project(typeof record === "string" ? record : record.path, record.name)
    if (item && !seen[item.id]) { seen[item.id] = true; out.push(item) }
  })
  return out
}

function sshTokens(line) {
  var out = [], token = "", quote = "", escaped = false
  for (var i = 0; i < line.length; i++) {
    var ch = line[i]
    if (escaped) { token += ch; escaped = false; continue }
    if (ch === "\\") { escaped = true; continue }
    if (quote) { if (ch === quote) quote = ""; else token += ch; continue }
    if (ch === '"' || ch === "'") { quote = ch; continue }
    if (ch === "#") break
    if (/\s/.test(ch) || (ch === "=" && out.length === 0)) {
      if (token) { out.push(token); token = "" }
    } else token += ch
  }
  if (quote || escaped) return []
  if (token) out.push(token)
  return out
}

function sshHosts(files) {
  var out = [], seen = {}
  ;(files || []).forEach(function(file) {
    String(file.text || "").split(/\r?\n/).forEach(function(line) {
      var tokens = sshTokens(line)
      if (!tokens.length || tokens.shift().toLowerCase() !== "host") return
      tokens.forEach(function(host) {
        if (!/^[A-Za-z0-9_][A-Za-z0-9._-]{0,199}$/.test(host) || seen[host.toLowerCase()] || out.length >= 500) return
        seen[host.toLowerCase()] = true
        out.push({ id: stableId("ssh", host.toLowerCase()), kind: "ssh", title: host, subtitle: file.path, host: host, argv: ["ssh", "--", host] })
      })
    })
  })
  return out
}

function safeUrl(value) {
  return typeof value === "string" && /^(https?|ftp):\/\/[^\s\u0000-\u001f]+$/i.test(value)
}

function bookmarks(files) {
  var out = [], seen = {}, visited = 0
  function walk(node, source, depth) {
    if (!node || typeof node !== "object" || depth > 32 || ++visited > 20000 || out.length >= 1000) return
    var url = node.url || node.uri
    if (safeUrl(url)) {
      var id = stableId("bookmark", source + "\u0000" + url)
      if (!seen[id]) {
        seen[id] = true
        out.push({ id: id, kind: "bookmark", title: String(node.name || node.title || url).slice(0, 200), subtitle: url, url: url })
      }
    }
    if (Array.isArray(node.children)) node.children.forEach(function(child) { walk(child, source, depth + 1) })
  }
  ;(files || []).slice(0, 32).forEach(function(file) {
    var doc = typeof file.text === "string" ? JSON.parse(file.text) : file.document
    if (doc && doc.roots && typeof doc.roots === "object") {
      Object.keys(doc.roots).forEach(function(key) { walk(doc.roots[key], file.path, 0) })
    } else if (doc && (Array.isArray(doc.children) || doc.type === "text/x-moz-place-container")) walk(doc, file.path, 0)
    else throw new Error("Expected Chromium bookmarks or Firefox bookmark export JSON: " + file.path)
  })
  return out
}

function pluginPanels(text) {
  var doc = typeof text === "string" ? JSON.parse(text) : text
  if (!Array.isArray(doc)) throw new Error("Plugin list must be a JSON array")
  var out = [], seen = {}
  doc.slice(0, 5000).forEach(function(item) {
    if (!item || item.enabled !== true || !Array.isArray(item.kinds) || !item.kinds.some(function(kind) { return kind === "panel" || kind === "overlay" })) return
    if (typeof item.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(item.id) || seen[item.id]) return
    seen[item.id] = true
    out.push({ id: stableId("plugin", item.id), kind: "pluginPanel", title: String(item.name || item.id), subtitle: item.id, pluginId: item.id, argv: ["omarchy-shell", "shell", "summon", item.id, "{}"] })
  })
  return out
}

function rows(catalog, scope, query, matchScore) {
  var data = catalog || {}, out = []
  var groups = [{ scope: "projects", key: "projects" }, { scope: "ssh", key: "sshHosts" }, { scope: "bookmarks", key: "bookmarks" }, { scope: "plugins", key: "pluginPanels" }]
  groups.forEach(function(group) {
    if (scope && scope !== "root" && scope !== "catalog" && scope !== group.scope) return
    ;(data[group.key] || []).forEach(function(item, index) {
      var score = matchScore ? matchScore(query, { name: item.title, aliases: [item.subtitle || ""] }) : (!query || (item.title + " " + item.subtitle).toLowerCase().indexOf(String(query).toLowerCase()) >= 0 ? 1 : -1)
      if (score < 0) return
      out.push({ key: item.id, section: group.scope, title: item.title, subtitle: item.subtitle, primaryLabel: item.kind === "ssh" ? "Connect" : "Open", score: score, order: index, frecencyKey: item.id, pinnable: true, payload: item })
    })
  })
  return out
}

// Membership is refreshed inside the owned action, immediately before summon.
function activationCommand(pluginId, pluginCli) {
  if (typeof pluginId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(pluginId)) return []
  var program = [
    "import json, resource, subprocess, sys, tempfile",
    "def limit():",
    "    resource.setrlimit(resource.RLIMIT_FSIZE, (262144, 262144))",
    "try:",
    "    with tempfile.TemporaryFile() as output, tempfile.TemporaryFile() as error:",
    "        result = subprocess.run([sys.argv[2], 'plugin', 'list', '--json'], stdout=output, stderr=error, timeout=3, preexec_fn=limit)",
    "        output.seek(0)",
    "        data = output.read(262145)",
    "        if result.returncode or len(data) >= 262144: raise ValueError('Cannot refresh enabled plugin membership')",
    "        plugins = json.loads(data)",
    "    if not isinstance(plugins, list): raise ValueError('Invalid plugin list response')",
    "    allowed = any(isinstance(item, dict) and item.get('id') == sys.argv[1] and item.get('enabled') is True and isinstance(item.get('kinds'), list) and any(kind in ('panel', 'overlay') for kind in item['kinds']) for item in plugins)",
    "    if not allowed: raise ValueError('Plugin is no longer an enabled panel or overlay')",
    "    result = subprocess.run(['omarchy-shell', 'shell', 'summon', sys.argv[1], '{}'], timeout=3)",
    "    sys.exit(result.returncode if result.returncode >= 0 else 1)",
    "except subprocess.TimeoutExpired:",
    "    print('Plugin activation timed out', file=sys.stderr)",
    "    sys.exit(124)",
    "except (OSError, ValueError) as error:",
    "    print(str(error), file=sys.stderr)",
    "    sys.exit(1)"
  ].join("\n")
  return ["python3", "-c", program, pluginId, typeof pluginCli === "string" && pluginCli ? pluginCli : "omarchy"]
}

if (typeof module !== "undefined") module.exports = { stableId: stableId, project: project, projects: projects, sshTokens: sshTokens, sshHosts: sshHosts, safeUrl: safeUrl, bookmarks: bookmarks, pluginPanels: pluginPanels, activationCommand: activationCommand, rows: rows }
