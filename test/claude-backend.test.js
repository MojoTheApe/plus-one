import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { randomUUID } from "node:crypto";
import { ClaudeBackend, parseClaudeResult } from "../src/claude-backend.js";

const reply = (id, text = "Відповідь", extra = {}) => JSON.stringify({ type: "result", subtype: "success", is_error: false, session_id: id, result: text, ...extra });
const failure = (text, extra = {}) => JSON.stringify({ type: "result", subtype: "success", is_error: true, session_id: randomUUID(), result: text, ...extra });

function paths(root) {
  return { home: root, workspace: root, stateFile: path.join(root, "claude-map.json"), apiKey: "sk-ant-test" };
}

function fakeSpawn(outputs, calls) {
  return (cli, args, options) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
    const call = { cli, args, options, prompt: "" }; calls.push(call);
    child.stdin.on("data", (data) => { call.prompt += data; });
    child.stdin.on("finish", () => {
      const item = outputs.shift();
      setTimeout(() => { child.stdout.end(item.stdout); child.stderr.end(item.stderr || ""); child.emit("close", item.code ?? 0); }, item.delay || 0);
    });
    return child;
  };
}

test("parses a single result, an event array and failures", () => {
  const id = randomUUID();
  assert.deepEqual(
    (({ sessionId, text, completed, failed }) => ({ sessionId, text, completed, failed }))(parseClaudeResult(reply(id, "Hi"))),
    { sessionId: id, text: "Hi", completed: true, failed: false },
  );
  const array = parseClaudeResult(JSON.stringify([{ type: "system" }, JSON.parse(reply(id, "Last"))]));
  assert.equal(array.text, "Last");
  const bad = parseClaudeResult(failure("Invalid API key", { api_error_status: 401 }));
  assert.equal(bad.failed, true);
  assert.equal(bad.completed, false);
  assert.equal(bad.status, 401);
  assert.equal(parseClaudeResult("not json").completed, false);
});

test("sessions survive a new backend instance, tools are disabled and secrets stay out of the child", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bot-claude-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  process.env.TELEGRAM_BOT_TOKEN = "123:secret";
  t.after(() => { delete process.env.TELEGRAM_BOT_TOKEN; });
  const id = randomUUID(), calls = [];
  const opts = { ...paths(root), models: ["m1"], spawn: fakeSpawn([{ stdout: reply(id) }, { stdout: reply(id, "Продовження") }], calls) };
  await new ClaudeBackend(opts).ask({ sessionKey: "chat-one", prompt: "First" });
  const resumed = await new ClaudeBackend(opts).ask({ sessionKey: "chat-one", prompt: "Next" });
  assert.equal(resumed.text, "Продовження");
  assert.equal(calls[0].args.includes("--resume"), false);
  assert.deepEqual(calls[1].args.slice(calls[1].args.indexOf("--resume"), calls[1].args.indexOf("--resume") + 2), ["--resume", id]);
  assert.equal(calls[1].args.includes("--bare"), true);
  assert.deepEqual(calls[1].args.slice(calls[1].args.indexOf("--tools"), calls[1].args.indexOf("--tools") + 2), ["--tools", ""]);
  assert.equal(calls[1].args.includes("dontAsk"), true);
  assert.equal(calls[1].prompt, "Next");
  assert.equal("TELEGRAM_BOT_TOKEN" in calls[1].options.env, false);
  assert.equal(calls[1].options.env.ANTHROPIC_API_KEY, "sk-ant-test");
  assert.equal((await fs.stat(opts.stateFile)).mode & 0o777, 0o600);
});

test("a request without a session key is not persisted", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bot-claude-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const calls = [];
  const backend = new ClaudeBackend({ ...paths(root), models: ["m1"], spawn: fakeSpawn([{ stdout: reply(randomUUID()) }], calls) });
  await backend.ask({ prompt: "One-off" });
  assert.equal(calls[0].args.includes("--no-session-persistence"), true);
  await assert.rejects(fs.stat(path.join(root, "claude-map.json")), { code: "ENOENT" });
});

