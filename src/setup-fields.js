import { normalizeGamePlayers } from './assemble.js';
import { escapeRegex } from './helpers.js';

const strings = { gameName:80, commandName:80, caption:2000, announcement:2000, packTitle:64, packName:80, emoji:32, target:80, groupName:256, groupLabel:80, messageText:2000 };
const arrays = { aliases:80, phrases:1024 };
const plain = text => String(text ?? '').trim().replace(/^[«“"']|[»”"']$/gu,'');
const contains = (text,value) => {
  const literal=value.normalize('NFKC'),left=/^[\p{L}\p{N}_@]/u.test(literal)?'(?<![\\p{L}\\p{N}_@])':'',right=/[\p{L}\p{N}_]$/u.test(literal)?'(?![\\p{L}\\p{N}_])':'';
  return new RegExp(left+escapeRegex(literal)+right,'iu').test(text.normalize('NFKC'));
};
export const featureFieldNames = [...Object.keys(strings),...Object.keys(arrays),'players','addPlayers','removePlayers','operatorIds','skipAnimation','skipCaption','skipPhrases','skipAliases','skipAnnouncement','stickerMode','action','access','match','field'];

// The model proposes fields. Literal values must be present in this turn;
// identifiers and permissions are resolved separately from this bounded result.
export function groundedFeatureFields(fields, text) {
  const result = {};
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return result;
  for (const [key,limit] of Object.entries(strings)) {
    const value = fields[key];
    if (typeof value === 'string' && value.trim() && value.length <= limit && contains(text,value)) result[key] = value.trim();
  }
  for (const [key,limit] of Object.entries(arrays)) {
    if (Array.isArray(fields[key]) && fields[key].length && fields[key].length <= 16 && fields[key].every(value => typeof value === 'string' && value.trim() && value.length <= limit && contains(text,value))) result[key] = [...new Set(fields[key].map(x=>x.trim()))];
  }
  for (const key of ['players','addPlayers','removePlayers']) {
    const values = fields[key];
    if (!Array.isArray(values) || values.length > 100 || !values.length) continue;
    if (values.every(value => typeof value === 'string' && /^@?[A-Za-z0-9_]{5,32}$/u.test(value) && new RegExp(`(?<![A-Za-z0-9_@])@${value.replace(/^@/u,'')}(?![A-Za-z0-9_])`,'iu').test(text))) {
      try { result[key] = normalizeGamePlayers(values,key); } catch { /* Ask for a valid username rather than inventing one. */ }
    }
  }
  if (Array.isArray(fields.operatorIds) && fields.operatorIds.length <= 50 && fields.operatorIds.every(id=>Number.isSafeInteger(id)&&id>0&&new RegExp(`(?<!\\d)${id}(?!\\d)`,'u').test(text))) result.operatorIds=fields.operatorIds;
  for (const key of ['skipAnimation','skipCaption','skipPhrases','skipAliases','skipAnnouncement']) if (fields[key] === true) result[key]=true;
  for (const [key,values] of Object.entries({ stickerMode:['new','existing'],action:['judge','assemble','animation','message','persona'], access:['owner','members'], match:['exact','contains'], field:[...Object.keys(strings),...Object.keys(arrays),'players','operatorIds','animation','firstSticker','stickerMode','access','match'] })) if(values.includes(fields[key]))result[key]=fields[key];
  return result;
}

export function literalFieldAnswer(field, text) {
  const value = plain(text);
  if (!value || value.startsWith('/') || value.length > 2000) return {};
  if(/^(?:skip|none|no|пропусти(?:ть)?|нет|без анимации|без подписи|без фраз|пропустити|ні)$/iu.test(value)) {
    const optional={animation:'skipAnimation',caption:'skipCaption',phrases:'skipPhrases',aliases:'skipAliases',announcement:'skipAnnouncement'};
    if(optional[field])return {[optional[field]]:true};
  }
  if (field === 'players') {
    const names = text.match(/@[A-Za-z0-9_]{5,32}\b/gu);
    return names ? {players:normalizeGamePlayers(names,'draft')} : {};
  }
  if (field === 'operatorIds') return /^\d+(?:[\s,]+\d+)*$/u.test(value) ? {operatorIds:value.split(/[\s,]+/u).map(Number).filter(x=>Number.isSafeInteger(x)&&x>0)} : {};
  if (field === 'phrases' || field === 'aliases') {
    const phrases = value.split(/[,\n]/u).map(plain).filter(Boolean);
    return phrases.length && phrases.length <= 16 && phrases.every(x=>x.length<=(arrays[field])) ? {[field]:phrases} : {};
  }
  if (strings[field] && value.length <= strings[field]) return {[field]:value};
  return {};
}

export function mergeFeatureFields(draft, fields) {
  const next = structuredClone(draft);
  for (const [key,value] of Object.entries(fields)) {
    if (['groupName','addPlayers','removePlayers','skipAnimation','skipCaption','skipPhrases','skipAliases','skipAnnouncement','field'].includes(key)) continue;
    next[key] = value;
  }
  if (fields.addPlayers) next.players=[...new Set([...(next.players??[]),...fields.addPlayers])];
  if (fields.removePlayers) {
    const removed=new Set(fields.removePlayers.map(x=>x.toLowerCase()));
    next.players=(next.players??[]).filter(x=>!removed.has(x.toLowerCase()));
  }
  if(fields.skipAnimation){next.animation=null;delete next.animationPath;delete next.previewMedia;}
  if(fields.skipCaption)next.caption='';
  if(fields.skipPhrases)next.phrases=[];
  if(fields.skipAliases)next.aliases=[];
  if(fields.skipAnnouncement)next.announcement='';
  if(fields.packName)next.stickerMode='existing';
  if(fields.field)next.requestedField=fields.field;
  next.previewed=false;
  delete next.mediaError;
  return next;
}
