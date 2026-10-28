const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const path = require('node:path')
const fs = require('node:fs/promises')
const { spawn } = require('node:child_process')
const harness = require('./qml-harness')
const files = ['Picker.qml', 'AgentAnswers.qml', 'SemanticSearch.qml', 'OptionalWorker.qml', 'bin/omacast_adapter.py']
async function setup(t, options = {}) {
  return harness(t, { files, harness: 'optional-harness.qml', ...options })
}
async function server(t, respond) {
  const requests = []
  const service = http.createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk
    const data = JSON.parse(body)
    requests.push({ url: request.url, data })
    respond(data, response)
  })
  await new Promise(resolve => service.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => { service.closeAllConnections(); service.close(resolve) }))
  return { endpoint: `http://127.0.0.1:${service.address().port}`, requests }
}

test('semantic uses real loopback HTTP vectors and keeps stable candidate identities', { timeout: 20000 }, async t => {
  const service = await server(t, (data, response) => {
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify({ embeddings: [[1, 0], [0, 1], [1, 0]] }))
  })
  const h = await setup(t)
  if (!h) return
  const landed = h.changed(state => state.semantic.status === 'ready')
  await h.command('semantic', { enabled: true, endpoint: service.endpoint, model: 'fixture-model', query: 'meaning',
    candidates: [{key: 'app:first', title: 'First'}, {key: 'app:second', title: 'Second'}] })
  const state = await landed
  assert.deepEqual(state.semantic.suggestions.map(row => row.key), ['app:second', 'app:first'])
  assert.equal(service.requests[0].url, '/api/embed')
  assert.equal(service.requests[0].data.model, 'fixture-model')
  assert.equal(state.semantic.suggestions[0].kind, 'semantic')
})

test('disabled and model-less semantic never send HTTP; remote endpoints fail before sending', { timeout: 20000 }, async t => {
  const service = await server(t, (data, response) => response.end('{}'))
  const h = await setup(t)
  if (!h) return
  assert.equal((await h.command('semantic', {enabled: false, endpoint: service.endpoint, model: 'x', query: 'q'})).semantic.status, 'disabled')
  assert.equal((await h.command('semantic', {enabled: true, endpoint: service.endpoint, query: 'q'})).semantic.status, 'failed')
  const failed = h.changed(state => state.semantic.status === 'failed')
  await h.command('semantic', {enabled: true, endpoint: 'http://example.com', model: 'x', query: 'q', candidates: [{key: 'x', title: 'x'}]})
  assert.equal((await failed).semantic.status, 'failed')
  assert.equal(service.requests.length, 0)
})

test('semantic cancellation does not publish a delayed HTTP response', { timeout: 20000 }, async t => {
  let release
  const received = new Promise(resolve => { release = resolve })
  let pending
  const service = await server(t, (data, response) => { pending = response; release() })
  const h = await setup(t)
  if (!h) return
  await h.command('semantic', {enabled: true, endpoint: service.endpoint, model: 'x', query: 'q', candidates: [{key: 'old', title: 'old'}]})
  await received
  await h.command('cancelSemantic')
  pending.end(JSON.stringify({embeddings: [[1], [1]]}))
  const state = await h.command('snapshot')
  assert.deepEqual(state.semantic.suggestions, [])
  assert.equal(state.semantic.status, 'empty')
})

test('picker selection returns literal data and rejects replaced request identities', { timeout: 20000 }, async t => {
  const h = await setup(t)
  if (!h) return
  const folder = path.join(h.dir, 'runtime', 'omacast-picker-test')
  await fs.mkdir(folder, {mode: 0o700})
  const request = path.join(folder, 'request.json')
  const id = 'a'.repeat(32)
  const doc = {version: 1, id, deadline: Date.now() / 1000 + 60, prompt: 'Choose', items: [{id: 'literal', title: 'Literal', value: '$(touch should-not-exist)'}]}
  await fs.writeFile(request, JSON.stringify(doc), {mode: 0o600})
  const ready = h.changed(state => state.picker.status === 'ready' && state.picker.requestId === id)
  await h.command('picker', {path: request})
  await ready
  const done = h.changed(state => state.picker.status === 'ready' && !state.picker.requestId)
  await h.command('select', {selection: 'literal'})
  await done
  const response = JSON.parse(await fs.readFile(path.join(folder, 'response.json'), 'utf8'))
  assert.equal(response.value, doc.items[0].value)
  await assert.rejects(fs.stat(path.join(h.dir, 'should-not-exist')), {code: 'ENOENT'})
  await fs.unlink(path.join(folder, 'response.json'))
  const readyAgain = h.changed(state => state.picker.requestId === id)
  await h.command('picker', {path: request})
  await readyAgain
  await fs.writeFile(request, JSON.stringify({...doc, id: 'b'.repeat(32)}))
  const failed = h.changed(state => state.picker.status === 'failed')
  await h.command('select', {selection: 'literal'})
  assert.equal((await failed).picker.status, 'failed')
  await assert.rejects(fs.stat(path.join(folder, 'response.json')), {code: 'ENOENT'})
})

