import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openSetupStore } from '../src/setup-store.js';
import { assignGroupProfile } from '../src/setup-profiles.js';
import { createSetup } from '../src/setup.js';
import { groundedFeatureFields } from '../src/setup-fields.js';
import { availableRuleAction, gatheringChunks } from '../src/group-commands.js';
import { matchMessageRule, validateMessageRules } from '../src/message-rules.js';
import { featureIntroduction, featureTest } from '../src/setup-feature-copy.js';

const bot={id:77,username:'ConversationFixtureBot'};
async function fixture(t){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'feature-conversation-')),file=path.join(dir,'setup.sqlite');
  let store=await openSetupStore('101',file),setup,turn={intent:'conversation'},failAI=false,admin=true,mediaFails=false,createUncertain=false,lookupFailures=0;
  const calls=[],sets=new Map();
  const telegram=async(method,payload)=>{
    calls.push({method,payload});
    if(method==='getChatMember')return {status:admin?'administrator':'member',can_restrict_members:admin};
    if(method==='getChatAdministrators')return [{user:{id:101,first_name:'Owner'}}];
    if(method==='getStickerSet'){if(lookupFailures-->0)throw new Error('network disconnected');if(!sets.has(payload.name))throw new Error('STICKERSET_INVALID');return sets.get(payload.name);}
    if(method==='createNewStickerSet'){
      sets.set(payload.name,{name:payload.name,title:payload.title,sticker_type:'regular',stickers:[{file_unique_id:'prepared-unique'}]});
      if(createUncertain){createUncertain=false;throw new Error('network result unknown');}return true;
    }
    if(method==='sendAnimation'&&mediaFails)throw new Error('fixture invalid media');
    return {message_id:calls.length+100};
  };
  const make=()=>createSetup({store,telegram,games:[],featureMode:(id,key)=>key==='minigames'?'unavailable':store.group(id)?.modes?.[key],
    checkFeature:async feature=>{calls.push({method:'diagnosticSnapshot',payload:{feature}});return feature==='status'?{checks:[{name:'ffmpeg',ok:true},{name:'whisper_python',ok:false}]}:{ok:false};},
    classifyTurn:async()=>{if(failAI)throw new Error('AI unavailable');return JSON.stringify(turn);},
    prepareAnimation:async(message)=>{if(mediaFails)throw new Error('conversion failed');return {fileId:message.animation?.file_id??'converted-animation'};},
    prepareSticker:async()=>({fileId:'prepared-sticker',uniqueId:'prepared-unique'})});
  store.bind(bot.id);store.change(s=>{
    s.defaultProfile='base';s.locale='en';s.profiles.base={name:'Marina',personality:'Calm',language:'en',locale:'en'};
    for(const [id,title]of [['-300','Alpha'],['-400','Beta']]){s.groups[id]={title,active:true};assignGroupProfile(s,id,'base','seed');}
  });setup=make();
  t.after(async()=>{store.close();await fs.rm(dir,{recursive:true,force:true});});
  const dm=(text,extra={})=>setup.handle({message_id:10,chat:{id:101,type:'private'},from:{id:101},text,...extra},bot);
  const panel=()=>calls.filter(x=>x.payload.reply_markup).at(-1)?.payload;
  const click=async(label,saved=panel(),from=101)=>{
    const key=saved?.reply_markup.inline_keyboard.flat().find(x=>x.text===label)||saved?.reply_markup.inline_keyboard.flat().find(x=>x.text.includes(label));
    assert.ok(key,'Missing '+label+' in '+JSON.stringify(saved?.reply_markup));
    return setup.handleCallback({id:'cb',data:key.callback_data,from:{id:from},message:{message_id:999,chat:{id:101,type:'private'}}},bot);
  };
  const open=async(feature)=>{await dm('/setup');await click('My groups');await click('Alpha');await click(feature);};
  return {get store(){return store;},get setup(){return setup;},calls,sets,dm,click,panel,open,
    answer:async(text,fields,intent='answer')=>{turn={intent,fields};return dm(text);},
    setTurn:value=>{turn=value;},setAdmin:value=>{admin=value;},setFailAI:value=>{failAI=value;},setMediaFail:value=>{mediaFails=value;},setUncertain:value=>{createUncertain=value;},setLookupFailures:value=>{lookupFailures=value;},
    restart:async()=>{store.close();store=await openSetupStore('101',file);setup=make();}};
}

