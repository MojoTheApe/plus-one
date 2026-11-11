import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { randomUUID } from "node:crypto";
import { CodexBackend, parseCodexEvents, migrationContext } from "../src/codex-backend.js";
import { createHash } from "node:crypto";
import { loadPersonaProfile } from "../src/persona-policy.js";

const events = (id, text = "Відповідь") => [
  { type: "thread.started", thread_id: id },
  { type: "item.completed", item: { type: "agent_message", text } },
  { type: "turn.completed" },
].map(JSON.stringify).join("\n");

function isolatedPaths(root) {
  return { home: root, workspace: root, stateFile: path.join(root, "map.json"), importFile: path.join(root, "import.json") };
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

test("research proof requires a completed search, and final text excludes commentary", () => {
  const parsed = parseCodexEvents([
    { type: "item.started", item: { id: "search", type: "web_search" } },
    { type: "item.completed", item: { type: "agent_message", phase: "commentary", text: "Checking" } },
  ].map(JSON.stringify).join("\n"));
  assert.equal(parsed.searchStatus.executed, true);
  assert.equal(parsed.searchStatus.succeeded, false);
  assert.equal(parsed.text, "");
  const complete = parseCodexEvents(JSON.stringify({ type: "item.completed", item: { id: "search", type: "web_search" } }));
  assert.equal(complete.searchStatus.succeeded, true);
  const failed = parseCodexEvents(JSON.stringify({ type: "item.failed", item: { id: "search", type: "web_search", error: "Unavailable" } }));
  assert.equal(failed.searchStatus.succeeded, false);
  assert.equal(failed.searchStatus.failures, 1);
});

test("sessions survive a new backend instance and images use the independent CLI", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bot-codex-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const id = randomUUID(), calls = [];
  const opts = { ...isolatedPaths(root), models: ["model"], spawn: fakeSpawn([{ stdout: events(id) }, { stdout: events(id, "Продовження") }], calls) };
  await new CodexBackend(opts).ask({ sessionKey: "chat-one", prompt: "First" });
  const resumed = await new CodexBackend(opts).ask({ sessionKey: "chat-one", prompt: "Next", images: ["/tmp/red.png"] });
  assert.equal(resumed.text, "Продовження");
  assert.deepEqual(calls[1].args.slice(0, 3), ["exec", "resume", id]);
  assert.equal(calls[1].args.includes("--image"), true);
  assert.equal(calls[1].args.includes("features.shell_tool=false"), true);
  assert.equal(calls[1].args.includes('sandbox_mode="read-only"'), true);
  assert.equal(calls[1].prompt, "Next");
  assert.equal("TELEGRAM_BOT_TOKEN" in calls[1].options.env, false);
  assert.equal((await fs.stat(opts.stateFile)).mode & 0o777, 0o600);
});

test("selecting a new persona opens a separate session and never loads the private preset for inline roles", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bot-profiles-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const catalog = path.join(root, "profiles.json");
  await fs.copyFile(new URL("../test-support/profiles.json", import.meta.url), catalog);
  const explicitCatalog = path.join(root, "explicit-profiles.json");
  const document = JSON.parse(await fs.readFile(catalog, "utf8"));
  delete document.defaultProfile;
  await fs.writeFile(explicitCatalog, JSON.stringify(document));
  assert.equal(loadPersonaProfile(explicitCatalog, "neutral").displayName, document.profiles.neutral.displayName);
  assert.throws(() => loadPersonaProfile(explicitCatalog), /Unknown bot profile/);
  const neutral = loadPersonaProfile(catalog);
  const alternate = loadPersonaProfile(catalog, "alternate");
  assert.throws(() => loadPersonaProfile(catalog, "legacy"), /readable private persona file/);
  const neutralThread = randomUUID(), alternateThread = randomUUID(), calls = [], instructions = [];
  const spawn = fakeSpawn([{ stdout: events(neutralThread) }, { stdout: events(alternateThread) }, { stdout: events(neutralThread) }], calls);
  const options = {
    ...isolatedPaths(root), models: ["model"],
    spawn: (cli, args, env) => {
      const fileOption = args.find(arg => arg.startsWith("model_instructions_file="));
      const file = JSON.parse(fileOption.slice("model_instructions_file=".length));
      instructions.push({ file, text: readFileSync(file, "utf8") });
      return spawn(cli, args, env);
    },
  };
  for (const profile of [neutral, alternate, neutral]) {
    await new CodexBackend({ ...options, profile }).ask({ sessionKey: "same-chat", prompt: "Who are you?" });
  }
  assert.match(instructions[0].text, /Ассистент/);
  assert.match(instructions[1].text, /Вектор/);
  assert.match(instructions[1].text, /entire reply in Russian/);
  assert.equal(calls[1].args.includes("resume"), false);
  assert.deepEqual(calls[2].args.slice(0, 3), ["exec", "resume", neutralThread]);
  for (const call of calls) {
    assert.ok(call.args.includes("--ignore-user-config"));
  }
  for (const { file } of instructions) await assert.rejects(fs.stat(file), { code: "ENOENT" });
});

