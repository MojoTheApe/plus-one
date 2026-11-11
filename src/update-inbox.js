import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
export class UpdateInbox {
  constructor(file){this.file=file;this.queue=Promise.resolve();this.state=null;}
  async load(){if(this.state)return this.state;try{this.state=JSON.parse(await fs.readFile(this.file,'utf8'));if(this.state.version!==1||!Array.isArray(this.state.pending)||!Number.isSafeInteger(this.state.offset))throw Error('Invalid inbox');this.state.pending=this.state.pending.filter(u=>!u.message?.date || u.message.date*1000>=Date.now()-7*86400000);}catch(e){if(e.code!=='ENOENT')throw e;this.state={version:1,offset:0,pending:[]};}return this.state;}
  mutate(fn){const job=this.queue.catch(()=>{}).then(async()=>{const state=await this.load();const next=fn(structuredClone(state));await fs.mkdir(path.dirname(this.file),{recursive:true,mode:0o700});const temp=this.file+'.'+randomUUID()+'.tmp';await fs.writeFile(temp,JSON.stringify(next),{mode:0o600});await fs.rename(temp,this.file);this.state=next;return next;});this.queue=job;return job;}
  add(updates){return this.mutate(s=>{const ids=new Set(s.pending.map(u=>u.update_id));for(const u of updates){if(!ids.has(u.update_id)){s.pending.push(u);ids.add(u.update_id);}s.offset=Math.max(s.offset,u.update_id+1);}return s;});}
  done(id){return this.mutate(s=>({...s,pending:s.pending.filter(u=>u.update_id!==id)}));}
}
export class ChatQueue {
  constructor({concurrency=2,onError=()=>{}}={}){this.concurrency=concurrency;this.onError=onError;this.waiting=[];this.active=new Set();this.ids=new Set();this.idle=[];}
  add(id,key,work){if(this.ids.has(id))return;this.ids.add(id);this.waiting.push({id,key,work});this.pump();}
  pump(){while(this.active.size<this.concurrency){const i=this.waiting.findIndex(j=>!this.active.has(j.key));if(i<0)break;const job=this.waiting.splice(i,1)[0];this.active.add(job.key);Promise.resolve().then(job.work).catch(this.onError).finally(()=>{this.active.delete(job.key);this.ids.delete(job.id);this.pump();if(!this.ids.size)this.idle.splice(0).forEach(r=>r());});}}
  drain(){return this.ids.size?new Promise(r=>this.idle.push(r)):Promise.resolve();}
}

export function isPermanentUpdateError(error) { const status=Number(error?.status); return Number.isFinite(status) && status>=400 && status<500 && status!==429; }
