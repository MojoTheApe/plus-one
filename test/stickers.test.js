import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { StickerRouter, stickerIntent } from "../src/stickers.js";
import { botAliasPrefix } from "../src/helpers.js";

const bot = { id: 77, username: "TestBot" };
const packName = "OurPack_by_TestBot";
const sticker = (id, set = packName) => ({ file_id: id, file_unique_id: `unique-${id}`, set_name: set, emoji: "😂", width: 512, height: 512 });
const msg = (extra = {}) => ({ message_id: 10, chat: { id: -123, type: "supergroup" }, from: { id: 88 },
  message_thread_id: 900, text: "@TestBot добавь это в стикеры", photo: [{ file_id: "photo", file_unique_id: "photo-unique" }], ...extra });

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sticker-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const bindingsFile = path.join(root, "bindings.json"), stateFile = path.join(root, "state.json");
  await fs.writeFile(bindingsFile, JSON.stringify({ version: 1, chats: { [-123]: { packName, ownerId: 99 } } }));
  const pack = { name: packName, title: "Our Pack", sticker_type: "regular", stickers: [sticker("a"), sticker("b")] };
  const calls = [], faults = new Set(), uploaded = new Set();
  let status = "administrator", conversions = 0;
  const telegram = async (method, payload) => {
    calls.push({ method, payload });
    if (method === "getChatMember") return { status };
    if (method === "getStickerSet") return structuredClone(pack);
    if (method === "addStickerToSet") {
      if (!uploaded.has(payload.sticker.sticker)) {
        uploaded.add(payload.sticker.sticker);
        pack.stickers.push(sticker("copy-" + payload.sticker.sticker));
        pack.stickers.at(-1).emoji = payload.sticker.emoji_list[0];
      }
    } else if (method === "deleteStickerFromSet") pack.stickers = pack.stickers.filter(s => s.file_id !== payload.sticker);
    else assert.ok(["sendMessage", "sendSticker"].includes(method), method);
    if (faults.delete(method)) throw new Error("Simulated disconnect after mutation");
    return true;
  };
  const deps = { bindingsFile, stateFile, telegram,
    telegramMultipart: async (method, form) => {
      assert.equal(method, "uploadStickerFile"); assert.equal(form.get("user_id"), "99");
      assert.equal(form.get("sticker_format"), "static"); assert.equal(form.get("sticker").type, "image/webp");
      calls.push({ method }); return { file_id: "uploaded-photo" };
    },
    prepareImage: async () => { conversions++; return { buffer: Buffer.from("fixture-webp") }; },
  };
  let router = new StickerRouter(deps);
  return { root, calls, faults, pack, bindingsFile, stateFile,
    handle: message => router.handleMessage(message, bot),
    restart: () => { router = new StickerRouter(deps); }, setStatus: value => { status = value; },
    conversions: () => conversions };
}

test("explicit and polite requests resolve only current addressed text", () => {
  for (const text of ["@TestBot добавь это в стикеры", "@TestBot, можешь, пожалуйста, добавить это в пак 😂", "Оріон, додай у стікери", "@TestBot add this to our sticker pack", "/stickeradd@TestBot"]) {
    assert.equal(stickerIntent(msg({ text }), bot, botAliasPrefix(["Оріон"]))?.action, "add", text);
  }
  assert.equal(stickerIntent(msg({ text: "@TestBot удали этот стикер" }), bot)?.action, "delete");
  assert.equal(stickerIntent(msg({ text: "Оріон, додай у стікери" }), bot), null);
  assert.equal(stickerIntent(msg({ text: "видали цей стікер", reply_to_message: { from: { id: 77 } } }), bot)?.action, "delete");
  for (const text of ["@TestBot Загальне оголошення: у нас новий стікерпак", "@TestBot Тегни всіх, поговоримо про стікери", "@TestBot Хочеться катки, стікери потім", "@TestBot весь пак дуже гарний"]) assert.equal(stickerIntent(msg({ text }), bot), null, text);
});

test("quoted, forwarded, negative, hypothetical and other-bot text cannot mutate packs", () => {
  for (const text of ["добавь в стикеры", "/stickeradd@OtherBot"]) assert.equal(stickerIntent(msg({ text }), bot), null, text);
  for (const text of ["@TestBot не удаляй этот стикер", "@TestBot как добавить это в стикеры?", "@TestBot удали весь пак", "@TestBot видали весь стікерпак", "@TestBot delete the whole sticker pack", "/stickerdel all stickers"]) assert.equal(stickerIntent(msg({ text }), bot)?.action, "unsupported", text);
  assert.equal(stickerIntent(msg({ forward_origin: { type: "user" } }), bot), null);
  for (const type of ["blockquote", "expandable_blockquote", "pre", "code"]) {
    const text = "@TestBot удали этот стикер";
    assert.equal(stickerIntent(msg({ text, entities: [{ type, offset: 0, length: text.length }] }), bot), null);
  }
});

test("image addition persists, uses owner, emoji and originating topic, and survives replay", async t => {
  const f = await fixture(t); await f.handle(msg({ text: "@TestBot добавь это в стикеры 🥳" }));
  assert.equal(f.pack.stickers.length, 3); assert.equal(f.conversions(), 1);
  assert.equal(f.calls.find(c => c.method === "addStickerToSet").payload.user_id, 99);
  assert.deepEqual(f.calls.find(c => c.method === "addStickerToSet").payload.sticker.emoji_list, ["🥳"]);
  assert.equal(f.calls.find(c => c.method === "sendSticker").payload.message_thread_id, 900);
  f.restart(); await f.handle(msg({ text: "@TestBot добавь это в стикеры 🥳" }));
  assert.equal(f.calls.filter(c => c.method === "addStickerToSet").length, 1);
  assert.equal(f.pack.stickers.length, 3);
  assert.equal(JSON.parse(await fs.readFile(f.stateFile)).jobs["-123:10:add"].status, "done");
});

