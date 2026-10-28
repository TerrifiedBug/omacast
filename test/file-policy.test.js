const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs/promises")
const os = require("node:os")
const path = require("node:path")
const { promisify } = require("node:util")
const execFile = promisify(require("node:child_process").execFile)
const Policy = require("../FilePolicy.js")
const harness = require("./qml-harness.js")

test("named roots normalize traversal without altering literal pathname characters", () => {
  const roots = Policy.normalizeRoots({ fileRoots: [
    { name: " Work ", path: "~/one/../space\tand\nline" },
    { name: "work", path: "/duplicate" }, { name: "bad name", path: "/bad" },
    { name: "Other", path: "/other" }
  ] }, "/home/person")
  assert.deepEqual(roots, [{ name: "Work", path: "/home/person/space\tand\nline" }, { name: "Other", path: "/other" }])
  assert.equal(Policy.selectRoot(roots, "WORK"), roots[0])
  assert.equal(Policy.selectRoot(roots, "missing"), null)
  assert.deepEqual(Policy.normalizeRoots({}, "/home/person"), [{ name: "Home", path: "/home/person" }])
  assert.equal(Policy.request("/other/../escape", "/other", "/home/person", {}, "preview").ok, false)
  assert.equal(Policy.contains("/home/person", "/home/person-other/file"), false)
})

test("protected paths cover alternate preview purposes and explicit allowances", () => {
  for (const purpose of ["preview", "image", "content", "root"]) {
    for (const file of [".ssh/id_ed25519", ".cache/image.png", "project/.env.production", "project/credentials.json", "project/session.sqlite"]) {
      const full = "/home/person/" + file
      assert.equal(Policy.request(full, "/home/person", "/home/person", {}, purpose).ok, false, purpose + ": " + file)
      assert.equal(Policy.request(full, "/home/person", "/home/person", { allowProtectedPaths: [full] }, purpose).ok, true)
    }
  }
  assert.equal(Policy.request("/home/person/.env", "/home/person", "/home/person", { protectPreviews: false }, "image").ok, true)
  assert.equal(Policy.request("/home/person/.env", "/home/person", "/home/person", { protectPreviews: false }, "content").ok, false)
  assert.equal(Policy.request("/home/person/.env", "/home/person", "/home/person", { allowProtectedPaths: ["/home/person/.ENV"] }, "preview").ok, false)
})

test("content search excludes secrets before rg is invoked and never follows links", async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omacast-policy-"))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const home = path.join(dir, "home"), root = path.join(home, "work"), bin = path.join(dir, "bin")
  await fs.mkdir(root, { recursive: true })
  await fs.mkdir(bin)
  const publicFile = path.join(root, "-literal\tand\nfile.txt")
  const secret = path.join(root, ".env.production"), external = path.join(dir, "outside.txt")
  for (const file of [publicFile, secret, external]) await fs.writeFile(file, "literal [needle] -- no regex\n")
  await fs.writeFile(secret + ".backup", "literal [needle]")
  await fs.mkdir(path.join(root, ".ssh"))
  const protectedChild = path.join(root, ".ssh", "ordinary-name.txt")
  await fs.writeFile(protectedChild, "literal [needle]")
  await fs.symlink(external, path.join(root, "linked.txt"))
  await fs.mkdir(path.join(home, ".ssh"))
  await fs.writeFile(path.join(home, ".ssh", "config"), "literal [needle]")
  await fs.symlink(path.join(home, ".ssh"), path.join(root, "linked-dir"))
  await fs.mkdir(path.join(root, "ignored"))
  await fs.writeFile(path.join(root, ".gitignore"), "ignored/\n")
  await fs.writeFile(path.join(root, "ignored", "private.txt"), "literal [needle]")
  const rg = (await execFile("sh", ["-c", "command -v rg"])).stdout.trim()
  const log = path.join(dir, "rg-log")
  await fs.writeFile(path.join(bin, "rg"), '#!/bin/bash\nfor arg; do if [[ "$arg" == --files ]]; then exec "$RG_REAL" "$@"; fi; done\nafter=0\nfor arg; do if ((after == 2)); then printf "%s\\0" "$arg" >> "$RG_LOG"; elif ((after == 1)); then after=2; elif [[ "$arg" == -- ]]; then after=1; fi; done\nexec "$RG_REAL" "$@"\n', { mode: 0o755 })
  const env = { ...process.env, PATH: bin + ":" + process.env.PATH, RG_LOG: log, RG_REAL: rg }
  async function search(config) {
    const argv = Policy.contentCommand(root, "literal [needle]", home, config)
    const result = await execFile(argv[0], argv.slice(1), { env, encoding: "buffer" })
    return result.stdout.toString().split("\0").filter(Boolean)
  }
  assert.deepEqual(await search({}), [publicFile])
  const firstReads = (await fs.readFile(log, "utf8")).split("\0").filter(Boolean)
  assert.ok(firstReads.includes(publicFile))
  assert.ok(!firstReads.includes(secret))
  assert.ok(!firstReads.some(file => file.includes("/ignored/") || file.includes("/linked") || file.includes("/.ssh/") || file === secret + ".backup"))
  await fs.writeFile(log, "")
  assert.deepEqual((await search({ allowProtectedPaths: [secret] })).sort(), [publicFile, secret].sort())
  const allowedReads = (await fs.readFile(log, "utf8")).split("\0").filter(Boolean)
  assert.ok(allowedReads.includes(secret))
  assert.ok(!allowedReads.some(file => file.includes("/ignored/") || file.includes("/linked") || file.includes("/.ssh/") || file === secret + ".backup"))
  assert.deepEqual((await search({ allowProtectedPaths: [protectedChild] })).sort(), [publicFile, protectedChild].sort())
})

