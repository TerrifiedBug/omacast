// Identity records executable intent, never a rendered label or a cached checkmark.
var PRESENTATION = { title: true, subtitle: true, label: true, icon: true,
  iconFont: true, preview: true, score: true, order: true, section: true, accessory: true,
  checkedResult: true, primaryLabel: true, secondaryLabel: true, fields: true }

function canonical(value) {
  if (value === null || typeof value !== "object") return value
  if (Array.isArray(value)) return value.map(canonical)
  var result = {}
  Object.keys(value).sort().forEach(function(key) {
    if (typeof value[key] !== "undefined") result[key] = canonical(value[key])
  })
  return result
}

function intentFields(value) {
  var result = {}
  Object.keys(value || {}).forEach(function(key) {
    if (!PRESENTATION[key] && key !== "payload") result[key] = value[key]
  })
  return result
}

function identity(item) {
  if (!item || typeof item !== "object") return ""
  var intent = intentFields(item)
  if (item.payload) intent.payload = intentFields(item.payload)
  return JSON.stringify(canonical(intent))
}

function validArgv(argv) {
  return Array.isArray(argv) && argv.length > 0 && argv.length <= 256
    && argv.every(function(arg) { return typeof arg === "string" && arg.indexOf("\u0000") < 0 && arg.length <= 65536 })
    && argv[0].length > 0 && argv.join("").length <= 262144
}

function parseProcessStat(text) {
  var match = /^([1-9][0-9]*) \(([\s\S]*)\) ([A-Za-z]) ([\s\S]*)$/.exec(String(text || "").trim())
  if (!match) return null
  var fields = match[4].trim().split(/\s+/)
  // fields starts at ppid (field 4); starttime is field 22. Keep ticks as a
  // decimal string: an identity must not round through a JavaScript number.
  if (fields.length < 19 || !/^\d+$/.test(fields[18])) return null
  return { pid: match[1], startTime: fields[18] }
}

function sameProcess(text, pid, startTime) {
  var current = parseProcessStat(text)
  return !!current && /^[1-9][0-9]*$/.test(String(pid)) && /^\d+$/.test(String(startTime))
    && current.pid === String(pid) && current.startTime === String(startTime)
}

// pidfd binds the final signal to the inspected process, even if its PID is
// recycled between the procfs read and delivery. Refuse without that support.
var SIGNAL_WORKER = [
  "import os, signal, sys",
  "pid, ticks, force = int(sys.argv[1]), sys.argv[2], sys.argv[3] == '1'",
  "try:",
  " fd = os.pidfd_open(pid, 0)",
  " try:",
  "  if os.stat('/proc/%d' % pid).st_uid != os.geteuid(): sys.exit(1)",
  "  with open('/proc/%d/stat' % pid) as f: stat = f.read()",
  "  tail = stat[stat.rfind(')') + 2:].split()",
  "  if len(tail) < 20 or tail[19] != ticks: sys.exit(1)",
  "  signal.pidfd_send_signal(fd, signal.SIGKILL if force else signal.SIGTERM)",
  " finally: os.close(fd)",
  "except (OSError, ValueError, AttributeError): sys.exit(1)"
].join("\n")

function signalCommand(pid, force, startTime) {
  if (!/^[1-9][0-9]*$/.test(String(pid)) || !/^\d+$/.test(String(startTime))) return []
  return ["python3", "-c", SIGNAL_WORKER, String(pid), String(startTime), force ? "1" : "0"]
}

