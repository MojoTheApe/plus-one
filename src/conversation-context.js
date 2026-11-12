import { replyChain, scopedItems } from './conversation-store.js';
import { deliveryDecision, deliveryContract } from './dialogue-actions.js';
export function localParts(date,timeZone){return Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(new Date(date)).filter(p=>p.type!=='literal').map(p=>[p.type,p.value]));}
export function localTime(date,timeZone){const p=localParts(date,timeZone);return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;}
export function localEpoch(day,clock,timeZone){const [y,m,d]=day.split('-').map(Number),[h,min]=clock.split(':').map(Number);if(h>23||min>59)throw Error('Invalid local time');const target=Date.UTC(y,m-1,d,h,min);let result=target;for(let n=0;n<4;n++){const p=localParts(result,timeZone);const observed=Date.UTC(+p.year,+p.month-1,+p.day,+p.hour,+p.minute,+p.second);result+=target-observed;}return result;}
export function historyIntent(question,{previousQuestion='',now=Date.now(),timeZone='Europe/Kyiv',maxMessages=300}={}){
  let q=String(question||'').trim();
  if(/^(?:а\s+)?(?:до цього|раніше|до этого|раньше|before that|earlier)[.!?\s]*$/iu.test(q))return {type:'before',count:maxMessages,description:'earlier messages before the previous history slice',followUp:true};
  const intent=/(?:summari[sz]|summary|recap|analy[sz]|review|chat history|conversation|last|past|переписк|підбий|підсум|підвед|подвед|итог|ітог|підсумок|ранков|утрен|повідомлен|сообщен|супереч|спор|дискус|історі|истори|останні|последн|скільки|count|mentions?)/iu.test(q);
  if(!intent)return null;
  const p=localParts(now,timeZone),day=`${p.year}-${p.month}-${p.day}`;
  const since=q.match(/(?:^|\s)(?:з|із|від|с|since|from)\s*(\d{1,2}):(\d{2})(?!\d)/iu);
  if(since){const clock=`${since[1].padStart(2,'0')}:${since[2]}`;return {type:'range',from:localEpoch(day,clock,timeZone),to:now,description:`${day} from ${clock} to ${localTime(now,timeZone)} (${timeZone})`};}
  if(/(?:ранков|утрен|morning)/iu.test(q))return {type:'range',from:localEpoch(day,'00:00',timeZone),to:Math.min(now,localEpoch(day,'12:00',timeZone)),description:`morning ${day} before 12:00 (${timeZone})`};
  if(/(?:сьогодні|сегодня|today)/iu.test(q))return {type:'range',from:localEpoch(day,'00:00',timeZone),to:now,description:`today ${day} (${timeZone})`};
  const hours=q.match(/(?:за\s+)?(?:останніх?|последни[ех]|last|past)\s+(\d{1,3})\s*(?:годин|час|hour)/iu);
  if(hours)return {type:'range',from:now-(+hours[1])*3600000,to:now,description:`last ${hours[1]} hours`};
  if(/(?:^|\s)(?:усі|всі|усе|все|all)(?:\s|$)/iu.test(q))return {type:'range',from:now-7*86400000,to:now,description:'all available history within seven-day retention'};
  const count=q.match(/(?:last|past|останніх?|последни[ех])\s+(\d{1,4})/iu);
  if(count)return {type:'messages',count:Math.min(maxMessages,Math.max(1,+count[1])),description:`last ${count[1]} messages`};
  return {type:'messages',count:Math.min(100,maxMessages),description:'recent chat history'};
}
export function selectContext(items,request,{beforeId=null}={}){
  if(request.type==='range')return items.filter(i=>i.date>=request.from&&i.date<=request.to);
  if(request.type==='before')return items.filter(i=>!beforeId||i.messageId<beforeId).slice(-request.count);
  return items.slice(-request.count);
}
export function historyPage(items,{cursor=0,limit=100,maxChars=24000}={}){
  const page=[];let used=0,index=Math.max(0,cursor);const cap=Math.min(150,Math.max(1,limit));
  for(;index<items.length&&page.length<cap;index++){const i={...items[index],text:items[index].text.slice(0,5000)};const len=JSON.stringify(i).length;if(page.length&&used+len>maxChars)break;page.push(i);used+=len;}
  return {items:page,total:items.length,nextCursor:index<items.length?index:null,truncatedMessages:page.filter(i=>i.text.length===5000).length};
}
export function responseDecision(raw,{mustReply=true,assemblyGames}={}){
  return deliveryDecision(raw,{mustReply,assemblyGames});
}
export function dialoguePolicy(options={}){return deliveryContract(options);}
export {replyChain,scopedItems};
