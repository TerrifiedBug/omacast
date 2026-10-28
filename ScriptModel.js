// Structured script values stay literal until validation has completed.
var BYTE_LIMIT = 65536
var ROW_LIMIT = 200

function normalizeSpecs(specs) {
  return (Array.isArray(specs) ? specs : []).map(function(spec, index) {
    spec = spec || {}
    return {
      type: String(spec.type || "text"),
      placeholder: String(spec.placeholder || "Argument " + (index + 1)),
      optional: spec.optional === true,
      percentEncoded: spec.percentEncoded === true,
      default: spec.default === undefined ? "" : String(spec.default),
      validation: spec.validation === undefined ? "" : String(spec.validation),
      options: (Array.isArray(spec.options) ? spec.options : []).map(function(option) {
        return typeof option === "string" ? { title: option, value: option }
          : { title: String(option && option.title !== undefined ? option.title : ""), value: String(option && option.value !== undefined ? option.value : "") }
      })
    }
  })
}

// Validation is a whole-value sequence of literals, character classes, dot and
// single-character escapes, with ?, *, + or {n,m} repetition. Optional ^/$
// anchors are accepted. Groups, alternatives, lookarounds and backreferences
// are rejected. Matching uses bounded dynamic programming, never backtracking.
function compileValidation(pattern) {
  if (typeof pattern !== "string" || pattern.length > 256) return null
  var atoms = [], i = 0
  if (pattern.charAt(0) === "^") i++
  while (i < pattern.length) {
    if (pattern.charAt(i) === "$" && i === pattern.length - 1) break
    var start = i, ch = pattern.charAt(i++), expression = "", literal = null
    if (ch === "[") {
      if (pattern.charAt(i) === "^") i++
      var members = 0
      while (i < pattern.length && pattern.charAt(i) !== "]") {
        if (pattern.charAt(i) === "[") return null
        if (pattern.charAt(i++) === "\\") {
          if (i >= pattern.length) return null
          var classEscape = pattern.charAt(i++)
          if ("dDsSwWntr".indexOf(classEscape) < 0 && !/^[^A-Za-z0-9]$/.test(classEscape)) return null
        }
        members++
      }
      if (!members || pattern.charAt(i) !== "]") return null
      i++
      expression = pattern.slice(start, i)
    } else if (ch === "\\") {
      if (i >= pattern.length) return null
      var escaped = pattern.charAt(i++)
      if (/^[dDsSwWntr]$/.test(escaped)) expression = "\\" + escaped
      else if (/^[^A-Za-z0-9]$/.test(escaped)) literal = escaped
      else return null
    } else if (ch === ".") expression = "."
    else if ("^$*+?()[]{}|".indexOf(ch) >= 0) return null
    else literal = ch
    var min = 1, max = 1, quantifier = pattern.charAt(i)
    if (quantifier === "*" || quantifier === "+" || quantifier === "?") {
      min = quantifier === "+" ? 1 : 0
      max = quantifier === "?" ? 1 : 4096
      i++
    } else if (quantifier === "{") {
      var bound = pattern.slice(i).match(/^\{([0-9]{1,4})(?:,([0-9]{0,4}))?\}/)
      if (!bound) return null
      min = Number(bound[1])
      max = bound[2] === undefined ? min : (bound[2] === "" ? 4096 : Number(bound[2]))
      if (max < min || max > 4096) return null
      i += bound[0].length
    }
    var matcher = null
    try { if (expression) matcher = new RegExp("^(?:" + expression + ")$") }
    catch (_) { return null }
    atoms.push({ literal: literal, matcher: matcher, min: min, max: max })
  }
  return atoms
}

