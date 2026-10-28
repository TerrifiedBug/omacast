const assert = require("node:assert/strict")
const test = require("node:test")
const { spawn } = require("node:child_process")
const { readFile } = require("node:fs/promises")
const Policy = require("../ActionPolicy.js")

function run(argv, options = {}) {
  const command = Policy.executionCommand(argv, options.timeout || 1000, options.limit || 1024)
  const proc = spawn(command[0], command.slice(1))
  const chunks = []
  proc.stdout.on("data", data => chunks.push(data))
  const done = new Promise((resolve, reject) => {
    proc.on("error", reject)
    proc.on("close", (code, signal) => resolve({ code, signal, output: Buffer.concat(chunks) }))
  })
  return { proc, done }
}

function python(code, ...args) { return ["python3", "-u", "-c", code, ...args] }

async function inactive(pid) {
  try {
    const text = await readFile(`/proc/${pid}/stat`, "utf8")
    return text.slice(text.lastIndexOf(")") + 2).startsWith("Z ")
  } catch (error) {
    if (error.code === "ENOENT") return true
    throw error
  }
}

test("typed action identity follows args and guards, not presentation", () => {
  const row = { key: "menu:one", title: "Old", payload: { kind: "menu", action: "printf one", args: ["a"], preview: { text: "old" } }, guards: ["test -e /a"] }
  const identity = Policy.identity(row)
  assert.equal(identity, Policy.identity({ guards: row.guards, payload: { preview: {}, args: ["a"], action: "printf one", kind: "menu" }, title: "New", key: row.key }))
  for (const change of [
    { ...row, payload: { ...row.payload, args: ["b"] } },
    { ...row, guards: ["test -e /b"] },
    { ...row, payload: { ...row.payload, action: "printf two" } },
    { ...row, payload: { ...row.payload, args: [1] } }
  ]) assert.notEqual(identity, Policy.identity(change))
  assert.notEqual(Policy.identity({ payload: { kind: "theme", name: "one" } }), Policy.identity({ payload: { kind: "theme", name: "two" } }))
})

test("proc stat handles parentheses and compares exact start ticks", () => {
  const fields = ["S", ...Array(18).fill("0"), "90071992547409931", "0"]
  const text = `234 (command ) with (parens)) ${fields.join(" ")}`
  assert.deepEqual(Policy.parseProcessStat(text), { pid: "234", startTime: "90071992547409931" })
  assert.equal(Policy.sameProcess(text, 234, "90071992547409931"), true)
  assert.equal(Policy.sameProcess(text, 234, "90071992547409930"), false)
  assert.equal(Policy.sameProcess(text, 235, "90071992547409931"), false)
  assert.equal(Policy.parseProcessStat("234 (short) S 0"), null)
  assert.deepEqual(Policy.signalCommand("234;touch nope", false, "1"), [])
})

test("owned execution preserves literal argv and distinguishes failures", async () => {
  const literal = "a b\n$(printf BAD); -- ' \""
  const success = await run(python("import sys; print(sys.argv[1], end='')", literal)).done
  assert.equal(Policy.exitStatus(success.code, !!success.signal), "success")
  assert.equal(success.output.toString(), literal)
  assert.equal(Policy.exitStatus((await run(["/definitely/missing/omacast"]).done).code, false), "missing")
  assert.equal(Policy.exitStatus((await run(python("raise SystemExit(7)")).done).code, false), "nonzero")
  assert.deepEqual(Policy.executionCommand(["echo", "bad\0arg"]), [])
})

test("stdout and stderr are capped before collection", async () => {
  for (const stream of ["stdout", "stderr"]) {
    const result = await run(python(`import sys; sys.${stream}.write('x' * 1000000)`), { limit: 257 }).done
    assert.equal(Policy.exitStatus(result.code, false), "truncated")
    assert.equal(result.output.length, 257)
  }
})

test("timeout owns TERM-resistant descendants", async () => {
  const script = "import os, signal, time; signal.signal(signal.SIGTERM, signal.SIG_IGN); pid=os.fork(); os.write(1, f'{os.getpid()} {pid}\\n'.encode()) if pid else None; time.sleep(30)"
  const result = await run(python(script), { timeout: 150 }).done
  assert.equal(Policy.exitStatus(result.code, false), "timeout")
  const pids = result.output.toString().trim().split(/\s+/).map(Number)
  assert.equal(pids.length, 2)
  for (const pid of pids) assert.equal(await inactive(pid), true)
})

test("leader exit wins over a detached descendant retaining the output pipe", async t => {
  for (const code of [0, 7]) {
    const script = "import subprocess, sys; child=subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'], start_new_session=True); print(child.pid, flush=True); sys.exit(int(sys.argv[1]))"
    const result = await run(python(script, String(code))).done
    const pid = Number(result.output.toString().trim())
    t.after(() => {
      try { process.kill(pid, "SIGKILL") } catch (error) { if (error.code !== "ESRCH") throw error }
    })
    assert.equal(Policy.exitStatus(result.code, false), code === 0 ? "success" : "nonzero")
    assert.equal(await inactive(pid), false)
  }
})

test("TERM cancellation and supervisor destruction clean the execution group", async () => {
  for (const sig of ["SIGTERM", "SIGKILL"]) {
    const job = run(python("import os, signal, time; signal.signal(signal.SIGTERM, signal.SIG_IGN); print(os.getpid(), flush=True); time.sleep(30)"), { timeout: 5000 })
    await new Promise(resolve => job.proc.stdout.once("data", resolve))
    job.proc.kill(sig)
    const result = await job.done
    if (sig === "SIGTERM") assert.equal(Policy.exitStatus(result.code, false), "cancelled")
    else assert.equal(result.signal, "SIGKILL")
    assert.equal(await inactive(Number(result.output.toString().trim())), true)
  }
})

test("pidfd signalling refuses stale ticks then signals the matching process", async t => {
  const child = spawn("sleep", ["30"])
  const closed = new Promise(resolve => child.once("close", resolve))
  t.after(() => child.kill("SIGKILL"))
  const stat = Policy.parseProcessStat(await readFile(`/proc/${child.pid}/stat`, "utf8"))
  async function signal(ticks) {
    const argv = Policy.signalCommand(child.pid, false, ticks)
    const sender = spawn(argv[0], argv.slice(1))
    return new Promise((resolve, reject) => { sender.on("error", reject); sender.on("close", resolve) })
  }
  assert.notEqual(await signal(String(BigInt(stat.startTime) + 1n)), 0)
  assert.equal(await inactive(child.pid), false)
  assert.equal(await signal(stat.startTime), 0)
  await closed
})
