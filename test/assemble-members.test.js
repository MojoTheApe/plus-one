import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MemberRoster, mentionChunks } from "../src/assemble-members.js";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "assemble-members-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const users = new Map([[1, { id: 1, is_bot: false, first_name: "Operator", username: "operator" }], [2, { id: 2, is_bot: false, first_name: "🤖 Мовчун" }], [3, { id: 3, is_bot: true, first_name: "Bot" }]]);
  const statuses = new Map([...users.keys()].map((id) => [id, "member"]));
  const roster = new MemberRoster({ stateFile: root + "/members.json", telegram: async (method, body) => {
    if (method === "getChatMemberCount") return [...statuses.values()].filter((s) => s === "member").length;
    assert.equal(method, "getChatMember"); return { user: users.get(body.user_id), status: statuses.get(body.user_id) };
  } });
  const chat = { id: -100, type: "supergroup" };
  const observe = (id) => roster.observe({ message: { chat, from: users.get(id) } });
  return { roster, users, statuses, chat, observe, stateFile: root + "/members.json" };
}

test("global roster refuses a partial known-member list instead of presenting it as all", async (t) => {
  const f = await fixture(t); await f.observe(1);
  await assert.rejects(f.roster.all(f.chat, f.users.get(3)), /complete group roster/);
});

test("complete global roster includes silent members and excludes bots", async (t) => {
  const f = await fixture(t); await f.observe(1); await f.observe(2);
  assert.deepEqual((await f.roster.all(f.chat, f.users.get(3))).map((u) => u.id), [1, 2]);
  assert.equal((await fs.stat(f.stateFile)).mode & 0o777, 0o600);
});

test("membership updates add new users and remove departed or nonmember-restricted users", async (t) => {
  const f = await fixture(t); await f.observe(1); await f.observe(2);
  f.users.set(4, { id: 4, is_bot: false, first_name: "New" }); f.statuses.set(4, "member");
  await f.roster.observe({ chat_member: { chat: f.chat, new_chat_member: { user: f.users.get(4), status: "member" } } });
  f.statuses.set(2, "left");
  await f.roster.observe({ message: { chat: f.chat, from: f.users.get(1), left_chat_member: f.users.get(2) } });
  assert.deepEqual((await f.roster.all(f.chat, f.users.get(3))).map((u) => u.id), [1, 4]);
  await f.roster.observe({ chat_member: { chat: f.chat, new_chat_member: { user: f.users.get(4), status: "restricted", is_member: false } } });
  assert.equal(f.roster.state.chats[-100].users[4].active, false);
});

test("username changes update one identity and global membership is rechecked live", async (t) => {
  const f = await fixture(t); await f.observe(1); await f.observe(2);
  f.users.get(1).username = "renamed_operator"; f.statuses.set(2, "left");
  const members = await f.roster.all(f.chat, f.users.get(3));
  assert.equal(members.length, 1); assert.equal(members[0].username, "renamed_operator");
  const restarted = new MemberRoster({ stateFile: f.stateFile, telegram: f.roster.telegram });
  assert.equal((await restarted.all(f.chat, f.users.get(3))).length, 1);
});

test("username snapshot entries merge into real IDs on observed messages", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.stateFile, JSON.stringify({ chats: { [-100]: { verifiedSnapshot: "confirmed UI inventory", users: { "name:operator": { user: { username: "operator", is_bot: false }, active: true } } } } }));
  await f.observe(1);
  assert.deepEqual(Object.keys(f.roster.state.chats[-100].users), ["1"]);
});

test("anonymous sender-chat messages do not create fake human members", async (t) => {
  const f = await fixture(t);
  await f.roster.observe({ message: { chat: f.chat, sender_chat: f.chat, from: { id: 1087968824, is_bot: true, first_name: "Anonymous" } } });
  assert.equal(Object.keys(f.roster.state.chats).length, 0);
});

test("mention chunks preserve every user, UTF-16 offsets and ID mentions without exceeding captions", () => {
  const users = [{ id: 1, username: "operator", first_name: "User" }, ...Array.from({ length: 55 }, (_, n) => ({ id: n + 2, first_name: "🤖 Довге ім’я учасника " + n }))];
  const chunks = mentionChunks("Avengers Assemble!", users);
  assert.ok(chunks.length > 1);
  assert.equal(chunks.reduce((n, c) => n + c.entities.length, 0), users.length);
  for (const chunk of chunks) {
    assert.ok(chunk.text.length <= 950);
    for (const entity of chunk.entities) assert.ok(chunk.text.slice(entity.offset, entity.offset + entity.length).trim());
  }
  assert.equal(chunks[0].entities[0].type, "mention");
  assert.equal(chunks[0].entities[1].type, "text_mention");
});
