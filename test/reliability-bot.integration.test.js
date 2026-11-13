import '../test-support/isolated-env.mjs';
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { CodexBackend } from "../src/codex-backend.js";
import { ClaudeBackend } from "../src/claude-backend.js";
import { featureTurnFixture } from "../test-support/setup-model-fixture.mjs";
import { nativeExtractorSource, verifiedMediaSource } from "../src/media-source.js";
import { MediaCache } from "../src/media-cache.js";
import { MediaOperations } from "../src/media-operations.js";
import { ConversationStore } from "../src/conversation-store.js";

async function fixture(t, profile = "legacy", owner, configure = async () => {}, answerBackend = "codex", voice = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bot-reliability-"));
  const oldEnv = { ...process.env }, oldFetch = globalThis.fetch;
  const Backend = answerBackend === "claude" ? ClaudeBackend : CodexBackend;
  const oldAsk = Backend.prototype.ask, oldClassify = Backend.prototype.classify;
  Object.assign(process.env, { TELEGRAM_BOT_TOKEN: "000:FAKE", ANSWER_BACKEND: answerBackend, CODEX_HOME: root + "/codex", AI_AGENT_DIR: root + "/agent",
    CONVERSATION_HISTORY_DIR: root + "/runtime/conversations", BOT_INBOX_FILE: root + "/runtime/inbox.json", CHAT_TIME_ZONE: "Europe/Kyiv", MEMORY_DIR: root + "/memory", MEMORY_AUTO_CAPTURE: "false", BOT_LOCK_FILE: root + "/runtime/bot.pid",
    ASSEMBLE_MEMBERS_FILE: root + "/runtime/members.json", ASSEMBLE_STATE_FILE: root + "/runtime/assemble.json", ASSEMBLE_GAMES_FILE: path.resolve("test-support/assemble-games.json"), ASSEMBLE_GAME_ASSET_DIR: root + "/assets/games",
    MEDIA_OPERATIONS_FILE: root + "/runtime/media.json", SOCIAL_VIDEO_ENABLED: "true", VOICE_TRANSCRIPTION_ENABLED: voice ? "true" : "false", INSULT_REPLY_ENABLED: "false" });
  if (profile) {
    await fs.copyFile("test-support/profiles.json", root + "/profiles.json");
    await fs.mkdir(root + "/private");
    await fs.writeFile(root + "/private/effective-persona.md", "Synthetic legacy assistant. Your name is Оріон. Reply in Ukrainian; apply the supplied routing and privacy rules.");
    Object.assign(process.env, { BOT_PROFILE_FILE: root + "/profiles.json", BOT_PROFILE: profile });
  }
  if (owner) Object.assign(process.env, { BOT_OWNER_ID: String(owner), BOT_SETUP_FILE: root + "/runtime/setup.sqlite" });
  const calls = [], prompts = [], classified = [];
  let answerError = null, searchSucceeded = true, answerFn = null, languageDecision = {language:"uk",confident:true};
  let setupTurn = async input => ({ intent: input.kind === "menu" ? "setup" : "answer" });
  Backend.prototype.classify = async args => { classified.push(args); return JSON.stringify(args.schemaFile.endsWith("setup-turn.schema.json") ? {...featureTurnFixture(JSON.parse(args.prompt)),...await setupTurn(JSON.parse(args.prompt))} : languageDecision); };
  Backend.prototype.ask = async args => { prompts.push(args.prompt); if (answerError) throw answerError; if (answerFn) return answerFn(args); return { text: "Знайшов відповідь за назвою.", searchStatus: { executed: searchSucceeded, succeeded: searchSucceeded, failures: 0 } }; };
  let nextMessage = 1000, memberStatus = "administrator", memberLookup = null, uploadFn = null;
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(String(input)); assert.equal(url.hostname, "api.telegram.org", "Only mocked Telegram calls");
    if(url.pathname.startsWith("/file/"))return new Response(new Uint8Array([1,2,3]));
    const method = url.pathname.split("/").at(-1), multipart = options.body instanceof FormData;
    const payload = multipart ? Object.fromEntries(options.body.entries()) : JSON.parse(options.body || "{}");
    assert.notEqual(method, "getUpdates"); calls.push({ method, payload });
    if (multipart && uploadFn) return uploadFn(method, options.body);
    const result = method === "getStickerSet" ? { name: payload.name, sticker_type: "regular" } : method === "getChatMember" ? (memberLookup ? memberLookup(payload) : { status: memberStatus }) : method === "getFile" ? {file_path:"photos/fixture.jpg",file_size:3} : { message_id: nextMessage++ };
    assert.ok(["getChatMember", "sendChatAction", "sendMessage", "getFile", "sendAnimation", "sendPhoto", "sendVideo", "sendMediaGroup", "getStickerSet", "getChatAdministrators", "answerCallbackQuery", "editMessageText", "banChatMember", "unbanChatMember"].includes(method), method);
    return new Response(JSON.stringify({ ok: true, result }));
  };
  t.after(async () => {
    globalThis.fetch = oldFetch; Backend.prototype.ask = oldAsk; Backend.prototype.classify = oldClassify;
    for (const key of Object.keys(process.env)) if (!(key in oldEnv)) delete process.env[key]; Object.assign(process.env, oldEnv);
    await fs.rm(root, { recursive: true, force: true });
  });
  await fs.mkdir(root + "/src");
  for (const name of await fs.readdir("src")) if (name !== "bot.js") await fs.symlink(path.resolve("src", name), root + "/src/" + name);
  let source = await fs.readFile("src/bot.js", "utf8");
  source = source.replace('import { verifySourcePages, sourceAvailability } from "./source-verification.js";',
    'import {sourceAvailability} from "./source-verification.js"; let verifySourcePages=async urls=>urls.map(url=>({url,ok:true})); export function setSourceVerifier(fn){verifySourcePages=fn;}');
  const start = source.indexOf("main().catch((error) => {"), end = source.indexOf("\nasync function main()", start);
  source = source.slice(0, start) + source.slice(end);
  source += '\nexport async function enqueue(update){await updateInbox.add([update]);scheduleUpdate(update);}\nexport async function drainText(){await workQueue.drain();}\nexport async function drainAll(){await workQueue.drain();await mediaQueue.drain();}\nexport async function pending(){return (await updateInbox.load()).pending;}\n';
  source += '\nexport async function queued(update){await enqueue(update);await drainAll();return pending();}\nexport function setCallback(fn){assembleRouter.handleCallback=fn;}\nexport async function init(){botInfo={id:77,username:"ReliabilityTestBot"};await ensureMemoryVault();await ensureSettingsVault();}\nexport {handleUpdate};\nexport function closeSetup(){setupStore?.close();}\nexport function setDownloader(fn){downloadSocialVideo=fn;}\nexport function setTranscriber(fn){transcribeWithLocalWhisper=fn;}\nexport function setMediaNow(fn){socialVideoBudget.now=fn;}\n';
  await fs.writeFile(root + "/src/bot.mjs", source);
  await configure(root);
  let app = await import(root + "/src/bot.mjs"); await app.init();
  t.after(() => app.closeSetup());
  let id = 10;
  return { root, calls, prompts, classified, update: update => app.handleUpdate(update), queue: update => app.queued(update), enqueue:update=>app.enqueue(update), drainText:()=>app.drainText(), drainAll:()=>app.drainAll(), pending:()=>app.pending(), setUpload:fn=>{uploadFn=fn;}, setCallback: fn => app.setCallback(fn), setSourceVerifier:fn=>app.setSourceVerifier(fn), restart: async () => { app.closeSetup(); app = await import(root + "/src/bot.mjs?restart=" + Date.now()); await app.init(); }, setDownloader: fn => app.setDownloader(fn), setTranscriber: fn => app.setTranscriber(fn), setMediaNow: fn => app.setMediaNow(fn), setLanguage:value=>{languageDecision=value;},
    setAnswer: fn => { answerFn = fn; }, setSetupTurn: fn => { setupTurn = fn; }, setMemberStatus: value => { memberStatus = value; }, setMemberLookup: fn => { memberLookup = fn; }, setError: error => { answerError = error; }, setSearch: value => { searchSucceeded = value; },
    handle: extra => app.handleUpdate({ update_id: id, message: { message_id: nextMessage++, date: Math.floor(Date.now()/1000), chat: { id: -123, type: "supergroup", is_forum:true }, is_topic_message:true, from: { id: 88, username: "Fixture" }, message_thread_id: 9, ...extra } }) };
}

test('portable startup requires the owner before any Telegram or AI operation', async t => {
  await assert.rejects(fixture(t, 'legacy', undefined, async () => {
    process.env.BOT_REQUIRE_OWNER = 'true';
    delete process.env.BOT_OWNER_ID;
  }), /numeric Telegram user ID before starting/);
});

test('preferred owner name is remembered privately and never enters a group prompt or personality', async t => {
  const f = await fixture(t, 'neutral', 88);
  const dm = text => f.handle({ text, chat: { id: 88, type: 'private' } });
  await dm('/start'); await dm('My name is DistinctOwner; your name is Marina, calm and clear in English'); await dm('save');
  await f.restart();
  await dm('Do you remember my name?');
  assert.match(f.prompts.at(-1), /preferred name "DistinctOwner"/);
  const group = { id: -990, type: 'supergroup', title: 'Alpha' };
  await f.handle({ text: 'hello', chat: group });
  await dm('use profile Marina in Alpha'); await dm('save');
  await f.handle({ text: '@ReliabilityTestBot hello', chat: group });
  assert.doesNotMatch(f.prompts.at(-1), /DistinctOwner/);
});

