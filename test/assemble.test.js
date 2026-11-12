import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AssembleRouter, parseAssembleIntent, isAssembleCandidate, validateGames } from "../src/assemble.js";

const games = JSON.parse(await fs.readFile(new URL("../test-support/assemble-games.json", import.meta.url)));
const verdict = (action = "call", game = "rocket-league", language = "ambiguous", confident = true) => JSON.stringify({ action, game, language, confident });
const message = (text, extra = {}) => ({ chat: { id: -100, type: "supergroup", is_forum: true }, from: { id: 123 }, message_id: 456, message_thread_id: 99, text, ...extra });

test("shipped game definitions contain no recipients and cannot summon before configuration", async t => {
  const definitions = JSON.parse(await fs.readFile(new URL("../src/assemble-games.json", import.meta.url)));
  assert.ok(validateGames(definitions).every(game => game.players.length === 0));
  const f = await fixture(t);
  const router = new AssembleRouter({ ...f.options, games: definitions });
  await router.handleMessage(message("/assemble fort"), "FixtureBot", "/assemble fort");
  assert.equal(f.calls.length, 0);
  assert.match(f.notices[0], /не налаштовано/);
});

async function fixture(t, result = verdict()) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "assemble-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const calls = [], menus = [], notices = [], callbacks = [], prompts = [];
  let now = 100000;
  const options = { games, stateFile: root + "/state.json", now: () => now,
    classify: async (p) => { prompts.push(JSON.parse(p)); return result; },
    sendGlobal: async () => calls.push("global"), sendCall: async (_m, g) => calls.push(g.id),
    sendMenu: async (m, token, choices) => { menus.push({ m, token, choices }); return { message_id: 789 }; }, sendNotice: async (_m, text) => notices.push(text),
    canChoose: async () => true, answerCallback: async (_id, text) => callbacks.push(text), clearMenu: async () => {},
  };
  return { router: new AssembleRouter(options), options, calls, menus, notices, callbacks, prompts, advance: (ms) => { now += ms; } };
}

test("four validated rosters retain 12/12/6/11 players and deduplicate case-insensitively", () => {
  assert.deepEqual(validateGames(games).map((g) => g.players.length), [12, 12, 6, 11]);
  const duplicate = structuredClone(games); duplicate[0].players.push("@FIXTURE_PLAYER_01".replace("О", "O"));
  assert.equal(validateGames(duplicate)[0].players.length, 12);
  assert.equal(validateGames(games)[3].media, "helldivers-2.mp4");
  for (const media of ["../escape.mp4", "/tmp/clip.mp4", "helldivers-2.exe", "fortnite.mp4"]) { const bad = structuredClone(games); bad[3].media = media; assert.throws(() => validateGames(bad), /Invalid assemble media/); }
  const invalid = structuredClone(games); invalid[0].players = ["@bad mention"];
  assert.throws(() => validateGames(invalid));
});

test('managed arbitrary game commands, aliases and picker use the current saved payload',async t=>{
  const f=await fixture(t),custom={id:'g_custom',name:'Minecraft',commandName:'Crew',aliases:['blocks'],players:['player_one'],caption:'Build together',animationReference:'prepared-gif'};
  const group={games:[custom]},router=new AssembleRouter({...f.options,getGroupAssembly:()=>group,chooseOnCommand:true});
  await router.handleMessage(message('/assemble'),'FixtureBot','/assemble');assert.equal(f.calls.length,0);assert.equal(f.menus[0].choices[0].commandName,'Crew');
  const token=f.menus[0].token;await router.handleCallback({id:'custom',from:{id:456},data:'assemble:'+token+':g_custom',message:{chat:{id:-100,type:'supergroup',is_forum:true},message_id:789,message_thread_id:99}});
  assert.deepEqual(f.calls,['g_custom']);f.advance(61000);
  custom.commandName='Builders';custom.players=['player_two'];
  let sent;router.sendCall=async(_m,game)=>{sent=structuredClone(game);};
  await router.handleMessage(message('/assemble Builders'),'FixtureBot','/assemble Builders');assert.equal(sent.commandName,'Builders');assert.deepEqual(sent.players,['player_two']);assert.equal(sent.caption,'Build together');
  f.advance(61000);await router.handleMessage(message('/assemble blocks'),'FixtureBot','/assemble blocks');assert.equal(sent.animationReference,'prepared-gif');
  group.games=[];f.advance(61000);sent=null;await router.call(message('go'),'g_custom');assert.equal(sent,null);
});

