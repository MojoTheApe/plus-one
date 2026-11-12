import '../test-support/isolated-env.mjs';
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CodexBackend } from "../src/codex-backend.js";

const groupA = { id: -123, type: "supergroup", is_forum: true };
const groupB = { id: -456, type: "supergroup", is_forum: true };
const packA = "alpha_by_AssembleTestBot", packB = "beta_by_AssembleTestBot";

async function fixture(t, { perGroup = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "assemble-handler-"));
  const previous = { ...process.env }, previousFetch = globalThis.fetch;
  const previousClassify = CodexBackend.prototype.classify, previousAsk = CodexBackend.prototype.ask;
  let classification = { action: "none", game: null, confident: true, language: "ambiguous" };
  const calls = [], prompts = [], answerPrompts = [];
  let answer = "Звичайна відповідь.";
  const users = new Map([[77, { id: 77, is_bot: true, username: "AssembleTestBot", first_name: "Bot" }], [88, { id: 88, is_bot: false, username: "qa_operator", first_name: "Operator" }], [99, { id: 99, is_bot: false, first_name: "🤖 Мовчун" }], [100, { id: 100, is_bot: true, first_name: "Other Bot" }]]);
  const betaMember = { id: 199, is_bot: false, first_name: "Beta Member" };
  const betaUsers = new Map([[77, users.get(77)], [88, users.get(88)], [199, betaMember]]);
  const members = new Map([[groupA.id, users], [groupB.id, betaUsers]]);
  const packs = new Map([packA, packB].map(name => [name, { sticker_type: "regular", stickers: [] }]));
  Object.assign(process.env, {
    TELEGRAM_BOT_TOKEN: "000000:ASSEMBLE_QA_ONLY", ANSWER_BACKEND: "codex", MEMORY_DIR: root + "/memory", MEMORY_AUTO_CAPTURE: "false",
    BOT_LOCK_FILE: root + "/runtime/bot.pid", BOT_STATUS_FILE: root + "/runtime/status.json", BOT_OFFSET_FILE: root + "/runtime/offset.json",
    STICKER_BINDINGS_FILE: root + "/runtime/sticker-bindings.json", STICKER_STATE_FILE: root + "/runtime/sticker-actions.json",
    ASSEMBLE_STATE_FILE: root + "/runtime/assemble-state.json", ASSEMBLE_MEMBERS_FILE: root + "/runtime/assemble-members.json",
    ASSEMBLE_GAMES_FILE: path.resolve("test-support/assemble-games.json"), ASSEMBLE_GAME_ASSET_DIR: root + "/assets/games", ASSEMBLE_MEDIA_PATH: root + "/assets/assemble.mp4",
    AI_SESSION_MAP: root + "/runtime/map.json", AI_IMPORTED_CONVERSATIONS: root + "/runtime/import.json",
    VOICE_TRANSCRIPTION_ENABLED: "false", VOICE_GROUP_AUTO_REPLY: "false", SOCIAL_VIDEO_ENABLED: "false", INSULT_REPLY_ENABLED: "false",
  });
  await fs.copyFile("test-support/profiles.json", root + "/profiles.json");
  await fs.mkdir(root + "/private");
  await fs.writeFile(root + "/private/effective-persona.md", "Synthetic legacy assistant. Use Ukrainian and the supplied routing policy.");
  Object.assign(process.env, { BOT_PROFILE_FILE: root + "/profiles.json", BOT_PROFILE: "legacy" });
  CodexBackend.prototype.classify = async ({ prompt }) => { prompts.push(prompt); return JSON.stringify(classification); };
  CodexBackend.prototype.ask = async ({ prompt }) => {
    answerPrompts.push(prompt);
    return { text: answer, searchStatus: { succeeded: false } };
  };
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(String(input)); assert.equal(url.hostname, "api.telegram.org");
    const method = url.pathname.split("/").at(-1); assert.notEqual(method, "getUpdates", "No second poller");
    const payload = options.body instanceof FormData ? Object.fromEntries(options.body.entries()) : JSON.parse(options.body || "{}");
    calls.push({ method, payload });
    let result = true;
    if (method === "getChatMember") result = {
      user: members.get(payload.chat_id)?.get(payload.user_id),
      status: payload.user_id === 77 || (perGroup && payload.chat_id === groupA.id && payload.user_id === 88) ? "administrator" : "member",
    };
    else if (method === "getChatMemberCount") result = members.get(payload.chat_id).size;
    else if (method === "getStickerSet") result = packs.get(payload.name);
    else if (method === "addStickerToSet") {
      packs.get(payload.name).stickers.push({ file_id: payload.sticker.sticker, file_unique_id: payload.sticker.sticker });
    }
    else if (method === "sendMessage") result = { message_id: 999, chat: { id: Number(payload.chat_id), type: "supergroup" } };
    else assert.ok(["sendAnimation", "sendMessage", "sendChatAction", "answerCallbackQuery", "editMessageReplyMarkup", "sendSticker"].includes(method), method);
    return new Response(JSON.stringify({ ok: true, result }));
  };
  t.after(async () => {
    globalThis.fetch = previousFetch; CodexBackend.prototype.classify = previousClassify; CodexBackend.prototype.ask = previousAsk;
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key]; Object.assign(process.env, previous);
    await fs.rm(root, { recursive: true, force: true });
  });
  await fs.mkdir(root + "/src"); await fs.mkdir(root + "/runtime"); await fs.mkdir(root + "/assets/games", { recursive: true });
  for (const game of JSON.parse(await fs.readFile("test-support/assemble-games.json"))) await fs.writeFile(root + "/assets/games/" + (game.media || game.id + ".gif"), "isolated media fixture " + game.id);
  await fs.writeFile(root + "/assets/assemble.mp4", "isolated original media fixture");
  await fs.writeFile(process.env.ASSEMBLE_MEMBERS_FILE, JSON.stringify({
    chats: Object.fromEntries([...members].map(([chatId, chatUsers]) => [chatId, {
      users: Object.fromEntries([...chatUsers].map(([id, user]) => [id, { user, active: true }])),
    }])),
  }));
  if (perGroup) {
    const file = path.join(root, "runtime", "groups.json");
    Object.assign(process.env, { BOT_GROUP_SETTINGS_FILE: file, INSULT_REPLY_ENABLED: "true", INSULT_REPLY_ANIMATION: "legacy-reaction" });
    await fs.writeFile(process.env.STICKER_BINDINGS_FILE, JSON.stringify({
      version: 1, chats: { [-789]: { packName: "legacy_by_AssembleTestBot", ownerId: 909 } },
    }));
    await fs.writeFile(file, JSON.stringify({
      version: 1, chats: {
        [groupA.id]: {
          assemble: {
            globalAnimation: "alpha-global.mp4",
            games: {
              fortnite: { players: ["@AlphaPlayer", "alphaplayer"], animation: "alpha-fort.gif" },
              "rocket-league": { players: ["AlphaRocket"] },
            },
          },
          insultReply: { terms: ["alpha buzzword"], animation: "alpha-reaction" },
          stickerPack: { packName: packA, ownerId: 101 },
        },
        [groupB.id]: {
          assemble: {
            globalAnimation: "beta-global.mp4",
            games: {
              fortnite: { players: ["BetaPlayer"], animation: "beta-fort.gif" },
              "arc-riders": { players: ["BetaArc"] },
            },
          },
          insultReply: { terms: ["beta buzzword"], animationFile: "beta-reaction.gif" },
          stickerPack: { packName: packB, ownerId: 102 },
        },
      },
    }));
    for (const name of ["alpha-fort.gif", "beta-fort.gif", "alpha-global.mp4", "beta-global.mp4", "beta-reaction.gif"]) {
      await fs.writeFile(path.join(root, "runtime", name), "synthetic animation " + name);
    }
  }
  for (const file of await fs.readdir("src")) if (file !== "bot.js") await fs.symlink(path.resolve("src", file), root + "/src/" + file);
  let source = await fs.readFile("src/bot.js", "utf8");
  const start = source.indexOf("main().catch((error) => {"), end = source.indexOf("\nasync function main()", start);
  assert.ok(start > 0 && end > start); source = source.slice(0, start) + source.slice(end);
  source += '\nexport async function init(){botInfo={id:77,is_bot:true,first_name:"Bot",username:"AssembleTestBot"};await ensureMemoryVault();await ensureSettingsVault();}\nexport {handleUpdate};\n';
  await fs.writeFile(root + "/src/bot.mjs", source);
  const app = await import(root + "/src/bot.mjs"); await app.init();
  let serial = 200;
  const message = (text, extra = {}) => ({ chat: groupA, from: users.get(88), message_id: serial++, date: Math.floor(Date.now() / 1000), message_thread_id: 7001, text, ...extra });
  return { calls, prompts, answerPrompts, users, root, setAnswer: text => { answer = text; }, handle: (text, extra) => app.handleUpdate({ update_id: serial++, message: message(text, extra) }), update: (update) => app.handleUpdate(update), set: (v) => { classification = v; } };
}

