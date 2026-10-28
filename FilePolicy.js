// Path policy protects accidental reads; it is not a filesystem sandbox.
function normalizePath(value, home) {
  var path = typeof value === "string" ? value : ""
  if (path.indexOf("\u0000") !== -1 || path.length > 16384) return ""
  if (path === "~") path = String(home || "")
  else if (path.indexOf("~/") === 0) path = String(home || "") + path.slice(1)
  if (path.charAt(0) !== "/") return ""
  var parts = path.split("/"), result = []
  for (var i = 0; i < parts.length; i++) {
    if (!parts[i] || parts[i] === ".") continue
    if (parts[i] === "..") result.pop()
    else result.push(parts[i])
  }
  return "/" + result.join("/")
}

function normalizeRoots(config, home) {
  var entries = config && Array.isArray(config.fileRoots) ? config.fileRoots : []
  var roots = [], seen = Object.create(null)
  for (var i = 0; i < entries.length && roots.length < 32; i++) {
    var entry = entries[i] || {}, name = typeof entry.name === "string" ? entry.name.trim() : ""
    var path = normalizePath(entry.path, home)
    if (!name || /[\s@\u0000-\u001f\u007f]/.test(name) || !path || seen[name.toLowerCase()]) continue
    seen[name.toLowerCase()] = true
    roots.push({ name: name, path: path })
  }
  if (!roots.length && normalizePath(home, home)) roots.push({ name: "Home", path: normalizePath(home, home) })
  return roots
}

function selectRoot(roots, name) {
  if (!Array.isArray(roots) || !roots.length) return null
  if (!name) return roots[0]
  var wanted = String(name).toLowerCase()
  for (var i = 0; i < roots.length; i++) if (String(roots[i].name).toLowerCase() === wanted) return roots[i]
  return null
}

function contains(root, path) {
  return !!root && !!path && (root === "/" ? path.charAt(0) === "/" : path === root || path.indexOf(root + "/") === 0)
}

function overrides(home, config) {
  var entries = config && Array.isArray(config.allowProtectedPaths) ? config.allowProtectedPaths : []
  var result = []
  for (var i = 0; i < entries.length && result.length < 32; i++) {
    var path = normalizePath(entries[i], home)
    if (path && result.indexOf(path) === -1) result.push(path)
  }
  return result
}

function contentExcludes(home, config) {
  var base = normalizePath(home, home)
  var trees = [".ssh", ".gnupg", ".aws", ".kube", ".cache", ".azure", ".docker", ".local/share/keyrings", ".local/share/kwalletd", ".local/share/TelegramDesktop/tdata", ".config/gh", ".config/gcloud", ".config/chromium", ".config/google-chrome", ".mozilla", ".config/BraveSoftware"]
  return { trees: trees.map(function(path) { return base === "/" ? "/" + path : base + "/" + path }),
    components: [".ssh", ".gnupg", ".aws", ".kube", ".cache"],
    names: [".env", ".env.*", ".envrc", "*.pem", "*.key", "*.p12", "*.pfx", "*.kdbx", "id_rsa*", "id_ed25519*", "credentials", "credentials.*", "*credentials.json", "secrets", "secrets.*", "*.secret", "token", "tokens", "token.json", "tokens.json", "auth.json", ".authinfo", ".pgpass", ".my.cnf", ".bash_history", ".zsh_history", ".python_history", "session", "session.*", "sessions", "sessions.*", "Cookies", "Login Data", ".netrc", ".npmrc", ".pypirc", ".git-credentials", "kubeconfig"],
    allow: overrides(home, config) }
}

function wildcard(pattern, text) {
  var regex = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")
  return new RegExp("^" + regex + "$", "i").test(text)
}

function protectedPath(path, home, config) {
  var rules = contentExcludes(home, config)
  for (var a = 0; a < rules.allow.length; a++) if (contains(rules.allow[a], path)) return false
  for (var t = 0; t < rules.trees.length; t++) if (contains(rules.trees[t], path)) return true
  var parts = path.split("/")
  for (var p = 0; p < parts.length; p++) {
    for (var c = 0; c < rules.components.length; c++) if (parts[p].toLowerCase() === rules.components[c]) return true
    for (var n = 0; n < rules.names.length; n++) if (wildcard(rules.names[n], parts[p])) return true
  }
  return false
}