async function completeGathering(f,phrases=true){
  await f.open('Game calls');await f.click('Add or configure');
  await f.answer('Minecraft @player_one @player_two, caption Build together',{gameName:'Minecraft',players:['player_one','player_two'],caption:'Build together'});
  await f.dm(undefined,{animation:{file_id:'native-gif'},via_bot:{id:555}});
  assert.match(f.panel().text,/What should we call the command/);
  await f.answer('Builders',{commandName:'Builders'});
  if(phrases){await f.answer('go build, server time',{phrases:['go build','server time']});await f.click('Group members');await f.click('Whole message');}
  else await f.click('No phrases for now');
}

test('flat named-group overview shows all14 direct states without service IDs or game presets',async t=>{
  const f=await fixture(t);await f.dm('/setup');await f.click('My groups');await f.click('Alpha');
  const buttons=f.panel().reply_markup.inline_keyboard.flat();
  assert.equal(buttons.filter(x=>/ · /.test(x.text)).length,14);
  assert.ok(buttons.some(x=>/Game calls · set up first/.test(x.text)));
  assert.ok(buttons.some(x=>/Mini Apps · needs connection/.test(x.text)));
  assert.doesNotMatch(f.panel().text,/-300|Choose a section|Fortnite/);
  await f.click('Game calls');assert.doesNotMatch(f.panel().text,/Fortnite|Rocket League/);
});

test('multi-field game, real private preview, explicit name and inline phrases save one canonical record',async t=>{
  const f=await fixture(t);await completeGathering(f);
  assert.equal(f.store.group('-300').assemble,undefined,'preview does not commit');
  assert.match(f.panel().text,/Builders[\s\S]*Minecraft[\s\S]*player_two[\s\S]*Build together[\s\S]*whole message[\s\S]*Group members/);
  assert.ok(f.calls.some(x=>x.method==='sendAnimation'&&x.payload.chat_id===101&&x.payload.caption?.includes('Build together')));
  assert.ok(f.calls.every(x=>!['sendMessage','sendAnimation'].includes(x.method)||x.payload.chat_id===101),'no group side effects');
  const saved=f.panel();await f.click('Save',saved,202);assert.equal(f.store.group('-300').assemble,undefined);
  await f.click('Save',saved);
  const game=f.store.group('-300').assemble.games[0],rule=f.store.group('-300').rules[0];
  assert.equal(game.commandName,'Builders');assert.equal(game.animationReference,'native-gif');assert.equal(game.caption,'Build together');
  assert.equal(rule.action.game,game.id);assert.equal(rule.originCommand,game.id);assert.deepEqual(rule.phrases,['go build','server time']);
  assert.equal(f.store.group('-400').assemble,undefined);assert.match(f.panel().text,/Is everything right/);
  await f.answer('add @player_three',{addPlayers:['player_three']},'setup');await f.click('Save');
  const updated=f.store.group('-300').assemble.games[0];assert.equal(updated.id,game.id);assert.equal(updated.animationReference,'native-gif');
  assert.equal(f.store.group('-300').rules.length,1);assert.equal(f.store.group('-300').rules[0].id,rule.id);
  assert.deepEqual(updated.players,['player_one','player_two','player_three']);
  await f.answer('Rename command to Crew',{commandName:'Crew'},'setup');await f.click('Save');
  assert.equal(f.store.group('-300').rules[0].action.game,game.id);
  await f.dm('done');assert.match(f.panel().text,/Settings for/);
});