function matchesValidation(atoms, value) {
  var previous = new Array(value.length + 1)
  previous[0] = true
  for (var a = 0; a < atoms.length; a++) {
    var atom = atoms[a], prefix = [0], next = [], run = 0
    for (var p = 0; p <= value.length; p++) prefix[p + 1] = prefix[p] + (previous[p] ? 1 : 0)
    for (var end = 0; end <= value.length; end++) {
      if (end) {
        var character = value.charAt(end - 1)
        run = (atom.matcher ? atom.matcher.test(character) : atom.literal === character) ? run + 1 : 0
      }
      var low = Math.max(0, end - atom.max, end - run), high = end - atom.min
      next[end] = high >= low && prefix[high + 1] > prefix[low]
    }
    previous = next
  }
  return previous[value.length] === true
}

function validateArguments(specs, values) {
  var fields = normalizeSpecs(specs)
  var input = Array.isArray(values) ? values : []
  var raw = [], errors = [], encoded = []
  for (var i = 0; i < fields.length; i++) {
    var field = fields[i]
    var value = input[i] === undefined || input[i] === null || input[i] === "" ? field.default : String(input[i])
    var error = ""
    if (!value && !field.optional) error = field.placeholder + " is required"
    else if (value.indexOf("\0") >= 0 || value.length > 4096) error = "Value is too long or contains a NUL character"
    else if (value && field.options.length && !field.options.some(function(option) { return option.value === value })) error = "Choose one of the listed options"
    else if (value && field.type === "number" && (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value) || !isFinite(Number(value)))) error = "Enter a finite number"
    else if (value && field.type === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) error = "Enter an email address"
    else if (value && field.type === "url" && !/^https?:\/\/[^\s\u0000-\u001f]+$/i.test(value)) error = "Enter an HTTP or HTTPS URL"
    if (!error && value && field.validation) {
      var atoms = compileValidation(field.validation)
      if (!atoms) error = "Unsupported validation pattern"
      else if (!matchesValidation(atoms, value)) error = "Value does not match the required format"
    }
    raw.push(value)
    errors.push(error)
  }
  if (input.length > fields.length) errors.push("Too many arguments")
  var first = errors.filter(function(value) { return value !== "" })[0] || ""
  if (!first) {
    try { encoded = raw.map(function(value, index) { return fields[index].percentEncoded ? encodeURIComponent(value) : value }) }
    catch (_) { first = "Value contains invalid Unicode" }
  }
  return { ok: !first, values: raw, args: first ? [] : encoded, errors: errors, error: first }
}

function buildArgv(path, specs, values) {
  var result = validateArguments(specs, values)
  if (!validPath(path)) { result.ok = false; result.error = "Script path must be absolute" }
  result.argv = result.ok ? [path].concat(result.args) : []
  return result
}

function validPath(path) {
  return typeof path === "string" && path.charAt(0) === "/" && path.indexOf("\0") < 0 && path.length <= 4096
}

function validArgv(argv) {
  return Array.isArray(argv) && argv.length > 0 && argv.length <= 64
    && argv.every(function(value) { return typeof value === "string" && value.indexOf("\0") < 0 && value.length <= 4096 })
    && argv[0].length > 0
}

function validateAction(action) {
  if (!action || typeof action !== "object" || Array.isArray(action)) return null
  if (action.type === "copy" && typeof action.text === "string" && action.text.indexOf("\0") < 0) return { type: "copy", text: action.text }
  if (action.type === "open" && validPath(action.path)) return { type: "open", path: action.path }
  if (action.type === "url" && typeof action.url === "string" && /^https?:\/\/[^\s\u0000-\u001f]+$/i.test(action.url)) return { type: "url", url: action.url }
  if (action.type === "argv" && validArgv(action.argv)) return { type: "argv", argv: action.argv.slice() }
  return null
}

function byteLength(text) {
  try { return unescape(encodeURIComponent(text)).length } catch (_) { return BYTE_LIMIT + 1 }
}

function resultKey(path, requestId, id) {
  return "script-result:" + JSON.stringify([path, requestId, id])
}