test("actual handler sends the correct GIF, exact game mentions and forum topic for each explicit game", async (t) => {
  const f = await fixture(t);
  const games = JSON.parse(await fs.readFile("test-support/assemble-games.json"));
  for (const game of games) {
    await f.handle("Assemble " + game.name);
    const payload = f.calls.filter((c) => c.method === "sendAnimation").at(-1).payload;
    assert.equal(payload.animation.name, (game.media || game.id + ".gif")); assert.equal(payload.message_thread_id, "7001");
    assert.deepEqual(payload.caption.match(/@[A-Za-z0-9_]+/g), game.players.map((p) => "@" + p));
    assert.equal(JSON.parse(payload.caption_entities).length, game.players.length);
    assert.ok(!payload.caption.includes("Avengers"));
    if (game.id === "helldivers-2") assert.equal(payload.animation.type, "video/mp4");
  }
  assert.equal(f.prompts.length, 0);
});

test("global command keeps original animation/caption and includes silent users through ID mentions", async (t) => {
  const f = await fixture(t); await f.handle("/assemble");
  const payload = f.calls.find((c) => c.method === "sendAnimation").payload;
  assert.equal(payload.animation.name, "assemble.mp4"); assert.match(payload.caption, /^Avengers Assemble!/);
  const entities = JSON.parse(payload.caption_entities); assert.equal(entities.length, 2);
  assert.equal(entities.find((e) => e.type === "text_mention").user.id, 99);
  assert.ok(!payload.caption.includes("AssembleTestBot"));
});