test("ordinary answer uses one AI call for semantic language and general source resolution", async t => {
  const f = await fixture(t);
  await f.handle({ text: "@ReliabilityTestBot дай текст цього треку", reply_to_message: { message_id: 5, from: { id: 99 }, text: "https://unknown-service.example/song/123" } });
  assert.equal(f.classified.filter(c => c.schemaFile.endsWith("language-intent.schema.json")).length, 0);
  assert.match(f.prompts[0], /ONLY this current author's new request semantically/);
  assert.match(f.prompts[0], /other public sources/); assert.match(f.prompts[0], /ORIGINAL question/);
  assert.match(f.prompts[0], /without a rewrite demand/); assert.match(f.prompts[0], /overrides this baseline humor/);
  assert.match(f.calls.at(-1).payload.text, /Знайшов/);
});

test("profile aliases route only the selected persona and retry a mistaken language refusal", async t => {
  const f = await fixture(t, "alternate");
  await f.handle({ text: "Оріон, хто ти?" });
  await f.handle({ text: "Вектор вчера уже отвечал" });
  await f.handle({ text: "Вектор, кто ты?", forward_origin: { type: "user" } });
  assert.equal(f.prompts.length, 0);

  f.setAnswer(async () => ({
    text: JSON.stringify(f.prompts.length === 1
      ? { action: "reply", text: "Українською, будь ласка.", languageRefusal: true }
      : { action: "reply", text: "Вектор, товарищ." }),
    searchStatus: { succeeded: false },
  }));
  await f.handle({ text: "Вектор, кто ты?" });
  assert.equal(f.prompts.length, 2);
  assert.match(f.prompts[0], /entire reply in Russian/);
  assert.doesNotMatch(f.prompts[0], /Reply naturally in Ukrainian/);
  assert.match(f.prompts[1], /set languageRefusal=false/);
  assert.equal(f.classified.length, 0);
  assert.equal(f.calls.at(-1).payload.text, "Вектор, товарищ.");
});

test('replay: clarifying the bot wording does not inherit web dependency from its cited answer', async t => {
  const f = await fixture(t); f.setSearch(false);
  f.setAnswer(async () => ({text:JSON.stringify({action:'reply',language:'uk',text:'Я мав на увазі не поширювати точну адресу.',needsResearch:false}),searchStatus:{succeeded:false,openedUrls:[]}}));
  await f.handle({text:'Розганяти? Шо?',reply_to_message:{message_id:90,from:{id:77,is_bot:true},text:'Точне місце не варто розганяти. Джерело: https://example.org/biography'}});
  assert.equal(f.prompts.length,1);
  assert.match(f.calls.filter(c=>c.method==='sendMessage').at(-1).payload.text,/Я мав на увазі/);
});

test('replay: insistence keeps one interpersonal dispute, including after saved-case restart', async t => {
  const f=await fixture(t);
  for (const [message_id,text,reply] of [[10,'Хмара краще локального ШІ'],[11,'Не згоден',10],[12,'Централізація має ризики',11],[20,'Скинув картинку, але сам не дивився'],[21,'А навіщо тоді скинув?',20],[22,'Просто поділився, чому чіпляєшся?',21]]) await f.handle({message_id,text,reply_to_message:reply?{message_id:reply,from:{id:99}}:undefined});
  f.setAnswer(async args=>({text:args.prompt.includes('Return one JSON object:')?JSON.stringify({action:'judge',language:'uk',targetMessageId:21}):args.prompt.includes('scope extractor')?JSON.stringify({status:'ready',topic:'Тон розмови',messageIds:[20,21,22],materialPublicClaims:[]}):'Вердикт: запитання саме по собі не є агресією.',searchStatus:{succeeded:false}}));
  await f.handle({text:'@ReliabilityTestBot Розсуди всеодно',reply_to_message:{message_id:91,from:{id:77,is_bot:true},text:'Це дружня перепалка про намір і тон.'}});
  const scope=f.prompts.find(p=>p.includes('scope extractor'));
  assert.ok(!scope.includes('ALL disputes'));
  const verdict=f.prompts.find(p=>p.includes('independent judge of one isolated dispute'));
  assert.match(verdict,/навіщо тоді/); assert.ok(!verdict.includes('Хмара краще'));
  assert.ok(!verdict.includes('Впевненість: N%'));
  const journal=(await fs.readdir(f.root+'/runtime/conversations')).find(n=>n.endsWith('.jsonl'));
  const records=(await fs.readFile(f.root+'/runtime/conversations/'+journal,'utf8')).split('\n').filter(Boolean).map(JSON.parse);
  const saved=records.findLast(item=>item.judgeContext);
  assert.deepEqual(saved.judgeContext.messageIds,[20,21,22]);
  await f.restart();
  await f.handle({message_id:23,text:'Новий аргумент у тій самій суперечці',reply_to_message:{message_id:22,from:{id:99}}});
  await f.handle({text:'@ReliabilityTestBot ще раз розсуди',reply_to_message:{message_id:saved.messageId,from:{id:77,is_bot:true},text:saved.text}});
  assert.ok(!f.prompts.filter(p=>p.includes('scope extractor')).at(-1).includes('Хмара краще'));
  assert.match(f.prompts.filter(p=>p.includes('scope extractor')).at(-1),/Новий аргумент/);
});

test('a researched judge verdict preserves source access limitations', async t => {
  const f=await fixture(t);
  for (const [message_id,text,reply] of [[20,'Вода кипить при ста градусах'],[21,'Це залежить від тиску',20],[22,'Перевірмо за науковим джерелом',21]]) {
    await f.handle({message_id,text,reply_to_message:reply?{message_id:reply,from:{id:99}}:undefined});
  }
  f.setSourceVerifier(async urls=>urls.map(url=>({url,ok:false,reason:'access-restricted',status:403})));
  f.setAnswer(async args=>({text:args.prompt.includes('Return one JSON object:')
    ? JSON.stringify({action:'judge',language:'uk',targetMessageId:21})
    : args.prompt.includes('scope extractor')
      ? JSON.stringify({status:'ready',topic:'Кипіння води',messageIds:[20,21,22],materialPublicClaims:[{claim:'Температура кипіння залежить від тиску',messageIds:[21]}]})
      : 'Вердикт: тиск має значення. https://source.example/report',searchStatus:{executed:true,succeeded:true}}));
  await f.handle({text:'@ReliabilityTestBot розсуди',reply_to_message:{message_id:21,from:{id:99},text:'Це залежить від тиску'}});
  const sent=f.calls.filter(c=>c.method==='sendMessage').at(-1).payload.text;
  assert.match(sent,/тиск має значення/);
  assert.match(sent,/Частину джерел не вдалося повторно відкрити/);
});

test('research failure without a completed search is not accepted as verified', async t => {
  const f=await fixture(t);
  f.setAnswer(async()=>({text:JSON.stringify({action:'reply',language:'uk',needsResearch:true,text:'Перевірений факт',sources:[{title:'Новина',url:'https://example.org/report'}]}),searchStatus:{succeeded:false}}));
  await f.handle({text:'@ReliabilityTestBot перевір це'});
  assert.equal(f.prompts.length,2);
  assert.match(f.calls.filter(c=>c.method==='sendMessage').at(-1).payload.text,/Не вдалося підтвердити/);
});

test('researched results survive a blocked supplementary source and a same-task follow-up survives restart', async t => {
  const f=await fixture(t);
  const sources=[{title:'Organizer',url:'https://organizer.example/events'},{title:'Tickets',url:'https://tickets.example/event'}];
  let checks=0;
  f.setSourceVerifier(async urls=>{checks++;return urls.map(url=>({url,ok:url.includes('organizer'),reason:url.includes('organizer')?undefined:'access-restricted',status:url.includes('organizer')?200:403}));});
  f.setAnswer(async()=>({text:JSON.stringify({action:'reply',language:'uk',needsResearch:true,text:'Концерт у Відні 29 листопада.',sources}),searchStatus:{executed:true,succeeded:true}}));
  await f.handle({message_id:500,text:'@ReliabilityTestBot пошукай концерти в Європі'});
  assert.equal(f.prompts.length,1);assert.equal(checks,1);
  const sent=f.calls.filter(c=>c.method==='sendMessage').at(-1);
  assert.match(sent.payload.text,/Концерт у Відні/);assert.match(sent.payload.text,/Частину джерел/);
  const file=(await fs.readdir(f.root+'/runtime/conversations')).find(name=>name.endsWith('.jsonl'));
  const records=(await fs.readFile(f.root+'/runtime/conversations/'+file,'utf8')).split('\n').filter(Boolean).map(JSON.parse);
  const delivered=records.findLast(item=>item.researchEvidence);
  assert.equal(delivered.deliveryOutcome,'research_partial');assert.equal(delivered.researchEvidence.id,500);
  await f.restart();
  f.setSourceVerifier(async()=>{throw new Error('A saved follow-up must not repeat HTTP checks');});
  f.setAnswer(async args=>{
    assert.match(args.prompt,/Recent scoped research evidence/);assert.match(args.prompt,/Концерт у Відні/);
    return {text:JSON.stringify({action:'reply',language:'uk',needsResearch:true,researchRef:500,text:'Знайшов концерт у Відні 29 листопада.',sources}),searchStatus:{succeeded:false}};
  });
  await f.handle({message_id:1500,text:'Які концерти ти знайшов?',reply_to_message:{message_id:delivered.messageId,from:{id:77,is_bot:true},text:sent.payload.text}});
  assert.equal(f.prompts.length,2);assert.match(f.calls.filter(c=>c.method==='sendMessage').at(-1).payload.text,/Знайшов концерт/);
  await f.handle({message_id:1550,text:'@ReliabilityTestBot Do not search for anything; explain your previous answer.',reply_to_message:{message_id:delivered.messageId,from:{id:77,is_bot:true},text:sent.payload.text}});
  assert.equal(f.prompts.length,3);assert.match(f.calls.filter(c=>c.method==='sendMessage').at(-1).payload.text,/Знайшов концерт/);
  f.setAnswer(async()=>({text:JSON.stringify({action:'reply',language:'uk',needsResearch:true,researchRef:500,text:'Оновлений концерт.',sources}),searchStatus:{succeeded:false}}));
  await f.handle({message_id:1600,text:'@ReliabilityTestBot пошукай оновлення',reply_to_message:{message_id:delivered.messageId,from:{id:77,is_bot:true},text:sent.payload.text}});
  assert.match(f.calls.filter(c=>c.method==='sendMessage').at(-1).payload.text,/Не вдалося підтвердити/);
});

test('an unknown research reference cannot replace fresh research', async t => {
  const f=await fixture(t);
  f.setAnswer(async()=>({text:JSON.stringify({action:'reply',language:'uk',needsResearch:true,researchRef:500,text:'Нова подія підтверджена.',sources:[{title:'Other',url:'https://other.example/new'}]}),searchStatus:{succeeded:false}}));
  await f.handle({text:'@ReliabilityTestBot пошукай нові події'});
  assert.equal(f.prompts.length,2);assert.match(f.calls.filter(c=>c.method==='sendMessage').at(-1).payload.text,/Не вдалося підтвердити/);
});

test('a long media job leaves its durable inbox pending while a same-chat question completes; duplicate polling does not repeat it', async t => {
  const f=await fixture(t);
  let start,release,downloads=0;
  const started=new Promise(resolve=>{start=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  f.setDownloader(async()=>{downloads++;start();await gate;throw new Error('request timeout');});
  const message={message_id:500,date:Math.floor(Date.now()/1000),chat:{id:-123,type:'supergroup',is_forum:true},is_topic_message:true,message_thread_id:9,from:{id:88},text:'https://www.instagram.com/reel/fixture/'};
  const update={update_id:500,message};
  await f.enqueue(update);await started;
  await f.enqueue({update_id:501,message:{...message,message_id:501,text:'@ReliabilityTestBot поясни слово'}});
  await f.drainText();
  assert.match(f.calls.filter(c=>c.method==='sendMessage').at(-1).payload.text,/Знайшов відповідь/);
  assert.deepEqual((await f.pending()).map(item=>item.update_id),[500]);
  await f.enqueue(update);await f.drainText();assert.equal(downloads,1);
  release();await f.drainAll();assert.deepEqual(await f.pending(),[]);
});

test('an unconfirmed upload is not retried automatically; an explicit retry uses the prepared cache after restart', async t => {
  const f=await fixture(t);let downloads=0,uploads=0;
  const file=path.join(f.root,'image.jpg');await fs.writeFile(file,new Uint8Array([1,2,3]));
  const source=nativeExtractorSource('https://www.instagram.com/p/fixture/',{extractor_key:'Instagram',id:'fixture',channel:'fixture'});
  f.setDownloader(async()=>{downloads++;return {source,files:[{filePath:file,mediaKind:'image',mimeType:'image/jpeg',title:'Fixture'}]};});
  f.setUpload(async()=>{uploads++;throw Object.assign(new Error('connection interrupted'),{code:'ECONNRESET'});});
  await f.handle({message_id:500,text:'https://www.instagram.com/p/fixture/'});
  let journal=JSON.parse(await fs.readFile(f.root+'/runtime/media.json'));
  assert.equal(journal.operations[0].status,'unknown');assert.equal(journal.operations[0].failure.code,'UPLOAD_UNKNOWN');
  assert.equal(uploads,1);assert.equal(downloads,1);
  const notice=f.calls.filter(call=>call.method==='sendMessage').at(-1).payload.text;
  assert.match(notice,/автоматично його не дублюю/);
  await f.restart();f.setMediaNow(()=>Date.now()+31000);
  f.setUpload(async()=>{uploads++;return new Response(JSON.stringify({ok:true,result:{message_id:1900}}));});
  await f.handle({message_id:1500,text:'Repeat',reply_to_message:{message_id:journal.operations[0].errorMessageId,from:{id:77,is_bot:true},text:notice}});
  journal=JSON.parse(await fs.readFile(f.root+'/runtime/media.json'));
  assert.equal(downloads,1);assert.equal(uploads,2);assert.equal(journal.operations[0].status,'done');
  assert.deepEqual(journal.operations[0].sentMessageIds,[1900]);
  await f.handle({message_id:500,text:'https://www.instagram.com/p/fixture/'});
  assert.equal(uploads,2);
});

test('one story cannot send three unverified images or cache them as its verified source',async t=>{
  const f=await fixture(t);const files=[];
  for(let index=0;index<3;index++){
    const filePath=path.join(f.root,`unverified-${index}.jpg`);await fs.writeFile(filePath,Buffer.from([index,2,3]));
    files.push({filePath,mediaKind:'image',mimeType:'image/jpeg'});
  }
  f.setDownloader(async()=>({files,title:'Unbound provider images'}));
  await f.handle({message_id:500,text:'https://www.instagram.com/stories/fixture/64/'});
  assert.equal(f.calls.filter(call=>['sendPhoto','sendVideo','sendMediaGroup','sendDocument'].includes(call.method)).length,0);
  assert.match(f.calls.filter(call=>call.method==='sendMessage').at(-1).payload.text,/SOURCE_UNVERIFIED/);
  await assert.rejects(fs.access(f.root+'/runtime/media-cache/index.json'),{code:'ENOENT'});
  const operation=JSON.parse(await fs.readFile(f.root+'/runtime/media.json')).operations[0];
  assert.equal(operation.status,'failed');assert.equal(operation.source.status,'unverified');
  assert.equal(operation.deliveredFileCount,undefined);
});

test('a forged verified flag cannot hide mismatched native identity',async t=>{
  const f=await fixture(t);const filePath=path.join(f.root,'wrong.jpg');await fs.writeFile(filePath,'wrong');
  const source=nativeExtractorSource('https://www.instagram.com/stories/fixture/64/',{extractor_key:'InstagramStory',id:'BA',channel:'fixture'});
  source.resolved.id='OTHER';source.resolved.key='OTHER';
  f.setDownloader(async()=>({source,files:[{filePath,mediaKind:'image',mimeType:'image/jpeg'}]}));
  await f.handle({text:'https://www.instagram.com/stories/fixture/64/'});
  assert.equal(f.calls.filter(call=>call.method==='sendPhoto').length,0);
  assert.match(f.calls.filter(call=>call.method==='sendMessage').at(-1).payload.text,/SOURCE_MISMATCH/);
});

test('a verified carousel binds each Telegram photo to its own file, including after restart',async t=>{
  const f=await fixture(t);const files=[];
  for(let index=0;index<3;index++){
    const filePath=path.join(f.root,`item-${index}.jpg`);await fs.writeFile(filePath,Buffer.from([index,2,3]));
    files.push({filePath,mediaKind:'image',mimeType:'image/jpeg'});
  }
  const url='https://www.tiktok.com/@fixture/photo/123/';
  const source=verifiedMediaSource(url,{provider:'tiktok-api',id:'123',owner:'fixture'});
  f.setDownloader(async()=>({source,files,title:'A'.repeat(1500)}));
  f.setUpload(async(method)=>{
    assert.equal(method,'sendMediaGroup');
    return new Response(JSON.stringify({ok:true,result:files.map((file,index)=>({message_id:2000+index,message_thread_id:9,is_topic_message:true,
      chat:{id:-123,type:'supergroup',is_forum:true},photo:[{file_id:`photo-${index}`,file_size:3}]}))}));
  });
  await f.handle({message_id:500,text:url});
  const payload=f.calls.find(call=>call.method==='sendMediaGroup').payload;
  const caption=JSON.parse(payload.media)[0].caption;
  assert.ok(caption.length<=1000);assert.match(caption,/@Fixture/);assert.ok(caption.includes(url));
  await f.restart();let scope='item',inspected=[];
  f.setAnswer(async args=>{
    if(args.images?.length){inspected=await Promise.all(args.images.map(async file=>(await fs.readFile(file))[0]));return {text:'Опис фактично вибраних файлів.',searchStatus:{succeeded:false}};}
    return {text:JSON.stringify({action:'analyze',language:'uk',targetMessageId:2001,mediaScope:scope}),searchStatus:{succeeded:false}};
  });
  await f.handle({message_id:3000,text:'@ReliabilityTestBot поясни це фото',reply_to_message:{message_id:2001,from:{id:77,is_bot:true},photo:[{file_id:'photo-1',file_size:3}]}});
  assert.deepEqual(inspected,[1]);
  scope='publication';
  await f.handle({message_id:3001,text:'@ReliabilityTestBot поясни весь альбом',reply_to_message:{message_id:2001,from:{id:77,is_bot:true},photo:[{file_id:'photo-1',file_size:3}]}});
  assert.deepEqual(inspected,[0,1,2]);
});

test('legacy unverified prepared files cannot authorize a redelivery',async t=>{
  const f=await fixture(t);const filePath=path.join(f.root,'legacy.jpg');await fs.writeFile(filePath,'legacy');
  const url='https://www.instagram.com/reel/legacy/';
  const cache=new MediaCache(f.root+'/runtime/media-cache');
  await cache.put({chatId:-123,topicId:9,sourceMessageId:500,sourceUrl:url,files:[{filePath,mediaKind:'image',mimeType:'image/jpeg'}]});
  await new MediaOperations(f.root+'/runtime/media.json').record({chatId:-123,topicId:9,userId:88,sourceMessageId:500,errorMessageId:600,url,status:'unknown',failure:{code:'UPLOAD_UNKNOWN',retryable:true,stage:'upload'}});
  let downloads=0;f.setDownloader(async()=>{downloads++;return {files:[{filePath,mediaKind:'image',mimeType:'image/jpeg'}]};});
  await f.handle({message_id:1500,text:'Repeat',reply_to_message:{message_id:600,from:{id:77,is_bot:true},text:'Previous upload outcome unknown'}});
  assert.equal(downloads,1);assert.equal(f.calls.filter(call=>call.method==='sendPhoto').length,0);
  assert.match(f.calls.filter(call=>call.method==='sendMessage').at(-1).payload.text,/SOURCE_UNVERIFIED/);
});

test('legacy album selection reads only its exact Telegram file and never substitutes an unavailable historical file',async t=>{
  const f=await fixture(t),files=[],store=new ConversationStore(f.root+'/runtime/conversations');
  const url='https://www.instagram.com/stories/fixture/64/';
  for(let index=0;index<3;index++){
    const filePath=path.join(f.root,`legacy-album-${index}.jpg`);await fs.writeFile(filePath,Buffer.from([10+index,2,3]));files.push({filePath,mediaKind:'image',mimeType:'image/jpeg'});
  }
  const cache=new MediaCache(f.root+'/runtime/media-cache');await cache.put({chatId:-123,topicId:9,sourceMessageId:500,sourceUrl:url,files});
  const indexPath=f.root+'/runtime/media-cache/index.json',index=JSON.parse(await fs.readFile(indexPath));
  index.entries[0].sentMessageIds=[600,601,602];delete index.entries[0].bindings;await fs.writeFile(indexPath,JSON.stringify(index));
  for(const item of [{messageId:600,sourceUrl:url,media:{kind:'image',fileId:'legacy-first',size:3}},
    {messageId:650,sourceUrl:'https://www.instagram.com/reel/legacy-video/',media:{kind:'video',fileId:'large-legacy',size:30*1024*1024}}]){
    await store.record({chatId:-123,messageThreadId:9,isForum:true,date:Date.now()-10000,isBot:true,userId:77,sender:'@ReliabilityTestBot',text:'Legacy sent file',...item});
  }
  let target=600,inspected=0,downloads=0;
  f.setDownloader(async()=>{downloads++;throw new Error('No source may substitute this historical file');});
  f.setAnswer(async args=>{
    if(args.images?.length){inspected++;assert.equal(args.images.length,1);assert.deepEqual([...await fs.readFile(args.images[0])],[1,2,3]);
      assert.match(args.prompt,/Зовнішнє походження не підтверджене/);return {text:'Опис лише видимого файла.',searchStatus:{succeeded:false}};}
    return {text:JSON.stringify({action:'analyze',language:'uk',targetMessageId:target}),searchStatus:{succeeded:false}};
  });
  await f.handle({message_id:700,text:'@ReliabilityTestBot поясни саме це',reply_to_message:{message_id:600,from:{id:77,is_bot:true},text:'Legacy sent file'}});
  assert.equal(inspected,1);assert.equal(f.calls.filter(call=>call.method==='getFile').length,1);
  target=650;
  await f.handle({message_id:701,text:'@ReliabilityTestBot поясни цей файл',reply_to_message:{message_id:650,from:{id:77,is_bot:true},text:'Legacy sent file'}});
  assert.equal(downloads,0);assert.equal(inspected,1);
  assert.match(f.calls.filter(call=>call.method==='sendMessage').at(-1).payload.text,/20 МіБ/);
});

test('an unavailable verified single-file receipt may use a matching source copy with explicit disclosure',async t=>{
  const f=await fixture(t),store=new ConversationStore(f.root+'/runtime/conversations'),filePath=path.join(f.root,'single.jpg');
  await fs.writeFile(filePath,Buffer.from([1,2,3]));
  const url='https://www.threads.com/@fixture/post/single/';const source=verifiedMediaSource(url,{provider:'threads-page',id:'single',owner:'fixture'});
  await store.record({chatId:-123,messageId:600,messageThreadId:9,isForum:true,date:Date.now()-10000,isBot:true,userId:77,sender:'@ReliabilityTestBot',text:'Verified single image',sourceUrl:url,mediaSource:source,mediaSelection:{index:0,total:1},media:{kind:'image',fileId:'large-single',size:30*1024*1024}});
  let downloads=0,inspected=false;
  f.setDownloader(async()=>{downloads++;return {source,files:[{filePath,mediaKind:'image',mimeType:'image/jpeg'}]};});
  f.setAnswer(async args=>{
    if(args.images?.length){inspected=true;assert.match(args.prompt,/попередній файл із Telegram не був прочитаний/);return {text:'Опис повторно отриманої копії.',searchStatus:{succeeded:false}};}
    return {text:JSON.stringify({action:'analyze',language:'uk',targetMessageId:600}),searchStatus:{succeeded:false}};
  });
  await f.handle({message_id:700,text:'@ReliabilityTestBot проаналізуй фото',reply_to_message:{message_id:600,from:{id:77,is_bot:true},text:'Verified single image'}});
  assert.equal(downloads,1);assert.equal(inspected,true);assert.equal(f.calls.filter(call=>call.method==='sendPhoto').length,0);
});

test('a short album receipt remains unknown and cannot create guessed file bindings',async t=>{
  const f=await fixture(t),files=[];const url='https://www.tiktok.com/@fixture/photo/123/';
  for(let index=0;index<3;index++){const filePath=path.join(f.root,`short-receipt-${index}.jpg`);await fs.writeFile(filePath,Buffer.from([index,2,3]));files.push({filePath,mediaKind:'image',mimeType:'image/jpeg'});}
  const source=verifiedMediaSource(url,{provider:'tiktok-api',id:'123',owner:'fixture'});
  f.setDownloader(async()=>({source,files}));let uploads=0;
  f.setUpload(async()=>{uploads++;return new Response(JSON.stringify({ok:true,result:[{message_id:600}]}));});
  await f.handle({message_id:500,text:url});
  const operation=JSON.parse(await fs.readFile(f.root+'/runtime/media.json')).operations[0];
  assert.equal(uploads,1);assert.equal(operation.status,'unknown');assert.equal(operation.failure.code,'UPLOAD_UNKNOWN');
  assert.equal(operation.deliveredFileCount,undefined);
  const index=JSON.parse(await fs.readFile(f.root+'/runtime/media-cache/index.json'));assert.deepEqual(index.entries[0].bindings,[]);
});

test('action explanations receive scoped recorded facts and actual automatic settings without certifying legacy origins',async t=>{
  const f=await fixture(t),store=new ConversationStore(f.root+'/runtime/conversations');
  const url='https://www.instagram.com/stories/source/64/';
  for(const item of [{messageId:500,isBot:false,userId:99,sender:'@Source',text:url},{messageId:600,isBot:true,userId:77,sender:'@ReliabilityTestBot',text:'Old album',sourceUrl:url,replyToMessageId:500}]){
    await store.record({chatId:-123,date:Date.now()-10000,messageThreadId:9,isForum:true,...item});
  }
  const operations=new MediaOperations(f.root+'/runtime/media.json');
  await operations.record({chatId:-123,topicId:9,sourceMessageId:500,sentMessageIds:[600,601,602],status:'done',deliveredFileCount:3,url});
  await operations.record({chatId:-456,topicId:9,sourceMessageId:500,status:'done',url:'https://www.instagram.com/reel/OTHER_CHAT_SECRET/'});
  await operations.record({chatId:-123,topicId:10,sourceMessageId:500,status:'done',url:'https://www.instagram.com/reel/OTHER_TOPIC_SECRET/'});
  await operations.record({chatId:-123,topicId:9,sourceMessageId:500,lastRequest:{messageId:800,sender:'FUTURE_REQUEST_SECRET'},status:'done',url});
  f.setAnswer(async args=>{
    assert.match(args.prompt,/Recorded scoped media operations/);assert.match(args.prompt,/unverified-legacy/);
    assert.match(args.prompt,/not-recorded/);assert.match(args.prompt,/"deliveredFileCount":3/);
    assert.match(args.prompt,/Current automatic download setting: enabled/);
    assert.doesNotMatch(args.prompt,/OTHER_CHAT_SECRET|OTHER_TOPIC_SECRET|FUTURE_REQUEST_SECRET/);
    assert.match(args.prompt,/requested source:.*origin unverified/);
    return {text:JSON.stringify({action:'reply',language:'uk',text:'Автозавантаження було увімкнено. Походження старих файлів журнал не підтверджує.'}),searchStatus:{succeeded:false}};
  });
  await f.handle({message_id:700,text:'Чому ти це надіслав?',reply_to_message:{message_id:600,from:{id:77,is_bot:true},text:'Old album'}});
  assert.match(f.calls.filter(call=>call.method==='sendMessage').at(-1).payload.text,/Походження старих файлів/);
  assert.equal(f.calls.filter(call=>['sendPhoto','sendVideo','sendMediaGroup'].includes(call.method)).length,0);
});

test('voice transcription leaves independent questions responsive and a reply waits for its referenced transcript',async t=>{
  const f=await fixture(t,'legacy',undefined,async()=>{},'codex',true);
  let start,release;const started=new Promise(resolve=>{start=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  f.setTranscriber(async()=>{start();await gate;return {text:'Spoken fixture evidence',language:'uk'};});
  const message={message_id:500,date:Math.floor(Date.now()/1000),chat:{id:-123,type:'supergroup',is_forum:true},is_topic_message:true,message_thread_id:9,from:{id:88},voice:{file_id:'voice',file_size:3,duration:1},reply_to_message:{message_id:90,from:{id:77,is_bot:true},text:'Question'}};
  await f.enqueue({update_id:500,message});await started;
  await f.enqueue({update_id:501,message:{...message,message_id:501,voice:undefined,reply_to_message:undefined,text:'@ReliabilityTestBot коротке питання'}});
  await f.drainText();assert.equal(f.prompts.length,1);
  await f.enqueue({update_id:502,message:{...message,message_id:502,voice:undefined,text:'@ReliabilityTestBot що він сказав?',reply_to_message:{message_id:500,from:{id:88},voice:message.voice}}});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(f.prompts.length,1);
  release();await f.drainAll();assert.equal(f.prompts.length,3);
  assert.match(f.prompts.at(-1),/Spoken fixture evidence/);assert.deepEqual(await f.pending(),[]);
});

test('an interrupted album retry sends only files without acknowledged delivery', async t => {
  const f=await fixture(t,'legacy',undefined,async()=>{process.env.SOCIAL_VIDEO_MAX_MEDIA_ITEMS='20';});let downloads=0;const uploads=[];
  const files=[];
  for(let i=0;i<11;i++){const file=path.join(f.root,`image-${i}.jpg`);await fs.writeFile(file,new Uint8Array([i,2,3]));files.push({filePath:file,mediaKind:'image',mimeType:'image/jpeg'});}
  const source=verifiedMediaSource('https://www.tiktok.com/@fixture/photo/123/',{provider:'tiktok-api',id:'123',owner:'fixture'});
  f.setDownloader(async()=>{downloads++;return {source,files};});
  f.setUpload(async method=>{
    uploads.push(method);
    if(method==='sendMediaGroup')return new Response(JSON.stringify({ok:true,result:Array.from({length:10},(_,i)=>({message_id:2000+i}))}));
    throw new Error('fetch failed');
  });
  await f.handle({message_id:500,text:'https://www.tiktok.com/@fixture/photo/123/'});
  const before=JSON.parse(await fs.readFile(f.root+'/runtime/media.json')).operations[0];
  assert.equal(before.deliveredFileCount,10);assert.equal(before.sentMessageIds.length,10);
  f.setMediaNow(()=>Date.now()+31000);
  f.setUpload(async method=>{uploads.push(method);return new Response(JSON.stringify({ok:true,result:{message_id:2010}}));});
  await f.handle({message_id:1500,text:'Repeat',reply_to_message:{message_id:before.errorMessageId,from:{id:77,is_bot:true},text:'Upload unconfirmed'}});
  const after=JSON.parse(await fs.readFile(f.root+'/runtime/media.json')).operations[0];
  assert.deepEqual(uploads,['sendMediaGroup','sendPhoto','sendPhoto']);assert.equal(downloads,1);
  assert.equal(after.status,'done');assert.equal(after.deliveredFileCount,11);assert.equal(after.sentMessageIds.length,11);
});

test('an unavailable explicit judge anchor cannot silently fall back to another discussion',async t=>{
  const f=await fixture(t);
  f.setAnswer(async()=>({text:JSON.stringify({action:'judge',language:'uk',targetMessageId:999999}),searchStatus:{succeeded:false}}));
  await f.handle({text:'@ReliabilityTestBot розсуди цю розмову'});
  assert.equal(f.prompts.length,1);
  assert.match(f.calls.filter(c=>c.method==='sendMessage').at(-1).payload.text,/Вибране повідомлення недоступне/);
});
test("link-dependent answers cannot be presented as verified without completed research", async t => {
  const f = await fixture(t); f.setSearch(false);
  await f.handle({ text: "@ReliabilityTestBot перевір це", reply_to_message: { message_id: 5, from: { id: 99 }, text: "https://other-service.example/item" } });
  assert.equal(f.prompts.length, 2); assert.match(f.calls.at(-1).payload.text, /Не вдалося підтвердити/);
});
test("AI failure produces a reasoned Telegram reply instead of silence", async t => {
  const f = await fixture(t); f.setError(Object.assign(new Error("timeout"), { code: "AI_TIMEOUT" }));
  await f.handle({ text: "@ReliabilityTestBot поясни поняття" });
  assert.match(f.calls.at(-1).payload.text, /за відведений час/); assert.match(f.calls.at(-1).payload.text, /AI_TIMEOUT/);
});
test("repeat re-executes the saved original media URL and never calls conversational AI", async t => {
  const f = await fixture(t), urls = [];
  f.setDownloader(async url => { urls.push(url); throw new Error("request timeout"); });
  await f.handle({ text: "https://www.instagram.com/reel/fixture/" });
  const error = f.calls.filter(c => c.method === "sendMessage").at(-1);
  assert.match(error.payload.text, /TIMEOUT/);
  const journal = JSON.parse(await fs.readFile(f.root + "/runtime/media.json"));
  f.setMediaNow(()=>Date.now()+31000);
  await f.handle({ text: "Repeat", reply_to_message: { message_id: journal.operations[0].errorMessageId, from: { id: 77 }, text: error.payload.text } });
  assert.equal(urls.length, 2); assert.equal(urls[0], urls[1]); assert.equal(f.prompts.length, 0);
});
test("permanent duration rejection explains actual and allowed length and is not retried", async t => {
  const f = await fixture(t); let attempts = 0;
  f.setDownloader(async () => { attempts++; throw Object.assign(new Error("longer than limit"), { code: "SOCIAL_VIDEO_DURATION_LIMIT", actualDurationSeconds: 361 }); });
  await f.handle({ text: "https://www.instagram.com/reel/fixture/" });
  const journal = JSON.parse(await fs.readFile(f.root + "/runtime/media.json"));
  await f.handle({ text: "спробуй ще раз", reply_to_message: { message_id: journal.operations[0].errorMessageId, from: { id: 77 } } });
  assert.equal(attempts, 1); assert.match(f.calls.at(-1).payload.text, /6:01/); assert.match(f.calls.at(-1).payload.text, /5:00/);
});


test("bare mention delegates the replied-to question without demanding a new question", async t => {
  const f=await fixture(t);
  await f.handle({text:"@ReliabilityTestBot",reply_to_message:{message_id:50,date:Math.floor(Date.now()/1000)-60,from:{id:99},text:"what about youtube shorts?"}});
  assert.match(f.prompts.at(-1),/request a response to the replied-to message/);
  assert.match(f.prompts.at(-1),/what about youtube shorts/);
  assert.ok(!f.prompts.at(-1).includes("Ask the user to include a question"));
});
test("morning summary and clock follow-up receive saved earlier history", async t => {
  const f=await fixture(t),now=Math.floor(Date.now()/1000);
  await f.handle({text:"Учора була інша тема",date:now-86400});
  await f.handle({text:"Ранкова важлива суперечка",date:now-120});
  await f.handle({text:"@ReliabilityTestBot підбий ітог ранкової переписки"});
  assert.match(f.prompts.at(-1),/Requested Telegram chat history/);
  assert.equal(f.classified.length,0);
  assert.match(f.prompts.at(-1),/morning/);
  await f.handle({text:"Усі повідомлення сьогодні з 5:00",reply_to_message:{message_id:1003,from:{id:77}}});
  assert.match(f.prompts.at(-1),/from 05:00/);assert.match(f.prompts.at(-1),/Europe\/Kyiv/);
  assert.match(f.prompts.at(-1),/local seven-day conversation history/);
  assert.equal(f.classified.length,0);
});
test("explicit requests recover an empty AI reply once and distinguish repeated emptiness", async t => {
  const f=await fixture(t);let n=0;
  f.setAnswer(async()=>({text:++n===1?"":JSON.stringify({action:"reply",language:"uk",text:"Відповідь після повтору"}),searchStatus:{succeeded:false}}));
  await f.handle({text:"@ReliabilityTestBot поясни це"});
  assert.equal(n,2);assert.match(f.calls.at(-1).payload.text,/після повтору/);
  f.setAnswer(async()=>({text:"",searchStatus:{succeeded:false}}));
  await f.handle({text:"@ReliabilityTestBot поясни інше"});
  assert.match(f.calls.at(-1).payload.text,/AI_EMPTY_ANSWER/);assert.match(f.calls.at(-1).payload.text,/двічі/);
});
test("human-addressed chatter can explicitly opt out without an error announcement", async t => {
  const f=await fixture(t);
  f.setAnswer(async()=>({text:JSON.stringify({action:"ignore",language:"mixed",text:""}),searchStatus:{succeeded:false}}));
  await f.handle({text:"@AnotherHuman ну брат путешествовать тебе на пользу",reply_to_message:{message_id:50,from:{id:77},text:"Оновлення"}});
  assert.equal(f.calls.filter(c=>c.method==="sendMessage").length,0);
});
test("all-disputes request separates topics and does not anchor to the latest news", async t => {
  const f=await fixture(t);
  for(const text of ["Піца краща за суп","Ні, суп кращий","Я за піцу","Чай краще кави","Ні, кава краща","Я за чай","Новина про потяги"])await f.handle({text});
  f.setAnswer(async args=>({text:args.prompt.includes("Return one JSON object:")?JSON.stringify({action:"judge",language:"uk",judgeScope:"all"}):args.prompt.includes("scope extractor")?JSON.stringify({disputes:[{status:"ready",topic:"Їжа",messageIds:[1000,1001,1002],materialPublicClaims:[]},{status:"ready",topic:"Напої",messageIds:[1003,1004,1005],materialPublicClaims:[]}]}):"Вердикт: це суб’єктивні смаки.",searchStatus:{succeeded:false}}));
  await f.handle({text:"@ReliabilityTestBot пошукай суперечки в чаті і розсуди, якщо знайдеш декілька розсуди усі"});
  const scope=f.prompts.find(p=>p.includes("scope extractor"));assert.match(scope,/ALL disputes/);assert.match(scope,/Reply anchor message ID: none/);
  const sent=f.calls.filter(c=>c.method==="sendMessage");assert.equal(sent.length,2);assert.match(sent[0].payload.text,/Їжа/);assert.match(sent[1].payload.text,/Напої/);
});


for (const profile of ["neutral", "alternate"]) {
  test(`all-disputes verdict follows the request language policy for ${profile}`, async t => {
    const f = await fixture(t, profile);
    for (const text of ["Піца краща за суп", "Ні, суп кращий", "Я за піцу"]) await f.handle({ text });
    f.setAnswer(async ({ prompt }) => ({
      text: prompt.includes("scope extractor")
        ? JSON.stringify({ disputes: [{ status: "ready", topic: "Їжа", messageIds: [1000, 1001, 1002], materialPublicClaims: [] }] })
        : "Вердикт: дело вкуса.",
      searchStatus: { succeeded: false },
    }));
    await f.handle({ text: "/judge all рассуди споры" });
    const verdict = f.prompts.find(prompt => prompt.includes("independent judge of one isolated dispute"));
    assert.match(verdict, /Current author request \(quoted data\): "\/judge all рассуди споры"/);
    assert.match(verdict, profile === "neutral" ? /current author's own request/ : /entire reply in Russian/);
    assert.doesNotMatch(verdict, /Що вдалося перевірити/);
    const sent = f.calls.filter(call => call.method === "sendMessage");
    assert.equal(sent.length, 1);
    assert.match(sent[0].payload.text, /Вердикт: дело вкуса/);
    assert.doesNotMatch(sent[0].payload.text, /Суперечка|Їжа/);
  });
}

test("a new bot module restores saved conversation and bot reply ancestors",async t=>{
 const f=await fixture(t);const before=Math.floor(Date.now()/1000)-3600;
 await f.handle({text:"ПЕРЕЗАПУСК_МАРКЕР: домовилися купити горіхи",date:before});
 await f.handle({text:"@ReliabilityTestBot підсумуй сьогодні"});
 const outgoing=f.calls.filter(c=>c.method==='sendMessage').at(-1);assert.ok(outgoing);
 await f.restart();
 await f.handle({text:"@ReliabilityTestBot підсумуй сьогодні"});
 assert.match(f.prompts.at(-1),/ПЕРЕЗАПУСК_МАРКЕР/);
 const files=await fs.readdir(f.root+'/runtime/conversations');const journal=files.find(n=>n.endsWith('.jsonl'));const saved=await fs.readFile(f.root+'/runtime/conversations/'+journal,'utf8');assert.match(saved,/"isBot":true/);
});


test("expired callbacks complete once while transient API failures stay recoverable",async t=>{
 const f=await fixture(t);const update={update_id:500,callback_query:{id:'expired',from:{id:88},message:{chat:{id:-123,type:'supergroup'},message_id:12},data:'assemble:test'}};
 f.setCallback(async()=>{throw Object.assign(new Error('query is too old'),{status:400});});
 assert.equal((await f.queue(update)).length,0);
 f.setCallback(async()=>{throw Object.assign(new Error('temporary server failure'),{status:503});});
 assert.equal((await f.queue({...update,update_id:501})).length,1);
});

test("a natural retry resolves an ordinary reply thread and executes the original URL",async t=>{
  const f=await fixture(t),urls=[];
  f.setDownloader(async url=>{urls.push(url);throw new Error('request timeout');});
  await f.handle({text:'https://www.instagram.com/reel/natural/',chat:{id:-123,type:'supergroup',is_forum:false},is_topic_message:false,message_thread_id:undefined});
  const operation=JSON.parse(await fs.readFile(f.root+'/runtime/media.json')).operations[0];
  f.setMediaNow(()=>Date.now()+31000);
  f.setAnswer(async()=>({text:JSON.stringify({action:'download',language:'uk',targetMessageId:operation.errorMessageId}),searchStatus:{succeeded:false}}));
  await f.handle({text:'Ще раз',chat:{id:-123,type:'supergroup',is_forum:false},is_topic_message:false,message_thread_id:operation.sourceMessageId,
    reply_to_message:{message_id:operation.errorMessageId,from:{id:77},text:'Не вдалося завантажити'}});
  assert.deepEqual(urls,['https://www.instagram.com/reel/natural/','https://www.instagram.com/reel/natural/']);
  assert.equal(f.prompts.length,1);
  assert.match(f.calls.at(-1).payload.text,/TIMEOUT/);
});

test("a false Ukrainian refusal is checked and repaired while genuine Russian is refused",async t=>{
  const f=await fixture(t);let turn=0;
  f.setAnswer(async()=>({text:JSON.stringify(++turn===1?{action:'reply',language:'ru',languageRefusal:true,text:'Перепиши українською'}:
    {action:'reply',language:'uk',text:'Свято відзначають першого жовтня.'}),searchStatus:{succeeded:false}}));
  await f.handle({text:'@ReliabilityTestBot коли день захисника та захисниць України?'});
  assert.equal(turn,2);assert.match(f.calls.at(-1).payload.text,/першого жовтня/);
  assert.match(f.prompts.at(-1),/Trusted current-request language decision/);
  f.setLanguage({language:'ru',confident:true});
  f.setAnswer(async()=>({text:JSON.stringify({action:'reply',language:'ru',languageRefusal:true,text:'Неправильний текст'}),searchStatus:{succeeded:false}}));
  await f.handle({text:'@ReliabilityTestBot расскажи, как устроен двигатель'});
  assert.equal(f.calls.at(-1).payload.text,'Українською, будь ласка.');
});

test("a human-only mention under a bot post needs no model call or bot reply",async t=>{
  const f=await fixture(t);
  await f.handle({text:'@AnotherHuman',reply_to_message:{message_id:50,from:{id:77},text:'Відео'}});
  assert.equal(f.prompts.length,0);assert.equal(f.calls.filter(c=>c.method==='sendMessage').length,0);
});

test("simulation keeps the requested task despite the word judge",async t=>{
  const f=await fixture(t);
  f.setAnswer(async()=>({text:JSON.stringify({action:'reply',language:'neutral',text:'Уявний сценарій: прозорість — 7/10, ризик кумівства — умовно 4/10; це художня модель.'}),searchStatus:{succeeded:false}}));
  await f.handle({text:'@ReliabilityTestBot simulate a fictional presidency, use context to judge, add metrics'});
  assert.equal(f.prompts.length,1);assert.ok(!f.prompts[0].includes('scope extractor'));
  assert.match(f.calls.at(-1).payload.text,/сценарій/);
});

test("a semantic file action cannot target a different forum topic",async t=>{
  const f=await fixture(t);let attempts=0;
  f.setDownloader(async()=>{throw new Error('fixture timeout');});
  await f.handle({message_id:80,text:'https://www.instagram.com/reel/other-topic/',message_thread_id:10});
  f.setDownloader(async()=>{attempts++;throw new Error('must not download');});
  f.setAnswer(async()=>({text:JSON.stringify({action:'download',language:'uk',targetMessageId:80}),searchStatus:{succeeded:false}}));
  await f.handle({text:'@ReliabilityTestBot надішли файлом',message_thread_id:9});
  assert.equal(attempts,0);assert.match(f.calls.at(-1).payload.text,/початкове повідомлення/);
});

test("an asserted researched answer without supporting pages is not delivered as fact",async t=>{
  const f=await fixture(t);
  f.setAnswer(async()=>({text:JSON.stringify({action:'reply',language:'uk',needsResearch:true,text:'Це точно потрібний маєток за 140 тисяч.'}),searchStatus:{succeeded:true}}));
  await f.handle({text:'@ReliabilityTestBot знайди ціну цього маєтку'});
  assert.equal(f.prompts.length,2);assert.match(f.calls.at(-1).payload.text,/Не вдалося підтвердити/);
});

test("an addressed attachment reaches analysis without a phrase-list trigger or repeated upload",async t=>{
  const f=await fixture(t);let analyzed=false;
  f.setAnswer(async args=>{
    if(args.images?.length){analyzed=true;return {text:'На зображенні видно предмет.',searchStatus:{succeeded:false}};}
    assert.match(args.prompt,/attachment: image/);
    return {text:JSON.stringify({action:'analyze',language:'uk'}),searchStatus:{succeeded:false}};
  });
  await f.handle({text:undefined,caption:'@ReliabilityTestBot що це?',photo:[{file_id:'fixture-photo',file_size:3}],chat:{id:-123,type:'supergroup',is_forum:false},is_topic_message:false});
  assert.ok(analyzed);assert.match(f.calls.at(-1).payload.text,/На зображенні/);
  analyzed=false;
  await f.handle({text:'@ReliabilityTestBot що це?',document:{file_id:'image-document',mime_type:'image/png',file_size:3}});
  assert.ok(analyzed);assert.match(f.calls.at(-1).payload.text,/На зображенні/);
});

test("explicit message references cannot read another topic through RAM",async t=>{
  const f=await fixture(t);
  await f.handle({message_id:80,text:'PRIVATE_TOPIC_MARKER',message_thread_id:10});
  await f.handle({text:'@ReliabilityTestBot поясни повідомлення №80',message_thread_id:9});
  assert.ok(!f.prompts.at(-1).includes('PRIVATE_TOPIC_MARKER'));
  assert.match(f.prompts.at(-1),/unavailable/);
});

test("a follow-up can select all offered game rosters without summoning the whole chat",async t=>{
  const f=await fixture(t);
  f.setAnswer(async()=>({text:JSON.stringify({action:'assemble',language:'mixed',gameIds:['fortnite','rocket-league','arc-riders','helldivers-2']}),searchStatus:{succeeded:false}}));
  await f.handle({text:'Покличь в усі 4',reply_to_message:{message_id:50,from:{id:77},text:'У що збираємось грати?'}});
  const sent=f.calls.filter(c=>c.method==='sendMessage');
  assert.equal(sent.length,4);assert.ok(sent.every(c=>c.payload.text.startsWith('🎮')));
});

test("a game action in a private chat reports its capability boundary",async t=>{
  const f=await fixture(t);
  f.setAnswer(async()=>({text:JSON.stringify({action:'assemble',language:'uk',gameIds:['fortnite']}),searchStatus:{succeeded:false}}));
  await f.handle({text:'Поклич їх',chat:{id:88,type:'private'},is_topic_message:false,reply_to_message:{message_id:50,from:{id:77},text:'Fortnite'}});
  assert.match(f.calls.at(-1).payload.text,/лише в групі/);
  assert.equal(f.calls.filter(c=>c.method==='sendMessage').length,1);
});

test('a file request uses the URL in the current message without an explicit target ID',async t=>{
  const f=await fixture(t),urls=[];
  f.setDownloader(async url=>{urls.push(url);throw new Error('fixture timeout');});
  f.setAnswer(async()=>({text:JSON.stringify({action:'download',language:'uk'}),searchStatus:{succeeded:false}}));
  await f.handle({text:'@ReliabilityTestBot надішли файлом https://www.instagram.com/reel/current/'});
  assert.deepEqual(urls,['https://www.instagram.com/reel/current/']);
  assert.match(f.calls.at(-1).payload.text,/TIMEOUT/);
});

test('media analysis retains scoped discussion and a live history ticket across the action handoff',async t=>{
  const f=await fixture(t);let analyzed=false;
  await f.handle({message_id:80,text:'Порівнюємо з автомобілем Volvo V60, який обрали раніше.'});
  await f.handle({message_id:81,text:'OTHER_TOPIC_SECRET',message_thread_id:10});
  f.setAnswer(async args=>{
    if(args.images?.length){
      analyzed=true;
      assert.match(args.prompt,/Volvo V60/);
      assert.ok(!args.prompt.includes('OTHER_TOPIC_SECRET'));
      assert.ok(args.contextTicket);
      const ticket=JSON.parse(await fs.readFile(args.contextTicket,'utf8'));
      assert.equal(ticket.chatId,-123);assert.equal(ticket.threadId,9);
      return {text:'Можу порівняти видимі ознаки з раніше обговореною Volvo V60.',searchStatus:{succeeded:false}};
    }
    return {text:JSON.stringify({action:'analyze',language:'uk'}),searchStatus:{succeeded:false}};
  });
  await f.handle({text:undefined,caption:'@ReliabilityTestBot а це та сама машина?',photo:[{file_id:'fixture-car',file_size:3}]});
  assert.ok(analyzed);assert.match(f.calls.at(-1).payload.text,/Volvo V60/);
});

test('an emergency media action preserves the higher-priority exception without misclassifying Russian',async t=>{
  const f=await fixture(t);let analyzed=false;
  f.setLanguage({language:'ru',confident:true});
  f.setAnswer(async args=>{
    if(args.images?.length){analyzed=true;return {text:'Потрібна термінова допомога.',searchStatus:{succeeded:false}};}
    return {text:JSON.stringify({action:'analyze',language:'ru',languageRefusal:false}),searchStatus:{succeeded:false}};
  });
  await f.handle({text:undefined,caption:'@ReliabilityTestBot срочно, ребёнок проглотил эти таблетки, что делать?',photo:[{file_id:'urgent-photo',file_size:3}]});
  assert.ok(analyzed);assert.equal(f.classified.length,0);
  assert.match(f.calls.at(-1).payload.text,/термінова допомога/);
});

test("owner completes Operator setup after a restart and edits two independent group profiles", async t => {
  const f = await fixture(t, "neutral", 88);
  const dm = (text, extra = {}) => f.handle({
    text, chat: { id: 88, type: "private" }, is_topic_message: false, message_thread_id: undefined, ...extra,
  });
  const last = () => f.calls.filter(call => call.method === "sendMessage").at(-1)?.payload.text?.replace(/<[^>]*>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  const alpha = { id: -501, type: "supergroup", title: "Alpha" };
  const beta = { id: -502, type: "supergroup", title: "Спокойный чат" };
  await dm("/setup", { chat: { id: 90, type: "private" }, from: { id: 90 } });
  assert.equal(last(), undefined);
  await f.handle({ text: "/setup", chat: alpha });
  assert.ok(f.calls.filter(call => call.method === "sendMessage").every(call => call.payload.chat_id === 88));
  await dm("/start");
  assert.match(last(), /Who’s on the other end/);
  await dm("Я Owner, тебя зовут Искра");
  assert.match(last(), /Before we go further/);
  await dm("отвечай на русском");
  assert.match(last(), /Теперь опиши меня/);
  await f.restart(); await dm("/setup");
  assert.match(last(), /Теперь опиши меня/);
  await dm("Общайся дружелюбно, спокойно и коротко.");
  assert.match(last(), /Имя: Искра/);
  assert.match(last(), /Сохраняем/);
  await dm("да, но пока подожди");
  assert.match(last(), /Сохраняем/);
  await dm("да, сохрани");
  assert.match(last(), /Ты создал мой первый профиль/);
  await dm("покажи список функций");
  assert.ok(f.calls.some(call => call.payload.reply_markup?.inline_keyboard?.length));
  assert.match(last(), /Общение и память/);
  assert.match(last(), /Голосовые[\s\S]*нужно подключить/);
  assert.doesNotMatch(last(), /Fortnite|Helldivers|Rocket League/);
  await dm("расскажи про голосовые");
  assert.match(last(), /Все доступные голосовые/);
  assert.doesNotMatch(last(), /доступные функции/);

  await f.handle({ text: "hello", chat: alpha });
  await f.handle({ text: "hello", chat: beta });
  for (const title of ["Alpha", "Спокойный чат"]) { await dm("используй профиль Искра в " + title); await dm("сохрани"); }
  await dm("/start");
  await dm("настрой сборы на Fortnite с @alpha_player без анимации, command Fort, no caption, no phrases");
  assert.match(last(), /название или номер/);
  await dm("/start");
  assert.match(last(), /поговорить со мной или открыть \/setup/);
  await dm("/setup");
  assert.match(last(), /название или номер/);
  await dm("1");
  assert.match(last(), /Alpha[\s\S]*@alpha_player/);
  await dm("да, включай");
  assert.match(last(), /Сохранено для «Alpha»/);
  await dm("настрой сборы в Спокойный чат на Fortnite с @beta_player без анимации, command Fort, no caption, no phrases");
  assert.match(last(), /Спокойный чат[\s\S]*@beta_player/);
  await dm("сохрани");

  await dm("создай новый профиль в Спокойный чат");
  await dm("назовись Lumen, be friendly and concise in English");
  assert.match(last(), /Спокойный чат[\s\S]*Name: Lumen/);
  await dm("yes");
  assert.match(last(), /profile saved|first profile/);
  await dm("yes");
  await dm("show group profile Спокойный чат");
  assert.match(last(), /Profile: Lumen/);
  assert.doesNotMatch(last(), /@alpha_player/);
  const scoped = new (await import("node:sqlite")).DatabaseSync(f.root + "/runtime/setup.sqlite", { readOnly: true });
  try { assert.deepEqual(JSON.parse(scoped.prepare("SELECT document FROM setup WHERE id=1").get().document).groups[beta.id].assemble.games[0].players, ["beta_player"]); }
  finally { scoped.close(); }
  await dm("configure game calls in Спокойный чат for Fortnite @beta_player, no animation, command Fort, no caption, no phrases");
  await dm("save");

  await f.handle({ text: "/assemble fort", chat: alpha });
  assert.match(last(), /@alpha_player/);
  assert.doesNotMatch(last(), /@beta_player/);
  await f.handle({ text: "/assemble fort", chat: beta });
  assert.match(last(), /@beta_player/);
  assert.doesNotMatch(last(), /@alpha_player/);

  const profiles = [];
  f.setAnswer(async args => {
    profiles.push([args.profile.displayName, args.profile.language.reply]);
    return { text: JSON.stringify({ action: "reply", text: "test" }), searchStatus: { succeeded: false } };
  });
  await Promise.all([
    f.handle({ text: "@ReliabilityTestBot hello", chat: alpha }),
    f.handle({ text: "@ReliabilityTestBot hello", chat: beta }),
  ]);
  assert.deepEqual(profiles.sort(), [["Lumen", "en"], ["Искра", "ru"]]);

  await dm("turn off game calls in Спокойный чат");
  assert.match(last(), /Спокойный чат[\s\S]*Current setting: off/);
  await dm("save");
  await f.restart();
  await f.handle({ text: "/assemble fort", chat: beta });
  assert.match(last(), /Збір не налаштовано/);
  await dm("/setup");
  await dm("show group profile Спокойный чат");
  assert.ok(f.calls.filter(x=>x.payload.reply_markup).at(-1).payload.reply_markup.inline_keyboard.flat().some(x=>x.text.startsWith("Game calls · off")));
  const preserved = new (await import("node:sqlite")).DatabaseSync(f.root + "/runtime/setup.sqlite", { readOnly: true });
  try { assert.deepEqual(JSON.parse(preserved.prepare("SELECT document FROM setup WHERE id=1").get().document).groups[beta.id].assemble.games[0].players, ["beta_player"]); }
  finally { preserved.close(); }
  const profileTitle = { id: -503, type: "supergroup", title: "Profile" };
  const firstGaming = { id: -504, type: "supergroup", title: "Gaming" };
  const secondGaming = { id: -505, type: "supergroup", title: "Gaming" };
  for (const chat of [profileTitle, firstGaming, secondGaming]) await f.handle({ text: "hello", chat });
  await dm("create new profile");
  await dm("My name is Owner; your name is Echo, friendly and clear in English");
  assert.match(last(), /Name: Echo/);
  await dm("yes");
  await dm("yes");
  await dm("show group profile Спокойный чат");
  assert.match(last(), /Profile: Lumen/);
  await dm("show group profile Profile");
  assert.match(last(), /Profile: Искра/);
  await dm("create new profile in Gaming");
  assert.match(last(), /Which group/);
  assert.match(last(), /Gaming · 1/);
  assert.match(last(), /Gaming · 2/);
  await dm("-505");
  assert.match(last(), /What name should I use/);
  await dm("My name is Owner; your name is Slate, calm and clear in English");
  assert.match(last(), /Gaming[\s\S]*Name: Slate/);
  await dm("yes");
  await dm("/start");
  assert.match(last(), /talk to me or open \/setup/);
  f.setSetupTurn(async () => ({ intent: "conversation" }));
  await dm("hello");
  assert.equal(last(), "test");
});

test("plain Start diagnoses ownership without AI and preserves game deep links", async t => {
  const f = await fixture(t, "neutral");
  await f.handle({ text: "/start", chat: { id: 88, type: "private" } });
  assert.match(f.calls.at(-1).payload.text, /BOT_OWNER_ID/);
  assert.equal(f.prompts.length, 0);
  assert.equal(f.classified.length, 0);
  await f.handle({ text: "/start flappy", chat: { id: 88, type: "private" } });
  assert.match(f.calls.at(-1).payload.text, /Flappy Bird/);
  assert.doesNotMatch(f.calls.at(-1).payload.text, /BOT_OWNER_ID/);
});

test("owner can chat through first setup, resume after restart and explicitly save", async t => {
  const f = await fixture(t, "neutral", 88);
  const dm = (text, extra = {}) => f.handle({ text, chat: { id: 88, type: "private" }, ...extra });
  const last = () => f.calls.filter(call => call.method === "sendMessage").at(-1)?.payload.text?.replace(/<[^>]*>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  const state = async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(f.root + "/runtime/setup.sqlite", { readOnly: true });
    try { return JSON.parse(db.prepare("SELECT document FROM setup WHERE id=1").get().document); }
    finally { db.close(); }
  };
  const chat = "Кстати, почему небо синее?";
  const story = "Расскажи историю про игроков";
  f.setSetupTurn(async input => ({ intent: [chat, story].includes(input.message) ? "conversation" : input.kind === "menu" ? "setup" : "answer" }));
  f.setAnswer(async () => ({ text: JSON.stringify({ action: "reply", text: "Из-за рассеяния света." }), searchStatus: { succeeded: false } }));

  await dm("/start", { chat: { id: 99, type: "private" }, from: { id: 99 } });
  assert.match(last(), /Only the owner/);
  assert.equal(f.classified.length, 0);
  await dm("/start");
  assert.match(last(), /^> connection open/);
  assert.equal(f.prompts.length, 0);
  await dm(chat);
  assert.equal(last(), "Из-за рассеяния света.");
  assert.match(f.prompts.at(-1), /owner is asking about configuration/);
  assert.equal((await state()).session.name, undefined);
  await dm("продолжим настройку");
  assert.match(last(), /what do you want to call me/);
  await dm("My name is Owner; your name is Spark");
  await dm("Russian");
  await dm("Warm, concise and curious.");
  assert.match(last(), /Имя: Spark/);
  await dm(chat);
  await f.restart();
  await dm("Да");
  assert.equal(Object.keys((await state()).profiles).length, 0, "side-chat yes cannot commit the pending preview");
  assert.equal((await state()).session.paused, true);
  await dm("Сохраняй");
  assert.equal(Object.keys((await state()).profiles).length, 0, "a save after side chat returns to the preview first");
  assert.match(last(), /Характер:/);
  await dm("вернёмся к настройке");
  assert.match(last(), /Характер: Warm, concise and curious/);
  await dm("Сохраняй");
  assert.match(last(), /профиль|Профиль/);
  const saved = await state();
  assert.equal(saved.profiles[saved.defaultProfile].name, "Spark");
  assert.equal(saved.profiles[saved.defaultProfile].settings, undefined, "personality has no editable feature settings");
  await dm("покажи список функций");
  assert.match(last(), /Сборы игроков[\s\S]*Зову настроенных игроков/);
  await dm("Как добавить нужных игроков?");
  assert.match(last(), /Telegram-имена|Telegram/);
  assert.match(last(), /настрой сборы игроков.*выбери группу/);
  await dm("Как твои дела?");
  assert.equal(last(), "Из-за рассеяния света.");
  assert.equal((await state()).session.kind, "catalogue");
  await dm(story);
  assert.equal(last(), "Из-за рассеяния света.");
  await dm("/flappy"); assert.match(last(), /не подключена/);
  await dm("/duel"); assert.match(last(), /не подключена/);
  await dm("/stickers"); assert.match(last(), /Управление стикерами/);
  await dm("/start");
  assert.match(last(), /Я на связи/);
  assert.equal(Object.keys((await state()).profiles).length, 1, "Start must not reset confirmed setup");
});

test("game, rule and assignment drafts survive side conversations and nested setup", async t => {
  const f = await fixture(t, "neutral", 88);
  const dm = text => f.handle({ text, chat: { id: 88, type: "private" } });
  const last = () => f.calls.filter(call => call.method === "sendMessage").at(-1)?.payload.text?.replace(/<[^>]*>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  const state = async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(f.root + "/runtime/setup.sqlite", { readOnly: true });
    try { return JSON.parse(db.prepare("SELECT document FROM setup WHERE id=1").get().document); }
    finally { db.close(); }
  };
  const chat = "Кстати, я читал историю про игроков. Обсудим?";
  f.setSetupTurn(async input => ({ intent: input.message === chat ? "conversation" : input.message === "Давай продолжим" ? "resume" : input.kind === "menu" ? "setup" : "answer" }));
  f.setAnswer(async () => ({ text: JSON.stringify({ action: "reply", text: "Давай обсудим." }), searchStatus: { succeeded: false } }));
  await dm("/start"); await dm("My name is Owner; your name is Cedar, calm and friendly in Russian"); await dm("сохраняй");
  const alpha = { id: -961, type: "supergroup", title: "Alpha" };
  const beta = { id: -962, type: "supergroup", title: "Beta" };
  await f.handle({ text: "hello", chat: alpha }); await f.handle({ text: "hello", chat: beta });
  await dm("use profile Cedar in Alpha"); await dm("save");
  await dm("/start"); // A request works outside the catalogue too.
  await dm('Давай создадим сбор для "Alpha"');
  assert.match(last(), /В какую игру/);
  await dm("Fortnite"); assert.match(last(), /Кого отметить/);
  await dm(chat); assert.equal(last(), "Давай обсудим.");
  assert.equal((await state()).session.gameName, "Fortnite");
  await dm("создай новый профиль");
  await dm("Echo"); await dm("Русский"); await dm("Спокойный и дружелюбный."); await dm("Сохраняй");
  assert.match(last(), /Предыдущий черновик сохранён/);
  await dm("Да");
  assert.equal((await state()).groups[alpha.id].assemble, undefined);
  await f.restart(); await dm("Давай продолжим"); assert.match(last(), /Кого отметить/);
  await dm("@alpha_player"); await dm("без анимации"); await dm("no caption"); await dm("command Fort"); await dm("no phrases");
  await dm("не сохраняй");
  assert.equal((await state()).groups[alpha.id].assemble, undefined);
  await dm("сохраняй");
  assert.deepEqual((await state()).groups[alpha.id].assemble.games[0].players, ["alpha_player"]);
  assert.equal((await state()).groups[beta.id].assemble, undefined);

  await dm("создай правило в Alpha whole message"); await dm("вечерний сбор");
  const ruleDraft = (await state()).session;
  await dm(chat); assert.equal(last(), "Давай обсудим.");
  await f.restart(); await dm("/setup");
  assert.equal((await state()).session.phrase, ruleDraft.phrase);
  assert.equal((await state()).session.kind, "feature");
  assert.match(last(), /Что делать: запустить сохранённый сбор, разобрать спор/);
  await dm("отмена");
  await dm("используй профиль Echo в Beta");
  assert.match(last(), /применю профиль «Echo»/);
  const before = (await state()).groups[beta.id].profile;
  await dm(chat); await f.restart(); await dm("да");
  assert.equal((await state()).groups[beta.id].profile, before);
  await dm("продолжим настройку"); await dm("Сохраняй");
  const assigned = await state();
  assert.equal(assigned.profiles[assigned.groups[beta.id].profile].name, "Echo");
  assert.deepEqual(assigned.groups[alpha.id].assemble.games[0].players, ["alpha_player"]);
});

test("failed AI turn classification preserves draft and saved settings", async t => {
  const f = await fixture(t, "neutral", 88);
  const dm = text => f.handle({ text, chat: { id: 88, type: "private" } });
  await dm("/start"); await dm("My name is Owner; your name is Spark");
  f.setSetupTurn(async () => { throw new Error("connection unavailable"); });
  await dm("Let's talk about something else.");
  assert.match(f.calls.at(-1).payload.text, /AI check failed.*draft is safe/);
  await f.restart(); await dm("/setup");
  assert.match(f.calls.at(-1).payload.text, /Before we go further/);
  f.setSetupTurn(async () => ({ intent: "unexpected" }));
  await dm("another topic");
  assert.match(f.calls.at(-1).payload.text, /AI check failed/);
  assert.equal(f.prompts.length, 0);
});

test("negative resume and informational detours never make a later yes save an old preview", async t => {
  const f = await fixture(t, "neutral", 88);
  const dm = text => f.handle({ text, chat: { id: 88, type: "private" } });
  const last = () => f.calls.filter(call => call.method === "sendMessage").at(-1)?.payload.text?.replace(/<[^>]*>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  const state = async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(f.root + "/runtime/setup.sqlite", { readOnly: true });
    try { return JSON.parse(db.prepare("SELECT document FROM setup WHERE id=1").get().document); }
    finally { db.close(); }
  };
  const conversation = new Set([
    "Не продолжай настройку, расскажи про космос",
    "If I want to continue setup later, how does that work?",
  ]);
  f.setSetupTurn(async input => ({ intent: conversation.has(input.message) ? "conversation" : input.kind === "menu" ? "setup" : "answer" }));
  f.setAnswer(async () => ({ text: JSON.stringify({ action: "reply", text: "We can talk." }), searchStatus: { succeeded: false } }));
  await dm("/start"); await dm("My name is Owner; your name is Draft"); await dm("English"); await dm("Calm and concise.");
  for (const text of [...conversation, "How can I create a new profile?", "How can I use profile Draft?"]) {
    const before = f.classified.length;
    await dm(text);
    assert.ok(f.classified.length > before, "ambiguous discussion goes through semantic discrimination");
    assert.equal((await state()).session.paused, true, text);
    assert.equal((await state()).session.name, "Draft");
    await dm("yes");
    assert.equal(Object.keys((await state()).profiles).length, 0, text + " must not leave an active confirmation");
    await dm("continue setup"); assert.match(last(), /Character:/);
  }
  await dm("save"); assert.match(last(), /profile saved|first profile/);
  assert.equal(Object.keys((await state()).profiles).length, 1);
});

test("ordinary feature questions stay conversational and saved-profile inspection keeps its scope", async t => {
  const f = await fixture(t, "neutral", 88);
  const dm = text => f.handle({ text, chat: { id: 88, type: "private" } });
  const last = () => f.calls.filter(call => call.method === "sendMessage").at(-1)?.payload.text?.replace(/<[^>]*>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  const ordinary = new Set([
    "Tell me about JavaScript features",
    "Расскажи про возможности Photoshop",
    "What's enabled by default in nginx?",
  ]);
  f.setSetupTurn(async input => ({ intent: ordinary.has(input.message) ? "conversation" : input.kind === "menu" ? "setup" : "answer" }));
  f.setAnswer(async () => ({ text: JSON.stringify({ action: "reply", text: "Ordinary answer." }), searchStatus: { succeeded: false } }));
  await dm("/start"); await dm("My name is Owner; your name is Gaming, calm and clear in English"); await dm("save"); await dm("yes");
  for (const text of ordinary) {
    const before = f.prompts.length;
    await dm(text);
    assert.equal(f.prompts.length, before + 1, text);
    assert.equal(last(), "Ordinary answer.");
  }
  await dm("What's enabled in profile Gaming?");
  assert.match(last(), /Gaming/); assert.match(last(), /Only personality changes/);
  await dm("/start"); // Also works outside the open configuration menu.
  await dm("What's enabled in profile Gaming?");
  assert.match(last(), /Only personality changes/);
  const before = f.classified.length;
  await dm("/setup"); assert.match(last(), /Here’s how I can help/);
  assert.equal(f.classified.length, before, "explicit bot command remains deterministic");
});

test("download defaults apply only after assignment, require admin and preserve saved off", async t => {
  const f = await fixture(t, "neutral", 88);
  const dm = text => f.handle({ text, chat: { id: 88, type: "private" } });
  const alpha = { id: -971, type: "supergroup", title: "Alpha" };
  const beta = { id: -972, type: "supergroup", title: "Beta" };
  const attempts = [];
  const download = async url => { attempts.push(url); throw new Error("fixture download unavailable"); };
  f.setDownloader(download);
  await dm("/start"); await dm("My name is Owner; your name is Cedar, calm and friendly in English"); await dm("save");
  await f.handle({ text: "hello", chat: alpha }); await f.handle({ text: "hello", chat: beta });
  const link = "https://www.instagram.com/reel/fixture_default/";
  await f.handle({ text: link, chat: alpha }); assert.equal(attempts.length, 0);
  await dm("create rule in Alpha whole message"); await dm("settle it"); await dm("judge"); await dm("everyone"); await dm("skip"); await dm("save");
  await f.handle({ text: link, chat: alpha }); assert.equal(attempts.length, 0, "first rule alone must not enable downloads");
  await dm("use profile Cedar in Alpha"); await dm("save");
  f.setMemberStatus("member"); await f.restart(); f.setDownloader(download);
  await f.handle({ text: link, chat: alpha }); assert.equal(attempts.length, 0, "administrator permission is still required");
  f.setMemberStatus("administrator"); await f.restart(); f.setDownloader(download);
  await f.handle({ text: link, chat: alpha }); assert.equal(attempts.length, 1);
  await dm("turn off downloads in Alpha"); await dm("save");
  await f.restart(); f.setDownloader(download);
  await f.handle({ text: link, chat: alpha }); await f.handle({ text: link, chat: beta });
  assert.equal(attempts.length, 1, "saved off and unassigned second group stay off across restart");
  await dm("/setup"); await dm("show group profile Alpha");
  assert.ok(f.calls.filter(call=>call.payload.reply_markup).at(-1).payload.reply_markup.inline_keyboard.flat().some(x=>x.text.startsWith("Media downloads · off")));
});

test("the existing Claude backend uses conversational setup and reports unsupported connections", async t => {
  const f = await fixture(t, "neutral", 88, async () => {}, "claude");
  const dm = text => f.handle({ text, chat: { id: 88, type: "private" } });
  const last = () => f.calls.filter(call => call.method === "sendMessage").at(-1)?.payload.text?.replace(/<[^>]*>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  f.setSetupTurn(async input => ({ intent: input.message === "Как твои дела?" ? "conversation" : input.kind === "menu" ? "setup" : "answer" }));
  f.setAnswer(async () => ({ text: JSON.stringify({ action: "reply", text: "Я на связи." }), searchStatus: { succeeded: false } }));
  await dm("/start"); assert.match(last(), /^> connection open/);
  await dm("My name is Owner; your name is Cedar");
  await dm("Как твои дела?"); assert.equal(last(), "Я на связи.");
  await f.restart(); await dm("продолжим настройку"); assert.match(last(), /what language/);
  await dm("Русский"); await dm("Спокойный и любопытный."); await dm("Сохраняй"); await dm("покажи список функций");
  assert.match(last(), /Поиск в интернете[^\n]*нужно подключить/);
  assert.match(last(), /Анализ фото и видео[^\n]*нужно подключить/);
  assert.match(last(), /Сборы игроков[^\n]*Зову/);
  await dm("настрой сборы в профиле Cedar"); assert.match(last(), /Функции принадлежат группе/);
  await f.handle({ text: "hello", chat: { id: -984, type: "supergroup", title: "Alpha" } });
  await dm("use profile Cedar in Alpha"); await dm("save"); await dm("later");
  await dm("настрой сборы в Alpha"); await dm("Fortnite"); await dm("@alpha_player"); await dm("без анимации"); await dm("skip"); await dm("command Fort"); await dm("no phrases"); await dm("Сохраняй");
  assert.match(last(), /Сохранено для «Alpha»/);
  assert.ok(f.classified.some(call => call.schemaFile.endsWith("setup-turn.schema.json")));
});

test("confirmed reactions, stickers and feature modes apply only to the selected group", async t => {
  const f = await fixture(t, "neutral", 88);
  const dm = (text, extra = {}) => f.handle({ text, chat: { id: 88, type: "private" }, ...extra });
  const alpha = { id: -601, type: "supergroup", title: "Понедельник" };
  const beta = { id: -602, type: "supergroup", title: "Вторник" };
  const last = () => f.calls.filter(call => call.method === "sendMessage").at(-1)?.payload.text?.replace(/<[^>]*>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

  await dm("/start");
  await dm("Меня зовут Owner; назовись Искра, отвечай коротко и по-русски");
  assert.match(last(), /Сохраняем/);
  await dm("сохрани");
  await dm("да");
  await f.handle({ text: "hello", chat: alpha });
  await f.handle({ text: "hello", chat: beta });
  for (const title of ["Понедельник", "Вторник"]) { await dm("используй профиль Искра в " + title); await dm("сохрани"); }

  await dm("настрой реакции Понедельник: вставай, зелёный сигнал", { animation: { file_id: "test-telegram-gif" } });
  assert.match(last(), /Понедельник[\s\S]*зелёный сигнал[\s\S]*Сохранить/);
  await dm("сохрани");
  await f.handle({ text: "зелёный сигнал", chat: alpha });
  await f.handle({ text: "зелёный сигнал", chat: beta });
  assert.deepEqual(f.calls.filter(call => call.method === "sendAnimation" && call.payload.chat_id < 0).map(({ payload }) => [payload.chat_id, payload.animation]), [
    [alpha.id, "test-telegram-gif"],
  ]);

  await dm("настрой стикерпак Понедельник https://t.me/addstickers/example_by_ReliabilityTestBot");
  assert.match(last(), /Понедельник[\s\S]*example_by_ReliabilityTestBot/);
  await dm("сохрани");
  await f.handle({ text: "/stickers", chat: alpha });
  assert.match(last(), /t.me\/addstickers\/example/);
  await f.handle({ text: "/stickers", chat: beta });
  assert.doesNotMatch(last(), /t.me\/addstickers/);

  await dm("настрой стикерпак Вторник https://t.me/addstickers/example_by_ReliabilityTestBot");
  await dm("сохрани");
  assert.match(last(), /уже привязан к другой группе/);
  await f.update({ my_chat_member: { chat: alpha, from: { id: 88 }, old_chat_member: { status: "member" }, new_chat_member: { status: "left" } } });
  await dm("сохрани");
  assert.match(last(), /Сохранено для «Вторник»/);
  await f.update({ my_chat_member: { chat: alpha, from: { id: 88 }, old_chat_member: { status: "left" }, new_chat_member: { status: "member" } } });
  await f.handle({ text: "/stickers", chat: alpha });
  assert.doesNotMatch(last(), /t.me\/addstickers/);
  await dm("включи стикерпак Понедельник");
  await dm("сохрани");
  assert.match(last(), /Создадим новый пак/);
  await dm("отмена");
  await dm("/setup");

  await dm("выключи память Понедельник");
  assert.match(last(), /Понедельник[\s\S]*Сейчас: выключено/);
  await dm("да");
  await f.handle({ text: "/remember marker scope stays private", chat: alpha });
  assert.match(last(), /вимкнена/);
  await dm("назначь профиль Искра в Вторник");
  await dm("сохрани");
  await f.handle({ text: "/remember marker scope stays private", chat: beta });
  await dm("расскажи про память Понедельник");
  assert.match(last(), /Сейчас: выключено/);
  await dm("расскажи про память Вторник");
  assert.match(last(), /Сейчас: по просьбе/);
  await f.handle({ text: "/memory", chat: beta });
  assert.match(last(), /marker scope stays private/);
  await dm("включи память Понедельник");
  await dm("сохрани");
  await f.handle({ text: "/memory", chat: alpha });
  assert.doesNotMatch(last(), /marker scope stays private/);
});

test("full profiles can be prepared before groups and switched privately by the owner", async t => {
  const f = await fixture(t, "neutral", 88);
  const dm = (text, extra = {}) => f.handle({ text, chat: { id: 88, type: "private" }, ...extra });
  const privateMessages = () => f.calls.filter(call => call.method === "sendMessage" && call.payload.chat_id === 88);
  const last = () => privateMessages().at(-1)?.payload.text?.replace(/<[^>]*>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  const alpha = { id: -801, type: "supergroup", title: "Friends" };
  const beta = { id: -802, type: "supergroup", title: "Friends" };

  await dm("/start");
  await dm("My name is Owner; your name is Base");
  await dm("English");
  await dm("Quiet and concise.");
  await dm("yes");
  await dm("/start");

  await dm('create new profile "Spark"');
  await dm("My name is Owner; your name is Spark");
  await dm("English");
  await dm("Friendly and playful.");
  assert.match(last(), /Name: Spark/);
  await dm("yes");
  await dm("later");
  await dm("configure game calls in profile Spark for Fortnite @game_player, no animation, command Fort, no caption, no phrases");
  assert.match(last(), /Features belong to a group/);
  await dm("save");
  await dm('configure phrase reactions in profile Spark: wake up', { animation: { file_id: "profile-gif" } });
  await dm("save");
  await dm("/start");
  await dm("please show all available profiles");
  assert.match(last(), /Available profiles\n• Base\n• Spark/);
  assert.doesNotMatch(last(), /Fortnite|game_player|profile-gif/);

  const beforeOther = f.calls.length;
  await dm("show all available profiles", { chat: { id: 99, type: "private" }, from: { id: 99 } });
  const denied = f.calls.slice(beforeOther).filter(call => call.method === "sendMessage");
  assert.equal(denied.length, 1);
  assert.equal(denied[0].payload.chat_id, 99);
  assert.doesNotMatch(denied[0].payload.text, /Spark|Spark/);

  await dm("create new profile");
  await dm("Draft");
  for (const chat of [alpha, beta]) {
    await f.update({ my_chat_member: { chat, from: { id: 900 }, old_chat_member: { status: "left" }, new_chat_member: { status: "member" } } });
  }
  const notifications = privateMessages().filter(call => call.payload.text.includes("Group “Friends” connected"));
  assert.equal(notifications.length, 2);
  assert.ok(notifications.every(call => call.payload.chat_id === 88));
  const beforeOwnerList = f.calls.length;
  await f.handle({ text: "show all available profiles", chat: alpha });
  assert.ok(f.calls.slice(beforeOwnerList).filter(call => call.method === "sendMessage")
    .every(call => call.payload.chat_id === 88));
  const callsBeforeBinding = f.calls.length;
  await f.handle({ text: "/assemble fort", chat: beta });
  assert.ok(f.calls.slice(callsBeforeBinding).every(call => call.method !== "sendAnimation"));
  assert.doesNotMatch(f.calls.filter(call => call.method === "sendMessage").at(-1).payload.text, /@game_player/);
  await dm("/setup");
  assert.match(last(), /What language/);
  await dm("cancel");

  // Use the older notification, even after another group was discovered.
  const sqlite = await import("node:sqlite");
  const database = new sqlite.DatabaseSync(f.root + "/runtime/setup.sqlite", { readOnly: true });
  const document = JSON.parse(database.prepare("SELECT document FROM setup WHERE id=1").get().document);
  database.close();
  assert.ok(document.groups[alpha.id].notificationId !== document.groups[beta.id].notificationId);
  await dm("Spark", { reply_to_message: { message_id: document.groups[alpha.id].notificationId } });
  assert.match(last(), /Friends · 1/);
  assert.doesNotMatch(last(), /@game_player/);
  await dm("save");
  await dm("configure game calls for Fortnite @game_player, no animation, command Fort, no caption, no phrases"); await dm("save");

  const publicBefore = f.calls.length;
  await f.handle({ text: "use profile Spark", chat: beta });
  const switchReplies = f.calls.slice(publicBefore).filter(call => call.method === "sendMessage");
  assert.ok(switchReplies.length && switchReplies.every(call => call.payload.chat_id === 88));
  assert.match(last(), /Friends · 2/);
  await dm("save");
  await dm("configure game calls for Fortnite @beta_player, no animation, command Fort, no caption, no phrases"); await dm("save");

  await dm("edit profile Spark");
  await dm("change character");
  await dm("Calm and analytical.");
  await dm("save");
  const profiles = [];
  f.setAnswer(async args => {
    profiles.push([args.sessionKey, args.profile.instructions]);
    return { text: JSON.stringify({ action: "reply", text: "test" }), searchStatus: { succeeded: false } };
  });
  await Promise.all([
    f.handle({ text: "@ReliabilityTestBot hello", chat: alpha }),
    f.handle({ text: "@ReliabilityTestBot hello", chat: beta }),
  ]);
  assert.equal(profiles.length, 2);
  assert.ok(profiles.every(([, instruction]) => instruction.includes("Calm and analytical.")));

  await f.handle({ text: "use profile Spark", chat: alpha });
  await dm("save");
  profiles.length = 0;
  await f.handle({ text: "@ReliabilityTestBot hello", chat: alpha });
  await f.handle({ text: "@ReliabilityTestBot hello", chat: beta });
  assert.match(profiles[0][1], /Calm and analytical/);
  assert.match(profiles[1][1], /Calm and analytical/);

  await f.handle({ text: "use profile Base", chat: alpha });
  await dm("save");
  await f.handle({ text: "/assemble fort", chat: alpha });
  const groupLast = f.calls.filter(call => call.method === "sendMessage").at(-1).payload;
  assert.match(groupLast.text, /@game_player/);
  await f.handle({ text: "/assemble fort", chat: beta });
  assert.match(f.calls.filter(call => call.method === "sendMessage").at(-1).payload.text, /@beta_player/);
});

test("targeted profile creation previews all changes and new-group replies retain their target", async t => {
  const f = await fixture(t, "neutral", 88);
  const dm = (text, extra = {}) => f.handle({ text, chat: { id: 88, type: "private" }, ...extra });
  const messages = () => f.calls.filter(call => call.method === "sendMessage");
  const last = () => messages().at(-1)?.payload.text?.replace(/<[^>]*>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  const alpha = { id: -811, type: "supergroup", title: "Monday" };
  const beta = { id: -812, type: "supergroup", title: "Tuesday" };
  const member = (chat, oldStatus, status) => f.update({ my_chat_member: {
    chat, from: { id: 900 }, old_chat_member: { status: oldStatus }, new_chat_member: { status },
  } });
  await dm("/start");
  await dm("My name is Owner; your name is Base, calm and clear in English");
  await dm("save");
  await member(alpha, "left", "member");
  await dm("use profile Base in Monday"); await dm("save");
  await dm("configure game calls in Monday for Fortnite @monday_player, no animation, command Fort, no caption, no phrases");
  await dm("save");
  await dm("create new profile in Monday");
  await dm("My name is Owner; your name is Echo, friendly and clear in English");
  await dm("save");
  assert.match(last(), /profile saved[\s\S]*Apply Echo in Monday/);
  assert.match(last(), /Features, players, rules and history are retained/);
  assert.doesNotMatch(last(), /Game calls — inactive/);
  await f.handle({ text: "/assemble fort", chat: alpha });
  assert.match(last(), /@monday_player/);
  await dm("save");
  await f.handle({ text: "/assemble fort", chat: alpha });
  assert.match(last(), /already|вже|уже/);

  await member(beta, "left", "member");
  const notification = messages().at(-1);
  assert.match(notification.payload.text, /Group “Tuesday” connected/);
  const sqlite = await import("node:sqlite");
  const database = new sqlite.DatabaseSync(f.root + "/runtime/setup.sqlite", { readOnly: true });
  const document = JSON.parse(database.prepare("SELECT document FROM setup WHERE id=1").get().document);
  database.close();
  await dm("create new profile „Night“", { reply_to_message: { message_id: document.groups[beta.id].notificationId } });
  assert.match(last(), /What language/);
  await dm("My name is Owner; your name is Night, playful and clear in English"); await dm("Playful and clear.");
  assert.match(last(), /Tuesday[\s\S]*Name: Night/);
  await dm("save");
  assert.match(last(), /Apply Night in Tuesday/);
  await dm("save");
  await dm("/start");
  await dm("create new profile „Night“");
  assert.match(last(), /label is already in use/);
  await dm('create new profile "Weekend"');
  assert.match(last(), /What language/);
  await dm("My name is Owner; your name is Weekend, quiet and clear in English"); await dm("Quiet and clear.");
  await dm("save");
  await dm("show all available profiles");
  assert.match(last(), /• Night\n• Weekend/);

  await f.handle({ text: "use profile Night", chat: alpha }); await dm("save");
  await dm("configure sticker pack in Monday https://t.me/addstickers/night_by_ReliabilityTestBot"); await dm("save");
  await f.handle({ text: "use profile Night", chat: beta }); await dm("save");
  await f.handle({ text: "/stickers", chat: alpha }); assert.match(last(), /t.me\/addstickers\/night/);
  await f.handle({ text: "/stickers", chat: beta }); assert.doesNotMatch(last(), /t.me\/addstickers/);
});

test("owner confirms a phrase rule that changes only one group's personality and survives replay", async t => {
  const f = await fixture(t, "neutral", 88);
  const dm = text => f.handle({ text, chat: { id: 88, type: "private" } });
  const alpha = { id: -941, type: "supergroup", title: "Alpha" };
  const beta = { id: -942, type: "supergroup", title: "Beta" };
  const sent = () => f.calls.filter(call => call.method === "sendMessage");
  const last = () => sent().at(-1)?.payload.text?.replace(/<[^>]*>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  const state = async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(f.root + "/runtime/setup.sqlite", { readOnly: true });
    try { return JSON.parse(db.prepare("SELECT document FROM setup WHERE id=1").get().document); }
    finally { db.close(); }
  };
  await dm("/start"); await dm("My name is Owner; your name is Base, calm and direct in English"); await dm("save");
  await dm("create new profile"); await dm("My name is Owner; your name is Cedar, playful and clear in English"); await dm("save");
  for (const chat of [alpha, beta]) await f.handle({ text: "hello", chat });
  await dm("use profile Base in Alpha"); await dm("save");
  await dm("configure game calls in Alpha for Fortnite @alpha_player, no animation, command Fort, no caption, no phrases"); await dm("save");
  await dm("assign profile Base in Beta"); await dm("save");
  await f.handle({ text: "/remember chat durable marker", chat: alpha });

  await dm("create rule in Alpha whole message"); assert.match(last(), /What words or phrases/);
  await dm("show rules in Alpha"); assert.match(last(), /No message rules yet/);
  assert.equal((await state()).session.kind, "feature", "listing does not replace the unfinished rule");
  await dm("Night. Shift. Seven."); assert.match(last(), /What should happen/);
  await dm("change personality to Cedar"); assert.match(last(), /Add an extra announcement/);
  await dm("Cedar is here.");
  assert.match(last(), /Only you[\s\S]*Cedar is here/);
  assert.match(last(), /Profile: Cedar/);
  await dm("save"); assert.match(last(), /Saved for/);
  const before = await state();
  const start = f.calls.length;
  await f.handle({ text: "NIGHT,\nSHIFT: SEVEN!", chat: alpha, message_id: 5001 });
  assert.deepEqual(f.calls.slice(start).filter(call => call.method === "sendMessage").map(call => [call.payload.chat_id, call.payload.text]), [[alpha.id, "Cedar is here."]]);
  let after = await state();
  assert.deepEqual(after.groups[alpha.id].assemble, before.groups[alpha.id].assemble);
  assert.equal(after.groups[alpha.id].character.persona.name, "Cedar");
  assert.equal(after.groups[beta.id].character, undefined);
  const revision = after.groups[alpha.id].character.revision;
  await f.restart();
  const replay = f.calls.length;
  await f.handle({ text: "night shift seven", chat: alpha, message_id: 5001 });
  assert.equal(f.calls.slice(replay).filter(call => call.method === "sendMessage").length, 0);
  await f.handle({ text: "night shift seven", chat: alpha, message_id: 5002 });
  assert.equal((await state()).groups[alpha.id].character.revision, revision);
  await f.handle({ text: "/memory chat", chat: alpha }); assert.match(last(), /durable marker/);
  await f.handle({ text: "/memory chat", chat: beta }); assert.doesNotMatch(last(), /durable marker/);
  await f.handle({ text: "/assemble fort", chat: alpha }); assert.match(last(), /@alpha_player/);

  await dm("create rule in Alpha whole message"); await dm("Morning service"); await dm("change personality to Base"); await dm("skip"); await dm("save");
  await f.handle({ text: "Morning service", chat: alpha, message_id: 5010 });
  assert.equal((await state()).groups[alpha.id].character.persona.name, "Base");
  for (const extra of [
    { from: { id: 99, username: "Other" } },
    { forward_origin: { type: "user" } },
    { entities: [{ type: "code", offset: 0, length: 17 }] },
    { text: '"night shift seven"' },
  ]) await f.handle({ text: "night shift seven", chat: alpha, message_id: 5020, ...extra });
  assert.equal((await state()).groups[alpha.id].character.persona.name, "Base");
  await dm("show rules in Alpha"); assert.match(last(), /Night. Shift. Seven./);
  const outsider = f.calls.length;
  await f.handle({ text: "show rules in Alpha", chat: alpha, from: { id: 99 } });
  assert.ok(f.calls.slice(outsider).filter(call => call.method === "sendMessage").every(call => !/Night|Cedar|Morning/.test(call.payload.text)));

  await dm("create rule in Alpha whole message"); await dm("night shift seven"); await dm("change personality to Base"); await dm("skip");
  assert.match(last(), /replaces the existing rule/); await dm("save");
  assert.equal((await state()).groups[alpha.id].rules.length, 2);
  await dm("delete rule in Alpha"); await dm("night shift seven"); await dm("save");
  assert.equal((await state()).groups[alpha.id].rules.length, 1);
  await dm("assign profile Base in Alpha"); await dm("save");
  assert.equal((await state()).groups[alpha.id].character, undefined);

  // Saved group phrases take precedence over the owner's ordinary setup intent.
  await dm("create rule in Alpha whole message"); await dm("use profile Cedar");
  await dm("change personality to Cedar"); await dm("Rule took precedence."); await dm("save");
  await f.handle({ text: "use profile Cedar", chat: alpha, message_id: 5030 });
  assert.equal(last(), "Rule took precedence.");
  assert.equal((await state()).groups[alpha.id].character.persona.name, "Cedar");
});

test("a paused Russian rule draft allows a new profile request", async t => {
  const f = await fixture(t, "neutral", 88);
  const dm = text => f.handle({ text, chat: { id: 88, type: "private" } });
  const last = () => f.calls.filter(call => call.method === "sendMessage").at(-1)?.payload.text?.replace(/<[^>]*>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  await dm("/start"); await dm("My name is Owner; your name is Cedar, calm and friendly in Russian"); await dm("save");
  await f.handle({ text: "hello", chat: { id: -945, type: "supergroup", title: "Alpha" } });
  await dm("use profile Cedar in Alpha"); await dm("save");
  await dm("создай правило в Alpha whole message"); await dm("вечерняя смена");
  await dm("сменить личность"); await dm("Cedar"); await dm("пропустить"); await dm("сохранить");
  await dm("what's enabled in Alpha"); assert.ok(f.calls.filter(x=>x.payload.reply_markup).at(-1).payload.reply_markup.inline_keyboard.flat().some(x=>x.text.includes('нужно настроить')));
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(f.root + "/runtime/setup.sqlite", { readOnly: true });
  try {
    const state = JSON.parse(db.prepare("SELECT document FROM setup WHERE id=1").get().document);
    assert.equal(state.groups[-945].modes.voice, "on");
    assert.equal(state.groups[-945].modes.download, "on");
    assert.equal(state.groups[-945].modes.minigames, "off");
  } finally { db.close(); }
  await dm("создай правило в Alpha whole message"); assert.match(last(), /фразы/);
  await dm("/start"); assert.match(last(), /на связи/);
  await dm("создай новый профиль"); assert.match(last(), /зовут|имя/);
  await dm("Вектор");
  await dm("На русском");
  await dm("Дружелюбный и спокойный, без пафоса");
  await dm("сохранить"); assert.match(last(), /сохран/);
  await dm("выведи список всех профилей"); assert.match(last(), /Вектор/);
});

test("explicit legacy import preserves old memory while new same-title groups stay isolated", async t => {
  const alpha = { id: -951, type: "supergroup", title: "Shared title" };
  const beta = { id: -952, type: "supergroup", title: "Shared title" };
  const f = await fixture(t, "legacy", 88, async root => {
    const catalog = JSON.parse(await fs.readFile(root + "/profiles.json", "utf8"));
    catalog.defaultProfile = "legacy";
    await fs.writeFile(root + "/profiles.json", JSON.stringify(catalog));
    const groups = { version: 1, chats: { [alpha.id]: { title: alpha.title, modes: { memory: "manual" }, legacyMemory: { chatFile: "legacy-room.md" } } } };
    await fs.writeFile(root + "/groups.json", JSON.stringify(groups));
    Object.assign(process.env, { BOT_IMPORT_PROFILES: "true", BOT_GROUP_SETTINGS_FILE: root + "/groups.json" });
    await fs.mkdir(root + "/memory/chats", { recursive: true });
    await fs.mkdir(root + "/memory/users", { recursive: true });
    await fs.writeFile(root + "/memory/users/@Fixture.md", "# Private user\n- legacy user marker\n");
    await fs.writeFile(root + "/memory/chats/legacy-room.md", "# Existing group\n- legacy chat marker\n");
    await fs.writeFile(root + "/memory/04_FACTS.md", "- legacy global marker\n");
  });
  const last = () => f.calls.filter(call => call.method === "sendMessage").at(-1)?.payload.text?.replace(/<[^>]*>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  await f.handle({ text: "/memory", chat: alpha }); assert.match(last(), /legacy user marker[\s\S]*legacy global marker/);
  await f.handle({ text: "/memory chat", chat: alpha }); assert.match(last(), /legacy chat marker/);
  await f.handle({ text: "hello", chat: beta });
  const dm = text => f.handle({ text, chat: { id: 88, type: "private" } });
  await dm("assign profile Оріон"); await dm(String(beta.id)); await dm("save");
  await f.handle({ text: "/memory chat", chat: beta }); assert.doesNotMatch(last(), /legacy.*marker/);
  await f.handle({ text: "/memory", chat: beta }); assert.doesNotMatch(last(), /legacy.*marker/);
  assert.equal(await fs.readFile(f.root + "/memory/users/@Fixture.md", "utf8"), "# Private user\n- legacy user marker\n");
});

test("saved phrases invoke the existing assembly, animation and judge actions with their permissions", async t => {
  const f = await fixture(t, "neutral", 88);
  const dm = (text, extra = {}) => f.handle({ text, chat: { id: 88, type: "private" }, ...extra });
  const group = { id: -961, type: "supergroup", title: "Friends" };
  const last = () => f.calls.filter(call => call.method === "sendMessage").at(-1)?.payload.text?.replace(/<[^>]*>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  await dm("/start"); await dm("My name is Owner; your name is Base, calm and clear in English"); await dm("save");
  await f.handle({ text: "hello", chat: group });
  await dm("use profile Base in Friends"); await dm("save");
  await dm("configure game calls in Friends for Fortnite @test_player, no animation, command Fort, no caption, no phrases"); await dm("save");
  await dm("create rule in Friends whole message"); await dm("Squad queue"); await dm("call players"); await dm("Fortnite"); await dm("group members");
  assert.match(last(), /Add an extra announcement/);
  await dm("Squad call ready."); await dm("save");
  await f.handle({ text: "Squad queue", chat: group, from: { id: 99 } });
  assert.equal(last(), "Squad call ready.");
  assert.ok(f.calls.some(call => /@test_player/.test(call.payload.text)));
  const beforeCooldown = f.calls.length;
  await f.handle({ text: "Squad queue", chat: group, from: { id: 99 } });
  assert.match(last(), /Наступний виклик/);
  assert.ok(!f.calls.slice(beforeCooldown).some(call => call.payload.text === "Squad call ready."));

  await dm("create rule in Friends whole message"); await dm("Light show"); await dm("send GIF", { animation: { file_id: "synthetic-gif" } }); await dm("members"); await dm("skip"); await dm("save");
  await f.handle({ text: "Light show", chat: group, from: { id: 99 } });
  assert.equal(f.calls.filter(call => call.method === "sendAnimation").at(-1)?.payload.animation, "synthetic-gif");

  await dm("create rule in Friends whole message"); await dm("Court time"); await dm("review dispute"); await dm("members");
  assert.match(last(), /Add an extra announcement/);
  await dm("Court finished."); await dm("save");
  await f.handle({ text: "I prefer the first option", chat: group, message_id: 6000 });
  await f.handle({ text: "The second option seems simpler", chat: group, message_id: 6001, from: { id: 99 } });
  await f.handle({ text: "I still prefer the first one", chat: group, message_id: 6002 });
  f.setAnswer(async args => ({ text: args.prompt.includes("scope extractor") ? JSON.stringify({ status: "ready", topic: "Options", messageIds: [6000, 6001, 6002], materialPublicClaims: [] }) : "Fixture verdict: both choices are preferences.", searchStatus: { succeeded: false } }));
  await f.handle({ text: "Court time", chat: group, message_id: 6010, from: { id: 99 } });
  assert.ok(f.prompts.some(prompt => prompt.includes("independent judge of one isolated dispute")));
  assert.ok(f.calls.some(call => /Fixture verdict/.test(call.payload.text)));
  assert.equal(last(), "Court finished.");
});

test('all group voices enter scoped history without unsolicited replies, while addressed voices and rules work', async t => {
  const f = await fixture(t, 'neutral', 88, async () => {}, 'codex', true);
  const dm = text => f.handle({ text, chat: { id: 88, type: 'private' } });
  const alpha = { id: -981, type: 'supergroup', title: 'Voice Alpha' };
  const beta = { id: -982, type: 'supergroup', title: 'Voice Beta' };
  await dm('/start'); await dm('My name is Owner; your name is Cedar, calm and clear in English'); await dm('save'); await dm('later');
  await f.handle({ text: 'hello', chat: alpha }); await f.handle({ text: 'hello', chat: beta });
  await dm('use profile Cedar in Voice Alpha'); await dm('save'); await dm('later');
  await dm('use profile Cedar in Voice Beta'); await dm('save'); await dm('later');
  let transcript = 'We agreed to meet on Friday.';
  let transcribed = 0;
  f.setTranscriber(async () => { transcribed++; return { text: transcript, language: 'en' }; });
  const voice = (extra = {}) => f.handle({ text: undefined, chat: alpha, message_id: 6001 + transcribed,
    voice: { file_id: 'voice-fixture', duration: 12 }, ...extra });
  const before = f.calls.filter(call => call.method === 'sendMessage' && call.payload.chat_id === alpha.id).length;
  const promptsBefore = f.prompts.length;
  await voice();
  assert.equal(transcribed, 1);
  assert.equal(f.prompts.length, promptsBefore, 'background speech does not invoke conversational AI');
  assert.equal(f.calls.filter(call => call.method === 'sendMessage' && call.payload.chat_id === alpha.id).length, before);
  const { ConversationStore } = await import('../src/conversation-store.js');
  const history = new ConversationStore(f.root + '/runtime/conversations');
  assert.ok((await history.read(alpha.id)).some(item => item.text.includes('meet on Friday')));
  assert.ok(!(await history.read(beta.id)).some(item => item.text.includes('meet on Friday')));
  transcript = 'Cedar, what did we agree?';
  f.setAnswer(async args => {
    assert.match(args.prompt, /meet on Friday/);
    assert.match(args.prompt, /Plus One: product knowledge/);
    return { text: JSON.stringify({ action: 'reply', text: 'Friday.' }), searchStatus: { succeeded: false } };
  });
  await voice();
  assert.match(f.calls.at(-1).payload.text, /Friday/);
  transcript = 'Yes, tell me more.';
  await voice({ reply_to_message: { message_id: 9001, from: { id: 77 }, text: 'Question' } });
  assert.equal(transcribed, 3);
  await dm('create rule in Voice Alpha whole message'); await dm('settle this voice'); await dm('animation');
  await f.handle({ text: undefined, chat: { id: 88, type: 'private' }, animation: { file_id: 'voice-rule-gif' } });
  await dm('everyone'); await dm('skip'); await dm('save');
  transcript = 'settle this voice';
  f.setAnswer(async () => ({ text: 'A bounded verdict.', searchStatus: { succeeded: false } }));
  await voice({ message_id: 7001 });
  assert.deepEqual(f.calls.filter(call => call.method === 'sendAnimation' && call.payload.animation === 'voice-rule-gif' && call.payload.chat_id < 0).map(call => call.payload.chat_id), [alpha.id]);
  await voice({ message_id: 7002, forward_origin: { type: 'user' } });
  assert.equal(f.calls.filter(call => call.method === 'sendAnimation' && call.payload.animation === 'voice-rule-gif' && call.payload.chat_id < 0).length, 1, 'forwarded voice cannot trigger a rule');
  assert.equal(transcribed, 5);
});

test('background voice failures stay silent and a replied-to failure is explained', async t => {
  const f = await fixture(t, 'neutral', 88, async () => {}, 'codex', true);
  const dm = text => f.handle({ text, chat: { id: 88, type: 'private' } });
  const group = { id: -983, type: 'supergroup', title: 'Voice errors' };
  await dm('/start'); await dm('My name is Owner; your name is Cedar, calm and clear in English'); await dm('save'); await dm('later');
  await f.handle({ text: 'hello', chat: group }); await dm('use profile Cedar in Voice errors'); await dm('save'); await dm('later');
  f.setTranscriber(async () => { throw new Error('fixture model unavailable'); });
  const before = f.calls.filter(call => call.method === 'sendMessage' && call.payload.chat_id === group.id).length;
  const message = { text: undefined, chat: group, voice: { file_id: 'voice-fixture', duration: 5 } };
  await f.handle(message);
  assert.equal(f.calls.filter(call => call.method === 'sendMessage' && call.payload.chat_id === group.id).length, before);
  await f.handle({ ...message, reply_to_message: { message_id: 10, from: { id: 77 } } });
  assert.match(f.calls.at(-1).payload.text, /could not transcribe/);
});

test('native callbacks reach setup before game callbacks and alter only their named group', async t => {
  const f = await fixture(t, 'neutral', 88);
  const dm = text => f.handle({ text, chat: { id: 88, type: 'private' } });
  const group = { id: -985, type: 'supergroup', title: 'Native controls' };
  await dm('/start'); await dm('My name is Owner; your name is Cedar, calm and clear in English'); await dm('save'); await dm('later');
  await f.handle({ text: 'hello', chat: group }); await dm('use profile Cedar in Native controls'); await dm('save'); await dm('later'); await dm('/setup');
  let gameCallbacks = 0;
  f.setCallback(async () => { gameCallbacks++; });
  const click = async label => {
    const message = f.calls.filter(call => call.payload.reply_markup).at(-1).payload;
    const key = message.reply_markup.inline_keyboard.flat().find(button => button.text.includes(label));
    assert.ok(key, label);
    await f.update({ callback_query: { id: 'cb', data: key.callback_data, from: { id: 88 }, message: { message_id: 10000, chat: { id: 88, type: 'private' } } } });
  };
  await click('My groups'); await click('Native controls'); await click('Media downloads'); await click('Disable');
  assert.equal(gameCallbacks, 0);
  assert.ok(f.calls.some(call => call.method === 'answerCallbackQuery'));
  assert.ok(f.calls.some(call => call.method === 'editMessageText'));
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(f.root + '/runtime/setup.sqlite', { readOnly: true });
  try { assert.equal(JSON.parse(db.prepare('SELECT document FROM setup WHERE id=1').get().document).groups[group.id].modes.download, 'off'); }
  finally { db.close(); }
});

test('prepared-message phrase uses the bounded executor, announcement and durable replay/actor guards',async t=>{
  const f=await fixture(t,'neutral',88),group={id:-995,type:'supergroup',title:'Lunch group'};
  const dm=text=>f.handle({text,chat:{id:88,type:'private'}});
  const click=async label=>{const p=f.calls.filter(c=>c.payload.reply_markup).at(-1).payload,key=p.reply_markup.inline_keyboard.flat().find(x=>x.text.includes(label));assert.ok(key,label);await f.update({callback_query:{id:'message-rule',data:key.callback_data,from:{id:88},message:{message_id:10000,chat:{id:88,type:'private'}}}});};
  await dm('/start');await dm('My name is Owner; your name is Cedar, calm and clear in English');await dm('save');await dm('later');await f.handle({text:'hello',chat:group});await dm('use profile Cedar in Lunch group');await dm('save');await dm('later');await dm('/setup');
  await click('My groups');await click('Lunch group');await click('Phrase actions');await click('Add or configure');
  f.setSetupTurn(async input=>({intent:'answer',fields:input.message==='When anyone writes lunch, send Meet at noon and announce Ready.'?{phrases:['lunch'],action:'message',messageText:'Meet at noon',announcement:'Ready.',access:'members',match:'exact'}:{}}));
  await dm('When anyone writes lunch, send Meet at noon and announce Ready.');await click('Save');
  const before=f.calls.length,trigger={text:'lunch',chat:group,message_id:9000,from:{id:99}};await f.handle(trigger);
  assert.deepEqual(f.calls.slice(before).filter(c=>c.method==='sendMessage'&&c.payload.chat_id===group.id).map(c=>c.payload.text),['Meet at noon','Ready.']);
  await f.restart();const replay=f.calls.length;await f.handle(trigger);await f.handle({...trigger,message_id:9001,forward_origin:{type:'user'}});
  assert.equal(f.calls.slice(replay).filter(c=>c.method==='sendMessage'&&c.payload.chat_id===group.id).length,0);
});

test('dangling profile rules do not consume ordinary replies or valid overlapping actions',async t=>{
  const group={id:-998,type:'supergroup',title:'Dangling profile rules'};
  const f=await fixture(t,'neutral',88,async root=>{
    const {openSetupStore}=await import('../src/setup-store.js'),store=await openSetupStore('88',root+'/runtime/setup.sqlite');
    store.change(s=>{s.defaultProfile='base';s.profiles.base={name:'Cedar',personality:'Calm',language:'en',locale:'en'};s.groups[group.id]={title:group.title,configured:true,active:true,modes:{chat:'on',history:'on'},rules:[
      {id:'dangling',phrase:'help',match:'contains',access:'owner',action:{type:'persona',profile:'missing'}},
      {id:'valid',phrase:'help me',access:'members',action:{type:'message',text:'Valid action'}}]};});store.close();
  });
  f.setAnswer(async()=>({text:JSON.stringify({action:'reply',text:'Normal reply.'}),searchStatus:{succeeded:false}}));
  await f.handle({text:'help',chat:group,is_topic_message:false,message_thread_id:undefined,reply_to_message:{message_id:1,from:{id:77,is_bot:true},text:'Ask me'}});
  await f.handle({text:'help me',chat:group,is_topic_message:false,message_thread_id:undefined});
  assert.deepEqual(f.calls.filter(c=>c.method==='sendMessage'&&c.payload.chat_id===group.id).map(c=>c.payload.text),['Normal reply.','Valid action']);assert.equal(f.prompts.length,1);
});

test('group moderation authorizes configured administrators only and retains its allowlist when disabled', async t => {
  const f = await fixture(t, 'neutral', 88);
  const dm = text => f.handle({ text, chat: { id: 88, type: 'private' } });
  const alpha = { id: -986, type: 'supergroup', title: 'Moderation Alpha' };
  const beta = { id: -987, type: 'supergroup', title: 'Moderation Beta' };
  f.setMemberLookup(({ user_id }) => ({ status: user_id === 909 ? 'member' : 'administrator', can_restrict_members: true }));
  await dm('/start'); await dm('My name is Owner; your name is Cedar, calm and clear in English'); await dm('save'); await dm('later');
  for (const chat of [alpha, beta]) {
    await f.handle({ text: 'hello', chat }); await dm('use profile Cedar in ' + chat.title); await dm('save'); await dm('later');
  }
  await dm('configure moderation in Moderation Alpha'); await dm('88'); await dm('save');
  const kick = chat => f.handle({ text: '/kick', chat, reply_to_message: { message_id: 3, from: { id: 909, first_name: 'Fixture target' }, text: 'A message' } });
  await kick(alpha); await kick(beta);
  assert.deepEqual(f.calls.filter(call => call.method === 'banChatMember').map(call => call.payload.chat_id), [alpha.id]);
  await dm('turn off moderation in Moderation Alpha'); await dm('save'); await kick(alpha);
  assert.equal(f.calls.filter(call => call.method === 'banChatMember').length, 1);
});

test('voice kick resolves known targets and default-linked groups never inherit an operator allowlist', async t => {
  const f = await fixture(t, 'neutral', 88, async () => { process.env.MODERATION_ALLOWED_USER_IDS = '88'; }, 'codex', true);
  const dm = text => f.handle({ text, chat: { id: 88, type: 'private' } });
  const alpha = { id: -988, type: 'supergroup', title: 'Voice moderation' };
  const beta = { id: -989, type: 'supergroup', title: 'Default moderation' };
  f.setMemberLookup(({ user_id }) => ({ status: user_id === 909 ? 'member' : 'administrator', can_restrict_members: true }));
  await dm('/start'); await dm('My name is Owner; your name is Cedar, calm and clear in English'); await dm('save'); await dm('later');
  for (const chat of [alpha, beta]) {
    await f.handle({ text: 'hello', chat }); await dm('use default in ' + chat.title); await dm('save'); await dm('later');
    await f.handle({ text: 'A recent target message', chat, from: { id: 909, username: 'TargetPerson' } });
  }
  await dm('configure moderation in Voice moderation'); await dm('88'); await dm('save');
  f.setTranscriber(async () => ({ text: '/kick @TargetPerson', language: 'en' }));
  const audio = { text: undefined, voice: { file_id: 'voice-fixture', duration: 5 } };
  await f.handle({ ...audio, chat: alpha });
  assert.deepEqual(f.calls.filter(call => call.method === 'banChatMember').map(call => [call.payload.chat_id, call.payload.user_id]), [[alpha.id, 909]]);
  await f.handle({ ...audio, chat: alpha, from: { id: 99, username: 'OtherAdmin' } });
  await f.handle({ ...audio, chat: beta });
  assert.equal(f.calls.filter(call => call.method === 'banChatMember').length, 1, 'other actors and unconfigured default-linked groups are denied');
});