function parseResults(text, path, requestId) {
  function failure(message) { return { ok: false, records: [], error: message } }
  if (typeof text !== "string" || byteLength(text) > BYTE_LIMIT) return failure("Script output exceeded 64 KiB")
  if (!validPath(path)) return failure("Invalid script path")
  var lines = text.split("\n")
  if (lines[lines.length - 1] === "") lines.pop()
  if (!lines.length) return failure("Missing results protocol header")
  var header
  try { header = JSON.parse(lines[0]) } catch (_) { return failure("Invalid results protocol header") }
  if (!header || header.version !== 1 || Array.isArray(header)) return failure("Unsupported results protocol version")
  if (lines.length - 1 > ROW_LIMIT) return failure("Script output exceeded 200 rows")
  var records = [], seen = Object.create(null)
  for (var i = 1; i < lines.length; i++) {
    var row
    try { row = JSON.parse(lines[i]) } catch (_) { return failure("Invalid JSON on result line " + (i + 1)) }
    if (!row || typeof row.id !== "string" || !row.id || row.id.length > 200 || /[\u0000-\u001f]/.test(row.id) || seen[row.id]) return failure("Invalid or duplicate result ID")
    if (typeof row.title !== "string" || !row.title || row.title.length > 1000 || /[\u0000-\u001f]/.test(row.title)) return failure("Invalid result title")
    if (row.subtitle !== undefined && (typeof row.subtitle !== "string" || row.subtitle.length > 2000 || /[\u0000-\u001f]/.test(row.subtitle))) return failure("Invalid result subtitle")
    var action = validateAction(row.action)
    if (!action) return failure("Unsupported or invalid result action")
    seen[row.id] = true
    records.push({ id: row.id, key: resultKey(path, requestId, row.id), title: row.title, subtitle: row.subtitle || "", action: action,
      needsConfirmation: action.type === "argv", sourcePath: path, requestId: requestId })
  }
  return { ok: true, records: records, error: "" }
}

function resolveRecord(records, id, generation, path, currentGeneration) {
  if (generation !== currentGeneration) return null
  for (var i = 0; i < records.length; i++) {
    var record = records[i]
    if (record.id !== id || record.requestId !== generation || record.sourcePath !== path) continue
    var action = validateAction(record.action)
    if (!action) return null
    return { id: record.id, key: resultKey(path, generation, id), title: record.title, subtitle: record.subtitle,
      action: action, needsConfirmation: action.type === "argv", sourcePath: path, requestId: generation }
  }
  return null
}

// timeout owns the whole pipeline group, including cancellation via TERM.
// stderr is deliberately discarded before collection; stdout is capped on disk
// before it reaches QML. Script/arguments are positional values, never shell code.
var RESULTS_SUPERVISOR = [
  'export LC_ALL=C',
  '[ -f "$1" ] && [ -x "$1" ] || exit 126',
  'tmp=$(mktemp -d) || exit 125',
  'trap \'rm -rf -- "$tmp"\' EXIT',
  '"$@" 2>/dev/null | {',
  '  head -c 65537 > "$tmp/output" || exit 125',
  '  size=$(wc -c < "$tmp/output")',
  '  if ((size > 65536)); then exit 123; fi',
  '  cat -- "$tmp/output"',
  '}',
  's=("${PIPESTATUS[@]}")',
  'if ((s[1] != 0)); then exit "${s[1]}"; fi',
  'if ((s[0] != 0)); then exit 122; fi'
].join("\n")

function resultsCommand(path, args) {
  if (!validPath(path) || !Array.isArray(args) || !validArgv([path].concat(args))) return null
  return ["timeout", "--kill-after=1s", "10s", "bash", "-c", RESULTS_SUPERVISOR, "omacast-script-results", path].concat(args)
}

// Model.js captures this namespace when loaded through Qt.include.
var ScriptModelApi = { validateArguments: validateArguments }

if (typeof module !== "undefined") module.exports = {
  normalizeSpecs: normalizeSpecs, validateArguments: validateArguments, buildArgv: buildArgv,
  validPath: validPath, validArgv: validArgv, validateAction: validateAction,
  parseResults: parseResults, resultKey: resultKey, resolveRecord: resolveRecord, resultsCommand: resultsCommand
}