test("actual natural handler obeys semantic intent and language result without falling into old assemble triggers", async (t) => {
  const f = await fixture(t);
  for (const text of ["Вчора катали в форточку", "Кто хочет поиграть в ракетку?", "Avengers Assemble"]) {
    f.set({ action: "call", game: "fortnite", confident: true, language: "russian" });
    await f.handle(text);
  }
  assert.equal(f.calls.filter((c) => c.method === "sendAnimation").length, 0);
  f.set({ action: "call", game: "arc-riders", confident: true, language: "mixed" });
  await f.handle("go в рейдеров поиграем");
  assert.equal(f.calls.find((c) => c.method === "sendAnimation").payload.animation.name, "arc-riders.gif");
});

test("voice transcript game invitation reaches assemble instead of a generic AI reply", async (t) => {
  const f = await fixture(t); f.set({ action: "call", game: "rocket-league", confident: true, language: "ambiguous" });
  await f.handle(undefined, { voice: { file_id: "fixture" }, _voiceTranscript: "го в ракетку" });
  assert.equal(f.calls.find((c) => c.method === "sendAnimation").payload.animation.name, "rocket-league.gif");
});

test("real callback update selects a game once and sends its GIF in the originating topic", async (t) => {
  const f = await fixture(t); f.set({ action: "choose", game: null, confident: true, language: "ambiguous" });
  await f.handle("го катнемо");
  const menu = f.calls.find((c) => c.method === "sendMessage").payload;
  assert.equal(f.calls.filter((c) => c.method === "sendAnimation").length, 0);
  const query = { id: "fixture-callback", from: f.users.get(88), data: menu.reply_markup.inline_keyboard[0][1].callback_data,
    message: { chat: { id: -123, type: "supergroup", is_forum: true }, message_id: 999, message_thread_id: 7001 } };
  await f.update({ callback_query: query }); await f.update({ callback_query: query });
  const animations = f.calls.filter((c) => c.method === "sendAnimation"); assert.equal(animations.length, 1);
  assert.equal(animations[0].payload.animation.name, "rocket-league.gif"); assert.equal(animations[0].payload.message_thread_id, "7001");
});

test("membership-only updates persist the new member without producing a chat response", async (t) => {
  const f = await fixture(t);
  await f.update({ chat_member: { chat: { id: -123, type: "supergroup", is_forum: true }, new_chat_member: { status: "member", user: { id: 111, is_bot: false, first_name: "New Player" } } } });
  const state = JSON.parse(await fs.readFile(f.root + "/runtime/assemble-members.json"));
  assert.equal(state.chats[-123].users[111].active, true); assert.equal(f.calls.length, 0);
});

