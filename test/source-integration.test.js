const test = require("node:test")
const assert = require("node:assert/strict")
const { chmod, mkdir, mkdtemp, rm, stat, writeFile } = require("node:fs/promises")
const path = require("node:path")
const { execFileSync } = require("node:child_process")
const harness = require("./qml-harness.js")
const os = require("node:os")

async function source(t, learning = true) {
  return harness(t, {
    harness: "source-integration-harness.qml",
    files: harness.sourceFiles,
    env: dir => ({PATH:path.join(dir, "bin") + ":/usr/bin:/bin"}),
    prepare: async dir => {
      for (const folder of [".config/omarchy/extensions", ".local/state/omarchy", "omarchy/default/omarchy", "omarchy/bin", "bin", "files", ".ssh"])
        await mkdir(path.join(dir, folder), { recursive: true })
      await writeFile(path.join(dir, ".bash_profile"), 'export PATH="$HOME/bin:/usr/bin:/bin"\n')
      await writeFile(path.join(dir, "bin/omarchy-toggle-nightlight"), '#!/bin/sh\nprintf invoked > "$HOME/nightlight-status"\n', {mode:0o755})
      await writeFile(path.join(dir, "bin/omarchy"), '#!/bin/sh\ncase "$1 $2" in "commands --json"|"plugin list") printf "[]";; "theme current") printf Fixture;; "default agent") printf fixture;; esac\n', {mode:0o755})
      await writeFile(path.join(dir, "bin/hyprctl"), '#!/bin/sh\nprintf "[]"\n', {mode:0o755})
      await writeFile(path.join(dir, "omarchy/bin/omarchy-menu-keybindings"), 'output_binding_records() { :; }\ndispatch_binding() { :; }\n')
      await writeFile(path.join(dir, ".config/omarchy/omacast.json"), JSON.stringify({queryLearning:learning}))
      await writeFile(path.join(dir, ".local/state/omarchy/omacast-state.json"), "{}")
      await chmod(path.join(dir, ".local/state/omarchy/omacast-state.json"), 0o644)
      await writeFile(path.join(dir, "omarchy/default/omarchy/omarchy-menu.jsonc"), JSON.stringify({"root": {label:"Root"}, "run":{label:"Run",action:"true"}}))
      await writeFile(path.join(dir, ".config/omarchy/extensions/omarchy-menu.jsonc"), "{}")
      await writeFile(path.join(dir, "child-status"), "")
      await writeFile(path.join(dir, "guard-status"), "")
      await writeFile(path.join(dir, "nightlight-status"), "idle")
    }
  })
}

test("Sources authorizes image publication and refuses protected credentials", {timeout:15000}, async t => {
  const h = await source(t)
  if (!h) return
  const protectedPath = path.join(h.dir, ".ssh", "secret.png")
  await writeFile(protectedPath, "private")
  const denied = h.changed(s => s && s.preview.key === "secret" && s.preview.text)
  await h.command("preview", {key:"secret",spec:{type:"image",path:protectedPath}})
  assert.equal((await denied).preview.kind, "text")
  const image = path.join(h.dir, "files", "image.png")
  await writeFile(image, "image")
  const allowed = h.changed(s => s && s.preview.key === "image" && s.preview.kind === "image")
  await h.command("preview", {key:"image",spec:{type:"image",path:image}})
  assert.equal((await allowed).preview.path, image)
})

test("Sources stores scoped learning as hashes and excludes transient contexts", {timeout:15000}, async t => {
  const h = await source(t)
  if (!h) return
  const learned = h.changed(s => s && Object.keys(s.store.queryHistory).length === 1)
  await h.command("use", {key:"app:editor",query:"sensitive query",scope:"root"})
  const history = (await learned).store.queryHistory
  assert.equal(Object.keys(history).length, 1)
  assert.match(Object.keys(history)[0], /^[a-f0-9]{32}$/)
  assert.equal(JSON.stringify(history).includes("sensitive query"), false)
  const excluded = await h.command("use", {key:"app:editor",query:"clipboard secret",scope:"clipboard"})
  assert.deepEqual(excluded.state.store.queryHistory, history)
})

test("Sources makes existing public state private before learning and preserves private atomic saves", {timeout:15000}, async t => {
  const h = await source(t, false)
  if (!h) return
  const statePath = path.join(h.dir, ".local/state/omarchy/omacast-state.json")
  assert.equal((await stat(statePath)).mode & 0o777, 0o644)
  await h.command("config", {edit:{op:"set",key:"queryLearning",value:true}})
  const learned = h.changed(s => s && Object.keys(s.store.queryHistory).length === 1)
  await h.command("use", {key:"app:editor",query:"private context",scope:"root"})
  await learned
  assert.equal((await stat(statePath)).mode & 0o777, 0o600)
  const saved = h.changed(s => s && s.persisted.usage && s.persisted.usage["app:other"] && Object.keys(s.persisted.queryHistory || {}).length === 1)
  await h.command("use", {key:"app:other"})
  await saved
  const disk = JSON.parse(await h.bytes(".local/state/omarchy/omacast-state.json"))
  assert.equal(Object.keys(disk.queryHistory).length, 1)
  assert.equal((await stat(statePath)).mode & 0o777, 0o600)
})