test('help retains the draft, returns real context, and paused confirmations cannot save',async t=>{
  const f=await fixture(t);await completeGathering(f,false);const old=f.panel();
  f.setTurn({intent:'conversation',fields:{commandName:'Invented'}});
  const message={message_id:11,chat:{id:101,type:'private'},from:{id:101},text:'Why do you need this?'};
  assert.equal(await f.setup.handle(message,bot),false);assert.match(message._setupConversationContext,/Minecraft|Save these settings/);
  assert.equal(f.store.state.session.commandName,'Builders');assert.equal(f.store.state.session.paused,true);
  await f.click('Save',old);assert.equal(f.store.group('-300').assemble,undefined,'old callback rejected');
  await f.dm('save');assert.equal(f.store.group('-300').assemble,undefined,'first typed save refreshes paused preview');
  await f.dm('save');assert.equal(f.store.group('-300').assemble.games[0].commandName,'Builders');
});

test('All features guards unsaved changes; restart preserves draft and rights recovery',async t=>{
  const f=await fixture(t);await f.open('Game calls');await f.click('Add or configure');
  await f.answer('Minecraft',{gameName:'Minecraft'});await f.click('All features');
  assert.match(f.panel().text,/unsaved changes/);assert.equal(f.store.group('-300').assemble,undefined);
  await f.click('Continue editing');await f.restart();await f.dm('/setup');assert.equal(f.store.state.session.gameName,'Minecraft');
  f.setAdmin(false);await f.answer('@player_one',{players:['player_one']});assert.equal(f.store.state.session.gameName,'Minecraft');
  assert.match(f.panel().text,/administrator/);f.setAdmin(true);await f.click('Check rights');assert.equal(f.store.state.session.kind,'feature');
  await f.click('All features');await f.click('Discard changes');assert.equal(f.store.state.session.kind,'menu');assert.equal(f.store.group('-300').assemble,undefined);
});

test('AI failures offer a deliberate field fallback and never consume questions as values',async t=>{
  const f=await fixture(t);await f.open('Game calls');await f.click('Add or configure');f.setFailAI(true);
  await f.dm('Minecraft @player_one');assert.equal(f.store.state.session.gameName,undefined);assert.match(f.panel().text,/draft is safe/);
  await f.click('Continue step by step');await f.dm('Minecraft');await f.dm('@player_one');await f.click('No GIF');await f.dm('Time to build');await f.dm('Builders');await f.click('No phrases for now');
  await f.click('Save');assert.equal(f.store.group('-300').assemble.games[0].name,'Minecraft');
});

test('status refresh is read-only and distinguishes available tools from real feature verification',async t=>{
  const f=await fixture(t),before=structuredClone(f.store.state.groups);await f.open('Status');assert.match(f.panel().text,/Media preparation — available/);assert.match(f.panel().text,/Voice processing tool — not found/);assert.match(f.panel().text,/AI login, speech models/);
  assert.ok(!f.panel().reply_markup.inline_keyboard.flat().some(x=>['Enable','Disable'].includes(x.text)));await f.click('Refresh');
  assert.equal(f.calls.filter(x=>x.method==='diagnosticSnapshot').length,2);assert.deepEqual(f.store.state.groups,before);
});

test('questions in explicit field fallback retain values rather than becoming a game name',async t=>{
  const f=await fixture(t);await f.open('Game calls');await f.click('Add or configure');f.setFailAI(true);await f.dm('Minecraft');await f.click('Continue step by step');await f.dm('How does this work?');
  assert.equal(f.store.state.session.gameName,undefined);assert.match(f.panel().text,/AI explanations are unavailable/);await f.dm('Minecraft');assert.equal(f.store.state.session.gameName,'Minecraft');
});

test('recovered AI restores normal preview controls and fallback prompts request one field',async t=>{
  const f=await fixture(t);await f.open('Game calls');await f.click('Add or configure');f.setFailAI(true);await f.dm('Minecraft');assert.match(f.panel().text,/Send only that name/);
  f.setFailAI(false);await f.answer('Minecraft @player_one command Crew, no GIF, no caption, no phrases',{gameName:'Minecraft',players:['player_one'],commandName:'Crew',skipAnimation:true,skipCaption:true,skipPhrases:true});
  assert.equal(f.store.state.session.aiUnavailable,false);await f.click('Save');assert.equal(f.store.group('-300').assemble.games[0].commandName,'Crew');
});

