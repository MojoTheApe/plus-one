import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const retentionMs = 7 * 24 * 3600 * 1000;

const positiveId = value => Number.isSafeInteger(value) && value > 0 ? value : null;
const hasValue = value => value !== undefined && value !== null && value !== '';

// Telegram also attaches message_thread_id to ordinary reply chains. Only the
// explicit forum flags establish a topic boundary.
export function conversationThreadId(message) {
  if (message?.chat?.is_forum === false) return null;
  return message?.chat?.is_forum === true || message?.is_topic_message === true
    ? positiveId(message?.message_thread_id)
    : null;
}

function textQuality(text) {
  if (!text?.trim()) return 0;
  if (/^\[[^\]\n]+ (?:без тексту|transcription failed|has no text available)\]$/iu.test(text.trim())) return 1;
  return /\[[^\]\n]+ transcript\]/iu.test(text) ? 3 : 2;
}

function mergeText(previous, incoming, partial) {
  previous = typeof previous === 'string' ? previous : '';
  incoming = typeof incoming === 'string' ? incoming : '';
  const previousQuality = textQuality(previous), incomingQuality = textQuality(incoming);
  if (incomingQuality < previousQuality) return previous;
  if (incomingQuality > previousQuality) {
    // Transcription may arrive after a caption. Keep both pieces of evidence
    // when the new snapshot contains only the newly obtained transcript.
    if (previousQuality === 2 && /^\[[^\]\n]+ transcript\]/iu.test(incoming)) return `${previous}\n${incoming}`;
    return incoming;
  }
  if (!incoming || previous.startsWith(incoming)) return previous;
  // A quote can add a previously missing transcript or expand a truncated
  // snapshot, but unrelated quoted text cannot replace the original message.
  return partial && previous && !incoming.startsWith(previous) ? previous : incoming;
}

// Both ingestion and replay use this merge. Old append-only logs may already
// contain a degraded snapshot after a complete message; replay must repair that
// ordering as well as prevent it in newly written records.
export function mergeConversationItem(previous, item, { partial = false } = {}) {
  if (!previous) {
    const merged = { ...item, text: typeof item?.text === 'string' ? item.text : '' };
    if (merged.isForum === false) merged.messageThreadId = null;
    if (item?.media) merged.media = { ...item.media };
    return merged;
  }
  const merged = { ...previous };
  for (const [key, value] of Object.entries(item || {})) {
    if (!hasValue(value)) continue;
    if (partial && hasValue(previous[key])) continue;
    merged[key] = value;
  }
  // A later quote's date and sender are not a new original event. Imported
  // minute-precision dates can still be enriched by a real Telegram message.
  for (const key of ['chatId', 'messageId', 'date', 'userId', 'isBot', 'sender', 'username']) {
    if (hasValue(previous[key]) && !(key === 'userId' && previous[key] === 0)) merged[key] = previous[key];
  }
  if (!partial && previous.datePrecision === 'minute' && !item.datePrecision && Number.isFinite(item.date)) {
    merged.date = item.date;
    delete merged.datePrecision;
  }
  merged.text = mergeText(previous.text, item.text, partial);
  if (previous.media || item.media) {
    merged.media = { ...previous.media };
    for (const [key, value] of Object.entries(item.media || {})) {
      if (hasValue(value) && !(partial && hasValue(merged.media[key]))) merged.media[key] = value;
    }
  }
  if (merged.isForum === false) merged.messageThreadId = null;
  return merged;
}