test("repeated source image on a new message is not uploaded twice", async t => {
  const f = await fixture(t); await f.handle(msg()); await f.handle(msg({ message_id: 11 }));
  assert.equal(f.conversions(), 1); assert.equal(f.pack.stickers.length, 3);
});

test("only admins may change packs, including after losing their role", async t => {
  const f = await fixture(t); f.setStatus("member"); await f.handle(msg());
  assert.equal(f.conversions(), 0); assert.ok(!f.calls.some(c => c.method === "getStickerSet"));
  f.setStatus("creator"); await f.handle(msg());
  f.setStatus("member"); await f.handle(msg({ message_id: 11 }));
  assert.equal(f.pack.stickers.length, 3);
});

test("anonymous administrators and unrelated groups cannot mutate", async t => {
  const f = await fixture(t);
  await f.handle(msg({ sender_chat: { id: -123 } }));
  await f.handle(msg({ chat: { id: -999, type: "supergroup" } }));
  await f.handle(msg({ chat: { id: 88, type: "private" } }));
  assert.ok(!f.calls.some(c => c.method === "getChatMember"));
});

test("caption and reply images work; unrelated photos are ignored", async t => {
  const f = await fixture(t);
  assert.equal(await f.handle(msg({ text: undefined, caption: "@TestBot додай у стікери" })), true);
  assert.equal(await f.handle(msg({ message_id: 11, text: undefined, caption: "holiday" })), false);
  await f.handle(msg({ message_id: 12, photo: undefined, reply_to_message: { document: { file_id: "doc", file_unique_id: "doc-unique", mime_type: "image/png" } } }));
  assert.equal(f.conversions(), 2);
});

test("delete removes exactly the replied-to sticker from the bound pack", async t => {
  const f = await fixture(t);
  await f.handle(msg({ photo: undefined, text: "@TestBot удали этот стикер", reply_to_message: { sticker: sticker("a") } }));
  assert.deepEqual(f.pack.stickers.map(s => s.file_id), ["b"]);
  assert.equal(f.calls.find(c => c.method === "deleteStickerFromSet").payload.sticker, "a");
  f.restart(); await f.handle(msg({ photo: undefined, text: "/stickerdel", reply_to_message: { sticker: sticker("a") } }));
  assert.equal(f.calls.filter(c => c.method === "deleteStickerFromSet").length, 1);
});

test("original pack, photograph and last sticker cannot be deleted", async t => {
  const f = await fixture(t);
  await f.handle(msg({ photo: undefined, text: "/stickerdel", reply_to_message: { sticker: sticker("a", "OriginalPack") } }));
  await f.handle(msg({ text: "/stickerdel" }));
  f.pack.stickers = [sticker("a")];
  await f.handle(msg({ photo: undefined, text: "/stickerdel", reply_to_message: { sticker: sticker("a") } }));
  assert.ok(!f.calls.some(c => c.method === "deleteStickerFromSet"));
});

test("add crash reuses the persisted uploaded file; Telegram deduplication prevents another sticker", async t => {
  const f = await fixture(t); f.faults.add("addStickerToSet"); await f.handle(msg());
  assert.equal(f.pack.stickers.length, 3); f.restart(); await f.handle(msg());
  assert.equal(f.pack.stickers.length, 3); assert.equal(f.conversions(), 1);
  const adds = f.calls.filter(c => c.method === "addStickerToSet");
  assert.equal(adds.length, 2); assert.deepEqual(adds[0].payload, adds[1].payload);
});

test("delete crash recognizes the missing sticker and completes its journal", async t => {
  const f = await fixture(t); f.faults.add("deleteStickerFromSet");
  const request = msg({ photo: undefined, text: "/stickerdel", reply_to_message: { sticker: sticker("a") } });
  await f.handle(request); f.restart(); await f.handle(request);
  assert.equal(f.calls.filter(c => c.method === "deleteStickerFromSet").length, 1);
  assert.equal(JSON.parse(await fs.readFile(f.stateFile)).jobs["-123:10:delete"].status, "done");
});

test("ready-made stickers can be added without image conversion", async t => {
  const f = await fixture(t);
  await f.handle(msg({ photo: undefined, sticker: { ...sticker("other", "OtherPack"), is_video: true } }));
  assert.equal(f.conversions(), 0);
  assert.equal(f.calls.find(c => c.method === "addStickerToSet").payload.sticker.format, "video");
});

test("help is available to members and includes the bound pack", async t => {
  const f = await fixture(t); f.setStatus("member"); await f.handle(msg({ text: "/stickers" }));
  assert.match(f.calls.at(-1).payload.text, /OurPack_by_TestBot/);
  assert.ok(!f.calls.some(c => c.method === "getChatMember"));
});

test("full packs reject additions before conversion or upload", async t => {
  const f = await fixture(t); f.pack.stickers = Array.from({ length: 120 }, (_, i) => sticker(String(i)));
  await f.handle(msg()); assert.equal(f.conversions(), 0);
});