test('invalid or forwarded media never saves a video ID as animation and retains other fields',async t=>{
  const f=await fixture(t);await f.open('Game calls');await f.click('Add or configure');
  await f.answer('Minecraft @player_one',{gameName:'Minecraft',players:['player_one']});
  assert.equal(await f.dm(undefined,{video:{file_id:'forwarded'},forward_origin:{type:'user'}}),false);assert.equal(f.store.state.session.animation,undefined);
  f.setMediaFail(true);await f.dm(undefined,{video:{file_id:'document-or-video'},via_bot:{id:555}});
  assert.equal(f.store.state.session.animation,undefined);assert.equal(f.store.state.session.gameName,'Minecraft');assert.match(f.panel().text,/20 MB/);
  f.setMediaFail(false);await f.dm(undefined,{document:{file_id:'gif-document',mime_type:'image/gif'}});assert.equal(f.store.state.session.animation,'converted-animation');
});

test('phrase actions support alternatives and word boundaries; dependency disables and deletion block execution',async t=>{
  const f=await fixture(t);await completeGathering(f);await f.click('Save');const game=f.store.group('-300').assemble.games[0],rule=f.store.group('-300').rules[0];
  const incoming={chat:{id:-300,type:'supergroup'},from:{id:202},message_id:20,date:Math.ceil(Date.now()/1000)};
  assert.equal(matchMessageRule([rule],{...incoming,text:'go build'})?.id,rule.id);
  assert.equal(matchMessageRule([rule],{...incoming,text:'please go build'}),null);
  const contains={...rule,match:'contains'};assert.equal(matchMessageRule([contains],{...incoming,text:'please go build tonight'})?.id,rule.id);
  assert.equal(matchMessageRule([contains],{...incoming,text:'go builders'}),null);
  for(const extra of [{via_bot:{id:5}},{forward_origin:{type:'user'}},{text:'"go build"'},{entities:[{type:'code',offset:0,length:2}]},{from:{id:202,is_bot:true}}])assert.equal(matchMessageRule([contains],{...incoming,text:'go build',...extra}),null);
  assert.equal(availableRuleAction(f.store.group('-300'),rule),true);
  await f.click('Disable gathering');assert.equal(availableRuleAction(f.store.group('-300'),rule),false);await f.click('Enable gathering');
  await f.click('Delete gathering');await f.click('Delete');assert.equal(f.store.group('-300').assemble.games.length,0);assert.equal(availableRuleAction(f.store.group('-300'),rule),false);
  assert.equal(f.store.group('-300').rules[0].action.game,game.id,'orphan is retained inactive rather than rebound');
});

test('creating a gathering from a phrase dependency returns to the original rule draft',async t=>{
  const f=await fixture(t);await f.open('Phrase actions');await f.click('Add or configure');
  await f.answer('When I say build, run a gathering',{phrases:['build'],action:'assemble',access:'members',skipCaption:true});
  await f.click('Create gathering');await f.answer('Minecraft @player_one command Crew',{gameName:'Minecraft',commandName:'Crew',players:['player_one'],skipAnimation:true,skipCaption:true,skipPhrases:true});await f.click('Save');
  assert.equal(f.store.state.session.feature,'reaction');assert.equal(f.store.state.session.targetId,f.store.group('-300').assemble.games[0].id);
  await f.click('Whole message');await f.click('No announcement');await f.click('Save');assert.equal(f.store.group('-300').rules[0].phrase,'build');
});

