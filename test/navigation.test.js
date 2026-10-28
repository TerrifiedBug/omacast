const test = require("node:test")
const assert = require("node:assert/strict")
const { mkdir, writeFile, readFile, mkdtemp, rm } = require("node:fs/promises")
const { execFileSync } = require("node:child_process")
const path = require("node:path")
const os = require("node:os")
const Navigation = require("../Navigation.js")
const Model = require("../Model.js")
const harness = require("./qml-harness.js")

test("SSH discovery admits literal aliases but never patterns, negations, or options", () => {
  const hosts = Navigation.sshHosts([{ path: "/fixture/config", text: 'Host=work *.internal !excluded -oProxyCommand=x\nHost "other" WORK\nHost user@remote [abc] ?\n' }])
  assert.deepEqual(hosts.map(item => item.host), ["work", "other"])
  assert.deepEqual(hosts[0].argv, ["ssh", "--", "work"])
  assert.equal(Navigation.sshHosts([{ text: "Host work", path: "/different" }])[0].id, hosts[0].id)
})

test("bookmark parsing supports explicit Chromium and Firefox exports, not executable URLs", () => {
  const records = Navigation.bookmarks([
    { path: "/chrome.json", document: { roots: { bookmark_bar: { children: [{ name: "Docs", url: "https://docs.test/a" }, { name: "Bad", url: "javascript:alert(1)" }] } } } },
    { path: "/firefox.json", document: { children: [{ title: "News", uri: "https://news.test/" }] } }
  ])
  assert.deepEqual(records.map(item => item.title), ["Docs", "News"])
  assert.throws(() => Navigation.bookmarks([{ path: "/wrong", document: { history: [] } }]))
  assert.throws(() => Navigation.bookmarks([{ path: "/broken", text: "{" }]))
})

test("long bookmark destinations retain pin alias and query-learning state", () => {
  const url = "https://docs.test/" + "long-path/".repeat(25)
  const [bookmark] = Navigation.bookmarks([{ path: "/bookmarks.json", document: { children: [{ title: "Long destination", uri: url }] } }])
  const [row] = Navigation.rows({ bookmarks: [bookmark] }, "bookmarks", "", Model.matchScore).map(Model.row)
  let state = Model.togglePin({}, row.key)
  const aliased = Model.setAlias(state, row.key, "longdocs", [])
  assert.equal(aliased.ok, true)
  const context = "a".repeat(32)
  state = Model.recordQueryUse(aliased.state, row.key, context, 1000)
  const restored = Model.normalizeState(JSON.parse(JSON.stringify(state)))
  assert.deepEqual(restored.pins, [row.key])
  assert.equal(restored.aliases[row.key], "longdocs")
  assert.equal(restored.queryHistory[context][row.key].count, 1)
  assert.equal(row.payload.url, url)
  const [again] = Navigation.bookmarks([{ path: "/bookmarks.json", document: { children: [{ title: "Renamed", uri: url }] } }])
  assert.equal(again.id, row.key)
})

test("plugin catalog uses enabled panel and overlay membership only", () => {
  const panels = Navigation.pluginPanels([
    { id: "local.panel", name: "Panel", kinds: ["panel"], enabled: true },
    { id: "local.overlay", kinds: ["overlay", "service"], enabled: true },
    { id: "local.disabled", kinds: ["panel"], enabled: false },
    { id: "local.widget", kinds: ["bar-widget"], enabled: true },
    { id: "-unsafe", kinds: ["panel"], enabled: true }
  ])
  assert.deepEqual(panels.map(item => item.pluginId), ["local.panel", "local.overlay"])
  assert.deepEqual(panels[0].argv, ["omarchy-shell", "shell", "summon", "local.panel", "{}"])
  assert.throws(() => Navigation.pluginPanels({ plugins: [] }))
})