test('inline answers require explicit send and run literal questions outside repository cwd', { timeout: 20000 }, async t => {
  const h = await setup(t)
  if (!h) return
  const script = path.join(h.dir, 'answer.py')
  await fs.writeFile(script, 'import os,sys,json\nprint(json.dumps({"cwd":os.getcwd(),"question":sys.argv[1]}))\n')
  const question = '@private-file\n$(do-not-run)'
  const ready = h.changed(state => state.agent.status === 'ready')
  await h.command('agent', {enabled: true, command: ['python3', script], prompt: question})
  const answer = JSON.parse((await ready).agent.answer)
  assert.ok(answer.question.endsWith(question))
  assert.ok(!answer.question.startsWith('@'))
  assert.ok(answer.cwd.startsWith(path.join(h.dir, 'runtime', 'omacast-answer-')))
  await assert.rejects(fs.stat(answer.cwd), {code: 'ENOENT'})
})

test('inline answer failures and output budgets are visible without executing answer text', { timeout: 20000 }, async t => {
  const h = await setup(t)
  if (!h) return
  const script = path.join(h.dir, 'oversize.py')
  await fs.writeFile(script, "print('x' * 70000)\n")
  const failed = h.changed(state => state.agent.status === 'failed')
  await h.command('agent', {enabled: true, command: ['python3', script], prompt: 'test'})
  assert.equal((await failed).agent.status, 'failed')
  assert.equal((await h.command('snapshot')).agent.answer, '')
  await fs.writeFile(script, "print('next result')\n")
  const recovered = h.changed(state => state.agent.status === 'ready')
  await h.command('agent', {enabled: true, command: ['python3', script], prompt: 'next'})
  assert.equal((await recovered).agent.answer, 'next result\n')
})

test('picker CLI completes the private response protocol and prints literal selection only', { timeout: 10000 }, async t => {
  const os = require('node:os')
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'omacast-picker-cli-'))
  t.after(() => fs.rm(dir, {recursive: true, force: true}))
  const runtime = path.join(dir, 'runtime')
  await fs.mkdir(runtime, {mode: 0o700})
  const bin = path.join(dir, 'bin')
  await fs.mkdir(bin)
  const fakeShell = path.join(bin, 'omarchy-shell')
  await fs.writeFile(fakeShell, '#!/usr/bin/python3\nimport json,sys,os\np=json.loads(sys.argv[-1])["pickerPath"]\nr=json.load(open(p))\nfd=os.open(os.path.join(os.path.dirname(p),"response.json"),os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)\nwith os.fdopen(fd,"w") as f: json.dump({"id":r["id"],"cancelled":False,"value":r["items"][1]["value"]},f)\n', {mode: 0o700})
  const child = spawn('python3', [path.join(__dirname, '../bin/omacast-pick')], {
    env: {...process.env, XDG_RUNTIME_DIR: runtime, PATH: bin + ':' + process.env.PATH}
  })
  let stdout = '', stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  const closed = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve) })
  child.stdin.end('first\n$(literal; no shell)\n')
  assert.equal(await closed, 0, stderr)
  assert.equal(stdout, '$(literal; no shell)\n')
  assert.deepEqual(await fs.readdir(runtime), [])
})

async function waitFile(file) {
  const { watch } = require('node:fs')
  return new Promise((resolve, reject) => {
    const watcher = watch(path.dirname(file), check)
    const deadline = setTimeout(() => { watcher.close(); reject(new Error('Fixture gate did not appear: ' + file)) }, 5000)
    async function check() {
      try { await fs.stat(file); watcher.close(); clearTimeout(deadline); resolve() }
      catch (error) { if (error.code !== 'ENOENT') { watcher.close(); clearTimeout(deadline); reject(error) } }
    }
    check()
  })
}

