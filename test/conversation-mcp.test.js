import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ConversationStore } from '../src/conversation-store.js';

test('context MCP reads only the ticket chat/topic, paginates, excludes future data and rejects expired tickets',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'history-mcp-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const store=new ConversationStore(root);const now=Date.now();
 for(let n=1;n<=130;n++)await store.record({chatId:-123,messageId:n,date:now-1000,text:'scope message '+n,messageThreadId:9});
 for(const item of [{chatId:-123,messageId:150,messageThreadId:10,text:'OTHER_TOPIC_SECRET'},{chatId:-999,messageId:1,messageThreadId:9,text:'OTHER_CHAT_SECRET'},{chatId:-123,messageId:999,messageThreadId:9,text:'FUTURE_MESSAGE'}])await store.record({...item,date:now-1000});
 const ticket=await store.ticket({chatId:-123,threadId:9,messageId:200,date:now,timeZone:'Europe/Kyiv'});
 const transport=new StdioClientTransport({command:process.execPath,args:[path.resolve('tools/telegram-context-mcp.mjs')],env:{PATH:process.env.PATH,TELEGRAM_CONTEXT_TICKET:ticket.file},stderr:'pipe'});
 const client=new Client({name:'context-test',version:'1'});await client.connect(transport);t.after(()=>client.close());
 assert.deepEqual((await client.listTools()).tools.map(t=>t.name).sort(),['get_chat_history','get_reply_chain']);
 const first=await client.callTool({name:'get_chat_history',arguments:{query:'today',limit:100}});
 assert.equal(first.isError,undefined);assert.equal(first.structuredContent.items.length,100);assert.equal(first.structuredContent.total,130);assert.equal(first.structuredContent.nextCursor,100);
 assert.ok(!JSON.stringify(first).includes('SECRET'));assert.ok(!JSON.stringify(first).includes('FUTURE_MESSAGE'));
 const second=await client.callTool({name:'get_chat_history',arguments:{query:'today',cursor:100}});assert.equal(second.structuredContent.items.length,30);
 const denied=await client.callTool({name:'get_reply_chain',arguments:{messageId:150}});assert.equal(denied.structuredContent.items.length,0);
 const s=JSON.parse(await fs.readFile(ticket.file));s.expiresAt=0;await fs.writeFile(ticket.file,JSON.stringify(s));assert.equal((await client.callTool({name:'get_chat_history',arguments:{query:'today'}})).isError,true);
});

test('ordinary chat tickets recover legacy reply ancestors, redact file handles and exclude known forums and later evidence',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'history-mcp-ordinary-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const store=new ConversationStore(root),now=Date.now();
 const items=[
  {messageId:1,text:'original video',media:{kind:'video',fileId:'PRIVATE_TELEGRAM_FILE',mimeType:'video/mp4',duration:12,size:5000}},
  {messageId:2,text:'bot downloaded video',messageThreadId:1,replyToMessageId:1,sourceUrl:'https://example.com/video'},
  {messageId:3,text:'try it again',isForum:false,replyToMessageId:2},
  {messageId:4,text:'KNOWN_FORUM_SECRET',isForum:true,messageThreadId:1},
  {messageId:5,text:'OTHER_TOPIC_SECRET',isForum:true,messageThreadId:42},
  {messageId:6,text:'LATER_DATE_SECRET',date:now+1},
  {messageId:30,text:'LATER_ID_SECRET'},
 ];
 for(const item of items)await store.record({chatId:-123,date:now-1000,...item});
 const ticket=await store.ticket({chatId:-123,isForum:false,threadId:1,messageId:20,date:now,timeZone:'Europe/Kyiv'});
 assert.equal(JSON.parse(await fs.readFile(ticket.file)).threadId,null);
 const transport=new StdioClientTransport({command:process.execPath,args:[path.resolve('tools/telegram-context-mcp.mjs')],env:{PATH:process.env.PATH,TELEGRAM_CONTEXT_TICKET:ticket.file},stderr:'pipe'});
 const client=new Client({name:'ordinary-context-test',version:'1'});await client.connect(transport);t.after(()=>client.close());
 const first=await client.callTool({name:'get_chat_history',arguments:{query:'all',limit:2}});
 assert.equal(first.structuredContent.total,3);assert.equal(first.structuredContent.nextCursor,2);
 assert.equal(first.structuredContent.scope.threadId,null);
 assert.deepEqual(first.structuredContent.items[0].media,{kind:'video',mimeType:'video/mp4',duration:12,size:5000});
 assert.ok(!JSON.stringify(first).includes('PRIVATE_TELEGRAM_FILE'));assert.ok(!JSON.stringify(first).includes('SECRET'));
 const second=await client.callTool({name:'get_chat_history',arguments:{query:'all',cursor:2,limit:2}});
 assert.deepEqual(second.structuredContent.items.map(i=>i.messageId),[3]);assert.equal(second.structuredContent.nextCursor,null);
 const chain=await client.callTool({name:'get_reply_chain',arguments:{messageId:3}});
 assert.deepEqual(chain.structuredContent.items.map(i=>i.messageId),[1,2,3]);assert.equal(chain.structuredContent.complete,true);assert.ok(!JSON.stringify(chain).includes('PRIVATE_TELEGRAM_FILE'));
 const hidden=await client.callTool({name:'get_reply_chain',arguments:{messageId:4}});assert.deepEqual(hidden.structuredContent.items,[]);
 // A trusted forum request cannot inherit the broader ordinary-chat repair.
 const s=JSON.parse(await fs.readFile(ticket.file));s.isForum=true;s.threadId=42;await fs.writeFile(ticket.file,JSON.stringify(s));
 const forum=await client.callTool({name:'get_chat_history',arguments:{query:'all'}});
 assert.deepEqual(forum.structuredContent.items.map(i=>i.messageId),[5]);
 assert.ok(!JSON.stringify(forum).includes('original video'));
});
