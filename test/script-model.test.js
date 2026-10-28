const test = require("node:test")
const assert = require("node:assert/strict")
const { mkdtemp, writeFile, rm, access } = require("node:fs/promises")
const { tmpdir } = require("node:os")
const path = require("node:path")
const { spawnSync } = require("node:child_process")
const Model = require("../ScriptModel.js")

const protocol = rows => [{ version: 1 }, ...rows].map(JSON.stringify).join("\n") + "\n"
const row = (id = "one", action = { type: "copy", text: "literal" }) => ({ id, title: "<b>Literal title</b>", action })

test("structured arguments validate defaults, literal choices and formats before encoding", () => {
  const specs = [
    { placeholder: "Destination", options: [{ title: "Work space", value: "work space" }], default: "work space", percentEncoded: true },
    { type: "number", placeholder: "Count", validation: "[1-9][0-9]?" },
    { optional: true }
  ]
  const valid = Model.buildArgv("/tmp/script", specs, ["", "12", "$(touch /tmp/nope)"])
  assert.equal(valid.ok, true)
  assert.deepEqual(valid.values, ["work space", "12", "$(touch /tmp/nope)"])
  assert.deepEqual(valid.argv, ["/tmp/script", "work%20space", "12", "$(touch /tmp/nope)"])
  assert.equal(Model.validateArguments(specs, ["other", "2"]).ok, false)
  assert.equal(Model.validateArguments(specs, ["work space", "100"]).ok, false)
  assert.equal(Model.validateArguments(specs, ["work space", "NaN"]).ok, false)
  assert.equal(Model.validateArguments(specs, ["work space", ""]).ok, false)
  assert.equal(Model.validateArguments([{ optional: true, validation: "[" }], ["x"]).ok, false)
  assert.equal(Model.validateArguments([], ["extra"]).ok, false)
  assert.equal(Model.buildArgv("relative", [], []).ok, false)
})

test("validation rejects backtracking constructs and matches its bounded pattern subset", () => {
  for (const validation of ["(a+)+$", "(a|aa)+$", "(?=a)a", "(a)\\1", "a{4097}", "[a-z]+?"]) {
    const result = Model.validateArguments([{ validation }], ["a".repeat(4000) + "!"])
    assert.equal(result.ok, false)
    assert.equal(result.error, "Unsupported validation pattern")
  }
  const accepts = (validation, value) => Model.validateArguments([{ validation }], [value]).ok
  assert.equal(accepts("^[A-Z][a-z]{1,8}\\d?$", "Abc2"), true)
  assert.equal(accepts("^[A-Z][a-z]{1,8}\\d?$", "abc2"), false)
  assert.equal(accepts("[a-z]+\\.[a-z]{2,4}", "example.test"), true)
  assert.equal(accepts("[^0-9]+", "hello"), true)
  assert.equal(accepts("[^0-9]+", "hello2"), false)
  assert.equal(accepts("a*a*a*a*a*a*b", "a".repeat(4000) + "b"), true)
  assert.equal(accepts("a*a*a*a*a*a*b", "a".repeat(4000) + "!"), false)
  assert.equal(accepts(String.raw`[\w\.-]+`, "example-file.txt"), true)
  assert.equal(accepts(String.raw`[\+]`, "+"), true)
  assert.equal(accepts(String.raw`[\/]`, "/"), true)
  assert.equal(accepts(String.raw`\/`, "/"), true)
  assert.equal(accepts(String.raw`\+`, "+"), true)
  assert.equal(Model.validateArguments([{ optional: true, validation: "(a+)+$" }], [""]).ok, true)
  assert.equal(Model.validateArguments([{ optional: true, validation: "[" }], []).ok, true)
  assert.equal(Model.validateArguments([{ optional: true, validation: "(a+)+$", default: "aaa" }], [""]).ok, false)
})

test("JSONL results preserve plain text and require explicit argv confirmation", () => {
  const actions = [{ type: "copy", text: "$(never execute)\nplain" }, { type: "open", path: "/tmp/a b" },
    { type: "url", url: "https://example.test/?x=$literal" }, { type: "argv", argv: ["printf", "%s", "$(not code)"] }]
  const result = Model.parseResults(protocol(actions.map((action, i) => row(String(i), action))), "/tmp/script", 7)
  assert.equal(result.ok, true)
  assert.equal(result.records[0].title, "<b>Literal title</b>")
  assert.deepEqual(result.records.map(record => record.needsConfirmation), [false, false, false, true])
  assert.deepEqual(result.records[3].action.argv, actions[3].argv)
})

test("malformed, oversized and executable protocol injections fail closed without partial rows", () => {
  for (const text of ["", "{\"version\":2}\n", "{}\n", "{\"version\":1}\nnot json", protocol([row(), row()]),
    protocol([row("x", { type: "qml", source: "Qt.quit()" })]), protocol([row("x", { type: "url", url: "javascript:alert(1)" })]),
    protocol([row("x", { type: "argv", argv: ["echo", "a\0b"] })]), protocol([row("x", { type: "open", path: "relative" })]),
    protocol(Array.from({ length: 201 }, (_, i) => row(String(i)))), protocol([row("x", { type: "copy", text: "é".repeat(40000) })])]) {
    const parsed = Model.parseResults(text, "/tmp/script", 1)
    assert.equal(parsed.ok, false)
    assert.deepEqual(parsed.records, [])
  }
})

test("resolution binds source and generation and returns a detached validated action", () => {
  const records = Model.parseResults(protocol([row("one", { type: "argv", argv: ["echo", "safe"] })]), "/tmp/a", 3).records
  assert.equal(Model.resolveRecord(records, "one", 3, "/tmp/b", 3), null)
  assert.equal(Model.resolveRecord(records, "one", 3, "/tmp/a", 4), null)
  assert.equal(Model.resolveRecord(records, "missing", 3, "/tmp/a", 3), null)
  const resolved = Model.resolveRecord(records, "one", 3, "/tmp/a", 3)
  resolved.action.argv[1] = "changed"
  assert.equal(records[0].action.argv[1], "safe")
  assert.notEqual(Model.resultKey("/tmp/a", 3, "one"), Model.resultKey("/tmp/a", 4, "one"))
})

test("real supervisor executes literal arguments, rejects nonexecutables and bounds stdout", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "omacast-script-model-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const script = path.join(dir, "script with spaces")
  const marker = path.join(dir, "injected")
  await writeFile(script, '#!/bin/bash\nprintf \'%s\' "$1"\n', { mode: 0o700 })
  const literal = `$(touch '${marker}') ; ' \" $HOME`
  const run = spawnSync(...command(Model.resultsCommand(script, [literal])), { encoding: "utf8" })
  assert.equal(run.status, 0)
  assert.equal(run.stdout, literal)
  await assert.rejects(access(marker))
  const disabled = path.join(dir, "disabled")
  await writeFile(disabled, "#!/bin/bash\nexit 0\n", { mode: 0o600 })
  assert.equal(spawnSync(...command(Model.resultsCommand(disabled, []))).status, 126)
  await writeFile(script, "#!/bin/bash\nhead -c 100000 /dev/zero\n", { mode: 0o700 })
  const capped = spawnSync(...command(Model.resultsCommand(script, [])))
  assert.equal(capped.status, 123)
  assert.equal(capped.stdout.length, 0)
  await writeFile(script, "#!/bin/bash\nexit 42\n", { mode: 0o700 })
  assert.equal(spawnSync(...command(Model.resultsCommand(script, []))).status, 122)
})

function command(argv) { return [argv[0], argv.slice(1)] }