test("activation refreshes plugin membership and refuses disabled or changed kinds", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "omacast-panel-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const cli = path.join(dir, "omarchy")
  await writeFile(cli, '#!/bin/sh\ncat "$HOME/membership.json"\n', { mode: 0o755 })
  await writeFile(path.join(dir, "omarchy-shell"), '#!/usr/bin/env python3\nimport json, os, sys\nwith open(os.path.join(os.environ["HOME"], "summon.json"), "w") as output: json.dump(sys.argv[1:], output)\n', { mode: 0o755 })
  const argv = Navigation.activationCommand("fixture.panel", cli)
  function activate() {
    return execFileSync(argv[0], argv.slice(1), { env: { ...process.env, HOME: dir, PATH: `${dir}:${process.env.PATH}` }, encoding: "utf8" })
  }
  for (const entry of [
    { id: "fixture.panel", enabled: false, kinds: ["panel"] },
    { id: "fixture.panel", enabled: true, kinds: ["service"] }
  ]) {
    await writeFile(path.join(dir, "membership.json"), JSON.stringify([entry]))
    assert.throws(activate)
    await assert.rejects(readFile(path.join(dir, "summon.json")), { code: "ENOENT" })
  }
  await writeFile(path.join(dir, "membership.json"), JSON.stringify([{ id: "fixture.panel", enabled: true, kinds: ["overlay"] }]))
  activate()
  const summoned = JSON.parse(await readFile(path.join(dir, "summon.json"), "utf8"))
  assert.deepEqual(summoned, ["shell", "summon", "fixture.panel", "{}"])
})

test("navigation rows retain stable distinct identities and lexical filtering", () => {
  const catalog = { projects: Navigation.projects(["/work/app", "/other/app", "/work/app"]), bookmarks: Navigation.bookmarks([{ path: "/bm", document: { children: [{ uri: "https://app.test/", title: "App docs" }] } }]) }
  const rows = Navigation.rows(catalog, "catalog", "", Model.matchScore).map(Model.row)
  assert.equal(rows.length, 3)
  assert.equal(new Set(rows.map(row => row.key)).size, 3)
  assert.equal(Navigation.rows(catalog, "projects", "unrelated", Model.matchScore).length, 0)
  assert.equal(Navigation.rows(catalog, "bookmarks", "docs", Model.matchScore).length, 1)
  assert.notEqual(Navigation.stableId("project", "/" + "a".repeat(1000)), Navigation.stableId("project", "/" + "a".repeat(999) + "b"))
})

test("local discovery bounds SSH Includes and reports missing/stale sources", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "omacast-navigation-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await mkdir(path.join(dir, ".ssh", "conf"), { recursive: true })
  await writeFile(path.join(dir, ".ssh", "config"), "Host primary\nInclude conf/*\nInclude missing\n")
  await writeFile(path.join(dir, ".ssh", "conf", "hosts"), "Host included\nInclude config\n")
  const doc = JSON.parse(execFileSync("python3", [path.join(__dirname, "..", "NavigationDiscovery.py"), "ssh", "{}", dir], { encoding: "utf8" }))
  assert.deepEqual(Navigation.sshHosts(doc.data).map(item => item.host), ["primary", "included"])
  assert.ok(doc.errors.some(message => message.includes("not found")))
})

test("bookmark discovery accepts exports above the SSH file cap and enforces its aggregate budget", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "omacast-bookmarks-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const bookmarkPath = path.join(dir, "bookmarks.json")
  await writeFile(bookmarkPath, JSON.stringify({ children: [{ title: "Larger export", uri: "https://large.test/" }], metadata: "x".repeat(300000) }))
  function discover(files) {
    return JSON.parse(execFileSync("python3", [path.join(__dirname, "..", "NavigationDiscovery.py"), "bookmarks", JSON.stringify({ bookmarkFiles: files }), dir], { encoding: "utf8", maxBuffer: 2097152 }))
  }
  const accepted = discover([bookmarkPath])
  assert.deepEqual(accepted.errors, [])
  assert.equal(Navigation.bookmarks(accepted.data)[0].title, "Larger export")
  const otherPaths = []
  for (let index = 0; index < 3; index++) {
    const file = path.join(dir, "extra-" + index + ".json")
    await writeFile(file, JSON.stringify({ children: [], metadata: "x".repeat(300000) }))
    otherPaths.push(file)
  }
  const bounded = discover([bookmarkPath, ...otherPaths])
  assert.equal(bounded.data.length, 3)
  assert.ok(bounded.errors.some(message => message.includes("budget exceeded")))
})