// Only this fixed supervisor is interpreted. Every user argument crosses exec
// literally. The child owns a fresh session; cancellation never signals qs.
var EXECUTION_WORKER = [
  "import os, selectors, signal, subprocess, sys, time",
  "limit, duration = int(sys.argv[1]), int(sys.argv[2]) / 1000",
  "cancelled = False",
  "def cancel(sig, frame):",
  " global cancelled",
  " cancelled = True",
  "signal.signal(signal.SIGTERM, cancel)",
  "signal.signal(signal.SIGINT, cancel)",
  // The forked owner watches a private lifetime pipe. Even SIGKILL of the QML
  // Process closes that pipe, so unloading cannot strand its execution group.
  "control, lifetime = os.pipe()",
  "owner = os.fork()",
  "if owner:",
  " os.close(control)",
  " def release(sig, frame):",
  "  global lifetime",
  "  if lifetime >= 0: os.close(lifetime); lifetime = -1",
  " signal.signal(signal.SIGTERM, release)",
  " signal.signal(signal.SIGINT, release)",
  " try:",
  "  _, result = os.waitpid(owner, 0)",
  " finally:",
  "  if lifetime >= 0: os.close(lifetime)",
  " sys.exit(os.waitstatus_to_exitcode(result))",
  "os.close(lifetime)",
  "try:",
  " child = subprocess.Popen(sys.argv[3:], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True)",
  "except FileNotFoundError: sys.exit(120)",
  "except (OSError, ValueError): sys.exit(125)",
  "def group(sig):",
  " try: os.killpg(child.pid, sig)",
  " except ProcessLookupError: pass",
  "def exited():",
  " return os.waitid(os.P_PID, child.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT)",
  "selector = selectors.DefaultSelector()",
  "selector.register(child.stdout, selectors.EVENT_READ)",
  "os.set_blocking(child.stdout.fileno(), False)",
  "selector.register(control, selectors.EVENT_READ)",
  "deadline, used, status = time.monotonic() + duration, 0, 0",
  "drain_until = None",
  "try:",
  " while True:",
  "  result, now = exited(), time.monotonic()",
  "  if cancelled: status = 124; break",
  // A deliberately detached session may retain the pipe after the command
  // exits. Drain briefly, then use the actual leader status, not that pipe.
  "  if result is not None:",
  "   if drain_until is None: drain_until = now + 0.05",
  "   if child.stdout.fileno() not in selector.get_map() or now >= drain_until: break",
  "  elif now >= deadline: status = 122; break",
  "  until = drain_until if result is not None else deadline",
  "  for key, events in selector.select(min(0.01, max(0, until - now))):",
  "   if key.fd == control: cancelled = True; status = 124; break",
  "   data = os.read(key.fd, min(8192, limit - used + 1))",
  "   if not data: selector.unregister(key.fileobj); continue",
  "   remaining = limit - used",
  "   sys.stdout.buffer.write(data[:remaining]); sys.stdout.buffer.flush()",
  "   used += len(data)",
  "   if used > limit: status = 123; break",
  "  if status: break",
  " if not status:",
  "  result = exited()",
  "  if result.si_code != os.CLD_EXITED or result.si_status != 0: status = 121",
  "finally:",
  " selector.close(); child.stdout.close()",
  " group(signal.SIGTERM)",
  // Retain group ownership through the grace period even when the direct child
  // has already exited: a grandchild may ignore TERM and hold no output pipe.
  " end = time.monotonic() + 0.2",
  " while time.monotonic() < end:",
  "  time.sleep(0.01)",
  " group(signal.SIGKILL)",
  " child.wait()",
  "sys.exit(124 if cancelled else status)"
].join("\n")

function executionCommand(argv, timeoutMs, byteLimit) {
  if (!validArgv(argv)) return []
  var duration = Math.max(1, Math.min(120000, Math.floor(Number(timeoutMs) || 10000)))
  var limit = Math.max(1, Math.min(262144, Math.floor(Number(byteLimit) || 65536)))
  return ["python3", "-c", EXECUTION_WORKER, String(limit), String(duration)].concat(argv)
}

function exitStatus(code, crashed) {
  if (crashed) return "nonzero"
  return ({ 0: "success", 120: "missing", 121: "nonzero", 122: "timeout", 123: "truncated", 124: "cancelled", 125: "invalid" })[code] || (code === 127 ? "missing" : "nonzero")
}

if (typeof module !== "undefined") module.exports = {
  identity: identity, validArgv: validArgv, parseProcessStat: parseProcessStat,
  sameProcess: sameProcess, signalCommand: signalCommand,
  executionCommand: executionCommand, exitStatus: exitStatus
}