test("another bot's command is ignored and a repeated game call sends no additional mentions", async (t) => {
  const f = await fixture(t); await f.handle("/assemble@OtherBot fort"); assert.equal(f.calls.length, 0);
  await f.handle("/assemble fort"); await f.handle("/assemble fort");
  assert.equal(f.calls.filter((c) => c.method === "sendAnimation").length, 1);
  assert.equal(f.calls.filter((c) => c.method === "sendMessage").length, 1);
});

test("quoted and code-formatted global, game and natural text cannot trigger the actual handler", async (t) => {
  const f = await fixture(t); f.set({ action: "call", game: "fortnite", confident: true, language: "english" });
  for (const type of ["blockquote", "expandable_blockquote", "pre", "code"]) {
    for (const text of ["Assemble", "Assemble Fortnite", "go fort", "Тегни всіх"]) await f.handle(text, { entities: [{ type, offset: 0, length: text.length }] });
    await f.handle(undefined, { caption: "Assemble Fortnite", caption_entities: [{ type, offset: 0, length: 17 }] });
  }
  assert.equal(f.prompts.length, 0); assert.equal(f.calls.filter((c) => c.method === "sendAnimation").length, 0);
});

test("unquoted current invitations remain actionable beside a formatted quote or a replied-to message", async (t) => {
  const f = await fixture(t); f.set({ action: "call", game: "rocket-league", confident: true, language: "mixed" });
  const quote = "🤖 Assemble Fortnite";
  await f.handle(quote + "\ngo в ракетку", { entities: [{ type: "blockquote", offset: 0, length: quote.length }], reply_to_message: { text: "Assemble arc" } });
  const prompt = JSON.parse(f.prompts[0].slice(f.prompts[0].indexOf("\n") + 1)); assert.equal(prompt.message, "go в ракетку"); assert.equal(prompt.quotedReply, "Assemble arc");
  assert.equal(f.calls.find((c) => c.method === "sendAnimation").payload.animation.name, "rocket-league.gif");
  await f.handle("/assemble arc", { reply_to_message: { text: "Assemble Fortnite" } });
  assert.equal(f.calls.filter((c) => c.method === "sendAnimation").at(-1).payload.animation.name, "arc-riders.gif");
});

test("removing formatted game arguments never promotes a longer command to global", async (t) => {
  const f = await fixture(t);
  for (const type of ["blockquote", "expandable_blockquote", "pre", "code"]) {
    for (const text of ["Assemble Fortnite", "/assemble Fortnite"]) {
      const entity = { type, offset: text.indexOf("Fortnite"), length: 8 };
      await f.handle(text, { entities: [entity] });
      await f.handle(undefined, { caption: text, caption_entities: [entity] });
    }
  }
  assert.equal(f.prompts.length, 0); assert.equal(f.calls.filter((c) => c.method === "sendAnimation").length, 0);
});

test("another group member can pick each game from a regular-group reply keyboard once", async (t) => {
  const f = await fixture(t); f.set({ action: "choose", game: null, confident: true, language: "ambiguous" });
  const chat = { id: -123, type: "supergroup", is_forum: false };
  const games = JSON.parse(await fs.readFile("test-support/assemble-games.json"));
  for (const [index, game] of games.entries()) {
    await f.handle(["Хочеться катнути", "Хочеться катки", "Хочеться пару каток", "Може пограємо?"][index], { chat, message_thread_id: 136768 });
    const menu = f.calls.filter(c => c.method === "sendMessage").at(-1).payload;
    assert.equal(menu.message_thread_id, undefined);
    const query = { id: "regular-" + index, from: f.users.get(99), data: menu.reply_markup.inline_keyboard[0][index].callback_data,
      message: { chat, message_id: 999, message_thread_id: 136768 } };
    const before = f.calls.filter(c => c.method === "sendAnimation").length;
    await f.update({ callback_query: query }); await f.update({ callback_query: query });
    const sent = f.calls.filter(c => c.method === "sendAnimation"); assert.equal(sent.length, before + 1);
    assert.equal(sent.at(-1).payload.animation.name, (game.media || game.id + ".gif")); assert.equal(sent.at(-1).payload.message_thread_id, undefined);
    assert.deepEqual(sent.at(-1).payload.caption.match(/@[A-Za-z0-9_]+/g), game.players.map(n => "@" + n));
  }
});