test("Sources rejects changed menu intent before scheduling an action", {timeout:15000}, async t => {
  const h = await source(t)
  if (!h) return
  const item = {key:"menu:run",payload:{kind:"menu",id:"run"}}
  const initial = await h.command("resolve", {item})
  assert.equal(initial.result.ok, true)
  await h.put("omarchy/default/omarchy/omarchy-menu.jsonc", JSON.stringify({root:{label:"Root"},run:{label:"Run",action:"false"}}))
  const refused = await h.command("menu", {menuId:"run",token:initial.result.token})
  assert.equal(refused.result, false)
  assert.equal(refused.state.operations.at(-1).status, "stale")
})

test("Sources worker rechecks ancestor availability before running menu action", {timeout:15000}, async t => {
  const h = await source(t)
  if (!h) return
  await h.put("omarchy/default/omarchy/omarchy-menu.jsonc", JSON.stringify({
    root:{label:"Root",when:"false"},
    run:{label:"Run",action:"touch \"$HOME/executed\""}
  }))
  const resolved = await h.command("resolve", {staleGuardCache:true,item:{key:"menu:run",payload:{kind:"menu",id:"run"}}})
  assert.equal(resolved.result.ok, true)
  const finished = h.changed(s => s && s.operations.some(op => op.key === "menu:run" && !op.ok))
  await h.command("menu", {staleGuardCache:true,menuId:"run",token:resolved.result.token})
  assert.equal((await finished).operations.at(-1).ok, false)
})

test("Sources dismisses before detached menu launch and does not cancel its long-lived child", {timeout:15000}, async t => {
  const h = await source(t, false)
  if (!h) return
  execFileSync("mkfifo", ["--", path.join(h.dir, "release")])
  await h.command("open")
  await h.put("omarchy/default/omarchy/omarchy-menu.jsonc", JSON.stringify({
    root:{label:"Root"},
    run:{label:"Run",action:"timeout 5 bash -c 'printf started > \"$HOME/child-status\"; IFS= read -r line < \"$HOME/release\"; printf survived > \"$HOME/child-status\"'"}
  }))
  const resolved = await h.command("resolve", {item:{key:"menu:run",payload:{kind:"menu",id:"run"}}})
  assert.equal(resolved.result.ok, true)
  const started = h.changed(s => s && s.childStatus === "started")
  await h.command("menu", {menuId:"run",token:resolved.result.token,autoLaunch:true})
  assert.equal((await started).opened, false)
  const survived = h.changed(s => s && s.childStatus === "survived")
  await writeFile(path.join(h.dir, "release"), "continue\n")
  assert.equal((await survived).opened, false)
})

test("Sources preserves admitted completion and literal keywordless alias arguments", {timeout:15000}, async t => {
  const h = await source(t, false)
  if (!h) return
  for (const [index, entry] of [
    {name:"Work Search",keyword:"work",url:"https://example.test/?q={argument}"},
    {name:"No keyword",keyword:"",url:"https://example.test/?q={argument}"}
  ].entries()) {
    await h.command("config", {edit:{op:"add",kind:"quicklinks"}})
    for (const [field, value] of Object.entries(entry))
      await h.command("config", {edit:{op:"setField",kind:"quicklinks",index,field,value}})
  }
  const complete = await h.command("resolve", {item:{key:"ql:work",payload:{kind:"quicklink",complete:true,argument:""}}})
  assert.equal(complete.result.ok, true)
  assert.equal(complete.result.item.payload.complete, true)
  const alias = await h.command("alias", {key:"ql:No keyword",text:"lookup"})
  assert.equal(alias.result.ok, true)
  const argument = "literal words & punctuation"
  const admitted = await h.command("resolve", {item:{key:"ql:No keyword",payload:{kind:"quicklink",complete:false,argument}}})
  assert.equal(admitted.result.ok, true)
  assert.equal(admitted.result.item.payload.argument, argument)
  assert.equal(admitted.result.item.payload.complete, false)
  await h.command("config", {edit:{op:"add",kind:"snippets"}})
  for (const [field, value] of Object.entries({name:"Text",keyword:"",text:"Value: {argument}"}))
    await h.command("config", {edit:{op:"setField",kind:"snippets",index:0,field,value}})
  const snippet = await h.command("resolve", {item:{key:"snip:Text",payload:{kind:"snippet",complete:false,argument}}})
  assert.equal(snippet.result.ok, true)
  assert.equal(snippet.result.item.payload.argument, argument)
})

