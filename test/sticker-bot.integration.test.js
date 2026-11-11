import '../test-support/isolated-env.mjs';
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sticker-handler-"));
  const previous = { ...process.env }, previousFetch = globalThis.fetch;
  Object.assign(process.env, {
    TELEGRAM_BOT_TOKEN: "000000:STICKER_QA_ONLY", ANSWER_BACKEND: "openai", OPENAI_API_KEY: "local-fixture",
    MEMORY_DIR: root + "/memory", MEMORY_AUTO_CAPTURE: "false", BOT_LOCK_FILE: root + "/runtime/bot.pid",
    ASSEMBLE_STATE_FILE: root + "/runtime/assemble.json", ASSEMBLE_MEMBERS_FILE: root + "/runtime/members.json",
    ASSEMBLE_GAMES_FILE: path.resolve("test-support/assemble-games.json"),
    ASSEMBLE_MEDIA_PATH: root + "/assets/assemble.mp4", ASSEMBLE_GAME_ASSET_DIR: root + "/assets/games",
    STICKER_BINDINGS_FILE: root + "/runtime/sticker-bindings.json", STICKER_STATE_FILE: root + "/runtime/sticker-actions.json",
    VOICE_TRANSCRIPTION_ENABLED: "false", SOCIAL_VIDEO_ENABLED: "false", INSULT_REPLY_ENABLED: "false",
    MODERATION_ALLOWED_USER_IDS: "88", MODERATION_ALLOWED_USERNAMES: "",
  });
  const name = "OurPack_by_StickerTestBot";
  const pack = { name, sticker_type: "regular", stickers: [
    { file_id: "first", file_unique_id: "first-unique", set_name: name },
    { file_id: "second", file_unique_id: "second-unique", set_name: name },
  ] };
  const calls = [];
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(String(input)); assert.equal(url.hostname, "api.telegram.org", "Sticker requests never reach AI");
    const method = url.pathname.split("/").at(-1); assert.notEqual(method, "getUpdates", "No second poller");
    const payload = options.body instanceof FormData ? Object.fromEntries(options.body.entries()) : JSON.parse(options.body || "{}");
    calls.push({ method, payload });
    let result = true;
    if (method === "getChatMember") result = { status: payload.user_id === 66 ? "member" : "administrator", can_restrict_members: true, user: { id: payload.user_id, is_bot: payload.user_id === 77, first_name: "Fixture" } };
    else if (method === "getChatMemberCount") result = 2;
    else if (method === "getStickerSet") result = structuredClone(pack);
    else if (method === "uploadStickerFile") result = { file_id: "upload" };
    else if (method === "addStickerToSet") pack.stickers.push({ file_id: "added", file_unique_id: "added-unique", set_name: name });
    else if (method === "deleteStickerFromSet") pack.stickers = pack.stickers.filter(s => s.file_id !== payload.sticker);
    else { assert.ok(["sendMessage", "sendAnimation", "sendSticker", "banChatMember", "unbanChatMember"].includes(method), method); result = { message_id: 1000 + calls.length }; }
    return new Response(JSON.stringify({ ok: true, result }));
  };
  t.after(async () => {
    globalThis.fetch = previousFetch;
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key]; Object.assign(process.env, previous);
    await fs.rm(root, { recursive: true, force: true });
  });
  await fs.mkdir(root + "/src"); await fs.mkdir(root + "/runtime");
  await fs.mkdir(root + "/assets"); await fs.writeFile(root + "/assets/assemble.mp4", "isolated assembly fixture");
  await fs.writeFile(process.env.STICKER_BINDINGS_FILE, JSON.stringify({ version: 1, chats: { [-123]: { packName: name, ownerId: 99 } } }));
  for (const file of await fs.readdir("src")) if (file !== "bot.js") await fs.symlink(path.resolve("src", file), root + "/src/" + file);
  let source = await fs.readFile("src/bot.js", "utf8");
  const start = source.indexOf("main().catch((error) => {"), end = source.indexOf("\nasync function main()", start);
  assert.ok(start > 0 && end > start); source = source.slice(0, start) + source.slice(end);
  source += '\nexport async function init(){botInfo={id:77,is_bot:true,username:"StickerTestBot",first_name:"Bot"};await ensureMemoryVault();await ensureSettingsVault();stickerRouter.prepareImage=async()=>({buffer:Buffer.from("fixture-webp")});}\nexport {handleUpdate,assembleRouter};\n';
  await fs.writeFile(root + "/src/bot.mjs", source);
  const app = await import(root + "/src/bot.mjs"); await app.init();
  let serial = 10;
  return { calls, pack, classify: (action) => { app.assembleRouter.classify = async () => JSON.stringify({ action, game: null, confident: true, language: "ukrainian" }); }, handle: (extra) => app.handleUpdate({ update_id: serial, message: {
    message_id: serial++, date: Math.floor(Date.now() / 1000), chat: { id: -123, type: "supergroup" }, from: { id: 88, is_bot: false },
    message_thread_id: 900, ...extra,
  } }) };
}