test('answer replacement waits for drained old generation and publishes only current request', {timeout: 20000}, async t => {
  const h = await setup(t)
  if (!h) return
  const script = path.join(h.dir, 'answer-gated.py')
  await fs.writeFile(script, 'import sys,os,time\nbase=sys.argv[1]\nif \"old\" in sys.argv[-1]:\n open(base+\"/entered\",\"w\").close()\n while not os.path.exists(base+\"/release\"): time.sleep(.01)\nprint(sys.argv[-1])\n')
  await h.command('agent', {enabled: true, command: ['python3', script, h.dir], prompt: 'old'})
  await waitFile(path.join(h.dir, 'entered'))
  const ready = h.changed(state => state.agent.status === 'ready')
  await h.command('agent', {enabled: true, command: ['python3', script, h.dir], prompt: 'new'})
  await fs.writeFile(path.join(h.dir, 'release'), '')
  const result = await ready
  assert.match(result.agent.answer, /new/)
  assert.doesNotMatch(result.agent.answer, /old/)
})

test('controller SIGKILL cancels answer subprocess group through lifetime guardian', {timeout: 15000}, async t => {
  const os = require('node:os')
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'omacast-answer-owner-'))
  const runtime = path.join(dir, 'runtime')
  await fs.mkdir(runtime, {mode: 0o700})
  const script = path.join(dir, 'process.py')
  await fs.writeFile(script, 'import os,time,sys\npid=os.fork()\nif pid==0:\n with open(sys.argv[1]+\"/descendant\",\"w\") as f: f.write(str(os.getpid()))\n while True: time.sleep(1)\nwith open(sys.argv[1]+\"/leader\",\"w\") as f: f.write(str(os.getpid()))\nwhile True: time.sleep(1)\n')
  const child = spawn('python3', [path.join(__dirname, '../bin/omacast_adapter.py'), 'agent', JSON.stringify({
    command: ['python3', script, dir], prompt: 'fixture'
  })], {env: {...process.env, XDG_RUNTIME_DIR: runtime}})
  let stdout = ''
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.resume()
  const closed = new Promise((resolve, reject) => {child.on('error', reject); child.on('close', resolve)})
  t.after(async () => { child.kill('SIGTERM'); await closed; await fs.rm(dir, {recursive: true, force: true}) })
  await waitFile(path.join(dir, 'leader'))
  await waitFile(path.join(dir, 'descendant'))
  const pids = await Promise.all(['leader', 'descendant'].map(name => fs.readFile(path.join(dir, name), 'utf8')))
  child.kill('SIGKILL')
  await closed
  assert.equal(JSON.parse(stdout).status, 'cancelled')
  for (const pid of pids) {
    try {
      const record = await fs.readFile('/proc/' + pid + '/stat', 'utf8')
      assert.equal(record.slice(record.lastIndexOf(')') + 2).split(' ')[0], 'Z', 'process must not remain live')
    } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
})

test('answer leader completion does not wait for detached inherited output pipes', {timeout: 10000}, async t => {
  const os = require('node:os')
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'omacast-answer-detached-'))
  const runtime = path.join(dir, 'runtime')
  await fs.mkdir(runtime, {mode: 0o700})
  const script = path.join(dir, 'detach.py')
  await fs.writeFile(script, 'import subprocess,sys\np=subprocess.Popen([sys.executable,\"-c\",\"import time; time.sleep(60)\"],start_new_session=True)\nwith open(sys.argv[1]+\"/pid\",\"w\") as f: f.write(str(p.pid))\nprint(\"leader result\",flush=True)\n')
  const child = spawn('python3', [path.join(__dirname, '../bin/omacast_adapter.py'), 'agent',
    JSON.stringify({command: ['python3', script, dir], prompt: 'fixture'})], {env: {...process.env, XDG_RUNTIME_DIR: runtime}})
  let stdout = ''
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.resume()
  const closed = new Promise((resolve, reject) => {child.on('error', reject); child.on('close', resolve)})
  t.after(async () => {
    child.kill('SIGTERM')
    try { process.kill(Number(await fs.readFile(path.join(dir, 'pid'), 'utf8')), 'SIGKILL') }
    catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error }
    await closed
    await fs.rm(dir, {recursive: true, force: true})
  })
  await closed
  const result = JSON.parse(stdout)
  assert.equal(result.status, 'ready')
  assert.equal(result.answer, 'leader result\n')
  process.kill(Number(await fs.readFile(path.join(dir, 'pid'), 'utf8')), 0)
})