test('replay: HD selects an existing game menu through its original invitation, once', async t => {
  const f=await fixture(t,verdict('choose',null));
  await f.router.handleMessage(message('Будем во что катать?'),'MyBot','Будем во что катать?');
  const selection=message('ХД',{message_id:457,from:{id:999},reply_to_message:{message_id:456,text:'Будем во что катать?'}});
  await f.router.handleMessage(selection,'MyBot','ХД');
  assert.deepEqual(f.calls,['helldivers-2']);
  assert.equal(f.menus.length,1); assert.equal(f.prompts.length,1);
  assert.equal(Object.keys(f.router.state.menus).length,0);
});

test('replay: classifier receives the human prototype/Discord chain rather than just Go', async t => {
  const f=await fixture(t,verdict('none',null));
  const chain=[{messageId:450,text:'Гоу диск покажу прототип',sender:'@PersonA'},{messageId:451,text:'Маякуй',sender:'@PersonB'}];
  f.router.getContext=async()=>({replyChain:chain,history:chain});
  await f.router.handleMessage(message('Го?',{reply_to_message:{message_id:451,text:'Маякуй'}}),'MyBot','Го?');
  assert.deepEqual(f.prompts[0].replyChain,chain);
  assert.equal(f.calls.length,0); assert.equal(f.menus.length,0);
});

test("broad candidate gate accepts new nickname combinations and long invitations without matching phrases", () => {
  for (const text of ["go в жуков", "go по демократиям", "Постріляємо жуків?", "Дайвери, хто на катку?", "ХВ", "HD2", "Хочеться катки", "Хочеться пару каток", "Go в ракетка", "go в рейдеров поиграем", "Хтось на пару матчів у рейдерів?", "Rocket ліжку катнемо?", "Є бажаючі щось пограти?", "го в арков", "Це просто передмова. ".repeat(35) + "Поклич усіх у фортик!"]) assert.equal(isAssembleCandidate(text), true, text);
  for (const text of ["Привіт", "/judge", "x".repeat(4097)]) assert.equal(isAssembleCandidate(text), false);
  for (const text of ["Собери игроков", "Созови игроков", "Пошли играть"]) {
    assert.equal(isAssembleCandidate(text), false);
    assert.equal(isAssembleCandidate(text, true), true);
  }
});

test("strict AI result gate rejects unsupported languages, uncertain answers and invalid game/action combinations", () => {
  for (const invalid of [verdict("call", "global"), verdict("global", "fortnite"), verdict("call", "rocket-league", "russian"), verdict("call", "rocket-league", "unknown"), verdict("call", "rocket-league", "mixed", false), '{"action":"call","game":"fortnite","confident":true}', "not JSON", verdict().slice(0, -1) + ',"tags":"@someone"}']) assert.deepEqual(parseAssembleIntent(invalid, games), { action: "none", game: null });
  for (const language of ["ukrainian", "english", "mixed", "ambiguous"]) assert.deepEqual(parseAssembleIntent(verdict("call", "fortnite", language), games), { action: "call", game: "fortnite" });
});

test("Russian natural invitations still require confident intent when the selected profile accepts Russian", async t => {
  const text = "Позови игроков Fortnite, сыграем сейчас";
  const f = await fixture(t, verdict("call", "fortnite", "russian"));
  assert.equal(await f.router.handleMessage(message(text), "MyBot", text), false);
  const accepting = new AssembleRouter({ ...f.options, acceptRussian: true });
  assert.equal(await accepting.handleMessage(message(text), "MyBot", text), true);
  assert.deepEqual(f.calls, ["fortnite"]);
  assert.deepEqual(parseAssembleIntent(verdict("call", "fortnite", "russian", false), games, true), { action: "none", game: null });
});