export class ConversationStore {
  constructor(directory, { now = Date.now } = {}) { this.directory = directory; this.now = now; this.queues = new Map(); }
  file(chatId) { if (!Number.isSafeInteger(chatId)) throw new Error('Invalid chat scope'); return path.join(this.directory, createHash('sha256').update(String(chatId)).digest('hex') + '.jsonl'); }
  async read(chatId) {
    let text; try { text = await fs.readFile(this.file(chatId), 'utf8'); } catch(e) { if(e.code==='ENOENT') return []; throw e; }
    const items = new Map();
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let item; try { item=JSON.parse(line); } catch { continue; } // An interrupted final append is never evidence.
      if (item.chatId===chatId && Number.isSafeInteger(item.messageId) && item.date>=this.now()-retentionMs) items.set(item.messageId,mergeConversationItem(items.get(item.messageId),item));
    }
    return [...items.values()].sort((a,b)=>a.date-b.date || a.messageId-b.messageId);
  }
  async record(item, { partial = false } = {}) {
    if ((!item?.text && !item?.media) || !Number.isSafeInteger(item.messageId) || !Number.isFinite(item.date) || item.date < this.now() - retentionMs) return;
    const file=this.file(item.chatId), previous=this.queues.get(file)||Promise.resolve();
    const work=previous.catch(()=>{}).then(async()=>{
      await fs.mkdir(this.directory,{recursive:true,mode:0o700});
      try { await fs.writeFile(file+'.coverage.json',JSON.stringify({capturingSince:this.now()}),{mode:0o600,flag:'wx'}); } catch(e) { if(e.code!=='EEXIST')throw e; }
      const previous=(await this.read(item.chatId)).find(i=>i.messageId===item.messageId);
      item=mergeConversationItem(previous,item,{partial});
      // Prefix newline lets a subsequent record survive a torn final line after a crash.
      await fs.appendFile(file,'\n'+JSON.stringify(item)+'\n',{mode:0o600});
    });
    this.queues.set(file,work);
    try { await work; return item; } finally { if(this.queues.get(file)===work)this.queues.delete(file); }
  }
  async coverage(chatId) { try{return JSON.parse(await fs.readFile(this.file(chatId)+'.coverage.json','utf8'));}catch(e){if(e.code==='ENOENT')return {capturingSince:this.now()};throw e;} }
  async compact() {
    await fs.mkdir(this.directory,{recursive:true,mode:0o700});
    for(const name of await fs.readdir(this.directory)) {
      if(!/^[a-f0-9]{64}\.jsonl$/.test(name))continue;
      const file=path.join(this.directory,name);
      const work=(this.queues.get(file)||Promise.resolve()).catch(()=>{}).then(async()=>{
        const records=new Map();
        for(const line of (await fs.readFile(file,'utf8')).split('\n')) {
          let item;try{item=JSON.parse(line);}catch{continue;}
          if(Number.isSafeInteger(item.chatId) && Number.isSafeInteger(item.messageId) && item.date>=this.now()-retentionMs && this.file(item.chatId)===file)records.set(item.messageId,mergeConversationItem(records.get(item.messageId),item));
        }
        if(!records.size){await fs.rm(file,{force:true});return;}
        const temp=file+'.'+randomUUID()+'.tmp';
        await fs.writeFile(temp,[...records.values()].map(JSON.stringify).join('\n')+'\n',{mode:0o600});await fs.rename(temp,file);
      });
      this.queues.set(file,work);
      try{await work;}finally{if(this.queues.get(file)===work)this.queues.delete(file);}
    }
    const tickets=path.join(this.directory,'tickets');
    for(const name of await fs.readdir(tickets).catch(e=>{if(e.code==='ENOENT')return [];throw e;})) {
      if(!/^[a-f0-9-]{36}\.json$/.test(name))continue;
      const file=path.join(tickets,name);let t;try{t=JSON.parse(await fs.readFile(file,'utf8'));}catch{continue;}
      if(t.expiresAt<this.now())await fs.rm(file,{force:true});
    }
  }
  async ticket({chatId,threadId=null,isForum,messageId,date,timeZone='Europe/Kyiv'}) {
    if (!Number.isSafeInteger(chatId) || !Number.isSafeInteger(messageId) || !Number.isFinite(date)) throw new Error('Invalid context scope');
    threadId=isForum===false?null:positiveId(threadId);
    const directory=path.join(this.directory,'tickets');await fs.mkdir(directory,{recursive:true,mode:0o700});
    const file=path.join(directory,randomUUID()+'.json');
    await fs.writeFile(file,JSON.stringify({version:1,directory:this.directory,chatId,threadId,isForum,messageId,date,timeZone,expiresAt:this.now()+10*60*1000}),{mode:0o600});
    return {file,cleanup:()=>fs.rm(file,{force:true})};
  }
}

export function scopedItems(items,scope) {
  const expected=scope.isForum===false?null:positiveId(scope.threadId);
  return items.filter(i=>{
    if(i.chatId!==scope.chatId || i.messageId>=scope.messageId || i.date>scope.date)return false;
    if(scope.isForum===false)return i.isForum!==true;
    if(scope.isForum===true && i.isForum===false)return false;
    const actual=i.isForum===false?null:positiveId(i.messageThreadId);
    return actual===expected;
  });
}
export function replyChain(items,startId,maxDepth=12) {
  const byId=new Map(items.map(i=>[i.messageId,i])),chain=[],seen=new Set();let id=startId;
  while(id && !seen.has(id) && chain.length<maxDepth){seen.add(id);const item=byId.get(id);if(!item)break;chain.push(item);id=item.replyToMessageId;}
  return chain.reverse();
}