test('default inline adapter cannot discover host MCP/auth roots or expand embedded file mentions', {timeout: 20000}, async t => {
  const h = await setup(t, {prepare: async dir => {
    const bin = path.join(dir, 'sentinel-tools')
    await fs.mkdir(bin)
    await fs.mkdir(path.join(dir, '.claude'))
    await fs.mkdir(path.join(dir, '.omp', 'agent'), {recursive: true})
    await fs.writeFile(path.join(dir, '.claude', 'mcp.json'), '{"mcpServers":{"sentinel":{}}}')
    await fs.writeFile(path.join(dir, '.omp', 'agent', 'auth.json'), 'private host credential sentinel')
    await fs.writeFile(path.join(dir, 'private.txt'), 'private attachment sentinel')
    await fs.writeFile(path.join(bin, 'omp'), `#!/usr/bin/python3
import os,sys,json,re
home=os.environ["HOME"]
roots=[home+"/.claude/mcp.json",home+"/.omp/agent/auth.json",os.environ["PI_CODING_AGENT_DIR"]+"/mcp.json",os.environ["PI_CONFIG_DIR"]+"/config.yml"]
found=[p for p in roots if os.path.exists(p)]
text=sys.argv[-1]
mentions=[]
for match in re.finditer(r'@(?:"([^"]+)"|\\x27([^\\x27]+)\\x27|([^\\s@]+))',text):
 if match.start()==0 or text[match.start()-1].isspace() or text[match.start()-1] in "([{<\\\"\\x27\\x60":
  candidate=next(value for value in match.groups() if value is not None)
  candidate=os.path.expanduser(candidate)
  if os.path.isfile(candidate):
   with open(candidate) as f: mentions.append(f.read())
print(json.dumps({"hostFiles":found,"attachments":mentions,"question":text,"home":home}))
`, {mode: 0o700})
  }, env: dir => ({PATH: path.join(dir, 'sentinel-tools') + ':' + process.env.PATH,
    OPENAI_API_KEY: 'fixture-key', OMP_PROFILE: 'host-profile', CODEX_HOME: path.join(dir, '.codex')})})
  if (!h) return
  const question = `Use @${h.dir}/private.txt and @"${h.dir}/private.txt" and @'${h.dir}/private.txt' and @~/private.txt`
  const ready = h.changed(state => state.agent.status === 'ready')
  await h.command('agent', {enabled: true, prompt: question})
  const answer = JSON.parse((await ready).agent.answer)
  assert.deepEqual(answer.hostFiles, [])
  assert.deepEqual(answer.attachments, [])
  assert.ok(answer.question.replaceAll('\u2060', '').endsWith(question))
  assert.notEqual(answer.home, h.dir)
  await assert.rejects(fs.stat(answer.home), {code: 'ENOENT'})
})

test('semantic cancellation closes active HTTP before accepting a new request', {timeout: 20000}, async t => {
  let firstReceived
  const received = new Promise(resolve => { firstReceived = resolve })
  let firstClosed
  const disconnected = new Promise(resolve => { firstClosed = resolve })
  let count = 0
  const service = await server(t, (data, response) => {
    count++
    if (count === 1) {
      response.on('close', firstClosed)
      firstReceived()
      return
    }
    response.end(JSON.stringify({embeddings: [[1], [1]]}))
  })
  const h = await setup(t)
  if (!h) return
  await h.command('semantic', {enabled: true, endpoint: service.endpoint, model: 'x', query: 'old', candidates: [{key: 'old', title: 'old'}]})
  await received
  const ready = h.changed(state => state.semantic.status === 'ready')
  await h.command('semantic', {enabled: true, endpoint: service.endpoint, model: 'x', query: 'new', candidates: [{key: 'new', title: 'new'}]})
  await disconnected
  const result = await ready
  assert.deepEqual(result.semantic.suggestions.map(row => row.key), ['new'])
})

test('semantic deadline reports timeout and permits a subsequent local request', {timeout: 20000}, async t => {
  let count = 0
  const service = await server(t, (data, response) => {
    count++
    if (count > 1) response.end(JSON.stringify({embeddings: [[1], [1]]}))
  })
  const h = await setup(t)
  if (!h) return
  const timedOut = h.changed(state => state.semantic.status === 'timeout')
  await h.command('semantic', {enabled: true, endpoint: service.endpoint, model: 'x', query: 'first', candidates: [{key: 'first', title: 'first'}]})
  assert.equal((await timedOut).semantic.status, 'timeout')
  const recovered = h.changed(state => state.semantic.status === 'ready')
  await h.command('semantic', {enabled: true, endpoint: service.endpoint, model: 'x', query: 'second', candidates: [{key: 'second', title: 'second'}]})
  assert.deepEqual((await recovered).semantic.suggestions.map(row => row.key), ['second'])
})