test('new sticker pack creates only after explicit preview and recovers uncertain creation without duplicates',async t=>{
  const f=await fixture(t);await f.open('Sticker pack');await f.click('Add or configure');await f.click('Create new');
  await f.answer('Friends stickers',{packTitle:'Friends stickers'});await f.dm(undefined,{photo:[{file_id:'photo'}]});await f.click('🎮');
  assert.equal(f.calls.filter(x=>x.method==='createNewStickerSet').length,0);f.setUncertain(true);await f.click('Create and connect');
  assert.equal(f.calls.filter(x=>x.method==='createNewStickerSet').length,1);assert.equal(f.store.group('-300').sticker.ownerId,101);
  assert.match(f.store.group('-300').sticker.packName,/_by_ConversationFixtureBot$/);assert.ok(f.store.group('-300').sticker.packName.length<=64);
  assert.match(f.panel().reply_markup.inline_keyboard.flat().find(x=>x.url)?.url,/addstickers/);
  await f.restart();assert.equal(f.calls.filter(x=>x.method==='createNewStickerSet').length,1);
});

test('grounding rejects invented literals, malformed usernames, regex input and IDs',()=>{
  assert.deepEqual(groundedFeatureFields({gameName:'Invented',players:['.*'],operatorIds:[909]},'Minecraft @player_one'),{});
  assert.deepEqual(groundedFeatureFields({caption:'',phrases:[],aliases:[]},'add @player_one'),{});
  assert.deepEqual(groundedFeatureFields({commandName:'Fort',target:'Ann',players:['player_one']},'Fortnite, Joanne, mail@player_one'),{});
  assert.deepEqual(groundedFeatureFields({gameName:'Minecraft',players:['player_one'],commandName:'Crew'},'Minecraft @player_one command Crew'),{gameName:'Minecraft',players:['player_one'],commandName:'Crew'});
  assert.throws(()=>validateMessageRules([{id:'bad',phrase:'go',access:'members',action:{type:'assemble',game:'../../file'}}]));
});

test('a profile notification and restart retain the unrelated unsaved group draft',async t=>{
  const f=await fixture(t);await f.open('Game calls');await f.click('Add or configure');await f.answer('Minecraft',{gameName:'Minecraft'});
  await f.setup.observe({my_chat_member:{chat:{id:-500,type:'supergroup',title:'Gamma'},old_chat_member:{status:'left'},new_chat_member:{status:'administrator'}}},bot);
  await f.click('Use Marina');assert.equal(f.store.group('-500').configured,true);assert.equal(f.store.state.session.resume.kind,'feature');
  await f.restart();await f.dm('/setup');assert.equal(f.store.state.session.group,'-300');assert.equal(f.store.state.session.gameName,'Minecraft');assert.match(f.panel().text,/Who should I mention/);
});

test('sticker enabling cannot activate a pack already connected in another group',async t=>{
  const f=await fixture(t);f.store.change(s=>{for(const g of Object.values(s.groups))g.sticker={packName:'same_by_ConversationFixtureBot',ownerId:101};s.groups['-300'].disabled={sticker:true};});
  await f.open('Sticker pack');await f.click('Enable');assert.equal(f.store.group('-300').disabled.sticker,true);assert.match(f.panel().text,/another active group/);
});

test('uncertain sticker readback survives restart and never creates a second pack',async t=>{
  const f=await fixture(t);await f.open('Sticker pack');await f.click('Add or configure');await f.click('Create new');await f.answer('Friends',{packTitle:'Friends'});await f.dm(undefined,{photo:[{file_id:'photo'}]});await f.click('🎮');
  f.setUncertain(true);f.setLookupFailures(1);await f.click('Create and connect');assert.equal(f.store.group('-300').sticker,undefined);assert.equal(f.calls.filter(x=>x.method==='createNewStickerSet').length,1);
  await f.restart();await f.click('Create and connect');assert.ok(f.store.group('-300').sticker);assert.equal(f.calls.filter(x=>x.method==='createNewStickerSet').length,1);
});