async function navigation(t) {
  return harness(t, {
    harness: "navigation-harness.qml",
    files: ["NavigationSources.qml", "Navigation.js", "NavigationDiscovery.py", "Model.js", "Learning.js", "ScriptModel.js"],
    env: dir => ({ PATH: `${path.join(dir, "bin")}:${process.env.PATH}` }),
    prepare: async dir => {
      await mkdir(path.join(dir, "bin"))
      await mkdir(path.join(dir, "projects", "alpha"), { recursive: true })
      await writeFile(path.join(dir, "bin", "omarchy"), `#!/bin/sh\nprintf called >> "$HOME/cli-calls"\nprintf '%s' '[{"id":"fixture.panel","name":"Fixture panel","kinds":["panel"],"enabled":true}]'\n`, { mode: 0o755 })
    }
  })
}

test("navigation enabled catalogs publish, resolve, disable immediately, and never call disabled CLI", { timeout: 15000 }, async t => {
  const h = await navigation(t)
  if (!h) return
  await h.command("open", { config: {} })
  await assert.rejects(h.bytes("cli-calls"), { code: "ENOENT" })
  const ready = h.changed(state => state.statuses.plugins?.state === "ready" && state.statuses.projects?.state === "ready")
  await h.command("config", { config: { projectsEnabled: true, projectRoots: [path.join(h.dir, "projects")], pluginPanelsEnabled: true } })
  const state = await ready
  assert.equal(state.projects[0].title, "alpha")
  assert.equal(state.plugins[0].title, "Fixture panel")
  const key = state.plugins[0].id
  assert.equal((await h.command("resolve", { key })).result.pluginId, "fixture.panel")
  const disabled = await h.command("config", { config: {} })
  assert.deepEqual(disabled.state.plugins, [])
  assert.equal(disabled.state.statuses.plugins.state, "disabled")
  assert.equal((await h.command("resolve", { key })).result, null)
  assert.equal((await h.command("retry", { source: "plugins" })).result, false)
  assert.equal(await h.bytes("cli-calls"), "called")
})

test("navigation source errors are retryable and repaired input replaces failure", { timeout: 15000 }, async t => {
  const h = await navigation(t)
  if (!h) return
  const bookmarkPath = path.join(h.dir, "bookmarks.json")
  const failed = h.changed(state => state.statuses.bookmarks?.state === "failed")
  await h.command("open", { config: { bookmarksEnabled: true, bookmarkFiles: [bookmarkPath] } })
  assert.equal((await failed).statuses.bookmarks.retryable, true)
  await h.put("bookmarks.json", JSON.stringify({ children: [{ title: "Recovered", uri: "https://recovered.test/" }] }))
  const ready = h.changed(state => state.statuses.bookmarks?.state === "ready")
  await h.command("retry", { source: "bookmarks" })
  assert.equal((await ready).bookmarks[0].title, "Recovered")
  const closed = await h.command("close")
  assert.equal(closed.state.bookmarks[0].title, "Recovered")
  assert.equal((await h.command("resolve", { key: closed.state.bookmarks[0].id })).result, null)
})