function request(path, rootPath, home, config, purpose) {
  var normalized = normalizePath(path, home), scope = normalizePath(rootPath || home, home)
  if (["preview", "image", "content", "root"].indexOf(purpose) === -1) return { ok: false, message: "Unknown file operation" }
  if (!normalized || !scope) return { ok: false, message: "An absolute file path and root are required" }
  if (!contains(scope, normalized)) return { ok: false, message: "Path is outside the selected root" }
  var protect = purpose === "content" || purpose === "root" || !config || config.protectPreviews !== false
  if (protect && protectedPath(normalized, home, config)) return { ok: false, message: "Protected path; configure an explicit allowance to read it" }
  return { ok: true, path: normalized, rootPath: scope, message: "" }
}

// rg enumerates names with ignore rules, without following links. Only admitted
// paths reach bounded content batches. No path or rule becomes shell source.
// Hardlinks and concurrent replacement still rely on the host's permissions.
var CONTENT_READER = [
  'export LC_ALL=C',
  'dir=$1; term=$2; trees=$3; sensitive=$4; allow=$5',
  'search_batch() {',
  '  ((${#batch[@]})) || return 0',
  '  exec {fd}< <(exec rg --no-config --no-follow --files-with-matches --null --max-count 1 --max-filesize 2M --fixed-strings --ignore-case -- "$term" "${batch[@]}")',
  '  pid=$!',
  '  while IFS= read -r -d "" -u "$fd" match; do',
  '    size=$((${#match}+1))',
  '    if ((records >= 200 || used + size > 262144)); then exec {fd}<&-; kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null; return 3; fi',
  '    if ! printf "%s\\0" "$match"; then exec {fd}<&-; kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null; return 3; fi',
  '    records=$((records+1)); used=$((used+size))',
  '  done',
  '  exec {fd}<&-',
  '  wait "$pid"; status=$?',
  '  batch=(); batch_bytes=0',
  '  ((status == 0 || status == 1)) || return 4',
  '}',
  'rg --no-config --files --null --hidden --no-follow --no-require-git --glob "!.git" --glob "!node_modules" -- "$dir" |',
  'awk \'BEGIN { RS="\\0"; ORS="\\0"; trees=ARGV[1]; sensitive=ARGV[2]; allow=ARGV[3]; ARGC=1 } $0 ~ allow || ($0 !~ trees && tolower($0) !~ sensitive) { print }\' "$trees" "$sensitive" "$allow" | {',
  '  batch=(); batch_bytes=0; records=0; used=0',
  '  while IFS= read -r -d "" path; do',
  '    [[ ! -L "$path" ]] || continue',
  '    batch+=("$path"); batch_bytes=$((batch_bytes+${#path}+1))',
  '    if ((${#batch[@]} >= 128 || batch_bytes >= 49152)); then search_batch; status=$?; ((status == 0)) || exit "$status"; fi',
  '  done',
  '  search_batch',
  '}',
  'status=("${PIPESTATUS[@]}")',
  'if ((status[2] == 3)); then exit 3; fi',
  'if ((status[2] != 0 || status[1] != 0 || (status[0] != 0 && status[0] != 1))); then exit 4; fi',
  'exit 0'
].join("\n")

function escapeRegex(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function pathAlternatives(paths) {
  if (!paths.length) return "a^"
  if (paths.indexOf("/") !== -1) return "^/"
  return "^(" + paths.map(escapeRegex).join("|") + ")(/|$)"
}

function contentCommand(dir, term, home, config) {
  var rules = contentExcludes(home, config)
  var patterns = rules.components.concat(rules.names).map(function(pattern) {
    return escapeRegex(pattern.toLowerCase()).replace(/\\\*/g, "[^/]*").replace(/\\\?/g, "[^/]")
  })
  return ["bash", "-c", CONTENT_READER, "omacast-content", String(dir), String(term),
    pathAlternatives(rules.trees), "(^|/)(" + patterns.join("|") + ")(/|$)", pathAlternatives(rules.allow)]
}

if (typeof module !== "undefined") module.exports = { normalizePath: normalizePath, normalizeRoots: normalizeRoots, selectRoot: selectRoot, contains: contains, overrides: overrides, contentExcludes: contentExcludes, protectedPath: protectedPath, request: request, contentCommand: contentCommand }