test('editing a disabled rule preserves its identity, parent disable and actor restrictions',async t=>{
  const f=await fixture(t);f.store.change(s=>{s.groups['-300'].rules=[{id:'owner-rule',phrase:'quiet',access:'owner',action:{type:'persona',profile:'base'},enabled:false}];s.groups['-300'].disabled={reaction:true};});
  await f.open('Phrase actions');await f.click('quiet');await f.click('Edit');await f.answer('When I say awake, use Marina',{phrases:['awake'],action:'persona',target:'Marina',access:'members'});await f.click('Save');
  const rule=f.store.group('-300').rules[0];assert.equal(rule.id,'owner-rule');assert.equal(rule.enabled,false);assert.equal(rule.access,'owner');assert.equal(f.store.group('-300').disabled.reaction,true);assert.equal(rule.phrase,'awake');
});

test('unknown group asks a concrete choice, retaining supplied fields without changing the current group',async t=>{
  const f=await fixture(t);await f.open('Game calls');
  await f.answer('Configure Minecraft @player_one in Unknown, command Crew, no GIF, no caption, no phrases',{groupName:'Unknown',gameName:'Minecraft',commandName:'Crew',players:['player_one'],skipAnimation:true,skipCaption:true,skipPhrases:true},'setup');
  assert.match(f.panel().text,/Which group/);assert.equal(f.store.group('-300').assemble,undefined);
  await f.click('Beta');assert.equal(f.store.state.session.group,'-400');assert.equal(f.store.state.session.gameName,'Minecraft');await f.click('Save');
  assert.equal(f.store.group('-300').assemble,undefined);assert.equal(f.store.group('-400').assemble.games[0].commandName,'Crew');
});

test('a game name matching another group title does not change the selected group',async t=>{
  const f=await fixture(t);f.store.change(s=>{s.groups['-400'].title='Minecraft';});await f.open('Game calls');await f.click('Add or configure');
  await f.answer('Minecraft @player_one',{gameName:'Minecraft',players:['player_one']});assert.equal(f.store.state.session.group,'-300');assert.equal(f.store.state.session.gameName,'Minecraft');
});

test('stale group choices cannot replace a newer feature draft or reuse another request',async t=>{
  const f=await fixture(t);await f.dm('/setup');await f.click('My groups');await f.click('Alpha');const overview=f.panel();
  await f.answer('Configure game calls for Minecraft in Gamma',{groupName:'Gamma',gameName:'Minecraft'},'setup');const oldChoice=f.panel();
  await f.click('Game calls',overview);await f.click('Add or configure');await f.answer('Terraria',{gameName:'Terraria'});
  const draft=structuredClone(f.store.state.session);await f.click('Beta',oldChoice);assert.deepEqual(f.store.state.session,draft);assert.match(f.calls.at(-1).payload.text,/expired/);assert.equal(f.store.group('-400').assemble,undefined);
});

test('old rights-recovery controls cannot act on a different active draft',async t=>{
  const f=await fixture(t);await f.open('Game calls');await f.click('Add or configure');f.setAdmin(false);await f.answer('Minecraft',{gameName:'Minecraft'});const oldRights=f.panel();
  f.setAdmin(true);await f.dm('/cancel');await f.answer('Configure game calls in Beta for Terraria',{groupName:'Beta',gameName:'Terraria'},'setup');const draft=structuredClone(f.store.state.session);
  await f.click('Check rights',oldRights);assert.deepEqual(f.store.state.session,draft);assert.match(f.calls.at(-1).payload.text,/expired/);assert.equal(draft.group,'-400');
});

test('all feature introductions and test instructions exist in EN/RU/UK and previews respect caption limits',()=>{
  const features=['chat','search','judge','history','memory','voice','analysis','download','assemble','minigames','reaction','sticker','moderation','status'];
  for(const l of ['en','ru','uk'])for(const feature of features){assert.ok(featureIntroduction(feature,l).length>30);assert.ok(featureTest(feature,l,{group:'Friends',botName:'Marina'}).includes('Friends'));}
  const game={name:'😀'.repeat(40),caption:'x'.repeat(2000),players:['player_one','player_two']};
  const chunks=gatheringChunks(game);assert.ok(chunks.every(c=>c.text.length<=950));
  assert.equal(chunks.map(c=>c.text).join('').includes(game.caption),true);
});