test("standalone Assemble commands retain direct all-chat behavior", async (t) => {
  const f = await fixture(t, verdict("none", null));
  for (const text of ["Assemble", "/assemble", "/assemble@MyBot", "ASSEMBLE"]) {
    await f.router.handleMessage(message(text), "MyBot", text); f.advance(60001);
  }
  assert.deepEqual(f.calls, ["global", "global", "global", "global"]);
  for (const text of ["Avengers Assemble", "Ми вчора писали Assemble", "/assemble@AnotherBot"]) await f.router.handleMessage(message(text), "MyBot", text);
  assert.equal(f.calls.length, 4);
});

test("explicit game commands target only their roster and need no classifier", async (t) => {
  const f = await fixture(t);
  for (const [text, game] of [["Assemble Fortnite", "fortnite"], ["/assemble fort", "fortnite"], ["Assemble Rocket League", "rocket-league"], ["/assemble rocket", "rocket-league"], ["Assemble Rocket ліжка", "rocket-league"], ["Assemble arc raiders", "arc-riders"], ["/assemble@MyBot arc", "arc-riders"], ["/assemble hd", "helldivers-2"], ["Assemble Helldivers 2", "helldivers-2"], ["Assemble ХВ", "helldivers-2"], ["Assemble жуки", "helldivers-2"]]) {
    await f.router.handleMessage(message(text), "MyBot", text); assert.equal(f.calls.at(-1), game); f.advance(60001);
  }
  assert.equal(f.prompts.length, 0);
});

test("natural game calls require AI invitation intent and target their game roster", async (t) => {
  const f = await fixture(t, verdict("call", "fortnite", "ukrainian"));
  await f.router.handleMessage(message("Поклич усіх у форточку"), "MyBot", "Поклич усіх у форточку");
  assert.deepEqual(f.calls, ["fortnite"]);
  const refused = await fixture(t, verdict("none", null, "russian"));
  assert.equal(await refused.router.handleMessage(message("Позови всех в форточку"), "MyBot", "Позови всех в форточку"), false);
  assert.equal(refused.calls.length, 0);
});

test("bot mentions do not disguise a clearly Russian request and forwarded invitations are ignored", async (t) => {
  const f = await fixture(t, verdict("call", "fortnite", "russian"));
  const text = "@MyBot Кто хочет поиграть в Fortnite?";
  await f.router.handleMessage(message(text), "MyBot", text);
  assert.equal(f.prompts[0].message.includes("@MyBot"), false);
  assert.equal(f.calls.length, 0);
  await f.router.handleMessage(message("go arc", { forward_origin: { type: "user" } }), "MyBot", "go arc");
  await f.router.handleMessage(message("@someone, go arc"), "MyBot", "@someone, go arc");
  assert.equal(f.prompts.length, 1);
});

test("ambiguous gaming invitation shows game buttons without any tags", async (t) => {
  const f = await fixture(t, verdict("choose", null));
  await f.router.handleMessage(message("го катнемо"), "MyBot", "го катнемо");
  assert.equal(f.calls.length, 0); assert.equal(f.menus.length, 1);
  assert.deepEqual(f.menus[0].choices.map((g) => g.id), ["fortnite", "rocket-league", "arc-riders", "helldivers-2"]);
});

test("cooldowns are per game and chat, independent of the global call, and survive restart", async (t) => {
  const f = await fixture(t);
  await f.router.handleMessage(message("Assemble"), "MyBot", "Assemble");
  await f.router.handleMessage(message("Assemble fort"), "MyBot", "Assemble fort");
  await f.router.handleMessage(message("Assemble rocket"), "MyBot", "Assemble rocket");
  const restarted = new AssembleRouter(f.options);
  await restarted.handleMessage(message("Assemble fort"), "MyBot", "Assemble fort");
  assert.deepEqual(f.calls, ["global", "fortnite", "rocket-league"]); assert.equal(f.notices.length, 1);
  await restarted.handleMessage(message("Assemble fort", { chat: { id: -101, type: "group" } }), "MyBot", "Assemble fort");
  assert.equal(f.calls.length, 4); f.advance(60001);
  await restarted.handleMessage(message("Assemble fort"), "MyBot", "Assemble fort"); assert.equal(f.calls.length, 5);
  assert.equal((await fs.stat(f.options.stateFile)).mode & 0o777, 0o600);
});

