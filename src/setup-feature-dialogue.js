import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { featureName, matchFeature, modeFeatures, modeLabel, say } from './setup-copy.js';
import { featureIntroduction, featureTest, connectionHelp, installerRequest } from './setup-feature-copy.js';
import { groundedFeatureFields, literalFieldAnswer, mergeFeatureFields } from './setup-fields.js';
import { commandTitle, commandNames, normalizedName, validateGroupCommand, gatheringChunks, availableRuleAction } from './group-commands.js';
import { validateMessageRules, ruleRequest, normalizePhrase } from './message-rules.js';
import { stickerMedia } from './stickers.js';
import { setupAnimation } from './setup-media.js';
import { stickerConflict, releaseInactiveStickerBindings, profileTitle } from './setup-profiles.js';
import { escapeTelegramMarkdown as literal } from './telegram-format.js';

const saveText = /^(?:save|confirm|apply|yes|yes, save|да|да, сохрани|да, включай|сохрани(?:ть)?|сохраняй|подтверждаю|так|збережи|зберегти)[.!]*$/iu;
const doneText = /^(?:done|all done|готово|всё готово|все готово|всё хорошо|все хорошо|завершено)[.!]*$/iu;
const cancelText = /^(?:\/cancel|cancel|отмена|отмени|скасуй|скасувати)[.!]*$/iu;
const newRequest = /созда|добав|настро|измени|включ|выключ|create|add|configure|change|enable|disable|створи|додай|налашту|зміни|увімк|вимк/iu;
const fieldTitles = {gameName:['game','игра','гра'],commandName:['command name','название команды','назва команди'],players:['players','участники','учасники'],caption:['caption','подпись','підпис'],animation:['GIF','GIF','GIF'],phrases:['phrases','фразы','фрази'],aliases:['other game names','другие названия игры','інші назви гри'],access:['who may use it','кто может запускать','хто може запускати'],match:['matching condition','условие совпадения','умова збігу'],action:['action','действие','дія'],target:['target','команда или профиль','команда чи профіль'],announcement:['announcement','объявление','оголошення'],messageText:['message text','текст сообщения','текст повідомлення'],firstSticker:['first image','первая картинка','перше зображення'],packTitle:['pack title','название пака','назва пака'],emoji:['emoji','эмодзи','емодзі']};
const button = (text, op, values={}) => ({text,action:{type:'f.'+op,...values}});
const brief = (locale,en,ru,uk) => say(locale,en,ru,uk);
const textValue = value => typeof value==='string' && value.trim();
const groupLabel = (group,id) => group.menuLabel || group.title || 'Unnamed group';

