// Synthetic structured model answers for these integration-test transcripts.
// This does not evaluate a real language model; production owns validation/save.
export function featureTurnFixture(input) {
  if(!['feature','feature-menu'].includes(input.kind))return {};
  const text=input.message,fields={};
  const namedGroup=input.groups?.find(name=>['in '+name,'в '+name,'для '+name].some(phrase=>text.includes(phrase))||/^(?:configure|настрой|включи|выключи|расскажи про)/iu.test(text)&&text.includes(name));if(namedGroup)fields.groupName=namedGroup;
  if(/Fortnite/u.test(text))fields.gameName='Fortnite';
  const command=text.match(/(?:command|команда)\s+([A-Za-z]+)/iu)?.[1];if(command)fields.commandName=command;
  const players=text.match(/@[A-Za-z0-9_]{5,32}\b/gu);if(players)fields.players=players.map(x=>x.slice(1));
  if(/no animation|без анимации/iu.test(text))fields.skipAnimation=true;
  if(/no caption/iu.test(text))fields.skipCaption=true;
  if(/no phrases/iu.test(text))fields.skipPhrases=true;
  if(/whole message|целое сообщение/iu.test(text))fields.match='exact';
  if(/^(?:everyone|group members|members)$/iu.test(text))fields.access='members';
  if(/^(?:only owner|owner)$/iu.test(text))fields.access='owner';
  const pack=text.match(/https:\/\/t\.me\/addstickers\/([A-Za-z][A-Za-z0-9_]+)/u)?.[1];if(pack)fields.packName=pack;
  if(/^(?:animation|send GIF)$/iu.test(text))fields.action='animation';
  if(/^(?:judge|review dispute)$/iu.test(text))fields.action='judge';
  if(/^(?:call players)$/iu.test(text))fields.action='assemble';
  if(/^(?:change personality|сменить личность)/iu.test(text)){
    fields.action='persona';fields.access='owner';
    const target=input.profiles?.find(name=>text.includes(name));if(target)fields.target=target;
  }
  if(input.draft?.feature==='reaction'&&input.draft.action==='persona'&&input.profiles?.includes(text))fields.target=text;
  if(input.draft?.feature==='reaction'&&input.draft.action==='assemble'&&input.commands?.some(x=>x.name===text||x.commandName===text))fields.target=text;
  if(input.feature==='reaction'&&input.attachment?.animation&&text.includes(':')){
    fields.phrases=text.slice(text.indexOf(':')+1).split(',').map(x=>x.trim());fields.action='animation';fields.match='exact';fields.access='members';fields.skipAnnouncement=true;
  }
  const requested=/^(?:configure|настрой|включи|выключи|turn off|turn on)/iu.test(text);
  const feature=requested?/sticker|стикер/iu.test(text)?'sticker':/game calls|сбор/iu.test(text)?'assemble':/memory|память/iu.test(text)?'memory':/moderat|модерац/iu.test(text)?'moderation':/реакц|phrase actions/iu.test(text)?'reaction':undefined:undefined;
  return {fields,...(feature?{feature}:{})};
}