test("failed delivery does not consume the game's cooldown", async (t) => {
  const f = await fixture(t);
  let fail = true;
  f.router.sendCall = async () => { if (fail) throw new Error("Telegram unavailable"); f.calls.push("fortnite"); };
  await assert.rejects(f.router.handleMessage(message("/assemble fort"), "MyBot", "/assemble fort"));
  fail = false;
  await f.router.handleMessage(message("/assemble fort"), "MyBot", "/assemble fort");
  assert.deepEqual(f.calls, ["fortnite"]);
});

test("buttons bind the delivered message, chat and forum topic, and allow any current member once", async (t) => {
  const f = await fixture(t, verdict("choose", null));
  await f.router.handleMessage(message("го катнемо"), "MyBot", "го катнемо");
  const token = f.menus[0].token;
  const query = { id: "callback", from: { id: 123 }, data: `assemble:${token}:arc-riders`, message: { chat: { id: -100, type: "supergroup", is_forum: true }, message_thread_id: 99, message_id: 789 } };
  await f.router.handleCallback({ ...query, message: { ...query.message, message_id: 790 } });
  await f.router.handleCallback({ ...query, message: { ...query.message, message_thread_id: 100 } });
  await f.router.handleCallback({ ...query, message: { ...query.message, chat: { id: -999 } } });
  await f.router.handleCallback({ ...query, data: `assemble:${token}:global` });
  assert.equal(f.calls.length, 0);
  const restarted = new AssembleRouter(f.options);
  await restarted.handleCallback({ ...query, from: { id: 124 } });
  assert.deepEqual(f.calls, ["arc-riders"]);
  await restarted.handleCallback(query); assert.equal(f.calls.length, 1);
});

test("expired choice buttons and private commands do not tag anyone", async (t) => {
  const f = await fixture(t, verdict("choose", null));
  await f.router.handleMessage(message("го катнемо"), "MyBot", "го катнемо");
  f.advance(300001);
  await f.router.handleCallback({ id: "expired", from: { id: 123 }, data: `assemble:${f.menus[0].token}:fortnite`, message: { chat: { id: -100 }, message_thread_id: 99 } });
  await f.router.handleMessage(message("/assemble", { chat: { id: 123, type: "private" } }), "MyBot", "/assemble");
  assert.equal(f.calls.length, 0); assert.equal(f.notices.length, 1);
});

test("a successful callback persists cooldown and consumption in the same interrupted checkpoint", async (t) => {
  const f = await fixture(t, verdict("choose", null));
  await f.router.handleMessage(message("го катнемо"), "MyBot", "го катнемо");
  const query = { id: "checkpoint", from: { id: 123 }, data: `assemble:${f.menus[0].token}:fortnite`, message: { chat: { id: -100, type: "supergroup", is_forum: true }, message_thread_id: 99, message_id: 789 } };
  const save = f.router.save.bind(f.router);
  f.router.save = async () => { await save(); throw new Error("Interrupted after persisted delivery checkpoint"); };
  await assert.rejects(f.router.handleCallback(query), /Interrupted/);
  const persisted = JSON.parse(await fs.readFile(f.options.stateFile));
  assert.equal(Object.keys(persisted.menus).length, 0); assert.equal(persisted.calls["-100:fortnite"], 100000);
  f.advance(60001);
  await new AssembleRouter(f.options).handleCallback(query);
  assert.deepEqual(f.calls, ["fortnite"]);
});

test("callback cooldown and delivery failures preserve the still-unused choice", async (t) => {
  const f = await fixture(t, verdict("choose", null));
  await f.router.handleMessage(message("го катнемо"), "MyBot", "го катнемо");
  const token = f.menus[0].token;
  const query = { id: "retry", from: { id: 123 }, data: `assemble:${token}:fortnite`, message: { chat: { id: -100, type: "supergroup", is_forum: true }, message_thread_id: 99, message_id: 789 } };
  await f.router.handleMessage(message("/assemble fort"), "MyBot", "/assemble fort");
  await f.router.handleCallback(query); assert.ok(f.router.state.menus[token]);
  f.advance(60001); f.router.sendCall = async () => { throw new Error("Delivery failed"); };
  await assert.rejects(f.router.handleCallback(query), /Delivery failed/); assert.ok(f.router.state.menus[token]);
});