test("actual handler adds a captioned image before media filtering and does not call AI", async t => {
  const f = await fixture(t);
  await f.handle({ photo: [{ file_id: "photo", file_unique_id: "photo-unique" }], caption: "@StickerTestBot добавь это в стикеры" });
  assert.equal(f.pack.stickers.length, 3);
  assert.equal(f.calls.filter(c => c.method === "uploadStickerFile").length, 1);
  assert.equal(f.calls.find(c => c.method === "sendSticker").payload.message_thread_id, 900);
});

test("actual handler deletes a replied-to sticker instead of kicking its author", async t => {
  const f = await fixture(t);
  await f.handle({ text: "@StickerTestBot можеш видалити цей стікер?", reply_to_message: {
    message_id: 9, from: { id: 66 }, sticker: f.pack.stickers[0],
  } });
  assert.equal(f.pack.stickers.length, 1);
  assert.equal(f.calls.filter(c => c.method === "deleteStickerFromSet").length, 1);
});

test("unrequested group images remain ignored", async t => {
  const f = await fixture(t); await f.handle({ photo: [{ file_id: "photo", file_unique_id: "photo-unique" }] });
  assert.equal(f.calls.length, 0);
});

test("unsupported addressed pack requests neither mutate stickers nor kick the replied-to author", async t => {
  const f = await fixture(t);
  for (const text of ["@StickerTestBot можеш видалити весь пак?", "@StickerTestBot ти можеш видалити весь пак?", "@StickerTestBot а можеш видалити цей стікер?", "@StickerTestBot бот, ти можеш видаляти стікери?", "@StickerTestBot видали весь стікерпак", "@StickerTestBot delete the whole sticker pack", "@StickerTestBot видали наш пак", "@StickerTestBot можна видаляти стікери?", "/stickerdel all stickers"]) {
    f.calls.length = 0;
    await f.handle({ text, reply_to_message: { message_id: 9, from: { id: 66, is_bot: false }, sticker: f.pack.stickers[0] } });
    assert.deepEqual(f.calls.map(c => c.method), ["sendMessage"], text);
    assert.equal(f.pack.stickers.length, 2, text);
  }
});

test("ordinary authorized user moderation remains available", async t => {
  const f = await fixture(t);
  for (const text of ["@StickerTestBot можеш видалити цього учасника?", "@StickerTestBot можеш видалити @StickerFan цього учасника?"]) {
    f.calls.length = 0;
    await f.handle({ text, reply_to_message: {
      message_id: 9, from: { id: 66, is_bot: false, first_name: "Member", username: "StickerFan" }, sticker: f.pack.stickers[0],
    } });
    assert.deepEqual(f.calls.filter(c => ["banChatMember", "unbanChatMember"].includes(c.method)).map(c => [c.method, c.payload.user_id]), [["banChatMember", 66], ["unbanChatMember", 66]]);
    assert.ok(!f.calls.some(c => c.method === "deleteStickerFromSet"));
    assert.equal(f.pack.stickers.length, 2);
  }
});

test("announcements and gaming wishes mentioning stickers still reach assembly", async t => {
  const global = await fixture(t); global.classify("global");
  await global.handle({ text: "@StickerTestBot Загальне оголошення: у нас новий стікерпак" });
  assert.equal(global.calls.filter(c => c.method === "sendAnimation").length, 1);
  assert.ok(!global.calls.some(c => ["deleteStickerFromSet", "banChatMember"].includes(c.method)));
  const gaming = global; gaming.calls.length = 0; gaming.classify("choose");
  await gaming.handle({ text: "@StickerTestBot Хочеться катки, стікери потім" });
  const menu = gaming.calls.find(c => c.method === "sendMessage");
  assert.equal(menu.payload.reply_markup.inline_keyboard[0].length, 4);
  assert.ok(!gaming.calls.some(c => ["deleteStickerFromSet", "banChatMember"].includes(c.method)));
});