test("navigation opens with cached catalogs and unrelated settings do not rediscover", { timeout: 15000 }, async t => {
  const h = await navigation(t)
  if (!h) return
  const config = { projectsEnabled: true, projectRoots: [path.join(h.dir, "projects")], pluginPanelsEnabled: true }
  const loading = h.changed(state => state.statuses.projects?.state === "loading" && state.statuses.plugins?.state === "loading")
  const ready = h.changed(state => state.statuses.projects?.state === "ready" && state.statuses.plugins?.state === "ready")
  const opened = await h.command("open", { config })
  assert.notEqual(opened.state.statuses.projects.state, "loading", "opening defers discovery work")
  const loadingState = await loading
  assert.equal(loadingState.notifications, opened.state.notifications + 1, "one coherent loading notification")
  const cached = await ready
  const key = cached.plugins[0].id
  await writeFile(path.join(h.dir, "bin/omarchy"), "#!/bin/sh\nprintf unexpected >> \"$HOME/cli-calls\"\nprintf '[]'\n", { mode: 0o755 })
  const unrelated = await h.command("config", { config: { ...config, preview: true, resultLimit: 25 } })
  assert.deepEqual(unrelated.state.plugins, cached.plugins)
  assert.equal(unrelated.state.notifications, cached.notifications)
  const closed = await h.command("close")
  assert.deepEqual(closed.state.projects, cached.projects)
  assert.equal((await h.command("resolve", { key })).result, null)
  const reopened = await h.command("open", { config })
  assert.deepEqual(reopened.state.plugins, cached.plugins)
  assert.equal(reopened.state.notifications, cached.notifications)
  assert.equal((await h.command("resolve", { key })).result.pluginId, "fixture.panel")
  await h.command("refresh")
  await h.command("snapshot")
  assert.equal(await h.bytes("cli-calls"), "called")
  await mkdir(path.join(h.dir, "other-projects", "beta"), { recursive: true })
  const refreshed = h.changed(state => state.statuses.projects?.state === "ready" && state.projects[0]?.title === "beta")
  const changed = await h.command("config", { config: { ...config, projectRoots: [path.join(h.dir, "other-projects")] } })
  assert.deepEqual(changed.state.projects, [], "changed source configuration invalidates its own cached rows immediately")
  assert.deepEqual(changed.state.plugins, cached.plugins)
  assert.equal((await refreshed).projects[0].title, "beta")
  assert.equal(await h.bytes("cli-calls"), "called")
})

test("navigation cancellation rejects old discovery and disabling clears only its catalog", { timeout: 15000 }, async t => {
  const h = await navigation(t)
  if (!h) return
  await h.put("discovery-started", "")
  await writeFile(path.join(h.dir, "bin/omarchy"), `#!/usr/bin/env python3
import json, os, time
home = os.environ["HOME"]
with open(home + "/discovery-started", "w") as output: output.write("blocked")
while not os.path.exists(home + "/release-discovery"): time.sleep(0.01)
print(json.dumps([{"id":"old.panel","name":"Old panel","kinds":["panel"],"enabled":True}]))
`, { mode: 0o755 })
  const config = { projectsEnabled: true, projectRoots: [path.join(h.dir, "projects")], pluginPanelsEnabled: true }
  const started = h.changed(state => state.discoveryStarted === "blocked")
  await h.command("open", { config })
  const active = await started
  assert.equal(active.projects[0].title, "alpha")
  const closed = await h.command("close")
  assert.deepEqual(closed.state.projects, active.projects)
  const disabled = await h.command("config", { config: { ...config, pluginPanelsEnabled: false } })
  assert.deepEqual(disabled.state.projects, active.projects)
  assert.deepEqual(disabled.state.plugins, [])
  assert.equal(disabled.state.statuses.plugins.state, "disabled")
  await h.put("release-discovery", "release")
  await writeFile(path.join(h.dir, "bin/omarchy"), '#!/bin/sh\nprintf \'[{"id":"new.panel","name":"New panel","kinds":["panel"],"enabled":true}]\'\n', { mode: 0o755 })
  const ready = h.changed(state => state.statuses.plugins?.state === "ready")
  await h.command("open", { config })
  const fresh = await ready
  assert.equal(fresh.plugins[0].pluginId, "new.panel")
  assert.deepEqual(fresh.projects, active.projects)
  assert.equal((await h.command("resolve", { key: Navigation.pluginPanels([{ id: "old.panel", kinds: ["panel"], enabled: true }])[0].id })).result, null)
})