test("persona instructions go through a private temporary file that is removed", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bot-claude-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const calls = [];
  const profile = { fingerprint: "p1", privateInstructions: "PERSONA TEXT" };
  let seen = "";
  const spawnSpy = (cli, args, options) => {
    const file = args[args.indexOf("--system-prompt-file") + 1];
    fs.readFile(file, "utf8").then((text) => { seen = text; });
    return fakeSpawn([{ stdout: reply(randomUUID()), delay: 20 }], calls)(cli, args, options);
  };
  await new ClaudeBackend({ ...paths(root), models: ["m1"], profile, spawn: spawnSpy }).ask({ sessionKey: "s", prompt: "Hi" });
  const file = calls[0].args[calls[0].args.indexOf("--system-prompt-file") + 1];
  assert.equal(seen, "PERSONA TEXT");
  await assert.rejects(fs.stat(file), { code: "ENOENT" });
});

test("a lost session is replaced once, but an invalid key does not drop it", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bot-claude-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const first = randomUUID(), fresh = randomUUID(), calls = [];
  const opts = { ...paths(root), models: ["m1"], spawn: fakeSpawn([
    { stdout: reply(first) },
    { stdout: failure("No conversation found with session ID") },
    { stdout: reply(fresh, "Нова розмова") },
    { stdout: failure("Invalid API key", { api_error_status: 401 }) },
  ], calls) };
  const backend = new ClaudeBackend(opts);
  await backend.ask({ sessionKey: "chat", prompt: "A" });
  const recovered = await backend.ask({ sessionKey: "chat", prompt: "B" });
  assert.equal(recovered.text, "Нова розмова");
  assert.equal(calls[1].args.includes("--resume"), true);
  assert.equal(calls[2].args.includes("--resume"), false);
  await assert.rejects(backend.ask({ sessionKey: "chat", prompt: "C" }), { code: "AI_INCOMPLETE_TURN" });
  assert.equal(calls.length, 4);
});

test("capacity errors fall back to the next model and then report AI_CAPACITY", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bot-claude-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const calls = [];
  const ok = new ClaudeBackend({ ...paths(root), models: ["big", "small"], spawn: fakeSpawn([{ stdout: failure("rate limit exceeded") }, { stdout: reply(randomUUID(), "OK") }], calls) });
  assert.equal((await ok.ask({ prompt: "x" })).model, "small");
  const bad = new ClaudeBackend({ ...paths(root), models: ["only"], spawn: fakeSpawn([{ stdout: failure("Your credit balance is too low") }], []) });
  await assert.rejects(bad.ask({ prompt: "x" }), { code: "AI_CAPACITY" });
});

test("images are rejected in this stage and a missing API key is reported", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bot-claude-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const backend = new ClaudeBackend({ ...paths(root), models: ["m1"], spawn: fakeSpawn([], []) });
  await assert.rejects(backend.ask({ prompt: "x", images: ["/tmp/a.png"] }), { code: "AI_UNSUPPORTED" });
  const keyless = new ClaudeBackend({ ...paths(root), apiKey: "", models: ["m1"], spawn: fakeSpawn([], []) });
  delete process.env.ANTHROPIC_API_KEY;
  await assert.rejects(keyless.ask({ prompt: "x" }), /ANTHROPIC_API_KEY/);
});

test("classification is sessionless, schema-bound, uses the classify model and returns JSON text", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bot-claude-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const schemaFile = path.join(root, "schema.json"), instructionsFile = path.join(root, "rules.md");
  await fs.writeFile(schemaFile, JSON.stringify({ type: "object", properties: { action: { type: "string" } } }));
  await fs.writeFile(instructionsFile, "Classify.");
  const calls = [];
  const backend = new ClaudeBackend({ ...paths(root), models: ["chat"], classifyModels: ["fast"], spawn: fakeSpawn([{ stdout: reply(randomUUID(), "", { structured_output: { action: "none" } }) }], calls) });
  const text = await backend.classify({ prompt: "msg", schemaFile, instructionsFile });
  assert.deepEqual(JSON.parse(text), { action: "none" });
  const args = calls[0].args;
  assert.equal(args[args.indexOf("--model") + 1], "fast");
  assert.equal(args.includes("--no-session-persistence"), true);
  assert.equal(args[args.indexOf("--system-prompt-file") + 1], instructionsFile);
  assert.deepEqual(JSON.parse(args[args.indexOf("--json-schema") + 1]), { type: "object", properties: { action: { type: "string" } } });
  const missing = new ClaudeBackend({ ...paths(root), classifyModels: ["fast"], spawn: fakeSpawn([{ stdout: reply(randomUUID(), "text only") }], []) });
  await assert.rejects(missing.classify({ prompt: "msg", schemaFile, instructionsFile }), /classification failed/);
});
