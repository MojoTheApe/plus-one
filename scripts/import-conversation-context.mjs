// Import only an operator-verified chat/topic rollout's quoted Telegram evidence.
// This is partial historical coverage, never a complete Telegram export.
import fs from 'node:fs/promises';
import { ConversationStore } from '../src/conversation-store.js';
const [directory,chatText,rollout,threadText]=process.argv.slice(2),chatId=Number(chatText),threadId=threadText?Number(threadText):null;
if(!directory||!Number.isSafeInteger(chatId)||!rollout)throw Error('Usage: directory verified-chat-id verified-rollout [verified-thread-id]');
const botUsername=(process.env.BOT_USERNAME||'').replace(/^@/,'').toLowerCase();
if(!/^[a-z][a-z0-9_]{4,31}$/.test(botUsername))throw Error('Set BOT_USERNAME to the verified bot identity before importing history');
const store=new ConversationStore(directory),items=new Map();
const headers=['Recent Telegram context:','Replied-to Telegram message:','Requested Telegram chat history:','Explicitly referenced Telegram messages:'];
for(const line of (await fs.readFile(rollout,'utf8')).split('\n')){
 let r;try{r=JSON.parse(line);}catch{continue;}const p=r.payload;
 if(r.type!=='response_item'||p?.role!=='user'||!r.timestamp)continue;
 const prompt=(p.content||[]).map(c=>c.text||'').join('\n');
 if(!prompt.includes('New text from current author:'))continue;
 for(const header of headers){
  const start=prompt.indexOf(header);if(start<0)continue;
  let end=prompt.indexOf('Current Telegram author:',start);if(end<0)end=prompt.length;
  for(const other of [...headers,'Relevant long-term memory']){const next=prompt.indexOf(other,start+header.length);if(next>=0)end=Math.min(end,next);}
  const segment=prompt.slice(start+header.length,end);
  const pattern=/^\[(\d\d:\d\d) #(\d+)(?: reply_to=(\d+))?\] ([^\n:]+):\s*/gm;
  const matches=[...segment.matchAll(pattern)];
  for(let i=0;i<matches.length;i++){
   const m=matches[i],next=matches[i+1]?.index??segment.length;
   const text=segment.slice(m.index+m[0].length,next).split('\nNote: this came')[0].trim();
   if(!text||text.length>20000)continue;
   let date=Date.parse(r.timestamp.slice(0,10)+'T'+m[1]+':00Z');if(date>Date.parse(r.timestamp)+60000)date-=86400000;
   const sender=m[4].trim(),item={chatId,messageId:+m[2],date,userId:0,isBot:sender.toLowerCase()==='@'+botUsername,sender,username:sender.startsWith('@')?sender:'',text,replyToMessageId:m[3]?+m[3]:null,messageThreadId:threadId,restoredFrom:'quoted prior AI context; partial coverage',datePrecision:'minute'};
   // Prefer the longest intact quote; duplicate short prompt excerpts do not erase it.
   if(!items.has(item.messageId)||items.get(item.messageId).text.length<text.length)items.set(item.messageId,item);
  }
 }
}
for(const item of [...items.values()].sort((a,b)=>a.messageId-b.messageId))await store.record(item);
await store.compact();
console.log(JSON.stringify({importedMessages:items.size,partialCoverage:true,chatId,threadId}));
