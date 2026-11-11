import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("memory MCP refuses an implicit unrestricted scope", () => {
  const result = spawnSync(process.execPath, [path.resolve("tools/the-source-memory-mcp.cjs")], {
    env: { ...process.env, THE_SOURCE_ALLOWED_PATHS: "" }, timeout: 3000, encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /explicit THE_SOURCE_ALLOWED_PATHS/);
});

test("independent memory MCP retains all six tools, commits writes, and denies other scopes", async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "bot-mcp-"));
  const repo = path.join(tmp, "repo"), origin = path.join(tmp, "origin.git");
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { stdio: "pipe" });
  git("init", "--bare", origin);
  git("init", "-b", "main", repo);
  git("-C", repo, "config", "user.name", "Memory Test");
  git("-C", repo, "config", "user.email", "memory-test@local.invalid");
  await fs.mkdir(path.join(repo, "Agents/FixtureBot"), { recursive: true });
  await fs.mkdir(path.join(repo, "Personal"));
  await fs.writeFile(path.join(repo, "Agents/FixtureBot/lore.md"), "# Lore\nBlue lighthouse.\n");
  await fs.writeFile(path.join(repo, "Personal/private.md"), "Unrelated private fixture");
  git("-C", repo, "add", "."); git("-C", repo, "commit", "-m", "Fixture");
  git("-C", repo, "remote", "add", "origin", origin);
  git("-C", repo, "push", "-u", "origin", "main");
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [path.resolve("tools/the-source-memory-mcp.cjs")],
    env: { ...process.env, THE_SOURCE_REPO: repo, THE_SOURCE_MCP_NAME: "the-source-legacy", THE_SOURCE_ALLOWED_PATHS: "Agents/FixtureBot/**,Archive/Agents/FixtureBot/**" },
    stderr: "pipe",
  });
  const client = new Client({ name: "migration-test", version: "1" });
  await client.connect(transport);
  t.after(() => client.close());
  assert.deepEqual(new Set((await client.listTools()).tools.map((v) => v.name)), new Set(["search", "read", "create", "append", "update", "archive"]));
  const call = async (name, args) => client.callTool({ name, arguments: args });
  const read = await call("read", { path: "Agents/FixtureBot/lore.md" });
  assert.equal(read.isError, undefined);
  assert.match(JSON.stringify(read), /Blue lighthouse/);
  const forbidden = await call("read", { path: "Personal/private.md" });
  assert.equal(forbidden.isError, true);
  const traversal = await call("read", { path: "Agents/FixtureBot/../../Personal/private.md" });
  assert.equal(traversal.isError, true);
  const search = await call("search", { query: "private fixture" });
  assert.equal(JSON.stringify(search).includes("Unrelated private fixture"), false);
  const target = "Agents/FixtureBot/migration-test.md";
  for (const [name, args] of [
    ["create", { path: target, content: "# Test\nFirst.\n" }],
    ["append", { path: target, text: "Second.\n" }],
    ["update", { path: target, existingText: "Second.", newText: "Updated." }],
    ["archive", { path: target }],
  ]) assert.equal((await call(name, args)).isError, undefined, name);
  assert.match(await fs.readFile(path.join(repo, "Archive", target), "utf8"), /Updated/);
  assert.equal(git("-C", repo, "status", "--porcelain").toString(), "");
  const head = git("-C", repo, "rev-parse", "HEAD").toString().trim();
  assert.equal(git("--git-dir", origin, "rev-parse", "refs/heads/main").toString().trim(), head);
});