test("abundant content matches stop at the row cap with truncated status", { timeout: 15000 }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omacast-content-cap-"))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  await Promise.all(Array.from({ length: 600 }, (_, i) => fs.writeFile(path.join(dir, "match-" + i), "cap needle\n")))
  const argv = Policy.contentCommand(dir, "cap needle", dir, {})
  let failure
  try { await execFile(argv[0], argv.slice(1), { encoding: "buffer", timeout: 10000 }) } catch (error) { failure = error }
  assert.ok(failure)
  assert.equal(failure.code, 3)
  assert.equal(failure.stdout.toString().split("\0").filter(Boolean).length, 200)
})

async function pathHarness(t) {
  return harness(t, {
    harness: "file-policy-harness.qml",
    files: ["PathPolicy.qml", "FilePolicy.js"],
    env: dir => ({ PATH: path.join(dir, "bin") + ":" + process.env.PATH }),
    prepare: async dir => {
      await fs.mkdir(path.join(dir, "bin"))
      await fs.writeFile(path.join(dir, "bin", "realpath"), '#!/bin/bash\nprintf "requested\\n" >> "$HOME/path-requests"\nif [[ "$3" == *stall.txt ]]; then sleep 30; fi\nexec /usr/bin/realpath "$@"\n', { mode: 0o755 })
      await fs.mkdir(path.join(dir, "work"))
      await fs.mkdir(path.join(dir, ".ssh"))
      await fs.writeFile(path.join(dir, "work", "-tab\tnewline\n.png"), "not read by metadata gate")
      await fs.writeFile(path.join(dir, ".ssh", "image.png"), "sensitive")
      await fs.writeFile(path.join(dir, "outside.txt"), "outside")
      await fs.symlink(path.join(dir, ".ssh", "image.png"), path.join(dir, "work", "alias.png"))
      await fs.symlink(path.join(dir, "outside.txt"), path.join(dir, "work", "escape.txt"))
    }
  })
}

async function inspect(h, key, file, purpose = "preview", rootPath = h.dir) {
  const event = h.changed(state => state && state.events.some(item => item.key === key))
  await h.command("inspect", { key, path: file, purpose, rootPath })
  const state = await event
  return state.events.find(item => item.key === key)
}

test("canonical policy rejects symlink escapes and image aliases to protected files", { timeout: 15000 }, async t => {
  const h = await pathHarness(t)
  if (!h) return
  const work = path.join(h.dir, "work")
  const image = await inspect(h, "image", path.join(work, "alias.png"), "image")
  assert.equal(image.allowed, false)
  const escape = await inspect(h, "escape", path.join(work, "escape.txt"), "preview", work)
  assert.equal(escape.allowed, false)
  const ordinary = path.join(work, "-tab\tnewline\n.png")
  assert.deepEqual((({ allowed, path }) => ({ allowed, path }))(await inspect(h, "literal", ordinary, "image", work)), { allowed: true, path: ordinary })
  await h.command("config", { config: { allowProtectedPaths: [path.join(h.dir, ".ssh", "image.png")] } })
  assert.equal((await inspect(h, "override", path.join(work, "alias.png"), "image")).allowed, true)
  await h.command("config", { config: { allowProtectedPaths: [path.join(work, "alias.png")] } })
  assert.equal((await inspect(h, "canonical-override", path.join(h.dir, ".ssh", "image.png"), "image")).allowed, true)
})

test("path replacement publishes only the current request", { timeout: 15000 }, async t => {
  const h = await pathHarness(t)
  if (!h) return
  const current = path.join(h.dir, "work", "-tab\tnewline\n.png")
  const ready = h.changed(state => state && state.events.some(item => item.key === "current"))
  await h.command("replace", { key: "current", oldPath: path.join(h.dir, "outside.txt"), path: current })
  const state = await ready
  assert.equal(state.events.some(item => item.key === "obsolete"), false)
  assert.equal(state.events.find(item => item.key === "current").allowed, true)
})

test("path policy does no discovery on construction/configuration and suppresses cancellation", { timeout: 15000 }, async t => {
  const h = await pathHarness(t)
  if (!h) return
  await h.command("snapshot")
  await h.command("config", { config: { allowProtectedPaths: [path.join(h.dir, ".ssh")] } })
  await assert.rejects(fs.stat(path.join(h.dir, "path-requests")), { code: "ENOENT" })
  await h.command("cancelRequest", { key: "cancelled", path: path.join(h.dir, "outside.txt") })
  const next = await inspect(h, "after-cancel", path.join(h.dir, "outside.txt"))
  assert.equal(next.allowed, true)
  const snapshot = await h.command("snapshot")
  assert.equal(snapshot.state.events.some(item => item.key === "cancelled"), false)
})

test("realpath work has a bounded deadline and reports failure without a readable path", { timeout: 15000 }, async t => {
  const h = await pathHarness(t)
  if (!h) return
  await fs.writeFile(path.join(h.dir, "stall.txt"), "not read")
  const result = await inspect(h, "timeout", path.join(h.dir, "stall.txt"))
  assert.equal(result.allowed, false)
  assert.equal(result.path, "")
  assert.match(result.message, /timed out/)
})