test("natural all-chat requests use the original Avengers media, complete human roster and global cooldown", async (t) => {
  const f = await fixture(t); f.set({ action: "global", game: null, confident: true, language: "ukrainian" });
  await f.handle("Можеш зібрати всіх учасників групи?", { chat: { id: -123, type: "supergroup" }, message_thread_id: 456 });
  const sent = f.calls.find(c => c.method === "sendAnimation").payload;
  assert.equal(sent.animation.name, "assemble.mp4"); assert.match(sent.caption, /^Avengers Assemble!/);
  assert.equal(sent.message_thread_id, undefined); assert.equal(JSON.parse(sent.caption_entities).length, 2);
  assert.ok(JSON.parse(sent.caption_entities).some(e => e.type === "text_mention" && e.user.id === 99));
  await f.handle("/assemble"); assert.equal(f.calls.filter(c => c.method === "sendAnimation").length, 1);
});

test("Helldivers nicknames use only its roster and shared buttons obey the same cooldown", async t => {
  const f = await fixture(t); f.set({ action: "call", game: "helldivers-2", confident: true, language: "mixed" });
  await f.handle("go в демократию", { chat: { id: -123, type: "supergroup" } });
  const animation = f.calls.find(c => c.method === "sendAnimation").payload;
  assert.equal(animation.animation.name, "helldivers-2.mp4"); assert.equal(animation.animation.type, "video/mp4");
  assert.deepEqual(animation.caption.match(/@[A-Za-z0-9_]+/g), ["@fixture_player_01", "@fixture_player_07", "@fixture_player_11", "@fixture_player_16", "@fixture_player_12", "@fixture_player_18", "@fixture_player_08", "@fixture_player_20", "@fixture_player_02", "@fixture_player_13", "@fixture_player_06"]);
  f.set({ action: "choose", game: null, confident: true, language: "ukrainian" }); await f.handle("Може пограємо?", { chat: { id: -123, type: "supergroup" } });
  const menu = f.calls.filter(c => c.method === "sendMessage").at(-1).payload;
  assert.deepEqual(menu.reply_markup.inline_keyboard[0].map(b => b.text), ["Fortnite", "Rocket League", "Arc Riders", "Helldivers 2"]);
  await f.update({ callback_query: { id: "hd-cooldown", from: f.users.get(99), data: menu.reply_markup.inline_keyboard[0][3].callback_data, message: { chat: { id: -123, type: "supergroup" }, message_id: 999 } } });
  assert.equal(f.calls.filter(c => c.method === "sendAnimation").length, 1);
  assert.ok(f.calls.some(c => c.method === "sendMessage" && c.payload.text.includes("Повторний збір")));
});

test("two groups keep identical commands, rosters, media, reaction terms and sticker permissions separate", async t => {
  const f = await fixture(t, { perGroup: true });
  const inChat = (chat, text, extra = {}) => f.handle(text, { ...extra, chat });
  const animations = () => f.calls.filter(call => call.method === "sendAnimation").map(call => call.payload);
  for (const chat of [groupA, groupB]) {
    await inChat(chat, "/assemble fort");
    await inChat(chat, "/assemble");
    await inChat(chat, "@AssembleTestBot alpha buzzword");
    await inChat(chat, "@AssembleTestBot beta buzzword");
    await inChat(chat, "@AssembleTestBot idiot");
    await inChat(chat, "/stickers");
  }
  const [alpha, alphaGlobal, alphaReaction, beta, betaGlobal, betaReaction] = animations();
  assert.equal(animations().length, 6);
  assert.deepEqual(animations().map(item => [Number(item.chat_id), item.animation.name ?? item.animation]), [
    [groupA.id, "alpha-fort.gif"], [groupA.id, "alpha-global.mp4"], [groupA.id, "alpha-reaction"],
    [groupB.id, "beta-fort.gif"], [groupB.id, "beta-global.mp4"], [groupB.id, "beta-reaction.gif"],
  ]);
  assert.deepEqual(alpha.caption.match(/@\w+/g), ["@AlphaPlayer"]);
  assert.deepEqual(beta.caption.match(/@\w+/g), ["@BetaPlayer"]);
  assert.equal(alphaReaction.message_thread_id, 7001);
  assert.equal(betaReaction.message_thread_id, "7001");
  assert.deepEqual([alphaGlobal, betaGlobal].map(item =>
    JSON.parse(item.caption_entities).find(entity => entity.type === "text_mention").user.id), [99, 199]);

  const links = f.calls.filter(call => call.method === "sendMessage" && call.payload.text.includes("addstickers/"));
  assert.deepEqual(links.map(({ payload }) => [payload.chat_id, payload.text.split("\n")[0]]), [
    [groupA.id, "https://t.me/addstickers/" + packA], [groupB.id, "https://t.me/addstickers/" + packB],
  ]);
  const sticker = { file_id: "fixture-sticker", file_unique_id: "fixture-sticker", set_name: packB };
  await inChat(groupA, "/stickerdel", { sticker });
  assert.match(f.calls.at(-1).payload.text, /іншому паку/);
  await inChat(groupB, "/stickeradd", { sticker });
  assert.match(f.calls.at(-1).payload.text, /лише адміністратори/);
  await inChat(groupA, "/stickeradd", { sticker });
  const additions = f.calls.filter(call => call.method === "addStickerToSet");
  assert.deepEqual(additions.map(({ payload }) => [payload.name, payload.user_id]), [[packA, 101]]);
  assert.equal(f.calls.some(call => call.method === "deleteStickerFromSet"), false);

  const unconfigured = { ...groupA, id: -789 };
  await inChat(unconfigured, "/assemble fort");
  assert.match(f.calls.at(-1).payload.text, /не налаштовано/);
  await inChat(unconfigured, "/stickers");
  assert.match(f.calls.at(-1).payload.text, /ще не підключено/);
  await inChat(unconfigured, "@AssembleTestBot idiot");
  assert.equal(animations().length, 6);
});