test("Sources keeps script keyword completion when structured forms are disabled", {timeout:15000}, async t => {
  const h = await source(t, false)
  if (!h) return
  const scriptPath = path.join(h.dir, "fixture.sh")
  const text = '#!/bin/sh\n# @omacast.schemaVersion 1\n# @omacast.title Fixture\n# @omacast.argument1 {\"type\":\"text\",\"placeholder\":\"value\"}\nprintf \"%s\" \"$1\"\n'
  await writeFile(scriptPath, text, {mode:0o755})
  await h.command("seedScript", {path:scriptPath,keyword:"fixture",text})
  await h.command("config", {edit:{op:"set",key:"scriptForms",value:false}})
  const complete = await h.command("resolve", {item:{key:"sc:" + scriptPath,payload:{kind:"script",complete:true,rawArgs:[]}}})
  assert.equal(complete.result.ok, true)
  assert.equal(complete.result.item.payload.complete, true)
  assert.equal(complete.result.item.payload.disabled, false)
  assert.equal(complete.result.item.payload.needsForm, false)
})

test("Sources reports shared owned-runner contention for process signals and toggles", {timeout:15000}, async t => {
  const h = await source(t, false)
  if (!h) return
  await h.put("omarchy/default/omarchy/omarchy-menu.jsonc", JSON.stringify({root:{label:"Root"},run:{label:"Toggle",action:"omarchy-toggle-nightlight"}}))
  const resolved = await h.command("resolve", {item:{key:"menu:run",payload:{kind:"menu",id:"run"}}})
  assert.equal(resolved.result.ok, true)
  const reply = await h.command("busyOwned", {menuId:"run",token:resolved.result.token})
  assert.deepEqual(reply.result, {first:true,signal:false,menu:false})
  assert.equal(reply.state.operations.some(op => op.key === "process:2147483647" && op.status === "busy" && op.message), true)
  assert.equal(reply.state.operations.some(op => op.key === "menu:run" && op.status === "busy" && op.message), true)
  assert.equal(reply.state.nightlightStatus, "idle")
})

test("Sources reports menu preparation contention rather than silently dropping activation", {timeout:15000}, async t => {
  const h = await source(t, false)
  if (!h) return
  const resolved = await h.command("resolve", {item:{key:"menu:run",payload:{kind:"menu",id:"run"}}})
  const reply = await h.command("busyMenus", {menuId:"run",token:resolved.result.token})
  assert.deepEqual(reply.result, {first:true,second:false})
  assert.equal(reply.state.operations.some(op => op.key === "menu:run" && op.status === "busy" && op.message), true)
})

test("Sources authorizes preview of scripts in an explicitly configured external folder", {timeout:15000}, async t => {
  const h = await source(t, false)
  if (!h) return
  const external = await mkdtemp(path.join(os.tmpdir(), "omacast-external-script-test-"))
  t.after(() => rm(external, {recursive:true,force:true}))
  const scriptPath = path.join(external, "script.sh")
  await writeFile(scriptPath, "external script preview\n", {mode:0o755})
  await h.command("config", {edit:{op:"set",key:"scriptDirs",value:[external]}})
  const preview = h.changed(s => s && s.preview.key === "sc:" + scriptPath)
  await h.command("preview", {key:"sc:" + scriptPath,spec:{type:"file",path:scriptPath}})
  assert.equal((await preview).preview.text, "external script preview\n")
})

test("Sources presents truncated script results as a visible failed provider", {timeout:15000}, async t => {
  const h = await source(t, false)
  if (!h) return
  const scriptPath = path.join(h.dir, "large-results.py")
  await writeFile(scriptPath, `#!/usr/bin/env python3\nimport json\nprint(json.dumps({"version":1}))\nprint("x"*70000)\n`, {mode:0o755})
  const failed = h.changed(s => s && s.resultsStatus === "truncated" && s.statuses.scriptResults.state === "failed" && s.statuses.scriptResults.message)
  await h.command("results", {path:scriptPath})
  const state = await failed
  assert.equal(state.resultCount, 0)
  assert.equal(state.statuses.scriptResults.state, "failed")
})

test("Sources retains bounded discovery rows with ready status and explicit partial coverage", {timeout:15000}, async t => {
  const h = await source(t, false)
  if (!h) return
  await Promise.all(Array.from({length:501}, (_, index) => writeFile(path.join(h.dir, "files", `file-${index}.txt`), "match")))
  const partial = h.changed(s => s && s.statuses.files.state === "ready" && s.statuses.files.message)
  await h.command("files")
  const state = await partial
  assert.equal(state.files.length, 500)
})