test("regular group reply-thread metadata does not reject a shared choice or leak into delivery", async (t) => {
  const f = await fixture(t, verdict("choose", null));
  await f.router.handleMessage(message("Хочеться катнути", { chat: { id: -100, type: "supergroup" }, message_thread_id: 400 }), "MyBot", "Хочеться катнути");
  const token = f.menus[0].token; assert.equal(f.router.state.menus[token].threadId, null);
  let delivered;
  f.router.sendCall = async (m, g) => { delivered = m; f.calls.push(g.id); };
  await f.router.handleCallback({ id: "regular", from: { id: 124 }, data: `assemble:${token}:rocket-league`, message: { chat: { id: -100, type: "supergroup" }, message_id: 789, message_thread_id: 456 } });
  assert.deepEqual(f.calls, ["rocket-league"]); assert.equal(delivered.message_thread_id, undefined); assert.equal(delivered.message_id, 456);
});

test("nonmembers and failed membership checks do not consume the picker", async (t) => {
  const f = await fixture(t, verdict("choose", null));
  await f.router.handleMessage(message("го катнемо"), "MyBot", "го катнемо");
  const token = f.menus[0].token;
  const q = { id: "membership", from: { id: 124 }, data: `assemble:${token}:arc-riders`, message: { chat: { id: -100, type: "supergroup", is_forum: true }, message_id: 789, message_thread_id: 99 } };
  f.router.canChoose = async () => false; await f.router.handleCallback(q); assert.equal(f.calls.length, 0); assert.ok(f.router.state.menus[token]);
  f.router.canChoose = async () => { throw new Error("Telegram down"); }; await f.router.handleCallback(q); assert.equal(f.calls.length, 0); assert.ok(f.router.state.menus[token]);
  f.router.canChoose = async () => true; await f.router.handleCallback(q); assert.deepEqual(f.calls, ["arc-riders"]);
});

test("a later invitation from the same author does not invalidate an earlier picker", async (t) => {
  const f = await fixture(t, verdict("choose", null));
  await f.router.handleMessage(message("го катнемо"), "MyBot", "го катнемо");
  await f.router.handleMessage(message("може пограємо", { message_id: 457 }), "MyBot", "може пограємо");
  assert.ok(f.router.state.menus[f.menus[0].token]); assert.ok(f.router.state.menus[f.menus[1].token]);
});

test("legacy picker records require the original reply target and ignore nonforum thread metadata", async (t) => {
  const f = await fixture(t, verdict("choose", null));
  await f.router.handleMessage(message("го катнемо"), "MyBot", "го катнемо");
  const token = f.menus[0].token; delete f.router.state.menus[token].menuMessageId; await f.router.save();
  const q = { id: "legacy", from: { id: 124 }, data: `assemble:${token}:fortnite`, message: { chat: { id: -100, type: "supergroup" }, message_id: 789, message_thread_id: 456 } };
  await f.router.handleCallback(q); assert.equal(f.calls.length, 0);
  await f.router.handleCallback({ ...q, message: { ...q.message, reply_to_message: { message_id: 456 } } }); assert.deepEqual(f.calls, ["fortnite"]);
});

test("confident natural requests summon the whole chat, while rejected or uncertain global intents do not", async (t) => {
  const f = await fixture(t, verdict("global", null, "ukrainian"));
  for (const text of ["Тегни всіх", "Можна в усіх спитати?", "Загальне оголошення"]) {
    await f.router.handleMessage(message(text), "MyBot", text); f.advance(60001);
  }
  assert.deepEqual(f.calls, ["global", "global", "global"]);
  for (const raw of [verdict("global", null, "russian"), verdict("global", null, "ukrainian", false), verdict("global", "fortnite")]) {
    const refused = await fixture(t, raw); await refused.router.handleMessage(message("Тегни всіх"), "MyBot", "Тегни всіх"); assert.equal(refused.calls.length, 0);
  }
});