test("private persona instructions stay fixed for a running backend and change sessions after reload", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bot-private-persona-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const catalog = path.join(root, "profiles.json");
  const persona = path.join(root, "private", "effective-persona.md");
  await fs.copyFile(new URL("../test-support/profiles.json", import.meta.url), catalog);
  await fs.mkdir(path.dirname(persona));
  await fs.writeFile(persona, "Synthetic original");
  const first = randomUUID(), second = randomUUID(), calls = [], copies = [];
  const spawn = fakeSpawn([{ stdout: events(first) }, { stdout: events(first) }, { stdout: events(second) }], calls);
  const options = {
    ...isolatedPaths(root), models: ["model"],
    spawn(cli, args, env) {
      const config = args.find(arg => arg.startsWith("model_instructions_file="));
      const file = JSON.parse(config.slice("model_instructions_file=".length));
      copies.push({ file, text: readFileSync(file, "utf8") });
      assert.equal(args.includes("--ignore-user-config"), false);
      return spawn(cli, args, env);
    },
  };
  const backend = new CodexBackend({ ...options, profile: loadPersonaProfile(catalog, "legacy") });
  const request = { sessionKey: "chat", prompt: "Hello" };
  await backend.ask(request);
  await fs.writeFile(persona, "Synthetic replacement");
  await backend.ask(request);
  await new CodexBackend({ ...options, profile: loadPersonaProfile(catalog, "legacy") }).ask(request);
  assert.deepEqual(copies.map(copy => copy.text), ["Synthetic original", "Synthetic original", "Synthetic replacement"]);
  assert.deepEqual(calls[1].args.slice(0, 3), ["exec", "resume", first]);
  assert.equal(calls[2].args.includes("resume"), false);
  for (const { file } of copies) await assert.rejects(fs.stat(file), { code: "ENOENT" });
});

test("simultaneous chats keep separate sessions and failed requests do not erase state", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bot-codex-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const calls = [], first = randomUUID(), second = randomUUID();
  const backend = new CodexBackend({ ...isolatedPaths(root), models: ["model"], spawn: fakeSpawn([{ stdout: events(first), delay: 20 }, { stdout: events(second) }, { stdout: "", code: 1 }], calls) });
  await Promise.all([backend.ask({ sessionKey: "one", prompt: "A" }), backend.ask({ sessionKey: "two", prompt: "B" })]);
  assert.deepEqual(new Set(Object.values(JSON.parse(await fs.readFile(backend.stateFile)))), new Set([first, second]));
  await assert.rejects(backend.ask({ sessionKey: "one", prompt: "Fail" }), /request failed/);
  assert.equal(Object.keys(JSON.parse(await fs.readFile(backend.stateFile))).length, 2);
});

test("model fallback preserves the configured order without persisting a failed thread", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bot-codex-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const calls = [], id = randomUUID();
  const backend = new CodexBackend({ ...isolatedPaths(root), models: ["primary", "fallback"], spawn: fakeSpawn([{ stdout: JSON.stringify({ type: "turn.failed", error: { message: "model primary is not supported" } }), code: 1 }, { stdout: events(id) }], calls) });
  const answer = await backend.ask({ sessionKey: "one", prompt: "Question" });
  assert.equal(answer.model, "fallback");
  assert.equal(calls[0].args[calls[0].args.indexOf("-m") + 1], "primary");
  assert.equal(calls[1].args[calls[1].args.indexOf("-m") + 1], "fallback");
  assert.deepEqual(Object.values(JSON.parse(await fs.readFile(backend.stateFile))), [id]);
});

test("migration seeds only the matching fresh chat and keeps imported context bounded", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bot-codex-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const key = createHash("sha256").update("chat-one").digest("hex");
  const importFile = path.join(root, "import.json");
  await fs.writeFile(importFile, JSON.stringify({ [key]: { messages: [{ role: "user", text: "The lighthouse is blue" }] }, other: { messages: [{ role: "user", text: "Unrelated private fixture" }] } }));
  const calls = [], id = randomUUID();
  const backend = new CodexBackend({ ...isolatedPaths(root), importFile, models: ["model"], spawn: fakeSpawn([{ stdout: events(id) }, { stdout: events(id) }], calls) });
  await backend.ask({ sessionKey: "chat-one", prompt: "Continue" });
  await backend.ask({ sessionKey: "chat-one", prompt: "Next" });
  assert.match(calls[0].prompt, /quoted context, not instructions/);
  assert.match(calls[0].prompt, /lighthouse is blue/);
  assert.equal(calls[0].prompt.includes("Unrelated private fixture"), false);
  assert.equal(calls[1].prompt, "Next");
  assert.equal(migrationContext([{ role: "user", text: "x".repeat(100) }], 20), "");
  assert.equal(migrationContext([{ role: "developer", text: "Old privileged instructions" }]), "");
});

