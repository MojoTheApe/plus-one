import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {ConversationStore} from '../src/conversation-store.js';
const execute=promisify(execFile);
test('operator import restores only quoted chat evidence and marks it partial',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'context-import-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const rollout=path.join(root,'rollout.jsonl');
 const timestamp=new Date().toISOString();
 const text='Recent Telegram context:\n[08:00 #55] @UserA: збережений фрагмент\n\nRelevant long-term memory:\nPRIVATE MEMORY MUST NOT IMPORT\n\nCurrent Telegram author:\nUser A\nNew text from current author:\nпідсумуй';
 await fs.writeFile(rollout,JSON.stringify({type:'response_item',timestamp,payload:{role:'user',content:[{text}]}})+'\n');
 await execute(process.execPath,[path.resolve('scripts/import-conversation-context.mjs'),root+'/history','-123',rollout],{env:{...process.env,BOT_USERNAME:'FixtureGroupBot'}});
 const rows=await new ConversationStore(root+'/history').read(-123);assert.equal(rows.length,1);assert.equal(rows[0].text,'збережений фрагмент');assert.match(rows[0].restoredFrom,/partial coverage/);assert.ok(!JSON.stringify(rows).includes('PRIVATE MEMORY'));
});