test("group game menus and AI actions only use games enabled in the current chat", async t => {
  const f = await fixture(t, { perGroup: true });
  f.set({ action: "choose", game: null, confident: true, language: "ambiguous" });
  for (const chat of [groupA, groupB]) await f.handle("го катнемо", { chat });
  const choices = [
    [{ id: "fortnite", name: "Fortnite" }, { id: "rocket-league", name: "Rocket League" }],
    [{ id: "fortnite", name: "Fortnite" }, { id: "arc-riders", name: "Arc Riders" }],
  ];
  assert.deepEqual(f.prompts.map(prompt => JSON.parse(prompt.slice(prompt.indexOf("\n") + 1)).availableGames.map(({id,name})=>({id,name}))), choices);
  const [alphaMenu, betaMenu] = f.calls.filter(call => call.payload.reply_markup?.inline_keyboard?.[0]?.length).map(call => call.payload.reply_markup.inline_keyboard[0]);
  assert.deepEqual(alphaMenu.map(button => button.text), ["Fortnite", "Rocket League"]);
  assert.deepEqual(betaMenu.map(button => button.text), ["Fortnite", "Arc Riders"]);

  const select = (chat, data) => f.update({ callback_query: {
    id: `fixture-${f.calls.length}`, from: f.users.get(88), data,
    message: { chat, message_id: 999, message_thread_id: 7001 },
  } });
  await select(groupB, alphaMenu[0].callback_data);
  assert.match(f.calls.at(-1).payload.text, /неактивний/);
  await select(groupB, betaMenu[1].callback_data.replace(/arc-riders$/, "rocket-league"));
  assert.match(f.calls.at(-1).payload.text, /не налаштовано/);
  assert.equal(f.calls.some(call => call.method === "sendAnimation"), false);
  await select(groupA, alphaMenu[1].callback_data);
  await select(groupB, betaMenu[1].callback_data);
  const gameMessages = f.calls.filter(call => call.method === "sendMessage" && call.payload.text?.startsWith("🎮"));
  assert.deepEqual(gameMessages.map(({ payload }) => [payload.chat_id, payload.text.match(/@\w+/g)]), [
    [groupA.id, ["@AlphaRocket"]], [groupB.id, ["@BetaArc"]],
  ]);

  f.setAnswer(JSON.stringify({ action: "assemble", language: "uk", gameIds: ["fortnite", "helldivers-2"] }));
  for (const chat of [groupA, groupB]) {
    await f.handle("Збери гравців у всіх доступних іграх", {
      chat, reply_to_message: { message_id: 99, from: f.users.get(77), text: "Fortnite, Helldivers" },
    });
  }
  assert.deepEqual(f.answerPrompts.map(prompt => JSON.parse(prompt.match(/Games enabled in this chat: (\[.*?\])\./)[1]).map(({id,name})=>({id,name}))), choices.flatMap(choice=>[choice,choice]));
  const calls = f.calls.filter(call => call.method === "sendAnimation");
  assert.deepEqual(calls,[], 'an out-of-scope game invalidates the whole AI action');
});