// A focused owner of the group conversation, using the existing setup document,
// session, authenticated controls and transport. Profiles stay in setup.js.
export function createFeatureDialogue({store,telegram,featureMode,classifyTurn,checkFeature,prepareAnimation,prepareSticker,previewGathering,connectedGames=()=>[],allowedGroup,resolveTarget,panel,setSession,keepDraft,overview}) {
  const locale = () => store.state.locale;
  const group = id => store.group(id);
  const heading = (id,feature) => `**${literal(groupLabel(group(id),id))} · ${featureName(feature,locale())}**`;
  const permitted = async (id,bot) => allowedGroup(id,bot,true);
  const back = () => button(brief(locale(),'All features','К функциям','До функцій'),'home');
  const cancel = () => button(brief(locale(),'Cancel changes','Отменить изменения','Скасувати зміни'),'cancel');

  function mode(id,feature) {
    if(feature==='status')return 'available';
    const available=featureMode(id,feature),settings=group(id);
    if(available==='unavailable')return available;
    if(modeFeatures.includes(feature))return settings.modes?.[feature]??available??(feature==='memory'?'manual':'off');
    if(settings.disabled?.[feature])return 'off';
    if(feature==='reaction')return settings.rules?.some(rule=>availableRuleAction(settings,rule,store.state.profiles))||settings.reaction?'on':settings.rules?.length?'off':'setup';
    if(feature==='assemble')return settings.assemble?.games?.some(g=>g.enabled!==false&&g.players?.length)?'on':settings.assemble?.games?.length?'off':'setup';
    return settings[feature]?'on':'setup';
  }

  function nextField(draft) {
    if(draft.requestedField)return draft.requestedField;
    if(draft.editingPrompt)return 'correction';
    if(draft.feature==='label')return textValue(draft.groupLabel)?null:'groupLabel';
    if(draft.feature==='assemble') {
      if(!textValue(draft.gameName))return 'gameName';
      if(!draft.players?.length)return 'players';
      if(draft.animation===undefined)return 'animation';
      if(draft.caption===undefined)return 'caption';
      if(!textValue(draft.commandName))return 'commandName';
      if(draft.phrases===undefined)return 'phrases';
      if(draft.phrases.length&&!draft.access)return 'access';
      if(draft.phrases.length&&!draft.match)return 'match';
      return null;
    }
    if(draft.feature==='reaction') {
      if(!draft.phrases?.length)return 'phrases';
      if(!draft.action)return 'action';
      if(['assemble','persona'].includes(draft.action)&&!draft.targetId)return 'target';
      if(draft.action==='animation'&&!draft.animation)return 'animation';
      if(draft.action==='message'&&!textValue(draft.messageText))return 'messageText';
      if(!draft.access)return 'access';
      if(!draft.match)return 'match';
      if(draft.announcement===undefined)return 'announcement';
      return null;
    }
    if(draft.feature==='sticker') {
      if(!draft.stickerMode)return 'stickerMode';
      if(draft.stickerMode==='existing')return draft.packName?null:'packName';
      if(!textValue(draft.packTitle))return 'packTitle';
      if(!draft.firstSticker)return 'firstSticker';
      if(!textValue(draft.emoji))return 'emoji';
      return null;
    }
    if(draft.feature==='moderation')return draft.operatorIds?.length?null:'operatorIds';
    return null;
  }

  function question(draft) {
    const l=locale(),field=nextField(draft);
    if(draft.fieldFallback||draft.aiUnavailable){
      if(field==='gameName')return brief(l,'What is the game’s name? Send only that name for this step.','Как называется игра? На этом шаге пришли только название.','Як називається гра? На цьому кроці надішли лише назву.');
      if(field==='correction')return brief(l,'Choose the field to change, or write “show fields”. We will update one field at a time.','Выбери, что изменить, или напиши «покажи поля». Здесь меняем по одному пункту за раз.','Вибери, що змінити, або напиши «покажи поля». Тут змінюємо по одному пункту за раз.');
    }
    const prompts={
      gameName:['What game do you play? You can include players, caption and other details in the same message.','В какую игру собираетесь? Можно сразу написать участников, подпись и остальные пожелания.','У яку гру збираєтеся? Можна відразу написати учасників, підпис та інші побажання.'],
      players:['Who should I mention? Send @usernames, for example @player_one, @player_two.','Кого отметить? Пришли @имена, например @player_one, @player_two.','Кого згадати? Надішли @імена, наприклад @player_one, @player_two.'],
      animation:['Send the GIF here. Telegram GIFs, GIF files and eligible short videos work; a video preview will be silent. Or skip the animation.','Пришли GIF сюда: из Telegram, файлом или подходящим коротким видео. Видеопредпросмотр будет без звука. Можно оставить без GIF.','Надішли GIF сюди: з Telegram, файлом або придатним коротким відео. Попередній перегляд відео буде без звуку. Можна залишити без GIF.'],
      caption:['What should the gathering say? I add player mentions separately.','Что написать при сборе? Имена игроков добавлю отдельно.','Що написати під час збору? Імена гравців додам окремо.'],
      commandName:['What should we call the command? For example, Fortnite or Fort.','Как назовём команду? Например: Fortnite или Fort.','Як назвемо команду? Наприклад: Fortnite або Fort.'],
      phrases:draft.feature==='assemble'?['We can add phrases that launch this command in the group now. Send yours, or keep manual launch.','Можем сразу добавить фразы для запуска этой команды в группе. Напиши свои фразы или оставим запуск вручную.','Можемо відразу додати фрази для запуску цієї команди в групі. Напиши свої фрази або залишимо ручний запуск.']:['What words or phrases should trigger the action? You can describe the action in the same message.','На какие слова или фразы реагировать? Можно сразу описать, что делать.','На які слова чи фрази реагувати? Можна відразу описати, що робити.'],
      action:['What should happen: run a saved gathering, review a dispute, send a GIF/message, or change profile?','Что делать: запустить сохранённый сбор, разобрать спор, отправить GIF или сообщение, сменить профиль?','Що робити: запустити збережений збір, розібрати суперечку, надіслати GIF чи повідомлення, змінити профіль?'],
      target:['Which saved command or profile? Choose below or write its name.','Какую сохранённую команду или профиль использовать? Выбери ниже или напиши название.','Яку збережену команду чи профіль використати? Вибери нижче або напиши назву.'],
      access:['Who may use these phrases: only you, or group members?','Кто может запускать эти фразы: только ты или участники группы?','Хто може запускати ці фрази: лише ти чи учасники групи?'],
      announcement:['Add an extra announcement? Write the exact text, or skip it.','Добавить сообщение при выполнении? Напиши готовый текст или пропусти.','Додати повідомлення під час виконання? Напиши готовий текст або пропусти.'],
      messageText:['What message should I send? Write its exact text.','Какое сообщение отправлять? Напиши готовый текст.','Яке повідомлення надсилати? Напиши готовий текст.'],
      packTitle:['What should we call the sticker pack?','Как назовём стикерпак?','Як назвемо стікерпак?'],
      firstSticker:['Send the image for the first sticker: a photo, PNG, JPEG or WebP. I will show the prepared sticker.','Пришли картинку для первого стикера: фото, PNG, JPEG или WebP. Покажу подготовленный стикер.','Надішли зображення для першого стікера: фото, PNG, JPEG або WebP. Покажу підготовлений стікер.'],
      emoji:['Which emoji fits this sticker? Send one, or choose below.','Какой эмодзи подходит стикеру? Пришли один или выбери ниже.','Який емодзі пасує стікеру? Надішли один або вибери нижче.'],
      packName:['Send the existing sticker-pack link. I will check that I can edit it.','Пришли ссылку на существующий стикерпак. Проверю, могу ли я его менять.','Надішли посилання на наявний стікерпак. Перевірю, чи можу я його змінювати.'],
      stickerMode:['Create a new pack for this group, or connect one I can edit?','Создадим новый пак для этой группы или подключим тот, которым я могу управлять?','Створимо новий пак для цієї групи чи підключимо той, яким я можу керувати?'],
      operatorIds:['Choose the current administrators who may remove members, or send their numeric Telegram IDs.','Выбери действующих администраторов, которым разрешено удалять участников, или пришли их цифровые Telegram ID.','Вибери чинних адміністраторів, яким дозволено видаляти учасників, або надішли їхні цифрові Telegram ID.'],
      groupLabel:['Give this group a clear menu label, for example Friends — games. Its Telegram title stays unchanged.','Как подписать эту группу в меню? Например: Друзья — игры. Название в Telegram останется прежним.','Як підписати цю групу в меню? Наприклад: Друзі — ігри. Назва в Telegram залишиться попередньою.'],
      correction:['Tell me what to change. You can update several details at once or ask to show the fields.','Напиши, что поменять. Можно изменить несколько деталей сразу или попросить показать поля.','Напиши, що змінити. Можна змінити кілька деталей відразу або попросити показати поля.'],
      aliases:['What other names do you use for this game? Separate them with commas.','Как ещё вы называете эту игру? Перечисли названия через запятую.','Як іще ви називаєте цю гру? Перелічи назви через кому.'],
      match:['Should the phrase be the whole message, or may it occur inside a longer message?','Сообщение должно целиком совпадать с фразой или она может быть внутри сообщения?','Повідомлення має повністю збігатися з фразою чи вона може бути всередині повідомлення?'],
    };
    return field?brief(l,...(prompts[field]??prompts.correction)):preview(draft);
  }

  function actionLabel(draft) {
    const l=locale();
    if(draft.action==='assemble') {
      const command=group(draft.group).assemble?.games?.find(x=>x.id===draft.targetId);
      if(!command)return brief(l,draft.targetId?'Saved gathering unavailable':'Run a saved gathering',draft.targetId?'Сохранённый сбор недоступен':'Запустить сохранённый сбор',draft.targetId?'Збережений збір недоступний':'Запустити збережений збір');
      return brief(l,'Gathering: ','Сбор: ','Збір: ')+literal(command?commandTitle(command):draft.target??'');
    }
    if(draft.action==='persona')return store.state.profiles[draft.targetId]?brief(l,'Profile: ','Профиль: ','Профіль: ')+literal(profileTitle(store.state.profiles[draft.targetId])):brief(l,draft.targetId?'Saved profile unavailable':'Change profile',draft.targetId?'Сохранённый профиль недоступен':'Сменить профиль',draft.targetId?'Збережений профіль недоступний':'Змінити профіль');
    return ({judge:brief(l,'Review the dispute','Разобрать спор','Розібрати суперечку'),animation:'GIF',message:brief(l,'Send message','Отправить сообщение','Надіслати повідомлення')})[draft.action]??'';
  }

  function rulePreview(draft) {
    const l=locale();
    return [brief(l,'Phrases: ','Фразы: ','Фрази: ')+(draft.phrases??[]).map(literal).join(', '),
      brief(l,'Matching: ','Совпадение: ','Збіг: ')+(draft.match==='contains'?brief(l,'inside a message, whole words','внутри сообщения, отдельные слова','всередині повідомлення, окремі слова'):brief(l,'whole message','сообщение целиком','повідомлення цілком')),
      draft.access==='owner'?brief(l,'Only you may trigger it.','Запускать можешь только ты.','Запускати можеш лише ти.'):brief(l,'Group members may trigger it within the action’s permissions.','Запускать могут участники группы с учётом прав действия.','Запускати можуть учасники групи з урахуванням прав дії.')].join('\n');
  }

  function preview(draft) {
    const l=locale();let lines=[];
    const otherBindings=draft.feature==='assemble'?(group(draft.group).rules??[]).filter(rule=>rule.action.type==='assemble'&&rule.action.game===draft.gameId&&rule.id!==draft.ruleId):[];
    if(draft.feature==='assemble')lines=[brief(l,'Command: ','Команда: ','Команда: ')+literal(draft.commandName),brief(l,'Game: ','Игра: ','Гра: ')+literal(draft.gameName),
      brief(l,'Players: ','Зову: ','Кличу: ')+(draft.players??[]).map(x=>'@'+x).join(', '),draft.aliases?.length?brief(l,'Other names: ','Другие названия: ','Інші назви: ')+draft.aliases.map(literal).join(', '):'',
      draft.animation||draft.animationPath?brief(l,'Prepared GIF (private preview above).','GIF подготовлена, предпросмотр выше.','GIF підготовлена, попередній перегляд вище.'):brief(l,'No GIF.','Без GIF.','Без GIF.'),
      draft.caption?brief(l,'Caption: ','Подпись: ','Підпис: ')+literal(draft.caption):brief(l,'No extra caption.','Без дополнительной подписи.','Без додаткового підпису.'),
      draft.phrases?.length?rulePreview(draft):otherBindings.length?'':brief(l,'Manual launch, without automatic phrases.','Ручной запуск, без автоматических фраз.','Ручний запуск, без автоматичних фраз.'),
      otherBindings.length?brief(l,'Other linked phrase actions: ','Другие связанные действия по фразам: ','Інші пов’язані дії за фразами: ')+otherBindings.map(rule=>literal(rule.phrase)+' — '+modeLabel(availableRuleAction(group(draft.group),rule,store.state.profiles)?'on':'off',l)).join(', '):''];
    if(draft.feature==='reaction')lines=[actionLabel(draft),rulePreview(draft),draft.messageText?literal(draft.messageText):'',draft.animation?brief(l,'Prepared GIF (private preview above).','GIF подготовлена, предпросмотр выше.','GIF підготовлена, попередній перегляд вище.'):'',draft.announcement?literal(draft.announcement):''];
    if(draft.feature==='sticker')lines=[draft.stickerMode==='new'?brief(l,'Create sticker pack: ','Создать стикерпак: ','Створити стікерпак: ')+literal(draft.packTitle)+'\n'+draft.emoji:brief(l,'Connect sticker pack: ','Подключить стикерпак: ','Підключити стікерпак: ')+literal(draft.packName)];
    if(draft.feature==='moderation')lines=[brief(l,'Permitted administrators: ','Разрешённые администраторы: ','Дозволені адміністратори: ')+draft.operatorIds.map(id=>literal(draft.operators?.find(x=>x.id===id)?.name??String(id))).join(', ')];
    if(draft.feature==='label')lines=[literal(draft.groupLabel)];
    if(draft.replacesExisting)lines.push(brief(l,'This replaces the existing rule for these phrases.','Эта настройка заменит существующее действие по этим фразам.','Це налаштування замінить наявну дію за цими фразами.'));
    return lines.filter(Boolean).join('\n\n')+'\n\n'+brief(l,'Save these settings?','Сохранить настройки?','Зберегти налаштування?');
  }

  function rows(draft) {
    const l=locale(),field=nextField(draft),result=[];
    if(draft.exitRequested)return [...(!field&&draft.previewed?[[button(brief(l,'Save','Сохранить','Зберегти'),'save')]]:[]),[button(brief(l,'Continue editing','Продолжить настройку','Продовжити налаштування'),'continue')],[button(brief(l,'Discard changes','Не сохранять','Не зберігати'),'discard')]];
    if(draft.aiUnavailable&&!draft.fieldFallback)return [[button(brief(l,'Continue step by step','Продолжить по шагам','Продовжити покроково'),'fallback')],[back(),cancel()]];
    if(!field)result.push([button(draft.feature==='sticker'&&draft.stickerMode==='new'?brief(l,'Create and connect','Создать и подключить','Створити й підключити'):brief(l,'Save','Сохранить','Зберегти'),'save'),button(brief(l,'Edit','Изменить','Змінити'),'edit')]);
    if(field==='animation'&&draft.feature==='assemble')result.push([button(brief(l,'No GIF','Без GIF','Без GIF'),'choice',{field:'animation',value:null})]);
    if(field==='caption')result.push([button(brief(l,'No caption','Без подписи','Без підпису'),'choice',{field:'caption',value:''})]);
    if(field==='phrases'&&draft.feature==='assemble')result.push([button(brief(l,'No phrases for now','Пока без фраз','Поки без фраз'),'choice',{field:'phrases',value:[]})]);
    if(field==='aliases')result.push([button(brief(l,'No other names','Без других названий','Без інших назв'),'choice',{field:'aliases',value:[]})]);
    if(field==='access')result.push([button(brief(l,'Only me','Только я','Лише я'),'choice',{field:'access',value:'owner'}),button(brief(l,'Group members','Участники группы','Учасники групи'),'choice',{field:'access',value:'members'})]);
    if(field==='match')result.push([button(brief(l,'Whole message','Сообщение целиком','Повідомлення цілком'),'choice',{field:'match',value:'exact'}),button(brief(l,'Inside a message','Внутри сообщения','Всередині повідомлення'),'choice',{field:'match',value:'contains'})]);
    if(field==='action'&&(draft.fieldFallback||draft.showFields))for(const value of ['assemble','judge','animation','message','persona'])result.push([button(actionLabel({...draft,action:value}), 'choice',{field:'action',value})]);
    if(field==='target') {
      const options=draft.action==='assemble'?(group(draft.group).assemble?.games??[]).map(x=>[x.id,commandTitle(x)]):Object.entries(store.state.profiles).map(([id,p])=>[id,profileTitle(p)]);
      result.push(...options.map(([id,title])=>[button(title,'target',{id})]));
      if(!options.length&&draft.action==='assemble')result.push([button(brief(l,'Create gathering','Настроить сбор','Налаштувати збір'),'createDependency')]);
    }
    if(field==='announcement')result.push([button(brief(l,'No announcement','Без объявления','Без оголошення'),'choice',{field:'announcement',value:''})]);
    if(field==='stickerMode')result.push([button(brief(l,'Create new','Создать новый','Створити новий'),'choice',{field:'stickerMode',value:'new'}),button(brief(l,'Connect existing','Подключить существующий','Підключити наявний'),'choice',{field:'stickerMode',value:'existing'})]);
    if(field==='emoji')result.push(['😂','🙂','🎮'].map(value=>button(value,'choice',{field:'emoji',value})));
    if(field==='operatorIds')result.push(...(draft.operators??[]).map(user=>[button((draft.operatorIds?.includes(user.id)?'✓ ':'')+user.name,'operator',{id:user.id})]));
    if(draft.showFields) {
      const fields=draft.feature==='assemble'?['gameName','commandName','aliases','players','animation','caption','phrases']:draft.feature==='reaction'?['phrases','action',...(['assemble','persona'].includes(draft.action)?['target']:draft.action==='animation'?['animation']:draft.action==='message'?['messageText']:[]),'access','match','announcement']:draft.feature==='sticker'?['packTitle','firstSticker','emoji']:[];
      result.push(...fields.map(field=>[button(brief(l,...fieldTitles[field]),'field',{field})]));
    }
    result.push([back(),cancel()]);return result;
  }

  async function render(draft,notice='') {
    const field=nextField(draft);
    if(!field)draft={...draft,previewed:true,baseRevision:group(draft.group).settingsRevision};
    setSession(draft);
    const text=draft.exitRequested?brief(locale(),'There are unsaved changes. Continue or discard them?','Есть несохранённые изменения. Продолжить настройку или не сохранять?','Є незбережені зміни. Продовжити налаштування чи не зберігати?'):question(draft);
    return panel((draft.feature==='label'?`**${literal(groupLabel(group(draft.group),draft.group))}**`:heading(draft.group,draft.feature))+'\n\n'+[notice,draft.mediaError&&notice?'':text].filter(Boolean).join('\n\n'),rows(draft),{group:draft.group,draft:true});
  }

  async function open(id,feature,bot,notice='',selected={}) {
    if(!await permitted(id,bot))return unavailable(id);
    const l=locale(),settings=group(id),state=mode(id,feature),r=[];
    setSession(keepDraft({kind:'menu',group:id,feature,...selected}));
    let description=featureIntroduction(feature,l);
    if(feature==='status'){
      let snapshot;try{snapshot=await checkFeature?.('status');}catch{/* Show an honest unavailable result, with retry. */}
      const names={codex_cli:['AI connection tool','Инструмент подключения AI','Інструмент підключення AI'],openclaw_cli:['AI/media connection tool','Инструмент AI и медиа','Інструмент AI й медіа'],social_video_downloader:['Link downloads','Скачивание по ссылкам','Завантаження за посиланнями'],ffmpeg:['Media preparation','Подготовка медиа','Підготовка медіа'],ffprobe:['Media inspection','Проверка медиа','Перевірка медіа'],whisper_python:['Voice processing tool','Инструмент расшифровки речи','Інструмент розшифрування мовлення']};
      description+='\n\n'+(snapshot?.checks?.length?snapshot.checks.map(check=>`${check.ok?'✓':'⚠'} ${brief(l,...(names[check.name]??[check.name,check.name,check.name]))} — ${check.ok?brief(l,'available','доступен','доступний'):brief(l,'not found','не найден','не знайдений')}`).join('\n'):brief(l,'Diagnostics are unavailable right now. Try refreshing.','Сейчас диагностика недоступна. Попробуй обновить.','Зараз діагностика недоступна. Спробуй оновити.'));
      description+='\n\n'+brief(l,'This checks local tools. AI login, speech models and a real Telegram game launch still need their own feature tests.','Здесь проверяются локальные инструменты. Вход в AI, модель речи и настоящий запуск игры в Telegram нужно проверять отдельно по примерам функций.','Тут перевіряються локальні інструменти. Вхід до AI, модель мовлення й справжній запуск гри в Telegram потрібно перевіряти окремо за прикладами функцій.');
      r.push([button(brief(l,'Refresh','Обновить','Оновити'),'check',{feature:'status'})]);
    }
    if(state==='unavailable'&&feature!=='minigames')description+='\n\n'+connectionHelp(feature,l);
    if(state!=='unavailable'&&feature!=='status') {
      if(feature==='memory')r.push([button(brief(l,'On request','По просьбе','За проханням'),'mode',{feature,value:'manual'}),button(brief(l,'From requests','Из обращений','Зі звернень'),'mode',{feature,value:'auto'}),button(brief(l,'Off','Выключить','Вимкнути'),'mode',{feature,value:'off'})]);
      else if(state!=='setup') {
        const off=['assemble','reaction','sticker','moderation'].includes(feature)?settings.disabled?.[feature]===true:state==='off';
        r.push([button(off?brief(l,'Enable','Включить','Увімкнути'):brief(l,'Disable','Выключить','Вимкнути'),'toggle',{feature})]);
      }
      if(['assemble','reaction','sticker','moderation'].includes(feature))r.push([button(brief(l,'Add or configure','Добавить или настроить','Додати чи налаштувати'),'start',{feature})]);
      if(feature==='judge')r.push([button(brief(l,'Add launch phrases','Добавить фразы запуска','Додати фрази запуску'),'triggers',{feature})]);
    }
    if(feature==='assemble') {
      const commands=settings.assemble?.games??[];
      if(commands.length)description+='\n\n'+commands.map(c=>`${literal(commandTitle(c))} — ${c.enabled===false?brief(l,'off','выключен','вимкнений'):brief(l,'on','включён','увімкнений')}, ${c.players.length}`).join('\n');
      r.push(...commands.map(c=>[button(commandTitle(c),'game',{id:c.id})]));
    }
    if(feature==='reaction') {
      const rules=settings.rules??[];
      if(rules.length)description+='\n\n'+rules.map(rule=>`${literal(rule.phrase)} — ${availableRuleAction(settings,rule,store.state.profiles)?brief(l,'on','включено','увімкнено'):brief(l,'inactive','неактивно','неактивно')}`).join('\n');
      r.push(...rules.map(rule=>[button(rule.phrase,'rule',{id:rule.id})]));
    }
    if(feature==='judge')r.push(...(settings.rules??[]).filter(rule=>rule.action.type==='judge').map(rule=>[button(rule.phrase,'rule',{id:rule.id})]));
    if(feature==='minigames')r.push([button(brief(l,'What is needed','Что потребуется','Що потрібно'),'miniInfo'),button(brief(l,'Text for agent','Текст для агента','Текст для агента'),'agent',{feature})],[button(brief(l,'Check connection','Проверить подключение','Перевірити підключення'),'check',{feature})]);
    else if(state==='unavailable')r.push([button(brief(l,'Text for agent','Текст для агента','Текст для агента'),'agent',{feature})]);
    if(feature==='sticker'&&settings.sticker)r.push([{text:brief(l,'Open pack','Открыть пак','Відкрити пак'),url:`https://t.me/addstickers/${settings.sticker.packName}`}]);
    if(feature==='moderation')r.push([button(brief(l,'Check permissions','Проверить права','Перевірити права'),'check',{feature})]);
    r.push([button(brief(l,'How to test','Как проверить','Як перевірити'),'test',{feature})],[back()]);
    return panel(heading(id,feature)+'\n\n'+[notice||description,feature==='status'?'':brief(l,'Current setting: ','Сейчас: ','Зараз: ')+modeLabel(state,l)].filter(Boolean).join('\n\n'),r,{group:id});
  }

  async function unavailable(id) {
    return panel(brief(locale(),'I could not verify group access. Restore my administrator rights, then continue. Your saved settings remain.','Не получилось проверить доступ к группе. Верни мне права администратора, затем продолжим. Сохранённые настройки остаются.','Не вдалося перевірити доступ до групи. Поверни мені права адміністратора, потім продовжимо. Збережені налаштування залишаються.'),[[button(brief(locale(),'Check rights','Проверить права','Перевірити права'),'check',{feature:'rights'})],[back()]],{group:id,draft:store.state.session?.kind==='feature'});
  }

  async function begin(id,feature,bot,values={}) {
    if(!await permitted(id,bot))return unavailable(id);
    if(feature!=='label'&&featureMode(id,feature)==='unavailable')return open(id,feature,bot);
    const current=group(id),existing=feature==='moderation'?current.moderation:feature==='sticker'?current.sticker:null;
    const draft=keepDraft({kind:'feature',flowVersion:3,feature,group:id,operationId:randomUUID(),baseRevision:current.settingsRevision,aliases:[],...(existing?{editing:true}:{}),...values});
    if(feature==='assemble')draft.gameId??='g_'+randomBytes(8).toString('hex');
    if(feature==='moderation') {
      try { draft.operators=(await telegram('getChatAdministrators',{chat_id:Number(id)})).filter(x=>!x.user.is_bot).map(x=>({id:x.user.id,name:x.user.username?'@'+x.user.username:x.user.first_name||String(x.user.id)})); } catch {draft.operators=[];}
    }
    return render(draft,feature==='label'?'':featureIntroduction(feature,locale()));
  }

  function resolveReferences(draft) {
    if(draft.feature!=='reaction')return;
    if(draft.action==='persona')draft.access='owner';
    if(draft.targetId && !(draft.action==='assemble'?(group(draft.group).assemble?.games??[]).some(x=>x.id===draft.targetId):draft.action==='persona'?Boolean(store.state.profiles[draft.targetId]):true))delete draft.targetId;
    if(!draft.target)return;
    const target=normalizedName(draft.target);
    const options=draft.action==='assemble'?(group(draft.group).assemble?.games??[]).filter(game=>commandNames(game).some(name=>normalizedName(name)===target)).map(game=>game.id):draft.action==='persona'?Object.entries(store.state.profiles).filter(([,profile])=>normalizedName(profileTitle(profile))===target).map(([id])=>id):[];
    if(options.length===1)draft.targetId=options[0];else delete draft.targetId;
  }

  function buildRule(draft,commandId) {
    const action=commandId?{type:'assemble',game:commandId}:({assemble:{type:'assemble',game:draft.targetId},persona:{type:'persona',profile:draft.targetId},judge:{type:'judge',scope:'single'},animation:{type:'animation',animation:draft.animation},message:{type:'message',text:draft.messageText}})[draft.action];
    return {id:draft.ruleId??randomUUID(),...(commandId?{originCommand:commandId}:draft.originCommand&&draft.action==='assemble'&&draft.targetId===draft.originCommand?{originCommand:draft.originCommand}:{}),phrase:draft.phrases[0],phrases:draft.phrases,match:draft.match??'exact',action,access:action.type==='persona'?'owner':draft.access,enabled:draft.ruleEnabled??true,announcement:draft.announcement??'',createdAt:draft.createdAt??new Date().toISOString()};
  }

  async function checkModerators(id,ids,bot) {
    if(!ids?.length)return false;
    try {
      const [self,...members]=await Promise.all([telegram('getChatMember',{chat_id:Number(id),user_id:bot.id}),...ids.map(user_id=>telegram('getChatMember',{chat_id:Number(id),user_id}))]);
      return self.status==='administrator'&&self.can_restrict_members===true&&members.every(x=>['creator','administrator'].includes(x.status));
    }catch{return false;}
  }

  async function createPack(draft,bot) {
    const suffix='_by_'+bot.username;
    if(suffix.length>55)throw new Error('Unsupported bot username');
    const key=draft.operationId;
    let job=store.state.stickerCreations?.[key];
    if(!job) {
      const prefix=('p1_'+createHash('sha256').update([store.ownerId,draft.group,key].join(':')).digest('hex')).slice(0,64-suffix.length);
      job={name:prefix+suffix,title:draft.packTitle,owner:store.ownerId,group:draft.group,first:draft.firstSticker,emoji:draft.emoji,stage:'prepared'};
      store.change(s=>{s.stickerCreations??={};s.stickerCreations[key]=job;});
    }
    if(job.stage==='prepared'&&(job.title!==draft.packTitle||job.first.uniqueId!==draft.firstSticker.uniqueId||job.emoji!==draft.emoji)){
      job={...job,title:draft.packTitle,first:draft.firstSticker,emoji:draft.emoji};store.change(s=>{s.stickerCreations[key]=job;});
    }
    if(job.owner!==store.ownerId||job.group!==draft.group||job.title!==draft.packTitle||job.first.uniqueId!==draft.firstSticker.uniqueId||job.emoji!==draft.emoji)throw new Error('Sticker creation draft changed');
    const verify=set=>set?.name?.toLowerCase()===job.name.toLowerCase()&&set.title===job.title&&set.sticker_type==='regular'&&set.stickers?.some(sticker=>sticker.file_unique_id===job.first.uniqueId);
    if(job.stage!=='prepared') {
      try {
        const existing=await telegram('getStickerSet',{name:job.name});
        if(!verify(existing))throw new Error('Sticker creation identity mismatch');
        store.change(s=>{s.stickerCreations[key].stage='verified';});return job.name;
      }catch(error){if(!/STICKERSET_INVALID|sticker set.*not found/iu.test(error.message))throw error;}
    }
    store.change(s=>{s.stickerCreations[key].stage='attempted';});
    let creationError;
    try {await telegram('createNewStickerSet',{user_id:job.owner,name:job.name,title:job.title,sticker_type:'regular',stickers:[{sticker:job.first.fileId,format:'static',emoji_list:[job.emoji]}]});}catch(error){creationError=error;}
    let set;try{set=await telegram('getStickerSet',{name:job.name});}catch(error){throw creationError??error;}
    if(!verify(set))throw new Error('Sticker creation identity mismatch');
    store.change(s=>{s.stickerCreations[key].stage='verified';});return job.name;
  }

  async function save(draft,bot) {
    if(nextField(draft)||!draft.previewed)return render(draft);
    if(!await permitted(draft.group,bot))return unavailable(draft.group);
    if(draft.baseRevision!==group(draft.group).settingsRevision)return render({...draft,previewed:false},brief(locale(),'Group settings changed. Check this preview again before saving.','Настройки группы изменились. Проверь этот предпросмотр ещё раз перед сохранением.','Налаштування групи змінилися. Перевір цей попередній перегляд ще раз перед збереженням.'));
    try {
      let command,rule;
      if(draft.feature==='assemble') {
        command=validateGroupCommand({id:draft.gameId,name:draft.gameName,commandName:draft.commandName,aliases:draft.aliases??[],players:draft.players,caption:draft.caption,animationReference:draft.animation,animationPath:draft.animationPath??null});
        const other=(group(draft.group).assemble?.games??[]).filter(x=>x.id!==command.id);
        const names=commandNames(command).slice(1).map(normalizedName);
        if(other.some(game=>commandNames(game).slice(1).some(name=>names.includes(normalizedName(name)))))throw new Error('Command name or alias is already used in this group');
        if(draft.phrases?.length)rule=buildRule(draft,command.id);
      }
      if(draft.feature==='reaction'){resolveReferences(draft);if(nextField(draft))return render(draft);rule=buildRule(draft);}
      if(rule)validateMessageRules([...(group(draft.group).rules??[]).filter(x=>x.id!==rule.id),rule]);
      if(draft.feature==='sticker') {
        if(draft.stickerMode==='new'&&([...new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(draft.emoji)].length!==1||!/[\p{Extended_Pictographic}\p{Regional_Indicator}\u20e3]/u.test(draft.emoji)))return render({...draft,requestedField:'emoji'},brief(locale(),'Send a single emoji for the sticker.','Пришли один эмодзи для стикера.','Надішли один емодзі для стікера.'));
        if(draft.stickerMode==='new')draft.packName=await createPack(draft,bot);
        if(stickerConflict(store.state,draft.group,{sticker:{packName:draft.packName}}))throw new Error('This pack is linked to another active group');
      }
      if(draft.feature==='moderation'&&!await checkModerators(draft.group,draft.operatorIds,bot))return render(draft,brief(locale(),'Operators must still be group administrators, and I need restriction permission. Restore permissions and try again.','Выбранные люди должны оставаться администраторами, а мне нужно право ограничивать участников. Исправь права и повтори.','Вибрані люди мають залишатися адміністраторами, а мені потрібне право обмежувати учасників. Виправ права й повтори.'));
      if(!await permitted(draft.group,bot))return unavailable(draft.group);
      store.change(s=>{
        const target=s.groups[draft.group];target.disabled??={};
        if(command){const previous=target.assemble?.games?.find(x=>x.id===command.id);target.assemble??={games:[]};target.assemble.games=[...target.assemble.games.filter(x=>x.id!==command.id),{...previous,...command}];if(!draft.editing)target.disabled.assemble=false;}
        if(rule){target.rules=validateMessageRules([...(target.rules??[]).filter(x=>x.id!==rule.id),rule]);if(!draft.editing)target.disabled.reaction=false;}
        else if(command&&draft.ruleId)target.rules=(target.rules??[]).filter(x=>x.id!==draft.ruleId);
        if(draft.feature==='moderation'){target.moderation={userIds:draft.operatorIds};if(!draft.editing)target.disabled.moderation=false;}
        if(draft.feature==='sticker'){target.sticker={packName:draft.packName,ownerId:store.ownerId};if(!draft.editing)target.disabled.sticker=false;releaseInactiveStickerBindings(s,draft.group,target);}
        if(draft.feature==='label')target.menuLabel=draft.groupLabel;
        s.session={kind:'menu',group:draft.group,feature:draft.feature,commandId:command?.id,ruleId:rule?.id,resume:draft.resume};
      });
      const title=literal(groupLabel(group(draft.group),draft.group));
      const notice=brief(locale(),`Saved for “${title}”. Is everything right, or would you like to change something?`,`Сохранено для «${title}». Всё как нужно или хочешь что-то изменить?`,`Збережено для «${title}». Усе як потрібно чи хочеш щось змінити?`);
      if(command&&draft.dependencyDraft)return render({...draft.dependencyDraft,targetId:command.id,target:command.commandName,paused:false,previewed:false},notice);
      if(command)return showCommand(draft.group,command.id,bot,notice);
      if(rule)return showRule(draft.group,rule.id,bot,notice);
      if(draft.feature==='label')return overview(draft.group,bot);
      return open(draft.group,draft.feature,bot,notice);
    }catch(error){
      if(/pack is linked to another active group/iu.test(error.message))return render(draft,brief(locale(),'That pack is already linked to another group. Disable it there or choose a different pack; your draft is retained.','Этот пак уже привязан к другой группе. Выключи его там или выбери другой пак; черновик сохранён.','Цей пак уже прив’язаний до іншої групи. Вимкни його там чи вибери інший пак; чернетку збережено.'));
      if(/name or alias is already used/iu.test(error.message))return render({...draft,requestedField:'commandName'},brief(locale(),'A command already uses that name in this group. Choose another name or edit the saved command.','В этой группе уже есть команда с таким названием. Выбери другое имя или измени сохранённую команду.','У цій групі вже є команда з такою назвою. Вибери інше ім’я чи зміни збережену команду.'));
      if(/at most 32 message rules/iu.test(error.message))return render(draft,brief(locale(),'This group already has 32 phrase actions. Edit or remove an existing one before adding another; your draft is retained.','В группе уже 32 действия по фразам. Измени или удали одно из существующих перед добавлением нового; черновик сохранён.','У групі вже 32 дії за фразами. Зміни чи видали одну з наявних перед додаванням нової; чернетку збережено.'));
      if(draft.feature==='sticker'&&draft.stickerMode==='new')return render(draft,brief(locale(),'I could not confirm the pack creation. Your image and settings are retained. Tap Create and connect again to check the same pack, without creating another.','Не получилось подтвердить создание пака. Картинка и настройки сохранены. Нажми «Создать и подключить» ещё раз — проверю тот же пак, без создания другого.','Не вдалося підтвердити створення пака. Зображення й налаштування збережено. Натисни «Створити й підключити» ще раз — перевірю той самий пак, без створення іншого.'));
      return render(draft,brief(locale(),'I could not save this configuration. Check the name, references, pack access and values; your draft is retained. If creation was interrupted, retry uses the same pack identity.','Не получилось сохранить настройку. Проверь название, выбранные команды, доступ к паку и значения. Черновик сохранён. Если создание пака прервалось, повторная попытка проверит тот же пак.','Не вдалося зберегти налаштування. Перевір назву, вибрані команди, доступ до пака й значення. Чернетку збережено. Якщо створення пака перервалося, повторна спроба перевірить той самий пак.'));
    }
  }

  async function showCommand(id,key,bot,notice='') {
    const game=group(id).assemble?.games?.find(g=>g.id===key);if(!game)return open(id,'assemble',bot);
    const l=locale(),linked=(group(id).rules??[]).filter(rule=>rule.action.type==='assemble'&&rule.action.game===key);setSession(keepDraft({kind:'menu',group:id,feature:'assemble',commandId:key}));
    return panel(heading(id,'assemble')+'\n\n'+[notice,`**${literal(commandTitle(game))}** — ${game.enabled===false||group(id).disabled?.assemble?brief(l,'inactive','неактивен','неактивний'):brief(l,'on','включён','увімкнений')}`,
      game.players.map(x=>'@'+x).join(', '),game.caption?literal(game.caption):'',linked.length?brief(l,'Launch phrases: ','Фразы запуска: ','Фрази запуску: ')+linked.map(rule=>literal(rule.phrase)).join(', '):brief(l,'Manual launch, without automatic phrases.','Ручной запуск, без автоматических фраз.','Ручний запуск, без автоматичних фраз.'),brief(l,'Tell me what to change, for example add @player_three or replace the GIF.','Напиши, что поменять: например, добавь @player_three или замени GIF.','Напиши, що змінити: наприклад, додай @player_three або заміни GIF.')].filter(Boolean).join('\n\n'),
      [[button(game.enabled===false?brief(l,'Enable gathering','Включить сбор','Увімкнути збір'):brief(l,'Disable gathering','Выключить сбор','Вимкнути збір'),'toggleGame',{id:key}),button(brief(l,'Edit','Изменить','Змінити'),'editGame',{id:key})],
       [button(brief(l,'Add launch phrases','Добавить фразы запуска','Додати фрази запуску'),'triggers',{feature:'assemble',id:key})],
       ...linked.map(rule=>[button(rule.phrase,'rule',{id:rule.id})]),
       [button(brief(l,'How to test','Как проверить','Як перевірити'),'test',{feature:'assemble',id:key})],[button(brief(l,'Delete gathering','Удалить сбор','Видалити збір'),'delete',{feature:'assemble',id:key}),back()]],{group:id});
  }

  async function showRule(id,key,bot,notice='') {
    const rule=group(id).rules?.find(x=>x.id===key);if(!rule)return open(id,'reaction',bot);
    setSession(keepDraft({kind:'menu',group:id,feature:'reaction',ruleId:key}));
    const d={...rule,feature:'reaction',group:id,phrases:rule.phrases??[rule.phrase],action:rule.action.type,targetId:rule.action.game??rule.action.profile};
    return panel(heading(id,'reaction')+'\n\n'+[notice,actionLabel(d),rulePreview(d),rule.action.text?literal(rule.action.text):'',rule.action.animation?'GIF': '',rule.announcement?literal(rule.announcement):'',availableRuleAction(group(id),rule,store.state.profiles)?brief(locale(),'Active','Включено','Увімкнено'):brief(locale(),'Inactive; check the rule and its action.','Неактивно: проверь правило и его действие.','Неактивно: перевір правило та його дію.')].filter(Boolean).join('\n\n'),
      [[button(rule.enabled===false?brief(locale(),'Enable','Включить','Увімкнути'):brief(locale(),'Disable','Выключить','Вимкнути'),'toggleRule',{id:key}),button(brief(locale(),'Edit','Изменить','Змінити'),'editRule',{id:key})],
       [button(brief(locale(),'How to test','Как проверить','Як перевірити'),'test',{feature:'reaction',id:key})],[button(brief(locale(),'Delete rule','Удалить правило','Видалити правило'),'delete',{feature:'reaction',id:key}),back()]],{group:id});
  }

  const commandDraft=(id,key)=>{
    const game=group(id).assemble?.games?.find(x=>x.id===key);if(!game)return null;
    const linked=group(id).rules?.find(rule=>rule.originCommand===key);
    return {editing:true,gameId:game.id,gameName:game.name,commandName:game.commandName??game.name,aliases:game.aliases??[],players:game.players,caption:game.caption??'',animation:game.animationReference??null,animationPath:game.animationPath,phrases:linked?.phrases??(linked?[linked.phrase]:[]),ruleId:linked?.id,ruleEnabled:linked?.enabled,createdAt:linked?.createdAt,access:linked?.access,match:linked?.match??'exact',editingPrompt:true};
  };
  const ruleDraft=(id,key)=>{
    const rule=group(id).rules?.find(x=>x.id===key);if(!rule)return null;
    return {editing:true,ruleId:rule.id,originCommand:rule.originCommand,ruleEnabled:rule.enabled,createdAt:rule.createdAt,phrases:rule.phrases??[rule.phrase],match:rule.match??'exact',action:rule.action.type,targetId:rule.action.game??rule.action.profile,access:rule.access,animation:rule.action.animation,messageText:rule.action.text,announcement:rule.announcement??'',editingPrompt:true};
  };

  async function applyInput(draft,fields,message,bot) {
    const job=store.state.stickerCreations?.[draft.operationId];
    if(draft.feature==='sticker'&&job&&job.stage!=='prepared'&&(Object.keys(fields).length||message&&stickerMedia(message)))return render({...draft,packTitle:job.title,firstSticker:job.first,emoji:job.emoji,requestedField:null,editingPrompt:false},brief(locale(),'Creation was already attempted. Save again to recover that same pack before changing its contents.','Создание уже началось. Нажми «Создать и подключить» ещё раз: сначала проверю тот же пак, затем можно будет менять его содержимое.','Створення вже почалося. Натисни «Створити й підключити» ще раз: спочатку перевірю той самий пак, потім можна буде змінювати його вміст.'));
    let next=mergeFeatureFields(draft,fields);
    if(fields.action&&fields.action!==draft.action){delete next.targetId;if(!fields.target)delete next.target;}
    if(Object.keys(fields).length){delete next.requestedField;delete next.editingPrompt;}
    if(next.action==='persona')next.access='owner';
    resolveReferences(next);
    if(next.feature==='reaction'&&!next.ruleId&&next.phrases?.length){
      const names=new Set(next.phrases.map(normalizePhrase));
      const existing=(group(next.group).rules??[]).filter(rule=>(rule.phrases??[rule.phrase]).some(phrase=>names.has(normalizePhrase(phrase))));
      if(existing.length===1){next.ruleId=existing[0].id;next.ruleEnabled=existing[0].enabled;next.createdAt=existing[0].createdAt;next.editing=true;next.replacesExisting=true;}
      else if(existing.length>1)return render({...next,requestedField:'phrases'},brief(locale(),'These phrases belong to different saved rules. Choose one rule to edit, or send other phrases.','Эти фразы относятся к разным сохранённым действиям. Выбери одно действие для изменения или пришли другие фразы.','Ці фрази належать різним збереженим діям. Вибери одну дію для зміни чи надішли інші фрази.'));
    }
    if(message&&setupAnimation(message)&&['assemble','reaction'].includes(next.feature)) {
      try {
        const media=prepareAnimation?await prepareAnimation(message,store.ownerId):message.animation?{fileId:message.animation.file_id}:null;
        if(!media?.fileId)throw new Error('Animation preparation unavailable');
        // A genuine Telegram animation still gets an actual private send check.
        if(!media.previewMessageId)await telegram('sendAnimation',{chat_id:store.ownerId,animation:media.fileId});
        next.animation=media.fileId;delete next.animationPath;delete next.mediaError;delete next.requestedField;delete next.editingPrompt;
        next.previewMedia=media.fileId;
      }catch(error){
        next.mediaError=true;next.requestedField='animation';setSession(next);
        return render(next,brief(locale(),'I could not prepare this file. Other draft settings remain. Send another GIF or skip it. Limits: 20 MB and 60 seconds.','Не получилось подготовить этот файл. Остальные настройки сохранены в черновике. Пришли другую GIF или пропусти. Лимиты: 20 МБ и 60 секунд.','Не вдалося підготувати цей файл. Інші налаштування збережено в чернетці. Надішли іншу GIF або пропусти. Обмеження: 20 МБ і 60 секунд.'));
      }
    }
    if(message&&next.feature==='sticker'&&stickerMedia(message)) {
      try {
        if(!prepareSticker)throw new Error('Sticker preparation unavailable');
        next.firstSticker=await prepareSticker(message,store.ownerId);delete next.requestedField;delete next.editingPrompt;
      }catch{return render(next,brief(locale(),'I could not prepare that sticker image. Send a photo, PNG, JPEG or WebP. Your draft is retained.','Не получилось подготовить стикер. Пришли фото, PNG, JPEG или WebP. Черновик сохранён.','Не вдалося підготувати стікер. Надішли фото, PNG, JPEG або WebP. Чернетку збережено.'));}
    }
    if(next.feature==='sticker'&&next.stickerMode==='existing'&&next.packName) {
      const candidate=next.packName.match(/(?:https:\/\/t\.me\/addstickers\/)?([A-Za-z][A-Za-z0-9_]{0,63})$/u)?.[1];
      try {
        if(!candidate?.toLowerCase().endsWith('_by_'+bot.username.toLowerCase()))throw new Error('Other bot pack');
        const pack=await telegram('getStickerSet',{name:candidate});
        if(pack.sticker_type!=='regular')throw new Error('Unsupported pack');next.packName=pack.name;
      }catch{delete next.packName;return render(next,brief(locale(),'I cannot manage that pack. Send another pack for this bot, or create a new one.','Этим паком я не могу управлять. Пришли другой пак этого бота или создай новый.','Цим паком я не можу керувати. Надішли інший пак цього бота або створи новий.'));}
    }
    if(!nextField(next)&&next.feature==='assemble') {
      const payload={id:next.gameId,name:next.gameName,commandName:next.commandName,players:next.players,caption:next.caption,animationReference:next.animation,animationPath:next.animationPath};
      const chunks=gatheringChunks(payload);
      try {
        if(previewGathering)await previewGathering(payload);
        else {
          if(next.animationPath)throw new Error('Saved animation preview transport unavailable');
          if(next.animation)await telegram('sendAnimation',{chat_id:store.ownerId,animation:next.animation,caption:chunks[0].text,caption_entities:chunks[0].entities});
          else await telegram('sendMessage',{chat_id:store.ownerId,...chunks[0]});
          for(const chunk of chunks.slice(1))await telegram('sendMessage',{chat_id:store.ownerId,...chunk});
        }
      }catch {return render({...next,requestedField:'animation',previewed:false},brief(locale(),'The GIF preview failed. Send another GIF or continue without it; other details are retained.','Предпросмотр GIF не отправился. Пришли другую GIF или продолжим без неё; остальные данные сохранены.','Попередній перегляд GIF не надіслався. Надішли іншу GIF чи продовжимо без неї; решту даних збережено.'));}
    }
    return render(next);
  }

  async function handle(message,bot) {
    let session=store.state.session;
    if(!session||!session.group||!group(session.group)?.configured||!['feature','menu'].includes(session.kind))return false;
    const text=(message.text??message.caption??'').trim();
    if(text.startsWith('/')&&!/^\/(?:setup|cancel)(?:@\w+)?\s*$/iu.test(text))return false;
    if(doneText.test(text)){if(session.kind==='feature')return render({...session,exitRequested:true}),true;setSession({kind:'menu',group:session.group,resume:session.resume});await overview(session.group,bot);return true;}
    if(cancelText.test(text)){setSession({kind:'menu',group:session.group,resume:session.resume});await overview(session.group,bot);return true;}
    if(!await permitted(session.group,bot)){await unavailable(session.group);return true;}
    if(session.kind==='feature'&&/^\/setup/iu.test(text)){await render({...session,paused:false});return true;}
    if(session.kind==='feature'&&saveText.test(text)) {
      if(session.paused){await render({...session,paused:false});return true;}
      await save(session,bot);return true;
    }
    if(session.kind==='feature'&&/^(?:show fields|покажи поля|покажи поля налаштувань)$/iu.test(text)){await render({...session,showFields:true});return true;}
    if(session.kind==='feature'&&session.fieldFallback&&/^(?:help|explain|what (?:is this|does this)|how (?:does|to)|why (?:do|is|are)|помоги|объясни|что (?:это|значит)|как (?:это|настроить|проверить)|зачем|поясни|як це|що це)/iu.test(text)){
      await render(session,brief(locale(),'AI explanations are unavailable right now. Here is the short feature guide; your values remain unchanged.','Сейчас подробное объяснение через AI недоступно. Вот краткое описание функции; введённые данные сохранены.','Зараз докладне пояснення через AI недоступне. Ось короткий опис функції; введені дані збережено.')+'\n\n'+featureIntroduction(session.feature,locale()));return true;
    }
    const media=Boolean(setupAnimation(message)||stickerMedia(message));
    if(session.kind==='feature'&&(message.animation||message.document||message.video||message.photo||message.sticker)&&(!media||['assemble','reaction'].includes(session.feature)&&!setupAnimation(message)||session.feature==='sticker'&&!stickerMedia(message))){
      await render(session,brief(locale(),'That file is not supported here. For GIF use a Telegram animation, GIF file or short MP4; for stickers use a photo, PNG, JPEG or WebP. Your draft is retained.','Этот файл здесь не подходит. Для GIF пришли анимацию Telegram, GIF-файл или короткое MP4; для стикера — фото, PNG, JPEG или WebP. Черновик сохранён.','Цей файл тут не підходить. Для GIF надішли анімацію Telegram, GIF-файл чи коротке MP4; для стікера — фото, PNG, JPEG або WebP. Чернетку збережено.'));return true;
    }
    if(session.kind==='feature'&&media&&!text){await applyInput(session,{},message,bot);return true;}
    if(!text||text.startsWith('/'))return false;
    const selected=ruleRequest.test(text)?'reaction':matchFeature(text)?.id;
    if(selected==='profile'&&session.feature!=='reaction')return false;
    if(session.kind==='menu'&&!session.feature&&!selected&&!newRequest.test(text))return false;
    let turn;
    try {
      if(session.kind==='feature'&&session.fieldFallback)turn={intent:'answer',fields:literalFieldAnswer(nextField(session),text)};
      else if(classifyTurn)turn=JSON.parse(await classifyTurn({kind:session.kind==='feature'?'feature':'feature-menu',feature:session.feature??selected,group:groupLabel(group(session.group),session.group),groups:Object.values(store.state.groups).filter(g=>g.active!==false).map(g=>g.menuLabel||g.title).filter(Boolean),paused:Boolean(session.paused),question:session.kind==='feature'?question(session):'Is this a request to configure this group, a correction to its selected feature, or a question?',message:text.slice(0,4000),attachment:{animation:Boolean(setupAnimation(message)),image:Boolean(stickerMedia(message))},draft:session.kind==='feature'?session:null,commands:(group(session.group).assemble?.games??[]).map(x=>({name:x.name,commandName:commandTitle(x)})),profiles:Object.values(store.state.profiles).map(profileTitle)}));
      else turn={intent:newRequest.test(text)?'setup':'answer',fields:{}};
    }catch {
      if(session.kind!=='feature')return false;
      await render({...session,aiUnavailable:true},brief(locale(),'I cannot interpret the full description right now. Your draft is safe; we can continue one field at a time.','Сейчас не получается разобрать описание целиком. Черновик сохранён; можем продолжить по отдельным полям.','Зараз не вдається розібрати опис цілком. Чернетку збережено; можемо продовжити за окремими полями.'));return true;
    }
    if(turn.intent==='resume'&&session.kind==='feature'){await render({...session,paused:false});return true;}
    if(['conversation'].includes(turn.intent)||!['answer','setup'].includes(turn.intent)) {
      if(session.kind==='feature')setSession({...session,paused:true});
      const feature=turn.feature??selected??session.feature;
      const requestedGroup=groundedFeatureFields(turn.fields,text).groupName,target=requestedGroup?await resolveTarget?.(requestedGroup,bot):null,id=target?.group??session.group;
      message._setupConversationContext=JSON.stringify({group:groupLabel(group(id),id),requestedGroup,feature,description:feature?featureIntroduction(feature,locale()):'',mode:feature?mode(id,feature):null,capabilities:Object.fromEntries([...modeFeatures,'assemble','reaction','sticker','moderation'].map(key=>[key,mode(id,key)])),pending:session.kind==='feature'?question(session):null,commands:(group(id).assemble?.games??[]).map(c=>({name:commandTitle(c),enabled:c.enabled!==false,players:c.players,caption:c.caption})),configuredGames:connectedGames()});
      return false;
    }
    let fields=groundedFeatureFields(turn.fields,text);
    if(fields.groupName){
      const target=await resolveTarget?.(fields.groupName,bot);
      if(target?.group!==session.group){
        if(session.kind==='feature'){await render({...session,exitRequested:true},brief(locale(),'Finish or discard this group’s draft before switching.','Сначала сохрани или отмени изменения этой группы, затем сменим группу.','Спочатку збережи чи скасуй зміни цієї групи, потім змінимо групу.'));return true;}
        if(target?.group){session={kind:'menu',group:target.group};setSession(session);}
        else {
          const feature=turn.feature??(ruleRequest.test(text)?'reaction':session.feature??selected);
          setSession({...session,pendingFeatureInput:{feature,fields,text,media:{animation:message.animation,video:message.video,document:message.document,photo:message.photo,sticker:message.sticker}}});
          await panel(brief(locale(),'Which group should I configure? Choose below; I will retain the details you supplied.','Какую группу настроить? Выбери ниже — переданные детали сохраню.','Яку групу налаштувати? Вибери нижче — передані деталі збережу.'),Object.entries(store.state.groups).filter(([,g])=>g.configured&&g.active!==false).map(([group,g])=>[button(g.menuLabel||g.title,'selectGroup',{group})]),{draft:true});return true;
        }
      }
    }
    if(session.kind==='feature'&&!Object.keys(fields).length)fields=literalFieldAnswer(nextField(session),text);
    if(session.kind==='feature'){await applyInput({...session,paused:false,aiUnavailable:false},fields,message,bot);return true;}
    const feature=turn.feature??(ruleRequest.test(text)?'reaction':session.feature??selected);
    if(!feature||feature==='profile')return false;
    if(modeFeatures.includes(feature)) {
      if(/выключ|disable|turn off|вимк/iu.test(text)){await action({type:'f.mode',feature,value:'off'},session.group,bot);return true;}
      if(feature==='memory'){if(/включ|enable|turn on|увімк/iu.test(text))await action({type:'f.mode',feature,value:'manual'},session.group,bot);else await open(session.group,feature,bot);return true;}
      if(/включ|enable|turn on|увімк/iu.test(text)){await action({type:'f.mode',feature,value:'on'},session.group,bot);return true;}
      await open(session.group,feature,bot);return true;
    }
    if(['assemble','reaction','sticker','moderation'].includes(feature)&&/выключ|disable|turn off|вимк/iu.test(text)){await action({type:'f.mode',feature,value:'off'},session.group,bot);return true;}
    if(session.commandId&&feature==='assemble'&&session.feature==='assemble')await begin(session.group,feature,bot,commandDraft(session.group,session.commandId));
    else if(session.ruleId&&feature==='reaction'&&session.feature==='reaction'&&!/^(?:create|add|создай|добавь|створи|додай).*(?:rule|правил)/iu.test(text))await begin(session.group,feature,bot,ruleDraft(session.group,session.ruleId));
    else if(feature==='assemble'&&!/create|add|созда|добав|створи|додай/iu.test(text)){
      const matches=(group(session.group).assemble?.games??[]).filter(game=>[fields.gameName,fields.commandName].filter(Boolean).some(name=>commandNames(game).some(alias=>normalizedName(alias)===normalizedName(name))));
      await begin(session.group,feature,bot,matches.length===1?commandDraft(session.group,matches[0].id):{});
    }
    else await begin(session.group,feature,bot);
    const draft=store.state.session;
    if(draft.kind==='feature')await applyInput(draft,fields,message,bot);
    return true;
  }

  async function action(a,id,bot) {
    if(!a.type.startsWith('f.'))return false;
    if(!await permitted(id,bot)){await unavailable(id);return true;}
    const l=locale(),op=a.type.slice(2),draft=store.state.session;
    switch(op) {
      case 'selectGroup':{
        const pending=draft?.pendingFeatureInput;
        if(draft?.kind!=='menu'||!pending)break;
        if(pending&&['assemble','reaction','sticker','moderation'].includes(pending.feature)){
          await begin(id,pending.feature,bot);await applyInput(store.state.session,pending.fields,pending.media,bot);
        }else await overview(id,bot);
        break;
      }
      case 'home':if(draft?.kind==='feature')await render({...draft,exitRequested:true});else await overview(id,bot);break;
      case 'continue':await render({...draft,exitRequested:false});break;
      case 'cancel':case 'discard':setSession({kind:'menu',group:id,resume:draft?.resume});await overview(id,bot);break;
      case 'fallback':await render({...draft,fieldFallback:true,aiUnavailable:false});break;
      case 'save':if(draft?.kind==='feature'&&draft.group===id)await save(draft,bot);break;
      case 'edit':await render({...draft,editingPrompt:true,previewed:false});break;
      case 'field':await render({...draft,requestedField:a.field,showFields:false,editingPrompt:false});break;
      case 'choice':if(draft?.kind==='feature'&&draft.group===id){const next={...draft,[a.field]:a.value,previewed:false};delete next.requestedField;if(a.field==='animation')delete next.animationPath;if(a.field==='action'){delete next.targetId;delete next.target;}await applyInput(next,{},null,bot);}break;
      case 'target':if(draft?.kind==='feature'){await render({...draft,targetId:a.id,requestedField:null});}break;
      case 'operator':if(draft?.feature==='moderation'&&draft.operators?.some(x=>x.id===a.id))await render({...draft,operatorIds:draft.operatorIds?.includes(a.id)?draft.operatorIds.filter(x=>x!==a.id):[...(draft.operatorIds??[]),a.id]});break;
      case 'start':await begin(id,a.feature,bot);break;
      case 'game':await showCommand(id,a.id,bot);break;
      case 'rule':await showRule(id,a.id,bot);break;
      case 'editGame':{const values=commandDraft(id,a.id);if(values)await begin(id,'assemble',bot,values);break;}
      case 'editRule':{const values=ruleDraft(id,a.id);if(values)await begin(id,'reaction',bot,values);break;}
      case 'createDependency':await begin(id,'assemble',bot,{dependencyDraft:draft});break;
      case 'triggers':await begin(id,'reaction',bot,{action:a.feature==='judge'?'judge':'assemble',targetId:a.id,announcement:''});break;
      case 'label':await begin(id,'label',bot);break;
      case 'mode':case 'toggle': {
        const feature=a.feature,state=mode(id,feature);
        if(state==='unavailable'){await open(id,feature,bot);break;}
        if(state==='setup'){await begin(id,feature,bot);break;}
        const value=op==='mode'?a.value:['assemble','reaction','sticker','moderation'].includes(feature)?group(id).disabled?.[feature]?'on':'off':state==='off'?'on':'off';
        if(feature==='minigames'&&value==='on'&&!(await checkFeature?.('minigames'))?.ok){await open(id,feature,bot,brief(l,'The game connection check failed. Follow the connection steps and retry.','Проверка игрового подключения не прошла. Выполни шаги подключения и повтори.','Перевірка ігрового підключення не пройшла. Виконай кроки підключення й повтори.'));break;}
        if(feature==='moderation'&&value==='on'&&!await checkModerators(id,group(id).moderation?.userIds,bot)){await open(id,feature,bot,brief(l,'Restore administrator/restriction permissions first.','Сначала восстанови права администраторов и право ограничивать участников.','Спочатку віднови права адміністраторів і право обмежувати учасників.'));break;}
        if(feature==='sticker'&&value==='on'&&stickerConflict(store.state,id,{sticker:group(id).sticker})){await open(id,feature,bot,brief(l,'That pack is already linked to another active group. Disable that binding or choose a different pack first.','Этот пак уже подключён в другой активной группе. Сначала выключи его там или выбери другой пак.','Цей пак уже підключено в іншій активній групі. Спочатку вимкни його там чи вибери інший пак.'));break;}
        store.change(s=>{const g=s.groups[id];if(modeFeatures.includes(feature)){g.modes??={};g.modes[feature]=feature==='memory'&&value==='on'?'manual':value;}else{g.disabled??={};g.disabled[feature]=value==='off';}});
        await open(id,feature,bot,feature==='judge'&&value==='on'?brief(l,'Dispute review is on. Usually you can address me or use /judge. If you like, add your own launch phrase below.','Разбор споров включён. Обычно можно обратиться ко мне или использовать /judge. Если хочешь, добавь вашу фразу запуска ниже.','Розбір суперечок увімкнено. Зазвичай можна звернутися до мене чи використати /judge. Якщо хочеш, додай вашу фразу запуску нижче.'):'');break;
      }
      case 'toggleGame':store.change(s=>{const c=s.groups[id].assemble?.games.find(x=>x.id===a.id);if(c)c.enabled=c.enabled===false;});await showCommand(id,a.id,bot);break;
      case 'toggleRule':store.change(s=>{const r=s.groups[id].rules?.find(x=>x.id===a.id);if(r)r.enabled=r.enabled===false;});await showRule(id,a.id,bot);break;
      case 'delete': {
        const value=a.feature==='assemble'?group(id).assemble?.games.find(x=>x.id===a.id):group(id).rules?.find(x=>x.id===a.id);if(!value)break;
        await panel(heading(id,a.feature)+'\n\n'+brief(l,'Delete “','Удалить «','Видалити «')+literal(a.feature==='assemble'?commandTitle(value):value.phrase)+'»?',[[button(brief(l,'Delete','Удалить','Видалити'),'confirmDelete',{feature:a.feature,id:a.id}),back()]],{group:id});break;
      }
      case 'confirmDelete':store.change(s=>{const g=s.groups[id];if(a.feature==='assemble')g.assemble.games=g.assemble.games.filter(x=>x.id!==a.id);else g.rules=g.rules.filter(x=>x.id!==a.id);});await open(id,a.feature,bot);break;
      case 'agent':await open(id,a.feature,bot,installerRequest(a.feature,l));break;
      case 'miniInfo':await open(id,'minigames',bot,brief(l,'Games need an always-on host and public HTTPS address. Existing suitable hosting/domain can be reused. Ask the installation agent to check the bot’s location, game state and costs before any purchase; then configure services and BotFather.','Играм нужны постоянно работающий компьютер или сервер и защищённый адрес в интернете. Подходящие сервер и домен можно использовать повторно. Попроси агента установки проверить размещение бота, игровые данные и расходы до покупки, затем настроить сервисы и BotFather.','Іграм потрібні постійно працюючий комп’ютер або сервер і захищена адреса в інтернеті. Придатні сервер і домен можна використати повторно. Попроси агента встановлення перевірити розміщення бота, ігрові дані й витрати до покупки, потім налаштувати сервіси й BotFather.'));break;
      case 'check': {
        if(a.feature==='status'){await open(id,'status',bot);break;}
        if(a.feature==='rights'){if(draft?.kind==='feature')await render(draft);else await open(id,draft?.feature??'status',bot);break;}
        const ok=a.feature==='moderation'?await checkModerators(id,group(id).moderation?.userIds,bot):Boolean((await checkFeature?.(a.feature))?.ok);
        await open(id,a.feature,bot,ok?brief(l,'The configured connection/permissions check passed. Test the actual feature using its example; reachability does not verify a Telegram launch.','Проверка подключения или прав прошла. Работу функции проверь по её примеру; доступный адрес ещё не подтверждает запуск игры в Telegram.','Перевірка підключення чи прав пройшла. Роботу функції перевір за її прикладом; доступна адреса ще не підтверджує запуск гри в Telegram.'):brief(l,'The check did not pass. Restore permissions or complete the connection, then retry.','Проверка не прошла. Восстанови права или заверши подключение, затем повтори.','Перевірка не пройшла. Віднови права чи заверши підключення, потім повтори.'));break;
      }
      case 'test': {
        const command=a.feature==='assemble'&&group(id).assemble?.games.find(x=>x.id===a.id),rule=a.feature==='reaction'&&group(id).rules?.find(x=>x.id===a.id);
        const state=mode(id,a.feature),ready=command?command.enabled!==false&&!group(id).disabled?.assemble:rule?availableRuleAction(group(id),rule,store.state.profiles):!['off','setup','unavailable'].includes(state);
        const prerequisite=ready?'':brief(l,'First complete the connection/setup and enable this feature or saved action. A missing referenced command needs to be selected again.','Сначала заверши подключение или настройку и включи функцию или сохранённое действие. Если связанная команда удалена, выбери существующую.','Спочатку заверши підключення чи налаштування й увімкни функцію чи збережену дію. Якщо пов’язану команду видалено, вибери наявну.');
        const history=a.feature==='voice'&&group(id).modes?.history==='off'?brief(l,'Turn history on for the context test. A voice replying to me can be tested separately.','Для проверки контекста включи историю. Голосовой ответ мне можно проверить отдельно.','Для перевірки контексту увімкни історію. Голосову відповідь мені можна перевірити окремо.'):'';
        const notice=[prerequisite,history,featureTest(a.feature,l,{group:groupLabel(group(id),id),botName:store.profile(id)?.displayName??'Bot',command,rule,configuredGames:connectedGames()})].filter(Boolean).join('\n\n');
        if(command)await showCommand(id,a.id,bot,notice);else if(rule)await showRule(id,a.id,bot,notice);else await open(id,a.feature,bot,notice);break;
      }
      default:return false;
    }
    return true;
  }
  return {open,begin,handle,action,rows,question,mode};
}