test("Sources refreshes the final checkmark when a successful toggle overtakes a gated guard batch", {timeout:15000}, async t => {
  const h = await source(t, false)
  if (!h) return
  await writeFile(path.join(h.dir, "bin", "omarchy-toggle-nightlight"), '#!/bin/sh\nprintf on > "$HOME/guard-value"\n', {mode:0o755})
  await h.put("guard-value", "off")
  await h.put("guard-gate", "gate")
  execFileSync("mkfifo", ["--", path.join(h.dir, "guard-release")])
  await h.command("open")
  const entered = h.changed(s => s && s.guardStatus === "entered")
  await h.put("omarchy/default/omarchy/omarchy-menu.jsonc", JSON.stringify({
    root:{label:"Root"},
    toggle:{label:"Nightlight",action:"omarchy-toggle-nightlight",checked:'old=$(cat "$HOME/guard-value"); if [ -e "$HOME/guard-gate" ]; then rm "$HOME/guard-gate"; printf entered > "$HOME/guard-status"; IFS= read -r release < "$HOME/guard-release"; fi; [ "$old" = on ]'}
  }))
  await entered
  const resolved = await h.command("resolve", {item:{key:"menu:toggle",payload:{kind:"menu",id:"toggle"}}})
  assert.equal(resolved.result.ok, true)
  const completed = h.changed(s => s && s.operations.some(op => op.key === "menu:toggle" && op.ok))
  await h.command("menu", {menuId:"toggle",token:resolved.result.token})
  await completed
  assert.equal(await h.bytes("guard-value"), "on")
  const refreshed = h.changed(s => s && s.checked.toggle === true)
  await writeFile(path.join(h.dir, "guard-release"), "release\n")
  assert.equal((await refreshed).checked.toggle, true)
})

test("Sources preserves SSH shell integration in the default terminal and rejects closed actions", {timeout:15000}, async t => {
  const h = await source(t, false)
  if (!h) return
  const host = "Work_alias-01.example"
  await h.put(".ssh/config", "Host " + host + "\n")
  await h.put(".bashrc", 'ssh() { command ssh "$@"; }\n')
  await mkdir(path.join(h.dir, "terminal-resources/shell-integration/bash"), {recursive:true})
  await h.put("terminal-resources/shell-integration/bash/ghostty.bash", 'ssh() { TERM=xterm-256color command ssh "$@"; }\n')
  await h.put("ssh-features", "ssh-env")
  await writeFile(path.join(h.dir, "bin/omarchy-launch-terminal"), `#!/usr/bin/env python3
import os, sys
assert sys.argv[1] == "-e"
os.environ["TERM"] = "xterm-ghostty"
os.environ["GHOSTTY_RESOURCES_DIR"] = os.path.join(os.environ["HOME"], "terminal-resources")
with open(os.path.join(os.environ["HOME"], "ssh-features")) as features:
    os.environ["GHOSTTY_SHELL_FEATURES"] = features.read()
os.execvp(sys.argv[2], sys.argv[2:])
`, {mode:0o755})
  await writeFile(path.join(h.dir, "bin/ssh"), `#!/usr/bin/env python3
import json, os, sys
with open(os.path.join(os.environ["HOME"], "ssh-invocation.json"), "w") as output:
    json.dump({"term":os.environ["TERM"],"argv":sys.argv[1:]}, output)
`, {mode:0o755})
  await h.command("config", {edit:{op:"set",key:"sshEnabled",value:true}})
  const discovered = h.changed(s => s.sshHosts.length === 1)
  await h.command("open")
  const state = await discovered
  const descriptor = state.sshHosts[0]
  const item = {key:descriptor.id,payload:descriptor}
  const resolved = await h.command("resolve", {item})
  assert.equal(resolved.result.ok, true)
  const finished = h.changed(s => s.operations.some(op => op.key === descriptor.id && op.ok))
  assert.equal((await h.command("navigation", {item,token:resolved.result.token})).result, true)
  await finished
  const invocation = JSON.parse(await h.bytes("ssh-invocation.json"))
  assert.equal(invocation.term, "xterm-256color", "The terminal must initialize its configured SSH compatibility wrapper")
  assert.deepEqual(invocation.argv, ["--",host])
  await h.put("ssh-features", "")
  const optedOut = h.changed(s => s.operations.length === 2 && s.operations[1].ok)
  assert.equal((await h.command("navigation", {item,token:resolved.result.token})).result, true)
  await optedOut
  assert.equal(JSON.parse(await h.bytes("ssh-invocation.json")).term, "xterm-ghostty", "Disabled terminal integration must not be sourced")
  await h.command("close")
  assert.equal((await h.command("navigation", {item,token:resolved.result.token})).result.ok, false)
  await h.command("config", {edit:{op:"set",key:"sshEnabled",value:false}})
  assert.deepEqual((await h.command("snapshot")).state.sshHosts, [])
})