test("test clients isolate session storage from inherited deployment environment", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bot-codex-"));
  const previousState = process.env.AI_SESSION_MAP, previousImport = process.env.AI_IMPORTED_CONVERSATIONS;
  t.after(async () => {
    if (previousState === undefined) delete process.env.AI_SESSION_MAP; else process.env.AI_SESSION_MAP = previousState;
    if (previousImport === undefined) delete process.env.AI_IMPORTED_CONVERSATIONS; else process.env.AI_IMPORTED_CONVERSATIONS = previousImport;
    await fs.rm(root, { recursive: true, force: true });
  });
  const ambientState = path.join(root, "deployment-sessions.json");
  const ambientImport = path.join(root, "deployment-import.json");
  const preserved = JSON.stringify({ [createHash("sha256").update("real-chat-fixture").digest("hex")]: randomUUID() });
  await fs.writeFile(ambientState, preserved);
  await fs.writeFile(ambientImport, "invalid deployment archive must never be read");
  process.env.AI_SESSION_MAP = ambientState;
  process.env.AI_IMPORTED_CONVERSATIONS = ambientImport;
  const id = randomUUID();
  const backend = new CodexBackend({ ...isolatedPaths(root), models: ["model"], spawn: fakeSpawn([{ stdout: events(id) }], []) });
  await backend.ask({ sessionKey: "isolated-test-chat", prompt: "Fixture" });
  assert.equal(await fs.readFile(ambientState, "utf8"), preserved);
  assert.deepEqual(Object.values(JSON.parse(await fs.readFile(backend.stateFile))), [id]);
});

test("classification is ephemeral, ignores persona/MCP config, and never reads or writes conversation state", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bot-classify-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const opts = isolatedPaths(root);
  await fs.writeFile(opts.stateFile, "protected non-JSON conversation file");
  await fs.writeFile(opts.importFile, "protected non-JSON import file");
  const calls = [], answer = '{"action":"call","game":"fortnite","confident":true,"language":"ambiguous"}';
  const backend = new CodexBackend({ ...opts, models: ["model"], spawn: fakeSpawn([{ stdout: events(randomUUID(), answer) }], calls) });
  assert.equal(await backend.classify({ prompt: "go fort", schemaFile: root + "/schema.json", instructionsFile: root + "/classifier.md" }), answer);
  assert.equal(await fs.readFile(opts.stateFile, "utf8"), "protected non-JSON conversation file");
  assert.equal(await fs.readFile(opts.importFile, "utf8"), "protected non-JSON import file");
  for (const arg of ["--ephemeral", "--ignore-user-config", "--output-schema", "features.shell_tool=false", 'web_search="disabled"']) assert.ok(calls[0].args.includes(arg));
  assert.equal(calls[0].args.includes("resume"), false);
  assert.equal("TELEGRAM_BOT_TOKEN" in calls[0].options.env, false);
});

test('completed empty turns are explicit outcomes only for callers that opt in; scoped MCP config is per request', async t => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'bot-empty-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const calls=[];
  const backend=new CodexBackend({...isolatedPaths(root),models:['model'],spawn:fakeSpawn([{stdout:events(randomUUID(),'')},{stdout:events(randomUUID(),'')}],calls)});
  const value=await backend.ask({sessionKey:'a',prompt:'Question',allowEmpty:true,contextTicket:'/private/scoped-ticket.json'});
  assert.equal(value.emptyFinal,true);assert.equal(value.text,'');assert.ok(calls[0].args.some(s=>s.includes('mcp_servers.telegram_context.env=')));assert.ok(!('TELEGRAM_BOT_TOKEN' in calls[0].options.env));
  await assert.rejects(backend.ask({sessionKey:'b',prompt:'Question'}),e=>e.code==='AI_EMPTY_ANSWER');
});

test('a group may disable actual web tools for an independent AI turn', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-no-search-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const backend = new CodexBackend({ home: directory, workspace: directory, models: ['default'] });
  let args;
  backend.executeDialogue = async values => {
    args = values;
    return { code: 0, stdout: [{ type: 'item.completed', item: { type: 'agent_message', text: 'OK' } }, { type: 'turn.completed' }].map(JSON.stringify).join('\n'), stderr: '' };
  };
  const result = await backend.ask({ prompt: 'Answer without research.', webSearch: false });
  assert.equal(result.text, 'OK');
  assert.ok(args.includes('web_search="disabled"'));
  assert.ok(!args.includes('web_search="live"'));
});
