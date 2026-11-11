import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ConversationStore, retentionMs, scopedItems, replyChain } from '../src/conversation-store.js';
import { historyIntent, selectContext, localEpoch, localTime, responseDecision, historyPage } from '../src/conversation-context.js';
import { UpdateInbox, ChatQueue } from '../src/update-inbox.js';
import { parseJudgeScopesText } from '../src/judge.js';

async function directory(t){const p=await fs.mkdtemp(path.join(os.tmpdir(),'bot-context-'));t.after(()=>fs.rm(p,{recursive:true,force:true}));return p;}
test('history survives process recreation, includes replies, and purges content after seven days',async t=>{
 const root=await directory(t);let now=Date.now();const store=new ConversationStore(root,{now:()=>now});
 const item={chatId:-123,messageId:1,date:now,text:'saved question',messageThreadId:9};await store.record(item);await store.record({...item,messageId:2,text:'bot answer',isBot:true,replyToMessageId:1});
 const recreated=new ConversationStore(root,{now:()=>now});assert.equal((await recreated.read(-123)).length,2);assert.equal((await fs.stat(store.file(-123))).mode&0o777,0o600);
 await fs.appendFile(store.file(-123),'bad interrupted JSON');await store.record({...item,messageId:3,text:'survives torn append'});assert.equal((await store.read(-123)).length,3);
 now+=retentionMs+1;await store.compact();assert.deepEqual(await store.read(-123),[]);await assert.rejects(fs.readFile(store.file(-123)),e=>e.code==='ENOENT');
});
test('reply chains and history snapshots isolate chat/topic and future messages',()=>{
 const items=[{chatId:1,messageThreadId:9,messageId:1,date:1,text:'question'},{chatId:1,messageThreadId:9,messageId:2,date:2,replyToMessageId:1,text:'answer'},{chatId:1,messageThreadId:10,messageId:3,date:3},{chatId:2,messageThreadId:9,messageId:4,date:4},{chatId:1,messageThreadId:9,messageId:8,date:8}];
 const scoped=scopedItems(items,{chatId:1,threadId:9,messageId:5,date:5});assert.deepEqual(scoped.map(i=>i.messageId),[1,2]);assert.deepEqual(replyChain(scoped,2).map(i=>i.messageId),[1,2]);
});
test('natural history periods use group local time and preserve prior history on follow-up',()=>{
 const now=Date.parse('2026-10-14T09:00:00Z');
 for(const q of ['підбий ітог ранкової переписки','подведи итог по утренней переписке'])assert.equal(historyIntent(q,{now}).type,'range');
 const since=historyIntent('Усі повідомлення сьогодні з 5:00',{now});assert.equal(since.from,Date.parse('2026-10-14T02:00:00Z'));
 const eight=historyIntent('А усі суперечки з 8:00',{now});assert.equal(eight.from,Date.parse('2026-10-14T05:00:00Z'));
 assert.equal(localTime(localEpoch('2026-12-14','08:00','Europe/Kyiv'),'Europe/Kyiv'),'2026-12-14 08:00');
 assert.equal(historyIntent('А до цього',{now}).type,'before');
 assert.equal(historyIntent('last 2 hours',{now}).from,now-7200000);
 const before=selectContext([{messageId:1},{messageId:2},{messageId:3}],historyIntent('А до цього',{now}),{beforeId:3});assert.deepEqual(before.map(i=>i.messageId),[1,2]);
});
test('history pages expose continuation and never replace requested periods with the latest messages',()=>{
 const items=Array.from({length:220},(_,i)=>({messageId:i+1,text:'message '+i}));const first=historyPage(items,{limit:100}),second=historyPage(items,{cursor:first.nextCursor,limit:100});assert.equal(first.items[0].messageId,1);assert.equal(second.items[0].messageId,101);assert.equal(second.total,220);
});
test('silence must be explicit, is disallowed for direct requests, and empty text is recoverable',()=>{
 const ignore=JSON.stringify({action:'ignore',text:''});assert.equal(responseDecision(ignore,{mustReply:false}).action,'ignore');assert.equal(responseDecision(ignore,{mustReply:true}).action,'empty');assert.equal(responseDecision('').action,'empty');assert.equal(responseDecision(JSON.stringify({action:'reply',language:'uk',text:'Відповідь'})).text,'Відповідь');
});
test('dispute extraction preserves separate validated topic scopes',()=>{
 const scopes=parseJudgeScopesText(JSON.stringify({disputes:[{status:'ready',topic:'A',messageIds:[1,2,999]},{status:'ready',topic:'B',messageIds:[3,4]}]}),[1,2,3,4],true);assert.equal(scopes.length,2);assert.deepEqual(scopes[0].messageIds,[1,2]);assert.throws(()=>parseJudgeScopesText('{"status":"ready"}',[1,2],true),/disputes array/);
});
test('durable pending updates recover after crash and completed updates do not replay',async t=>{
 const root=await directory(t),file=path.join(root,'inbox.json');const inbox=new UpdateInbox(file);await inbox.add([{update_id:5,message:{text:'A'}},{update_id:6,message:{text:'B'}}]);await inbox.done(5);
 const again=new UpdateInbox(file);assert.equal((await again.load()).offset,7);assert.deepEqual((await again.load()).pending.map(u=>u.update_id),[6]);await again.add([{update_id:6}]);assert.equal((await again.load()).pending.length,1);
});
test('slow AI does not block ingestion; same-chat execution is ordered and different chats can progress',async()=>{
 let release;const gate=new Promise(r=>release=r),done=[],queue=new ChatQueue({concurrency:2});
 queue.add(1,'chat-a',async()=>{await gate;done.push('a1');});queue.add(2,'chat-a',async()=>done.push('a2'));queue.add(3,'chat-b',async()=>done.push('b1'));
 await new Promise(r=>setImmediate(r));assert.deepEqual(done,['b1']);release();await queue.drain();assert.deepEqual(done,['b1','a1','a2']);
});


test('a quoted Telegram snapshot preserves the saved reply parent across restart',async t=>{
 const root=await directory(t),now=Date.now(),store=new ConversationStore(root);
 await store.record({chatId:-123,messageId:1,date:now-1000,text:'original history request',historyRequest:{selectedFirstId:20}});
 await store.record({chatId:-123,messageId:2,date:now,text:'bot answer',replyToMessageId:1,isBot:true});
 const fresh=new ConversationStore(root);
 await fresh.record({chatId:-123,messageId:2,date:now,text:'bot answer',replyToMessageId:null,isBot:true},{partial:true});
 const chain=replyChain(await fresh.read(-123),2);assert.deepEqual(chain.map(i=>i.messageId),[1,2]);assert.equal(chain[0].historyRequest.selectedFirstId,20);
});
