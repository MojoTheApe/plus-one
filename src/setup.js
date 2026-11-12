import { renderTelegramHtml, escapeTelegramMarkdown as literal } from "./telegram-format.js";
import { randomUUID, createHash } from "node:crypto";
import { createRuleEditor, ruleListRequest } from "./setup-rules.js";
import { ruleRequest } from "./message-rules.js";
import { createSetupControls } from "./setup-controls.js";
import {
  assignGroupProfile, assignmentIntent, creationIntent, initialProfileSettings,
  isSetupRequest, profileListIntent, profileTitle, releaseInactiveStickerBindings, selectProfile, stickerConflict,
} from "./setup-profiles.js";
import { actionableAssembleText, normalizeGamePlayers } from "./assemble.js";
import { escapeRegex, parseBotCommandText } from "./helpers.js";
import { catalogue, introduction, setupSections, editableGroupFeature, featureDetail, featureName, matchFeature, modeFeatures, modeLabel, modeOptions, say } from "./setup-copy.js";

const normalize = text => String(text ?? "").normalize("NFKC").trim().toLowerCase();
const isGroup = chat => ["group", "supergroup"].includes(chat?.type);
const activeMember = member => ["creator", "administrator", "member"].includes(member?.status) ||
  (member?.status === "restricted" && member.is_member === true);
const yes = /^(?:yes(?:[, ]+(?:please|save(?: it)?|enable(?: it)?))?|yep|sure|save(?: it)?|confirm|apply|go ahead|да(?:[, ]+(?:сохрани|применяй|включай))?|сохрани(?:ть| настройки)?|сохраняй(?: настройки)?|давай сохраним|применяй|включай|подтверждаю|так(?:[, ]+(?:збережи|застосуй|вмикай))?|збережи|зберігай|застосуй|вмикай)[.!]*$/iu;
const cancel = /^(?:\/cancel|cancel|later|done|отмена|отмени|позже|готово|не сейчас|скасуй|скасувати|пізніше)(?:[\s,.!]|$)/iu;
// Only standalone positive commands bypass semantic classification. A mention
// of returning in a question or a negative must leave the old preview paused.
const resume = /^(?:(?:please )?(?:resume|continue|back to)(?: the)? (?:setup|configuration|draft)|(?:давай )?продолжим настройку|верн[её]мся к настройке|назад к настройке|(?:давай )?продовжимо налаштування|повернімося до налаштування)[.!]*$/iu;
const configure = /configure|set up|enable|disable|turn (?:on|off)|настро|включ|выключ|налашту|увімк|вимк|созда(?:й|дим|ть)|добав(?:ь|им|ить)|create|add|створи|додай/iu;
const draftKinds = new Set(["persona", "group", "assignment", "rule"]);
const helpRequest = /^(?:how|what|tell me|show me|расскажи|покажи|как|что|розкажи|як|що)(?:\s|$)/iu;
const catalogueRequest = /catalog|features|abilities|список.*функц|возможност|функции|можливост|функції/iu;
const profileViewRequest = /group profile|профиль группы|профіль групи|what.s enabled|что включено|що увімкнено/iu;
const noAnimation = /^(?:no|skip|none|нет|пропусти|ні)[.!]?$|(?:no animation|без анимации|без анімації)/iu;

function readTurnIntent(raw) {
  const { intent } = JSON.parse(raw);
  if (!["answer", "conversation", "resume", "setup"].includes(intent)) throw new Error("Invalid setup intent");
  return { ...JSON.parse(raw), intent };
}

function localeOf(text, fallback) {
  if (/[іїєґ]|(?:^|\s)(?:також|українською|мене звати|збережи|відповідай|мовою)(?=\s|$)/iu.test(text)) return "uk";
  if (/[а-яё]/iu.test(text)) return "ru";
  return /[a-z]{2,}/iu.test(text) ? "en" : fallback;
}

function readLanguage(text) {
  const value = normalize(text);
  if (/match|whatever language|same language|as they write|собеседник|на котором|как пишут|співрозмовник|якою пишуть/i.test(value)) return "match-request";
  if (/ukrainian|украин|україн/i.test(value) || /^(uk|ua)$/.test(value)) return "uk";
  if (/russian|русск|російськ/i.test(value) || value === "ru") return "ru";
  if (/english|английск|англійськ/i.test(value) || value === "en") return "en";
  return null;
}

function languageText(locale, language) {
  switch (language) {
    case "match-request": return say(locale, "the language of whoever writes to me", "язык собеседника", "мова співрозмовника");
    case "uk": return say(locale, "Ukrainian", "украинский", "українська");
    case "ru": return say(locale, "Russian", "русский", "російська");
    default: return say(locale, "English", "английский", "англійська");
  }
}

function personaQuestion(draft, targetTitle) {
  if (draft.flowVersion === 2 || draft.editMenu || draft.editorField) return personaQuestionV2(draft, targetTitle);
  const { locale, language } = draft;
  const name = literal(draft.name), personality = literal(draft.personality);
  if (!draft.name) return draft.makeDefault && locale === "en" ?
    "> connection open\nYou there? Looks like I made it through. What do you want to call me?" :
    say(locale, "What name should I use?", "Какое имя мне использовать?", "Яке ім’я мені використовувати?");
  if (!draft.personality) return say(locale,
    `Okay. I’m ${name}. Now tell me what I’m like. Describe me like you’d describe someone you know. How do I talk? What do I find funny? How do I act when things get serious? A couple of lines in your own words is enough.`,
    `Хорошо, я ${name}. Теперь опиши меня, как описал бы знакомого. Как я разговариваю, над чем смеюсь и как веду себя, когда разговор серьёзный? Пары строк своими словами достаточно.`,
    `Добре, я ${name}. Тепер опиши мене, як описав би знайомого. Як я розмовляю, над чим сміюся і як поводжуся, коли розмова серйозна? Достатньо кількох рядків своїми словами.`);
  if (!language) return say(locale,
    "One more thing. What language should I reply in? You can pick one or ask me to use whatever language people write to me in.",
    "На каком языке мне отвечать? Можно выбрать один язык или отвечать на языке собеседника.",
    "Якою мовою мені відповідати? Можна вибрати одну мову або відповідати мовою співрозмовника.");
  const label = draft.label && draft.label !== name ? say(locale,
    `Profile “${literal(draft.label)}”\n`, `Профиль «${literal(draft.label)}»\n`, `Профіль «${literal(draft.label)}»\n`) : "";
  const target = targetTitle ? say(locale, `For ${literal(targetTitle)}\n`, `Группа «${literal(targetTitle)}»\n`, `Група «${literal(targetTitle)}»\n`) : "";
  return label + target + say(locale,
    `I’m ${name}. My character and behavior\n${personality}\n\nReply language — ${languageText(locale, language)}. Save that, or tell me what to change?`,
    `Я ${name}. Мой характер и поведение\n${personality}\n\nЯзык ответов — ${languageText(locale, language)}. Сохранить или хочешь что-то изменить?`,
    `Я ${name}. Мій характер і поведінка\n${personality}\n\nМова відповідей — ${languageText(locale, language)}. Зберегти чи хочеш щось змінити?`);
}

function editPersonaLegacy(draft, text) {
  const value = text.trim();
  if (!value || value.startsWith("/")) return;
  if (draft.name && draft.personality && draft.language) {
    if (/^(?:change|edit|поменяй|измени|зміни)/iu.test(value)) {
      if (/language|язык|мов/iu.test(value)) draft.language = null;
      else if (/name|имя|ім[’'ʼ]я/iu.test(value)) draft.name = null;
      else if (/personality|character|характер/iu.test(value)) draft.personality = null;
    }
    return;
  }
  if (!draft.name) {
    const named = value.match(/^(?:call (?:me|yourself)|your name is|назовись|називайся|назвися)\s+([^,;\n]+)(?:[,;\n]\s*(.+))?$/isu);
    const name = (named?.[1] ?? value).trim().replace(/^[«"“]|[»"”]$/g, "");
    if (name.length > 80 || !name || name.includes("\n")) return;
    draft.name = name;
    if (named?.[2] && !draft.personality) {
      const rest = named[2].trim();
      const language = readLanguage(rest);
      const personality = rest.replace(/(?:\s+(?:and|in|и|і)\s+)?(?:по[- ](?:украински|русски|английски)|українською|in (?:english|russian|ukrainian))\s*[.!]?$/iu, "").trim();
      if (personality && !/^(?:speak|reply|answer|отвечай|відповідай)$/iu.test(personality) && personality.length <= 1200) draft.personality = personality;
      if (language && !draft.language) {
        draft.language = language;
        draft.locale = language === "match-request" ? localeOf(rest, draft.locale) : language;
      }
    }
  } else if (!draft.personality) {
    if (value.length <= 1200) draft.personality = value;
  } else {
    const language = readLanguage(value);
    if (language) {
      draft.language = language;
      draft.locale = language === "match-request" ? localeOf(value, draft.locale) : language;
    }
  }
}

function validName(value) {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= 80 && !/[\n\r\u0000-\u001f]/u.test(value);
}

function initialNames(text, draft, extracted = {}) {
  const capture = pattern => pattern.exec(text)?.[1]?.trim();
  const supplied = key => {
    if (!validName(extracted[key])) return;
    const match = new RegExp(`(?<![\\p{L}\\p{M}\\p{N}_])${escapeRegex(extracted[key].trim())}(?![\\p{L}\\p{M}\\p{N}_])`, "iu").exec(text);
    return match?.[0];
  };
  const owner = supplied("ownerName") ?? capture(/(?:my name is|меня зовут|мене звати)\s+([^,;.!?\n]+)/iu);
  const bot = supplied("botName") ?? capture(/(?:your name is|call yourself|тебя зовут|тебе звати|назовись|називайся|назвися)\s+([^,;.!?\n]+)/iu) ??
    capture(/(?:^|[,;.!?]\s*|\s)(?:and\s+)?you(?:'re| are)\s+([^,;.!?\n]+)/iu) ??
    capture(/(?:^|[,;.!?]\s*|\s)(?:а\s+)?(?:ты|ти)\s+[—–-]?\s*([\p{L}][\p{L}\p{M} '-]{0,79})(?=[,;.!?\n]|$)/iu);
  const pairedOwner = bot ? capture(/(?:^|[.!?]\s*)(?:I(?:'m| am)|я)\s*[—–-]?\s*([^,;.!?\n]+)/iu) : undefined;
  const onlyValue = text.trim().replace(/^[«"“]|[»"”]$/g, "");
  const simple = /^[\p{L}\p{M}][\p{L}\p{M} .'-]{0,79}$/u.test(onlyValue) && !/^(?:yes|no|save|hello|hi|да|нет|привет|так|ні|save it)$/iu.test(onlyValue);
  if (!draft.ownerName && validName(owner ?? pairedOwner)) draft.ownerName = (owner ?? pairedOwner).trim();
  if (!draft.name && validName(bot)) draft.name = bot.trim();
  if (simple && draft.namesClarification === "owner" && !draft.ownerName) draft.ownerName = onlyValue;
  if (simple && draft.namesClarification === "bot" && !draft.name) draft.name = onlyValue;
  if (!draft.ownerName || !draft.name) draft.namesClarification = draft.ownerName ? "bot" : draft.name ? "owner" : "both";
  else delete draft.namesClarification;
}

function personaComplete(draft) {
  return draft.name && draft.language && draft.personality && (!draft.onboarding || draft.ownerName);
}

function personaQuestionV2(draft, targetTitle) {
  const locale = draft.locale;
  if (draft.editMenu) return say(locale, "What would you like to change?", "Что хочешь изменить?", "Що хочеш змінити?");
  if (draft.editorField === "name") return say(locale, "What should I be called?", "Как меня назвать?", "Як мене назвати?");
  if (draft.editorField === "personality") return say(locale, "What should my character be? Describe how I should talk and behave.",
    "Каким будет мой характер? Опиши, как мне общаться и вести себя.", "Яким буде мій характер? Опиши, як мені спілкуватися й поводитися.");
  if (draft.onboarding && (!draft.ownerName || !draft.name)) {
    if (draft.namesClarification === "owner") return "What should I call you?";
    if (draft.namesClarification === "bot") return "What do you want to call me?";
    if (draft.namesClarification) return "Tell me both names — for example, ‘I’m Alex, your name is River’.";
    return "> connection open\nYou there? Looks like I made it through.\n\nWho’s on the other end? What should I call you, and what do you want to call me?";
  }
  if (!draft.name) return say(locale, "What name should I use?", "Какое имя мне использовать?", "Яке ім’я мені використовувати?");
  if (!draft.language || draft.editorField === "language") return draft.onboarding && !draft.editorField ?
    "All right. I have a name now.\n\nBefore we go further — what language should I reply in?" :
    say(locale, "What language should I reply in?", "На каком языке мне отвечать?", "Якою мовою мені відповідати?");
  if (!draft.personality) return say(locale,
    `Okay${draft.ownerName ? ", " + literal(draft.ownerName) : ""}. I’m ${literal(draft.name)}.\n\nNow describe me as if we already knew each other. How do I talk, what makes me laugh, and how do I act when things get serious?\n\nA couple of lines in your own words is enough.`,
    `Хорошо${draft.ownerName ? ", " + literal(draft.ownerName) : ""}. Я ${literal(draft.name)}.\n\nТеперь опиши меня так, будто мы уже знакомы. Как я разговариваю, над чем смеюсь и как веду себя, когда разговор серьёзный?\n\nПары строк своими словами достаточно.`,
    `Добре${draft.ownerName ? ", " + literal(draft.ownerName) : ""}. Я ${literal(draft.name)}.\n\nТепер опиши мене так, ніби ми вже знайомі. Як я розмовляю, над чим сміюся і як поводжуся, коли розмова серйозна?\n\nДостатньо кількох рядків своїми словами.`);
  return (targetTitle ? literal(targetTitle) + "\n\n" : "") + say(locale,
    `**Here’s what we have**\n\n**Name:** ${literal(draft.name)}\n**Language:** ${languageText(locale, draft.language)}\n**Character:** ${literal(draft.personality)}\n\nSave this profile?`,
    `**Вот что получилось**\n\n**Имя:** ${literal(draft.name)}\n**Язык:** ${languageText(locale, draft.language)}\n**Характер:** ${literal(draft.personality)}\n\nСохраняем?`,
    `**Ось що вийшло**\n\n**Ім’я:** ${literal(draft.name)}\n**Мова:** ${languageText(locale, draft.language)}\n**Характер:** ${literal(draft.personality)}\n\nЗберігаємо?`);
}

function beginPersonaField(draft, field) {
  return { ...draft, flowVersion: 2, editMenu: false, editorField: field,
    editorBefore: { name: draft.name, personality: draft.personality, language: draft.language, locale: draft.locale } };
}

function editPersona(draft, text, extracted) {
  if (draft.flowVersion !== 2 && !draft.editorField && !draft.editMenu) return editPersonaLegacy(draft, text);
  const value = text.trim();
  if (!value || value.startsWith("/")) return;
  const compact = !draft.editorField && (!draft.name || !draft.language) && /(?:call (?:me|yourself)|your name is|назовись|називайся|назвися)\s+/iu.exec(value);
  if (compact && (!draft.onboarding || !/^call me\s/iu.test(compact[0]))) {
    const supplied = {};
    editPersonaLegacy(supplied, value.slice(compact.index));
    if (supplied.name) {
      if (draft.name) {
        draft.name = supplied.name;
        if (supplied.language) { draft.language = supplied.language; draft.locale = supplied.locale; }
      } else Object.assign(draft, supplied);
    }
    if (draft.onboarding) initialNames(value, draft, extracted);
    return;
  }
  if (draft.editorField) {
    const field = draft.editorField;
    if (field === "language") {
      const language = readLanguage(value);
      if (!language) return;
      draft.language = language;
      draft.locale = language === "match-request" ? draft.accountLocale || draft.locale : language;
    } else if ((field === "name" && validName(value)) || (field === "personality" && value.length <= 1200)) draft[field] = value;
    else return;
    delete draft.editorField; delete draft.editorBefore;
    return;
  }
  if (draft.editMenu) return;
  if (draft.onboarding && (!draft.ownerName || !draft.name)) {
    initialNames(value, draft, extracted);
    return;
  }
  if (!draft.name) { if (validName(value)) draft.name = value; return; }
  if (!draft.language) {
    const language = readLanguage(value);
    if (language) { draft.language = language; draft.locale = language === "match-request" ? draft.accountLocale || draft.locale : language; }
    return;
  }
  if (!draft.personality) { if (value.length <= 1200) draft.personality = value; return; }
  if (/^(?:change|edit|поменяй|измени|зміни)/iu.test(value)) {
    const field = /language|язык|мов/iu.test(value) ? "language" : /name|имя|ім[’'ʼ]я/iu.test(value) ? "name" : /personality|character|характер/iu.test(value) ? "personality" : null;
    if (field) Object.assign(draft, beginPersonaField(draft, field));
  }
}

function mentionsGroup(title, text) {
  const value = normalize(text);
  const name = normalize(title);
  if (value === name) return true;
  const withoutLinks = value.replace(/https?:\/\/\S+/giu, " ");
  return new RegExp(`(?<![\\p{L}\\p{N}_@])${escapeRegex(name)}(?![\\p{L}\\p{N}_])`, "u").test(withoutLinks);
}

function groupChoice(groups, text, allowNumber) {
  const value = normalize(text);
  const exactId = groups.find(([id]) => value === id)?.[0];
  if (exactId) return exactId;
  if (allowNumber && /^\d+$/.test(value)) return groups[Number(value) - 1]?.[0];
  const matches = groups.filter(([, group]) => mentionsGroup(group.title, text));
  const longest = Math.max(0, ...matches.map(([, group]) => group.title.length));
  const best = matches.filter(([, group]) => group.title.length === longest);
  return best.length === 1 ? best[0][0] : undefined;
}

function pickGame(games, text) {
  const words = value => ` ${normalize(value).replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `;
  const value = words(text);
  const selected = games.filter(game => [game.id, game.name, ...game.aliases].some(alias => value.includes(words(alias))));
  return selected.length === 1 ? selected[0] : null;
}

function playerNames(text) {
  const names = [...text.matchAll(/(?<![\w@])@([A-Za-z0-9_]{5,32})(?!\w)/g)].map(match => match[1]);
  return names.length ? normalizeGamePlayers(names, "setup") : null;
}

function readMode(feature, text) {
  if (/disable|turn off|^off$|выключ|вимк/iu.test(text)) return "off";
  const withModes = feature === "memory";
  if (withModes && /automatic|автомат|автоответ|автовідпов/iu.test(text)) return "auto";
  if (/enable|turn on|^on$|включ|увімк|on request|when addressed|по просьбе|при обращении|за запитом|при зверненні/iu.test(text)) return withModes ? "manual" : "on";
  return undefined;
}

export function createSetup({ store, games, telegram, featureMode, classifyTurn, checkFeature }) {
  const controls = createSetupControls({ store, telegram });
  let editMessageId;
  async function observe(update, bot = { id: store.state.botId }) {
    const event = update.my_chat_member ?? update.message;
    if (!isGroup(event?.chat) || !Number.isSafeInteger(event.chat.id) || !event.chat.title) return;
    const membership = update.my_chat_member;
    if (!membership && event.from?.id !== store.ownerId && !store.group(event.chat.id)) return;
    const { id, title } = event.chat;
    const wasKnown = store.group(id);
    const leaving = membership && !activeMember(membership.new_chat_member);
    const arriving = membership && activeMember(membership.new_chat_member) && !activeMember(membership.old_chat_member);
    if (!wasKnown || wasKnown.title !== title || membership) store.change(state => {
      const group = state.groups[id] ?? { configured: false, awaitingProfile: true };
      state.groups[id] = { ...group, title };
      if (leaving) state.groups[id].active = false;
      if (arriving) {
        state.groups[id].active = true;
        if (!group.configured) Object.assign(state.groups[id], { awaitingProfile: true, notificationId: null, notificationStage: null });
      }
    });
    const group = store.group(id);
    if (leaving || group.configured || (!group.awaitingProfile && wasKnown)) return;
    await showGroupConnection(String(id), bot, store.state.locale);
  }

  async function showGroupConnection(id, bot, locale, force = false) {
    const group = store.group(id);
    if (!group?.title || group.active === false) return;
    const ready = Boolean(bot?.id && await allowedGroup(id, bot, "assign"));
    const stage = ready ? "profile" : "admin";
    if (!force && (group.notificationStage === stage && group.notificationId ||
      group.notificationAttemptStage === stage && group.notificationAttemptedAt && Date.now() - group.notificationAttemptedAt < 60000)) return;
    const text = ready ? say(locale,
      `**Group “${literal(group.title)}” connected ✅**\n\nWhich profile should I use here? Choose an existing one or create another.`,
      `**Группа «${literal(group.title)}» подключена ✅**\n\nКакой профиль использовать здесь? Выбери уже созданный или создай другой для этой группы.`,
      `**Групу «${literal(group.title)}» підключено ✅**\n\nЯкий профіль використовувати тут? Вибери створений або створи інший для цієї групи.`) : say(locale,
      `I’m already in **“${literal(group.title)}”** 👋\n\nMake me an administrator of that group, then we can continue.`,
      `Я уже в группе **«${literal(group.title)}»** 👋\n\nОсталось назначить меня администратором. После этого продолжим настройку.`,
      `Я вже в групі **«${literal(group.title)}»** 👋\n\nЗалишилося призначити мене адміністратором. Потім продовжимо налаштування.`);
    const rows = ready ? [...Object.entries(store.state.profiles).map(([profile, record]) =>
      [button(say(locale, "Use ", "Использовать ", "Використати ") + profileTitle(record), "useProfile", { profile })]),
      [button(say(locale, "Create another profile", "Создать другой профиль", "Створити інший профіль"), "createForGroup")]] :
      [[button(say(locale, "Check rights", "Проверить права", "Перевірити права"), "checkRights")]];
    store.change(state => { state.groups[id].notificationAttemptedAt = Date.now(); state.groups[id].notificationAttemptStage = stage; });
    try {
      const sent = await sendPanel(text, rows, { group: id });
      if (Number.isSafeInteger(sent?.message_id)) store.change(state => {
        state.groups[id].notificationId = sent.message_id;
        state.groups[id].notificationStage = stage;
      });
    } catch { /* Discovery remains in My groups; a later event/user retry can recover. */ }
  }

  const setSession = session => store.change(state => {
    const previous = state.session;
    const fields = value => JSON.stringify({ ...value, _turn: undefined, _back: undefined, paused: undefined, resume: undefined });
    // Keep actual prior requested fields, not a guessed order of populated keys.
    // In particular, editing players must never erase an already-saved GIF.
    if (draftKinds.has(session?.kind) && session._turn === previous?._turn &&
      session.kind === previous?.kind && !session.paused && !previous.paused && fields(session) !== fields(previous)) {
      const { _back, ...snapshot } = previous;
      session = { ...session, _back: [...(_back ?? []).slice(-31), snapshot] };
    }
    state.session = session;
  });
  const button = (text, type, values = {}) => ({ text, action: { type, ...values } });
  const inputButton = (text, input) => button(text, "input", { input });
  function profileRows(group) {
    return Object.entries(store.state.profiles).map(([profile, record], index) =>
      [button(`${index + 1}. ${profileTitle(record)}`, "profile", { profile, group })]);
  }
  function newPersona(locale, values = {}) {
    const onboarding = !store.state.defaultProfile;
    return { kind: "persona", flowVersion: 2, accountLocale: store.state.telegramLocale || locale,
      onboarding, locale: onboarding ? "en" : locale, ...values };
  }
  function welcomeRows(locale) {
    return [[button(say(locale, "Add to group", "Добавить в группу", "Додати до групи"), "addGroup")],
      [button(say(locale, "View features", "Посмотреть функции", "Переглянути функції"), "catalogue")]];
  }
  function rootRows(bot, locale) {
    return [[button(say(locale, "My groups", "Мои группы", "Мої групи"), "groups")],
      [button(say(locale, "Profiles", "Профили", "Профілі"), "profiles")],
      [{ text: say(locale, "Add to group", "Добавить в группу", "Додати до групи"), action: { type: "addGroup" } }],
      [button(say(locale, "How it works", "Как это устроено", "Як це влаштовано"), "intro")]];
  }
  function sectionRows(locale) {
    return [...setupSections.map(([section, title]) => [button(say(locale, ...title), "section", { section })]),
      [button(say(locale, "Change personality", "Сменить личность", "Змінити особистість"), "chooseProfile")],
      [button(say(locale, "Later", "Позже", "Пізніше"), "finish")]];
  }
  function draftRows(session, locale) {
    const rows = [];
    if (session.kind === "persona") {
      if (session.editMenu) return [
        [button(say(locale, "My name", "Моё имя", "Моє ім’я"), "personaField", { field: "name" })],
        [button(say(locale, "Character", "Характер", "Характер"), "personaField", { field: "personality" })],
        [button(say(locale, "Language", "Язык", "Мова"), "personaField", { field: "language" })],
        [button(say(locale, "Back", "Назад", "Назад"), "personaBack")]];
      const languagePending = session.editorField === "language" || (session.flowVersion === 2 && !session.language && session.name && (!session.onboarding || session.ownerName));
      if (languagePending) rows.push([inputButton("English", "English"), inputButton("Русский", "Русский"), inputButton("Українська", "Українська")],
        [inputButton(say(locale, "Match the speaker’s language", "Язык собеседника", "Мова співрозмовника"), "match")]);
      if (session.editorField) return [...rows, [button(say(locale, "Back", "Назад", "Назад"), "personaBack")]];
      if (personaComplete(session)) return [[inputButton(say(locale, "Save profile", "Сохранить профиль", "Зберегти профіль"), "save"),
        button(say(locale, "Edit", "Изменить", "Змінити"), "personaMenu")]];
      if (session.flowVersion === 2) return rows;
      if (!session.language && session.name && session.personality) {
        rows.push([inputButton("English", "English"), inputButton("Русский", "Русский"), inputButton("Українська", "Українська")]);
      }
      if (session.name && session.personality && session.language) rows.push([inputButton(say(locale, "Save", "Сохранить", "Зберегти"), "save")]);
    } else if (session.kind === "assignment") {
      if (session.profile === undefined) rows.push(...profileRows(session.group));
      else rows.push([inputButton(say(locale, "Apply", "Применить", "Застосувати"), "save")]);
    } else if (session.kind === "group") {
      if (modeFeatures.includes(session.feature) && !session.mode) {
        if (session.feature === "memory") rows.push([inputButton(say(locale, "On request", "По просьбе", "За проханням"), "on request"), inputButton(say(locale, "From requests", "Из обращений", "Зі звернень"), "automatic")]);
        else rows.push([inputButton(say(locale, "On", "Включить", "Увімкнути"), "on")]);
        rows.push([inputButton(say(locale, "Off", "Выключить", "Вимкнути"), "off")]);
      } else if (session.feature === "assemble" && !session.game) {
        rows.push(...games.map(game => [inputButton(game.name, game.name)]));
      } else if (session.feature === "assemble" && session.players && session.animation === undefined) {
        rows.push([inputButton(say(locale, "Skip animation", "Без анимации", "Без анімації"), "no animation")]);
      }
      if (session.feature === "moderation") rows.push(...(session.operators ?? []).map(user =>
        [button((session.userIds?.includes(user.id) ? "✓ " : "") + user.name, "operator", { id: user.id })]));
      if (groupDraftComplete(session)) rows.push([inputButton(
        modeFeatures.includes(session.feature) || session.editField || session.operation === "disable"
          ? say(locale, "Save", "Сохранить", "Зберегти")
          : say(locale, "Save and enable", "Сохранить и включить", "Зберегти й увімкнути"), "save")]);
    } else if (session.kind === "rule") {
      if (session.phrase && !session.action) rows.push(...["judge", "assemble", "animation", "persona"].map(action =>
        [inputButton(({ judge: say(locale, "Review dispute", "Разобрать спор", "Розібрати суперечку"), assemble: say(locale, "Call players", "Собрать игроков", "Зібрати гравців"), animation: "GIF", persona: say(locale, "Change personality", "Сменить личность", "Змінити особистість") })[action], action)]));
      if (session.action?.type === "persona" && !session.action.profile) rows.push(...Object.entries(store.state.profiles).map(([, profile]) => [inputButton(profileTitle(profile), profileTitle(profile))]));
      if (session.action?.type === "assemble" && !session.action.game) rows.push(...games.map(game => [inputButton(game.name, game.name)]), [inputButton(say(locale, "Everyone", "Всех", "Усіх"), "everyone")]);
      const actionReady = session.action && (session.action.type === "judge" || session.action.profile || session.action.game || session.action.animation);
      if (actionReady && !session.access) rows.push([inputButton(say(locale, "Only owner", "Только владелец", "Лише власник"), "owner"), inputButton(say(locale, "Members", "Участники", "Учасники"), "members")]);
      if (actionReady && session.access && session.announcement === undefined) rows.push([inputButton(say(locale, "Skip announcement", "Без объявления", "Без оголошення"), "skip")]);
      if (session.deleteId || (actionReady && session.access && session.announcement !== undefined)) rows.push([inputButton(say(locale, "Save", "Сохранить", "Зберегти"), "save")]);
    }
    rows.push([button(say(locale, "Back", "Назад", "Назад"), "backDraft"), inputButton(say(locale, "Cancel", "Отмена", "Скасувати"), "/cancel")]);
    return rows;
  }
  function groupDraftComplete(draft) {
    return modeFeatures.includes(draft.feature) ? Boolean(draft.mode) : draft.operation !== "set" ||
      (draft.feature === "assemble" ? draft.game && draft.players && draft.animation !== undefined :
        draft.feature === "reaction" ? draft.terms && draft.animation : draft.feature === "moderation" ? draft.userIds?.length : draft.packName);
  }
  function currentRows(bot, locale) {
    const session = store.state.session;
    if (draftKinds.has(session?.kind) && !session.paused) return draftRows(session, locale);
    if (session?.kind === "discover") return [[button(say(locale, "Show me", "Да, расскажи", "Так, розкажи"), "intro"), button(say(locale, "Later", "Позже", "Пізніше"), "finish")]];
    if (session?.kind === "invitation") return [[button(say(locale, "Configure features", "Настроить функции", "Налаштувати функції"), "group", { group: session.group }), button(say(locale, "Later", "Позже", "Пізніше"), "finish")]];
    if (session?.kind === "welcome") return welcomeRows(locale);
    if (session?.kind === "catalogue") return [[button(say(locale, "Add to group", "Добавить в группу", "Додати до групи"), "addGroup")], [button(say(locale, "Back", "Назад", "Назад"), "intro")]];
    return session?.group && store.group(session.group)?.configured ? sectionRows(locale) : rootRows(bot, locale);
  }
  async function sendPanel(text, rows, { group, draft = false } = {}) {
    const target = store.group(group);
    const heading = target ? `${literal(target.title)} (${group})` : "";
    const duplicateTitle = target && groupEntries().some(([id, item]) => id !== String(group) && normalize(item.title) === normalize(target.title));
    if (heading && !text.includes(heading) && (!text.includes(literal(target.title)) || duplicateTitle && !text.includes(`(${group})`))) text = heading + "\n\n" + text;
    const markup = controls.markup(rows, { group, draft });
    // Edit only a confirmed callback's original private message. Notifications
    // and ordinary setup replies always create their own message.
    if (editMessageId && text.length <= 3900) {
      try { return await telegram("editMessageText", { chat_id: store.ownerId, message_id: editMessageId, text: renderTelegramHtml(text), parse_mode: "HTML", reply_markup: markup }); }
      catch { /* Deleted/uneditable message: the same state is shown anew. */ }
    }
    while (text.length > 3900) {
      const split = text.lastIndexOf("\n", 3900);
      const length = split > 0 ? split : 3899;
      await telegram("sendMessage", { chat_id: store.ownerId, text: renderTelegramHtml(text.slice(0, length)), parse_mode: "HTML" });
      text = text.slice(length).trimStart();
    }
    return telegram("sendMessage", { chat_id: store.ownerId, text: renderTelegramHtml(text), parse_mode: "HTML", reply_markup: markup });
  }
  const pendingDraft = session => draftKinds.has(session?.kind) ? session : draftKinds.has(session?.resume?.kind) ? session.resume : null;
  const keepDraft = draft => {
    const previous = pendingDraft(store.state.session);
    if (previous) draft.resume = { ...previous, paused: true };
    return draft;
  };
  const groupEntries = () => Object.entries(store.state.groups).filter(([, group]) => group.title && group.active !== false);
  const settingIsOn = (group, id) => Boolean((group?.[id] || (id === "reaction" && group?.rules?.length)) && !group.disabled?.[id]);
  const ruleEditor = createRuleEditor({ store, games, targetPrompt: configurationPrompt, resolveTarget: resolveConfigurationTarget, onDraft: setSession });
  function showCatalogue(locale) {
    const session = store.state.session;
    return catalogue(locale, feature => {
      const available = featureMode(session?.group, feature);
      if (available === "unavailable") return available;
      if (!modeFeatures.includes(feature)) return undefined;
      return session?.profileId ? store.state.profiles[session.profileId]?.settings?.modes?.[feature] : available;
    });
  }

  function draftQuestion(draft, locale) {
    if (draft.kind === "persona") return askPersona(draft);
    if (draft.kind === "group") return groupQuestion(draft, locale);
    if (draft.kind === "assignment") return assignmentQuestion(draft, locale);
    return ruleEditor.question(draft, locale);
  }

  async function resolveConfigurationTarget(text, bot) {
    const group = groupChoice(groupEntries(), text, true);
    if (group && await allowedGroup(group, bot, true)) return { group };
    return null;
  }

  function configuration(draft) {
    return draft.profileId ? null : store.group(draft.group);
  }

  function profileList(locale) {
    const entries = Object.values(store.state.profiles).map(profile => "• " + literal(profileTitle(profile)));
    return say(locale, "Available profiles", "Доступные профили", "Доступні профілі") + "\n" +
      (entries.join("\n") || say(locale, "Create a new profile to get started.", "Начни с сообщения «создай новый профиль».", "Почни з повідомлення «створи новий профіль»."));
  }

  async function allowedGroup(id, bot, featureWrite = false) {
    const group = store.group(id);
    if (!group?.title || group.active === false || (featureWrite === true && !group.configured)) return false;
    try {
      const [owner, member] = await Promise.all([
        telegram("getChatMember", { chat_id: Number(id), user_id: store.ownerId }),
        telegram("getChatMember", { chat_id: Number(id), user_id: bot.id }),
      ]);
      return activeMember(owner) && activeMember(member) &&
        (!featureWrite || ["creator", "administrator"].includes(member.status));
    } catch {
      return false;
    }
  }

  function groupPrompt(locale) {
    const groups = groupEntries();
    if (!groups.length) return say(locale,
      "Add me to a group and send a message I can receive there. Then come back here and tell me its name.",
      "Добавь меня в группу и отправь там сообщение, которое я увижу. Потом вернись сюда и назови группу.",
      "Додай мене до групи й надішли там повідомлення, яке я побачу. Потім повернися сюди й назви групу.");
    return say(locale, "Which group? Type its name or number.", "Какая группа? Напиши её название или номер.", "Яка група? Напиши її назву або номер.") +
      "\n" + groups.map(([id, group], index) => {
        const sameTitle = groups.some(([other, item]) => other !== id && normalize(item.title) === normalize(group.title));
        return `${index + 1}. ${literal(group.title)}${sameTitle ? ` (${id})` : ""}`;
      }).join("\n");
  }

  function configurationPrompt(locale) {
    return say(locale, "Features belong to a group, not a personality. Add me, select its profile and make me an administrator before editing its features.",
      "Функции принадлежат группе, а не личности. Добавь меня в группу, выбери её профиль и назначь меня администратором, чтобы настраивать функции.",
      "Функції належать групі, а не особистості. Додай мене до групи, вибери її профіль і признач мене адміністратором, щоб налаштовувати функції.") + "\n\n" + groupPrompt(locale);
  }

  function groupFeatureStatus(id, key, locale) {
    const group = store.group(id);
    if (key === "status") return `🟢 ${featureName(key, locale)} — **${say(locale, "available", "доступна", "доступна")}**`;
    const mode = nativeMode(id, key);
    const unavailable = featureMode(id, key) === "unavailable";
    const active = !unavailable && !["off", "setup", "unavailable"].includes(mode);
    let label = say(locale, active ? "active" : "inactive", active ? "активно" : "неактивно", active ? "активно" : "неактивно");
    if (unavailable) label += " · " + modeLabel("unavailable", locale);
    else if (mode === "setup") label += " · " + modeLabel("setup", locale);
    else if (active && key === "memory") label += ", " + modeLabel(mode, locale);
    else if (active && key === "analysis") label += say(locale, ", on request", ", по запросу", ", за запитом");
    else if (active && key === "download") label += say(locale, ", automatically", ", автоматически", ", автоматично");
    if (active && group.featureChecks?.[key]?.ok === false) label += " · " + modeLabel("error", locale);
    return `${active ? group.featureChecks?.[key]?.ok === false ? "🟡" : "🟢" : "⚪"} ${featureName(key, locale)} — **${label}**`;
  }

  function groupSummary(id, locale) {
    const group = store.group(id);
    const profile = group.character?.persona ?? store.state.profiles[group.profile ?? store.state.defaultProfile] ?? group.persona;
    return [say(locale, `**Settings for “${literal(group.title)}”**`, `**Настройки группы «${literal(group.title)}»**`, `**Налаштування групи «${literal(group.title)}»**`) + ` (${id})`,
      say(locale, "Profile: ", "Профиль: ", "Профіль: ") + `**${literal(profile ? profileTitle(profile) : "default")}**`,
      say(locale, "Here’s what is enabled now. You can configure the other features when you need them.",
        "Вот что сейчас включено. Остальные функции можно настроить, когда понадобятся.",
        "Ось що зараз увімкнено. Решту функцій можна налаштувати, коли знадобляться."),
      ...setupSections.map(([, title, ids]) => `**${say(locale, ...title)}**\n\n` + ids.map(key => groupFeatureStatus(id, key, locale)).join("\n")),
      say(locale, "Choose a section to start with.", "Выбери раздел, с которого начнём.", "Вибери розділ, з якого почнемо.")].join("\n\n");
  }

  function groupQuestion(draft, locale) {
    const group = configuration(draft);
    if (!group) return configurationPrompt(locale);
    if (modeFeatures.includes(draft.feature)) {
      if (featureMode(draft.group, draft.feature) === "unavailable" && draft.mode !== "off") return featureDetail(draft.feature, locale) + "\n" + modeLabel("unavailable", locale) + ".";
      if (!draft.mode) return modeOptions(draft.feature, locale);
      return `${literal(group.title)}
${featureName(draft.feature, locale)} — ${modeLabel(draft.mode, locale)}. ` +
        say(locale, "Save?", "Сохранить?", "Зберегти?");
    }
    if (draft.operation !== "set") {
      const enabling = draft.operation === "enable";
      const label = featureName(draft.feature, locale);
      return say(locale, `${literal(group.title)} — ${enabling ? "enable" : "disable"} ${label}? Say “save” to confirm.`,
        `${literal(group.title)} — ${enabling ? "включить" : "выключить"} «${label}»? Напиши «сохрани» для подтверждения.`,
        `${literal(group.title)} — ${enabling ? "увімкнути" : "вимкнути"} «${label}»? Напиши «збережи» для підтвердження.`);
    }
    switch (draft.feature) {
      case "assemble":
        if (!draft.game) return say(locale, "Which game?", "Какая игра?", "Яка гра?") + "\n" + games.map(game => game.name).join(" · ");
        if (!draft.players) return say(locale, "Who plays? Send their @usernames.", "Кто играет? Напиши их @имена.", "Хто грає? Напиши їхні @імена.");
        if (draft.animation === undefined) return say(locale, 'Send a GIF, or say “no animation”.', 'Пришли GIF или напиши «без анимации».', 'Надішли GIF або напиши «без анімації».');
        return say(locale, `${literal(group.title)} — call ${draft.players.map(name => "@" + name).join(", ")} for ${games.find(game => game.id === draft.game).name}${draft.animation ? " with a GIF" : ""}. Save and enable?`,
          `${literal(group.title)} — сбор на ${games.find(game => game.id === draft.game).name}. Зову ${draft.players.map(name => "@" + name).join(", ")}${draft.animation ? " с GIF" : " без анимации"}. Сохранить и включить?`,
          `${literal(group.title)} — збір на ${games.find(game => game.id === draft.game).name}. Кличу ${draft.players.map(name => "@" + name).join(", ")}${draft.animation ? " з GIF" : " без анімації"}. Зберегти й увімкнути?`);
      case "reaction":
        if (!draft.terms) return say(locale, "What phrases should trigger the reaction? Separate them with commas.", "На какие фразы реагировать? Перечисли их через запятую.", "На які фрази реагувати? Перелічи їх через кому.");
        if (!draft.animation) return say(locale, "Send the GIF you want me to reply with.", "Пришли GIF, которым я буду отвечать.", "Надішли GIF, яким я відповідатиму.");
        return say(locale, `${literal(group.title)} — react to ${draft.terms.map(literal).join(", ")} with this GIF. Save and enable?`,
          `${literal(group.title)} — отвечаю этим GIF на фразы «${draft.terms.map(literal).join("», «")}». Сохранить и включить?`,
          `${literal(group.title)} — відповідаю цим GIF на фрази «${draft.terms.map(literal).join("», «")}». Зберегти й увімкнути?`);
      case "sticker":
        if (!draft.packName) return say(locale, "Send the link to your existing sticker pack.", "Пришли ссылку на свой существующий стикерпак.", "Надішли посилання на свій наявний стікерпак.");
        return say(locale, `${literal(group.title)} — connect ${draft.packName}. Save and enable?`, `${literal(group.title)} — подключаю ${draft.packName}. Сохранить и включить?`, `${literal(group.title)} — підключаю ${draft.packName}. Зберегти й увімкнути?`);
      case "moderation":
        return draft.userIds?.length ? say(locale,
          `${literal(group.title)} — permitted administrator IDs: ${draft.userIds.join(", ")}. The bot needs restriction permission. Save and enable?`,
          `${literal(group.title)} — разрешённые ID администраторов: ${draft.userIds.join(", ")}. Боту нужно право ограничивать участников. Сохранить и включить?`,
          `${literal(group.title)} — дозволені ID адміністраторів: ${draft.userIds.join(", ")}. Боту потрібне право обмежувати учасників. Зберегти й увімкнути?`) :
          say(locale, "Select administrators below or send their numeric Telegram IDs separated by spaces.",
            "Выбери администраторов ниже или пришли их цифровые Telegram ID через пробел.",
            "Вибери адміністраторів нижче або надішли їхні цифрові Telegram ID через пробіл.");
    }
  }

  function updateGroup(draft) {
    store.change(state => {
      const group = draft.profileId ? state.profiles[draft.profileId].settings : state.groups[draft.group];
      if (!draft.profileId) group.configured = true;
      state.session = { kind: "menu", group: draft.group, resume: draft.resume };
      if (modeFeatures.includes(draft.feature)) {
        group.modes ??= {};
        group.modes[draft.feature] = draft.mode;
        return;
      }
      group.disabled ??= {};
      if (!draft.editField) group.disabled[draft.feature] = draft.operation === "disable";
      if (draft.operation !== "set") {
        if (!draft.profileId && draft.feature === "sticker") releaseInactiveStickerBindings(state, draft.group, group);
        return;
      }
      if (draft.feature === "assemble") {
        const game = games.find(item => item.id === draft.game);
        const current = group.assemble ?? { games: [] };
        group.assemble = {
          ...current,
          games: [...current.games.filter(item => item.id !== game.id), { ...current.games.find(item => item.id === game.id), ...game,
            players: draft.players, animationReference: draft.animation, animationPath: draft.animationPath ?? null }],
        };
      } else if (draft.feature === "reaction") {
        group.reaction = { terms: draft.terms, animation: draft.animation };
      } else if (draft.feature === "moderation") {
        group.moderation = { userIds: draft.userIds };
      } else {
        group.sticker = { packName: draft.packName, ownerId: store.ownerId };
        if (!draft.profileId) releaseInactiveStickerBindings(state, draft.group, group);
      }
    });
  }

  async function collectGroupInputs(draft, text, animation, bot, fullRequest) {
    if (draft.feature === "moderation") {
      const entries = text.trim().split(/[\s,;]+/u);
      if (entries.length && entries.length <= 50 && entries.every(id => /^[1-9]\d*$/u.test(id) && Number.isSafeInteger(Number(id)))) draft.userIds = [...new Set(entries.map(Number))];
      return;
    }
    if (draft.operation !== "set" || modeFeatures.includes(draft.feature)) return;
    if (draft.feature === "assemble") {
      draft.game ??= pickGame(games, text)?.id;
      draft.players ??= playerNames(text);
      if (animation || noAnimation.test(text)) draft.animation = animation || null;
      return;
    }
    if (draft.feature === "reaction") {
      draft.animation ??= animation;
      const termsText = fullRequest ? text.match(/(?:^|\s)[«"]([^»"]+)[»"]/u)?.[1] ?? text.match(/:\s*(.+)$/u)?.[1] : text;
      if (!draft.terms && termsText && !termsText.startsWith("/") && termsText.length <= 500) {
        const terms = termsText.split(/[,\n]/).map(item => item.trim()).filter(item => /[\p{L}\p{N}]/u.test(item));
        if (terms.length) draft.terms = terms;
      }
      return;
    }
    const pack = text.match(/https:\/\/t\.me\/addstickers\/([A-Za-z][A-Za-z0-9_]{0,63})(?![A-Za-z0-9_])/)?.[1] ??
      (!fullRequest ? text.match(/^([A-Za-z][A-Za-z0-9_]{0,63})$/)?.[1] : undefined);
    draft.packCandidate = pack ?? draft.packCandidate;
    if ((!draft.group && !draft.profileId) || !draft.packCandidate || draft.packName) return;
    const candidate = draft.packCandidate;
    if (!normalize(candidate).endsWith(`_by_${normalize(bot.username)}`)) return;
    try {
      const result = await telegram("getStickerSet", { name: candidate });
      if (result?.sticker_type === "regular" && normalize(result.name || candidate) === normalize(candidate)) {
        draft.packName = result.name || candidate;
      }
    } catch { /* The wizard asks for another link if verification fails. */ }
  }

  function settingsSummary(settings, locale) {
    const defaults = initialProfileSettings();
    const lines = ["assemble", "reaction", "sticker"].map(key => {
      const mode = settingIsOn(settings, key) ? "on" : "off";
      return `${featureName(key, locale)} — ${modeLabel(mode, locale)}`;
    });
    for (const key of modeFeatures) {
      const mode = settings.modes?.[key] ?? defaults.modes[key];
      lines.push(`${featureName(key, locale)} — ${modeLabel(mode, locale)}`);
    }
    for (const game of settings.assemble?.games ?? []) {
      lines.push(`${game.name} — ${game.players.map(name => "@" + name).join(", ")}`);
    }
    return lines.join("\n");
  }

  function profileSummary(id, locale) {
    const profile = store.state.profiles[id];
    return [
      literal(profileTitle(profile)),
      `${literal(profile.name)} — ${literal(profile.personality ?? say(locale, "private personality configured on the server", "частная личность, подключённая на сервере", "приватна особистість, підключена на сервері"))}`,
      languageText(locale, profile.language),
      say(locale, "Only personality changes. Group features, players and history are retained.", "Меняется только личность. Функции, игроки и история группы сохраняются.", "Змінюється лише особистість. Функції, гравці й історія групи зберігаються."),
    ].join("\n");
  }

  function assignmentQuestion(draft, locale) {
    if (!draft.global && !draft.group) return groupPrompt(locale);
    if (draft.profile === undefined) return profileList(locale) + "\n\n" +
      say(locale, "Which profile should I use? Reply with its name.", "Какой профиль использовать? Напиши его название.", "Який профіль використовувати? Напиши його назву.");
    const id = draft.profile ?? store.state.defaultProfile;
    const selected = store.state.profiles[id];
    if (!selected) return profileList(locale);
    const name = literal(profileTitle(selected));
    if (draft.global) return say(locale, `Make ${name} the default profile? Save?`,
      `Сделать ${name} общим профилем? Сохранить?`, `Зробити ${name} загальним профілем? Зберегти?`);
    const selectedGroup = store.group(draft.group);
    const duplicate = groupEntries().some(([id, item]) => id !== draft.group && normalize(item.title) === normalize(selectedGroup.title));
    const title = literal(selectedGroup.title) + (duplicate ? ` (${draft.group})` : "");
    return say(locale, `Apply ${name} in ${title}? Features, players, rules and history are retained.\n\n`,
      `В группе «${title}» применю профиль «${name}». Функции, игроки, правила и история сохранятся.\n\n`,
      `У групі «${title}» застосую профіль «${name}». Функції, гравці, правила й історія збережуться.\n\n`) +
      profileSummary(id, locale) + "\n\n" + say(locale, "Save?", "Сохранить?", "Зберегти?");
  }

  const askPersona = draft => {
    const affected = draft.editId ? groupEntries().filter(([, group]) => !group.character &&
      (group.profile ?? store.state.defaultProfile) === draft.editId).map(([, group]) => group.title) : [];
    return personaQuestion(draft, store.group(draft.target)?.title) + (affected.length ? "\n\n" + say(draft.locale,
      "Updates personality in: ", "Обновит личность в группах: ", "Оновить особистість у групах: ") + affected.map(literal).join(", ") : "");
  };

  async function editGroup(draft, text, animation, bot, locale) {
    const next = { ...draft };
    if (next.profileId) return configurationPrompt(locale);
    if (!next.group && !next.profileId) {
      const group = groupChoice(groupEntries(), text, true);
      {
        if (!group || !await allowedGroup(group, bot, Boolean(next.feature))) {
          return next.feature ? configurationPrompt(locale) : groupPrompt(locale);
        }
        next.group = group;
        if (next.view) { setSession({ kind: "menu", group, resume: next.resume }); return groupSummary(group, locale); }
        if (next.createPersona) {
          const persona = newPersona(locale, { target: group, resume: next.resume });
          setSession(persona);
          return askPersona(persona);
        }
      }
      if (next.operation === "enable" && !configuration(next)?.[next.feature] && !modeFeatures.includes(next.feature)) next.operation = "set";
      await collectGroupInputs(next, text, animation, bot, true);
      setSession(next);
      return groupQuestion(next, locale);
    }
    const modeSetting = modeFeatures.includes(next.feature);
    if (modeSetting && featureMode(next.group, next.feature) === "unavailable" && next.mode !== "off") {
      setSession(next.resume ?? { kind: "menu", group: next.group });
      return featureDetail(next.feature, locale) + "\n" + modeLabel("unavailable", locale) + ".";
    }
    if (modeSetting && !next.mode) {
      next.mode = readMode(next.feature, text);
      setSession(next);
      return groupQuestion(next, locale);
    }
    const complete = groupDraftComplete(next);
    if (complete && yes.test(text)) {
      if (!await allowedGroup(next.group, bot, true)) {
        return say(locale, "I can’t verify access to that group.", "Не получилось проверить доступ к группе.", "Не вдалося перевірити доступ до групи.");
      }
      if (next.feature === "minigames" && next.mode === "on" && (!checkFeature || !(await checkFeature("minigames")).ok)) return say(locale,
        "The game connection is not verified. Follow the Mini App instructions and retry.",
        "Подключение игры не подтверждено. Выполни инструкцию Mini App и повтори.",
        "Підключення гри не підтверджене. Виконай інструкцію Mini App і повтори.");
      if (next.feature === "moderation" && next.operation !== "disable" &&
        !await moderationReady(next.group, next.userIds ?? store.group(next.group)?.moderation?.userIds, bot)) return moderationRequirements(locale);
      const sticker = next.packName ? { packName: next.packName } : configuration(next).sticker;
      if (!next.profileId && next.feature === "sticker" && next.operation !== "disable" &&
        stickerConflict(store.state, next.group, { sticker })) {
        return say(locale, "That pack is already linked to another group.", "Этот пак уже привязан к другой группе.", "Цей пак уже прив’язаний до іншої групи.");
      }
      const title = literal(configuration(next).title);
      updateGroup(next);
      return say(locale, `Saved for ${title}. What else should we set up?`,
        `Сохранено для «${title}». Что ещё настроим?`,
        `Збережено для «${title}». Що ще налаштуємо?`);
    }
    if (!complete) {
      await collectGroupInputs(next, text, animation, bot, false);
      setSession(next);
      if (next.feature === "sticker" && !next.packName) {
        return say(locale, "I couldn’t verify that pack. Send a link to a regular pack for this bot.",
          "Не удалось проверить этот пак. Пришли ссылку на обычный стикерпак этого бота.",
          "Не вдалося перевірити цей пак. Надішли посилання на звичайний стікерпак цього бота.");
      }
    }
    return groupQuestion(next, locale);
  }

  async function menu(text, bot, locale, animation, requestedTarget) {
    const groups = groupEntries();
    const asksAbout = helpRequest.test(text);
    if (!asksAbout && (ruleRequest.test(text) || (!animation && /(?:configure|set up|настро|налашту).*(?:reaction|реакц)/iu.test(text) && !text.includes(":")))) {
      if (!groups.length || /(?:in|for|в|для|у)\s+(?:profile|профиле|профілі)/iu.test(text)) return configurationPrompt(locale);
      if (!groups.some(([, group]) => group.configured)) return configurationPrompt(locale);
      const target = await resolveConfigurationTarget(text, bot) ?? {};
      const operation = /delete|remove|удал|видал/iu.test(text) ? "delete" : ruleListRequest.test(text) ? "list" : "create";
      const draft = keepDraft({ kind: "rule", operation, ...target });
      if (operation === "list" && (draft.group || draft.profileId)) {
        setSession(keepDraft({ kind: "menu", ...target }));
        return ruleEditor.list(draft, locale);
      }
      setSession(draft);
      return ruleEditor.question(draft, locale);
    }
    const creation = creationIntent.exec(text);
    if (creation && !asksAbout) {
      const suffix = text.slice(creation.index + creation[0].length).trim();
      const qualifier = /^(?:in|for|в|для|у)(?:\s+|$)/iu.exec(suffix);
      let target = requestedTarget ?? null;
      if (qualifier) {
        target = groupChoice(groups, suffix.slice(qualifier[0].length));
        if (!target || !await allowedGroup(target, bot)) {
          setSession(keepDraft({ kind: "group", createPersona: true }));
          return groupPrompt(locale);
        }
      }
      const label = !qualifier ? suffix.match(/^[«"“„]([^»"”“]+)[»"”“]$/u)?.[1].trim() : undefined;
      if (label !== undefined && (label.length > 80 || !label)) {
        return say(locale, "Use a profile label of 1–80 characters.", "Назови профиль в пределах 1–80 символов.", "Назви профіль у межах 1–80 символів.");
      }
      if (label && Object.values(store.state.profiles).some(profile => normalize(profileTitle(profile)) === normalize(label))) {
        return say(locale, "That profile label is already in use. Ask me to create a profile with another label.",
          "Профиль с таким названием уже есть. Попроси создать профиль с другим названием.",
          "Профіль із такою назвою вже є. Попроси створити профіль з іншою назвою.");
      }
      const draft = keepDraft(newPersona(locale, { target, name: label }));
      setSession(draft);
      return askPersona(draft);
    }
    const match = matchFeature(text);
    const feature = match?.id;
    const profileRequest = profileViewRequest.exec(text);
    const targetWords = profileRequest ? text.replace(profileRequest[0], " ") :
      match ? text.slice(0, match.start) + " " + text.slice(match.end) : text;
    const presetRequest = /(?:in|for|в|для|у)\s+(?:profile|профиле|профілі)(?:\s+|$)/iu.exec(text);
    const presetId = presetRequest ? selectProfile(store.state.profiles, text.slice(presetRequest.index + presetRequest[0].length)) : undefined;
    if (presetRequest && editableGroupFeature(feature)) return configurationPrompt(locale);
    if (presetRequest && !presetId) return profileList(locale);
    const profileId = presetId ?? (!presetRequest && !groupChoice(groups, targetWords) ? store.state.session?.profileId : undefined);
    const assignmentTarget = assignmentIntent.test(text) ? /(?:^|\s)(?:in|for|в|для|у)\s+(.+)$/iu.exec(text)?.[1] : undefined;
    const explicitGroup = profileId ? undefined : groupChoice(groups, assignmentTarget ?? targetWords);
    const mentionsKnownTitle = groups.some(([, entry]) => mentionsGroup(entry.title, targetWords));
    const group = profileId ? null : explicitGroup ?? (mentionsKnownTitle ? null : store.state.session?.group);
    const access = profileId || (group && await allowedGroup(group, bot));
    if (access && (explicitGroup || presetId) && !asksAbout) setSession(keepDraft({ kind: "menu", group, profileId }));
    if (profileRequest && !/assign|назнач|признач/iu.test(text)) {
      if (access) return profileId ? profileSummary(profileId, locale) : groupSummary(group, locale);
      setSession(keepDraft({ kind: "group", view: true }));
      return groupPrompt(locale);
    }
    if (!asksAbout && /make .*default|сделай.*(?:общим|по умолчанию)|зроби.*(?:загальним|типовим)/iu.test(text)) {
      const selected = selectProfile(store.state.profiles, text);
      if (!selected) return say(locale, "Name the profile you want as default.", "Назови профиль, который сделать общим.", "Назви профіль, який зробити загальним.");
      const draft = keepDraft({ kind: "assignment", global: true, profile: selected });
      setSession(draft);
      return assignmentQuestion(draft, locale);
    }
    if (!asksAbout && assignmentIntent.test(text)) {
      const reset = /use default|общий профиль|загальний профіль/iu.test(text);
      const selected = reset ? null : selectProfile(store.state.profiles, text);
      const draft = keepDraft({ kind: "assignment", group: group || undefined, profile: selected });
      setSession(draft);
      return assignmentQuestion(draft, locale);
    }
    if (feature === "profile" && !asksAbout && /edit.*profil|change.*profil|измени.*профил|настрой.*профил|зміни.*профіл/iu.test(text)) {
      const editId = selectProfile(store.state.profiles, text) ?? store.state.defaultProfile;
      if (store.state.profiles[editId]?.catalogKey) return say(locale,
        "This personality is connected from a private server file. Create a new profile for a version you can edit here.",
        "Эта личность подключена из частного файла на сервере. Создай новый профиль, чтобы редактировать свою версию здесь.",
        "Ця особистість підключена з приватного файлу на сервері. Створи новий профіль, щоб редагувати свою версію тут.");
      const draft = keepDraft({ ...store.state.profiles[editId], kind: "persona", flowVersion: 2, accountLocale: store.state.telegramLocale || locale, editId });
      setSession(draft);
      return askPersona(draft);
    }
    if (feature && !asksAbout && editableGroupFeature(feature) && configure.test(text)) {
      if (!groups.length || (group && !await allowedGroup(group, bot, true))) return configurationPrompt(locale);
      let operation = /disable|turn off|выключ|вимк/iu.test(text) ? "disable" : /enable|turn on|включ|увімк/iu.test(text) ? "enable" : "set";
      if (operation === "enable" && access && !(profileId ? store.state.profiles[profileId].settings : store.group(group))?.[feature] && !modeFeatures.includes(feature)) operation = "set";
      const draft = keepDraft({ kind: "group", feature, profileId, group: access ? group : null, operation });
      if (modeFeatures.includes(feature)) draft.mode = readMode(feature, text);
      await collectGroupInputs(draft, text, animation, bot, true);
      setSession(draft);
      return groupQuestion(draft, locale);
    }
    if (feature === "profile" && asksAbout) {
      const selected = selectProfile(store.state.profiles, text);
      if (selected) return profileSummary(selected, locale);
    }
    if (feature) {
      const detail = featureDetail(feature, locale);
      const selected = access && editableGroupFeature(feature) ? "\n\n" +
        (profileId ? settingsSummary(store.state.profiles[profileId].settings, locale) : groupFeatureStatus(group, feature, locale)) : "";
      const hint = editableGroupFeature(feature) ? "\n\n" + say(locale,
        `To change it, say “configure ${featureName(feature, locale)}” and choose a group.`,
        `Чтобы изменить, напиши «настрой ${featureName(feature, locale).toLowerCase()}» и выбери группу.`,
        `Щоб змінити, напиши «налаштуй ${featureName(feature, locale).toLowerCase()}» та вибери групу.`) : "";
      return detail + selected + hint;
    }
    if (catalogueRequest.test(text)) {
      setSession(keepDraft({ kind: "catalogue" }));
      return showCatalogue(locale);
    }
    return null;
  }

  async function menuOrChat(text, bot, locale, animation) {
    const candidate = matchFeature(text) || catalogueRequest.test(text) || profileViewRequest.test(text) || ruleRequest.test(text);
    if (!candidate) return null;
    if (classifyTurn) {
      try {
        const { intent } = readTurnIntent(await classifyTurn({ kind: "menu", paused: false, question: "No pending field. Is this a request about the bot's features/settings, or ordinary conversation?", message: text.slice(0, 4000) }));
        if (intent !== "setup") return null;
      } catch { return null; } // No draft to change; the normal AI path reports its own failure.
    }
    return menu(text, bot, locale, animation);
  }

  async function handle(message, bot) {
    if (!message.text && !message.caption && !message.animation) return false;
    const text = actionableAssembleText(message, message.text ?? message.caption ?? "").trim();
    const command = parseBotCommandText(text, bot.username);
    const internal = isSetupRequest({ ...message, text });
    if (text.startsWith("/") && !command) return false;
    const owner = message.from?.id === store.ownerId;
    const privateChat = message.chat?.type === "private" && message.chat.id === store.ownerId;
    if (!owner) {
      if (!internal) return false;
      if (message.chat?.id && command?.name !== "setup") {
        await telegram("sendMessage", { chat_id: message.chat.id,
          text: say(localeOf(text, store.state.locale), "Only the owner can access bot profiles and settings. If that should be you, ask your installation agent to verify BOT_OWNER_ID, then open /start from that account.",
            "Профили и настройки доступны только владельцу бота. Если владельцем должен быть ты, попроси агента установки проверить BOT_OWNER_ID и открой /start с указанного аккаунта.", "Профілі й налаштування доступні лише власнику бота. Якщо власником маєш бути ти, попроси агента встановлення перевірити BOT_OWNER_ID і відкрий /start з указаного акаунта.") });
      }
      return true;
    }
    if (message.forward_origin || message.forward_date || message.forward_from || message.via_bot) return false;
    if (!privateChat && !internal) return false;
    if (command && !(["start", "setup"].includes(command.name) && !command.args) && command.name !== "cancel") {
      const draft = privateChat && pendingDraft(store.state.session);
      if (draft) setSession({ ...draft, paused: true });
      return false;
    }
    if (text.startsWith("/") && !command) return false;
    if (privateChat && /^(en|ru|uk)(?:-|$)/i.test(message.from.language_code || "")) {
      const accountLocale = message.from.language_code.slice(0, 2).toLowerCase();
      if (store.state.telegramLocale !== accountLocale) store.change(state => { state.telegramLocale = accountLocale; });
    }
    let extractedNames;
    let session = store.state.session;
    const locale = session?.kind === "persona" ? session.locale : store.state.locale;
    const reply = async response => {
      if (response === null) return false;
      const current = store.state.session;
      const draft = draftKinds.has(current?.kind) && !current.paused;
      const group = current?.group;
      const heading = draft && group ? literal(store.group(group)?.title) + ` (${group})\n\n` : "";
      await sendPanel(heading + response, currentRows(bot, current?.locale ?? store.state.locale), { group, draft });
      return true;
    };
    const pending = pendingDraft(session);
    if (!command && resume.test(text) && pending) {
      const restored = { ...pending, paused: false };
      setSession(restored);
      return reply(draftQuestion(restored, restored.locale ?? locale));
    }
    if (profileListIntent.test(text)) {
      if (pending) setSession({ ...pending, paused: true });
      return reply(profileList(store.state.locale));
    }
    if (ruleListRequest.test(text)) {
      if (pending) setSession({ ...pending, paused: true });
      const target = await resolveConfigurationTarget(text, bot) ??
        (!privateChat ? { group: String(message.chat.id) } :
          session?.group || session?.profileId ? { group: session.group, profileId: session.profileId } : null);
      return reply(target ? ruleEditor.list(target, locale) : configurationPrompt(locale));
    }

    const replyGroup = privateChat && message.reply_to_message?.message_id ?
      groupEntries().find(([, group]) => group.notificationId === message.reply_to_message.message_id)?.[0] : undefined;
    if (replyGroup || (!privateChat && assignmentIntent.test(text))) {
      const group = replyGroup || String(message.chat.id);
      if (!await allowedGroup(group, bot)) return reply(groupPrompt(store.state.locale));
      if (creationIntent.test(text)) return reply(await menu(text, bot, store.state.locale, message.animation?.file_id, group));
      const reset = /use default|общий профиль|загальний профіль/iu.test(text);
      const draft = { kind: "assignment", group, profile: reset ? null : selectProfile(store.state.profiles, text) };
      if (session && ["persona", "group", "assignment", "rule"].includes(session.kind)) {
        draft.resume = session.kind === "assignment" ? session.resume : { ...session, paused: true };
      }
      setSession(draft);
      return reply(assignmentQuestion(draft, store.state.locale));
    }
    if (!privateChat) {
      if (command?.name === "setup") return reply(showCatalogue(store.state.locale));
      return reply(await menu(text, bot, store.state.locale, message.animation?.file_id));
    }
    if (internal && !command && (!session || creationIntent.test(text) || (session.kind !== "rule" && assignmentIntent.test(text)))) {
      if (pending) setSession({ ...pending, paused: true });
      const response = await menuOrChat(text, bot, locale, message.animation?.file_id);
      if (response === null && pending) message._setupConversationContext = draftQuestion(pending, pending.locale ?? locale);
      return reply(response);
    }

    if ((cancel.test(text) || (session?.kind === "discover" && /^(?:no|нет|ні)[.!]?$/iu.test(text))) && (session || command)) {
      setSession(session?.resume ?? null);
      return reply(say(store.state.locale, "Okay. You can come back with /setup.", "Хорошо. Можно вернуться через /setup.", "Добре. Можна повернутися через /setup."));
    }
    if (command) {
      if (command.name === "start" && store.state.defaultProfile) {
        setSession(pending ? { ...pending, paused: true } : null);
        return reply(say(store.state.locale, "I’m here. You can talk to me or open /setup.", "Я на связи. Можешь поговорить со мной или открыть /setup.", "Я на зв’язку. Можеш поговорити зі мною або відкрити /setup."));
      }
      if (pending) {
        const draft = { ...pending, paused: false };
        setSession(draft);
        return reply(draftQuestion(draft, draft.locale ?? locale));
      }
      if (!store.state.defaultProfile) {
        const draft = { kind: "persona", flowVersion: 2, onboarding: true, makeDefault: true, locale: "en", accountLocale: store.state.telegramLocale || "en" };
        setSession(draft);
        return reply(askPersona(draft));
      }
      setSession({ kind: "menu", group: session?.group, profileId: session?.profileId });
      return reply(showCatalogue(locale));
    }
    if (!session) return reply(await menuOrChat(text, bot, locale, message.animation?.file_id));
    if (session.kind === "invitation" && yes.test(text)) {
      if (!await allowedGroup(session.group, bot, true)) return reply(configurationPrompt(locale));
      setSession({ kind: "menu", group: session.group, resume: session.resume });
      return reply(groupSummary(session.group, locale));
    }
    if (pending) {
      // A side conversation pauses a draft, not its confirmed settings. A bare
      // confirmation in that conversation can never apply an older preview.
      const currentQuestion = draftQuestion(pending, pending.locale ?? locale);
      if (pending.paused && yes.test(text)) {
        if (/save|confirm|apply|сохран|подтверж|примен|збер|застос/iu.test(text)) {
          setSession({ ...pending, paused: false });
          return reply(currentQuestion); // Explicit save returns to the preview first.
        }
        message._setupConversationContext = currentQuestion;
        return false;
      }
      const expectedAnimation = pending.kind === "rule" ? pending.action?.type === "animation" && !pending.action.animation :
        pending.kind === "group" && ["assemble", "reaction"].includes(pending.feature) && pending.animation === undefined;
      if (!message._setupButton && !yes.test(text) && !(message.animation && expectedAnimation) && classifyTurn) {
        let intent;
        try {
          const turn = readTurnIntent(await classifyTurn({ kind: pending.kind, paused: Boolean(pending.paused), question: currentQuestion.slice(0, 3500), message: text.slice(0, 4000),
            names: pending.onboarding && (!pending.ownerName || !pending.name) ? { ownerMissing: !pending.ownerName, botMissing: !pending.name } : undefined }));
          intent = turn.intent;
          if (intent === "answer" && pending.onboarding) extractedNames = turn;
        } catch {
          setSession({ ...pending, paused: true });
          return reply(say(locale, "I couldn’t interpret that turn because the AI check failed. Your draft is safe. Try /setup again when the AI connection is ready.",
            "Не смог разобрать сообщение: проверка через AI не удалась. Черновик сохранён. Когда AI будет доступен, продолжи через /setup.",
            "Не вдалося розібрати повідомлення: перевірка через AI не спрацювала. Чернетку збережено. Коли AI буде доступний, продовж через /setup."));
        }
        if (intent === "resume") {
          setSession({ ...pending, paused: false });
          return reply(currentQuestion);
        }
        if (intent === "conversation" || intent === "setup") {
          setSession({ ...pending, paused: true });
          if (intent === "setup") {
            const help = await menu(text, bot, locale, message.animation?.file_id);
            if (help !== null) return reply(help);
          }
          message._setupConversationContext = currentQuestion;
          return false;
        }
        session = { ...pending, paused: false }; setSession(session);
      } else if (pending.paused) return false;
    } else if (session.paused) return false;
    if (session.kind === "rule") {
      if (session.profileId || (session.group && !await allowedGroup(session.group, bot, true))) return reply(configurationPrompt(locale));
      return reply(await ruleEditor.handle(session, text, message.animation?.file_id, bot, locale, yes.test(text)));
    }

    if (session.kind === "persona") {
      if (personaComplete(session) && !session.editorField && !session.editMenu && yes.test(text)) {
        if (session.target && !await allowedGroup(session.target, bot)) return reply(groupPrompt(locale));
        const { name, personality, language } = session;
        const firstProfile = !store.state.defaultProfile;
        const previous = store.state.profiles[session.editId];
        const profileLabel = previous?.label && previous.label !== previous.name ? previous.label : session.flowVersion !== 2 && session.label ? session.label : name;
        if (Object.entries(store.state.profiles).some(([id, item]) => id !== session.editId && normalize(profileTitle(item)) === normalize(profileLabel))) {
          if (session.label) return reply(say(locale, "That profile label is already in use. Ask me to create a profile with another label.",
            "Профиль с таким названием уже есть. Попроси создать профиль с другим названием.",
            "Профіль із такою назвою вже є. Попроси створити профіль з іншою назвою."));
          return reply(say(locale, "That profile name is already in use. Say “change name”.", "Профиль с таким именем уже есть. Напиши «поменяй имя».", "Профіль із таким ім’ям уже є. Напиши «зміни ім’я»."));
        }
        store.change(state => {
          const id = session.editId ?? randomUUID();
          state.profiles[id] = {
            ...state.profiles[id], name,
            label: profileLabel,
            personality, language, locale: session.locale,
            revision: randomUUID(),
          };
          if (session.makeDefault || !state.defaultProfile) state.defaultProfile = id;
          if (session.onboarding && session.ownerName) state.owner = { displayName: session.ownerName };
          state.locale = session.locale;
          state.session = session.target ? { kind: "assignment", group: session.target, profile: id, resume: session.resume } : session.resume ?? { kind: "welcome" };
        });
        if (session.target) return reply(say(locale, "> profile saved\n\n", "> профиль сохранён\n\n", "> профіль збережено\n\n") +
          assignmentQuestion(store.state.session, locale));
        if (session.resume) return reply(say(locale, "Profile saved. Your earlier draft is safe; say “continue setup” to return.", "Профиль сохранён. Предыдущий черновик сохранён; напиши «продолжим настройку», чтобы вернуться.", "Профіль збережено. Попередню чернетку збережено; напиши «продовжимо налаштування», щоб повернутися."));
        return reply(firstProfile ? introduction(session.locale) : say(session.locale,
          `**Profile “${literal(name)}” saved.**`, `**Профиль «${literal(name)}» сохранён.**`, `**Профіль «${literal(name)}» збережено.**`));
      }
      const next = { ...session };
      editPersona(next, text, extractedNames);
      const languageStep = session.editorField === "language" || (session.name && !session.language &&
        (!session.onboarding || session.ownerName) && (session.flowVersion === 2 || session.personality));
      if (languageStep && !next.language && text) {
        return reply(say(locale, "Choose English, Russian, Ukrainian, or the language of whoever writes to me.",
          "Выбери английский, русский, украинский или язык собеседника.",
          "Вибери англійську, російську, українську або мову співрозмовника."));
      }
      setSession(next);
      return reply(askPersona(next));
    }
    if (session.kind === "assignment") {
      const next = { ...session };
      if (!next.global && !next.group) {
        const group = groupChoice(groupEntries(), text, true);
        if (!group || !await allowedGroup(group, bot)) return reply(groupPrompt(locale));
        next.group = group;
        next.profile ??= selectProfile(store.state.profiles, text);
        setSession(next);
        return reply(assignmentQuestion(next, locale));
      }
      if (next.profile === undefined) {
        next.profile = selectProfile(store.state.profiles, text);
        setSession(next);
        return reply(assignmentQuestion(next, locale));
      }
      if (!yes.test(text)) return reply(assignmentQuestion(next, locale));
      if (next.group && !await allowedGroup(next.group, bot)) return reply(groupPrompt(locale));
      if (next.group && !await allowedGroup(next.group, bot, "assign")) return reply(say(locale,
        "Make me an administrator of this group, then confirm again. Your draft is retained.",
        "Назначь меня администратором этой группы и подтверди ещё раз. Черновик сохранён.",
        "Признач мене адміністратором цієї групи й підтвердь ще раз. Чернетку збережено."));
      const selected = store.state.profiles[next.profile ?? store.state.defaultProfile];
      if (!selected) return reply(profileList(locale));
      store.change(state => {
        if (next.group) assignGroupProfile(state, next.group, next.profile, randomUUID());
        else {
          state.defaultProfile = next.profile;
          state.defaultRevision = randomUUID();
        }
        state.session = next.group ? { kind: "menu", group: next.group, resume: next.resume } : next.resume ?? { kind: "menu" };
      });
      if (!next.group) return reply(say(locale, "Default personality saved.", "Общая личность сохранена.", "Спільну особистість збережено."));
      return reply(groupSummary(next.group, locale));
    }
    if (session.kind === "group") return reply(await editGroup(session, text, message.animation?.file_id, bot, locale));
    if (session.kind === "discover") {
      setSession({ kind: "menu", group: session.group, profileId: session.profileId });
      if (yes.test(text) || /(?:see|show|what|посмотр|покажи|что|подив|покажи|що).*(?:next|дальше|далі)/iu.test(text)) return reply(showCatalogue(locale));
    }
    return reply(await menuOrChat(text, bot, locale, message.animation?.file_id));
  }

  function nativeMode(group, feature) {
    if (feature === "status") return "on";
    const available = featureMode(group, feature);
    if (available === "unavailable") return available;
    const settings = store.group(group);
    if (modeFeatures.includes(feature)) return settings?.modes?.[feature] ?? (feature === "minigames" ? "off" : available ?? (feature === "memory" ? "manual" : "on"));
    if (!settings?.[feature] && !(feature === "reaction" && settings?.rules?.length)) return "setup";
    if (settings.disabled?.[feature]) return "off";
    if (feature === "assemble" && !(settings.assemble?.games ?? []).some(game => game.enabled !== false && game.players?.length)) return settings.assemble?.games?.length ? "off" : "setup";
    if (feature === "reaction" && !settings.reaction && !settings.rules?.some(rule => rule.enabled !== false)) return "off";
    return "on";
  }

  const moderationRequirements = locale => say(locale,
    "Only current administrators may be operators, and I need restriction permission. Correct the selection or permissions.",
    "Исполнители должны быть действующими администраторами, а мне нужно право ограничивать участников. Исправь список или права.",
    "Виконавці мають бути чинними адміністраторами, а мені потрібне право обмежувати учасників. Виправ список чи права.");

  async function moderationReady(group, userIds, bot) {
    if (!userIds?.length) return false;
    try {
      const members = await Promise.all(userIds.map(id => telegram("getChatMember", { chat_id: Number(group), user_id: id })));
      const self = await telegram("getChatMember", { chat_id: Number(group), user_id: bot.id });
      return self.status === "administrator" && self.can_restrict_members === true &&
        members.every(member => ["creator", "administrator"].includes(member.status));
    } catch { return false; }
  }

  async function showFeature(group, feature, bot, locale, notice = "") {
    if (!featureName(feature, locale)) return;
    const settings = store.group(group);
    const rows = [];
    const mode = group ? nativeMode(group, feature) : "setup";
    const childActivationNeeded = mode === "off" && !settings?.disabled?.[feature] && ["assemble", "reaction"].includes(feature);
    if (childActivationNeeded) notice = [notice, feature === "assemble" ? say(locale,
      "Choose a game below, add players and enable its call.",
      "Выбери игру ниже, добавь игроков и включи сбор для неё.",
      "Вибери гру нижче, додай гравців і ввімкни збір для неї.") : say(locale,
      "Choose a phrase below and enable its rule.",
      "Выбери фразу ниже и включи её правило.",
      "Вибери фразу нижче й увімкни її правило.")].filter(Boolean).join("\n\n");
    if (group && settings?.configured && editableGroupFeature(feature)) {
      if (mode !== "unavailable") {
        if (mode !== "setup" && !childActivationNeeded) rows.push([button(mode === "off" ? say(locale, "Enable", "Включить", "Увімкнути") : say(locale, "Disable", "Выключить", "Вимкнути"), "toggle", { feature })]);
        if (feature === "memory") rows.push([button(say(locale, "Change mode", "Изменить режим", "Змінити режим"), "configure", { feature })]);
        if (!modeFeatures.includes(feature)) rows.push([button(say(locale, "Configure", "Настроить", "Налаштувати"), "configure", { feature })]);
      }
      if (feature === "assemble") rows.push(...(settings.assemble?.games ?? []).map(game => [button(game.name, "game", { game: game.id })]));
      if (feature === "reaction") rows.push(...(settings.rules ?? []).map(rule => [button(rule.phrase.slice(0, 50), "rule", { rule: rule.id })]));
    }
    if (feature === "minigames") {
      rows.push([{ text: say(locale, "Connection instructions", "Инструкция подключения", "Інструкція підключення"),
        url: "https://github.com/MojoTheApe/plus-one/blob/main/docs/runtime/MINI_APPS.md" }]);
      rows.push([button(say(locale, "Check connection", "Проверить подключение", "Перевірити підключення"), "checkConnection", { feature })]);
    }
    rows.push([button(say(locale, "How to test", "Как проверить", "Як перевірити"), "test", { feature })]);
    rows.push([button(say(locale, "Back", "Назад", "Назад"), group ? "group" : "intro", { group })]);
    const title = settings ? `${literal(settings.title)} (${group})\n\n` : "";
    await sendPanel(title + featureDetail(feature, locale) + "\n\n" +
      (notice ? notice + "\n\n" : "") + say(locale, "State: ", "Состояние: ", "Стан: ") + modeLabel(mode, locale) +
      (settings?.featureChecks?.[feature]?.ok === false && !["off", "unavailable"].includes(mode) ? " · " + modeLabel("error", locale) : ""), rows, { group });
  }

  async function configureFeature(group, feature, bot, locale) {
    if (!await allowedGroup(group, bot, true)) return sendPanel(configurationPrompt(locale), rootRows(bot, locale));
    if (featureMode(group, feature) === "unavailable") return showFeature(group, feature, bot, locale);
    const draft = keepDraft({ kind: feature === "reaction" ? "rule" : "group", group,
      feature, operation: feature === "reaction" ? "create" : "set" });
    if (feature === "moderation") {
      try {
        const admins = await telegram("getChatAdministrators", { chat_id: Number(group) });
        draft.operators = admins.filter(member => !member.user.is_bot).map(member => ({ id: member.user.id,
          name: member.user.username ? "@" + member.user.username : member.user.first_name || String(member.user.id) }));
      } catch { /* Numeric IDs remain an explicit supported input. */ }
    }
    setSession(draft);
    const text = feature === "reaction" ? ruleEditor.question(draft, locale) : groupQuestion(draft, locale);
    await sendPanel(store.group(group).title + ` (${group})\n\n` + text, draftRows(draft, locale), { group, draft: true });
  }

  async function nativeAction(action, group, bot, locale) {
    switch (action.type) {
      case "intro":
        setSession(keepDraft({ kind: "welcome" }));
        return sendPanel(introduction(locale), welcomeRows(locale));
      case "catalogue":
        setSession(keepDraft({ kind: "catalogue" }));
        return sendPanel(showCatalogue(locale), currentRows(bot, locale));
      case "addGroup":
        setSession(keepDraft({ kind: "connectGroup" }));
        return sendPanel(say(locale,
          "**Connect your first group**\n\n1. Tap Choose group and add me to the chat.\n2. Open that group’s settings → Administrators and make me an administrator.\n\nI’ll message you here when it’s ready. We’ll choose a profile and configure the group.",
          "**Подключим первую группу**\n\n1. Нажми «Выбрать группу» и добавь меня в нужный чат.\n2. Открой настройки этой группы → Администраторы и назначь меня администратором.\n\nКогда всё будет готово, я напишу тебе сюда. Выберем профиль и настроим функции для этой группы.",
          "**Підключимо першу групу**\n\n1. Натисни «Вибрати групу» й додай мене до потрібного чату.\n2. Відкрий налаштування цієї групи → Адміністратори й признач мене адміністратором.\n\nКоли все буде готово, я напишу тобі сюди. Виберемо профіль і налаштуємо функції групи."),
          [[{ text: say(locale, "Choose group", "Выбрать группу", "Вибрати групу"), url: `https://t.me/${bot.username}?startgroup=setup` }],
           [button(say(locale, "Back", "Назад", "Назад"), "intro")]]);
      case "checkRights": return showGroupConnection(group, bot, locale, true);
      case "createForGroup":
        if (!await allowedGroup(group, bot, "assign")) return showGroupConnection(group, bot, locale, true);
        setSession(keepDraft(newPersona(locale, { target: group })));
        return sendPanel(askPersona(store.state.session), draftRows(store.state.session, locale), { group, draft: true });
      case "useProfile":
        if (!store.state.profiles[action.profile] || !await allowedGroup(group, bot, "assign")) return showGroupConnection(group, bot, locale, true);
        setSession(keepDraft({ kind: "assignment", group, profile: action.profile }));
        return handle({ chat: { id: store.ownerId, type: "private" }, from: { id: store.ownerId }, text: "save", _setupButton: true }, bot);
      case "personaMenu": {
        const draft = store.state.session;
        if (draft?.kind !== "persona") return;
        setSession({ ...draft, editMenu: true });
        return sendPanel(askPersona(store.state.session), draftRows(store.state.session, locale), { draft: true });
      }
      case "personaField": {
        const draft = store.state.session;
        if (draft?.kind !== "persona" || !["name", "personality", "language"].includes(action.field)) return;
        setSession(beginPersonaField(draft, action.field));
        return sendPanel(askPersona(store.state.session), draftRows(store.state.session, locale), { draft: true });
      }
      case "personaBack": {
        const draft = store.state.session;
        if (draft?.kind !== "persona") return;
        const next = { ...draft, ...(draft.editorBefore || {}), editMenu: Boolean(draft.editorField) };
        delete next.editorField; delete next.editorBefore;
        setSession(next);
        return sendPanel(askPersona(store.state.session), draftRows(store.state.session, next.locale), { draft: true });
      }
      case "profiles": {
        const rows = Object.entries(store.state.profiles).map(([profile, item]) => [button(profileTitle(item), "editProfile", { profile })]);
        rows.push([button(say(locale, "Create profile", "Создать профиль", "Створити профіль"), "createProfile")],
          [button(say(locale, "Back", "Назад", "Назад"), "intro")]);
        return sendPanel(profileList(locale), rows);
      }
      case "createProfile":
        setSession(keepDraft(newPersona(locale)));
        return sendPanel(askPersona(store.state.session), draftRows(store.state.session, locale), { draft: true });
      case "editProfile": {
        const profile = store.state.profiles[action.profile];
        if (!profile) return;
        if (profile.catalogKey) return sendPanel(profileSummary(action.profile, locale), [[button(say(locale, "Create editable profile", "Создать свой профиль", "Створити свій профіль"), "createProfile")]]);
        setSession(keepDraft({ ...profile, kind: "persona", flowVersion: 2, accountLocale: store.state.telegramLocale || locale, editId: action.profile, locale }));
        return sendPanel(askPersona(store.state.session), draftRows(store.state.session, locale), { draft: true });
      }
      case "groups": {
        const rows = groupEntries().map(([id, item]) => [button(`${id} · ${item.title}`, "group", { group: id })]);
        return sendPanel(groupPrompt(locale), [...rows, ...rootRows(bot, locale)]);
      }
      case "group": {
        if (!await allowedGroup(group, bot)) return sendPanel(configurationPrompt(locale), rootRows(bot, locale));
        if (!store.group(group).configured || !await allowedGroup(group, bot, true)) return showGroupConnection(group, bot, locale, true);
        setSession(keepDraft({ kind: "menu", group }));
        return sendPanel(groupSummary(group, locale), sectionRows(locale), { group });
      }
      case "chooseProfile":
        if (!store.group(group)?.configured) return showGroupConnection(group, bot, locale, true);
        return sendPanel(literal(store.group(group)?.title) + ` (${group})\n\n` + profileList(locale), profileRows(group), { group });
      case "profile": {
        if (!store.state.profiles[action.profile] || !await allowedGroup(group, bot)) return;
        const draft = keepDraft({ kind: "assignment", group, profile: action.profile });
        setSession(draft);
        return sendPanel(assignmentQuestion(draft, locale), draftRows(draft, locale), { group, draft: true });
      }
      case "section": {
        if (!await allowedGroup(group, bot, true)) return sendPanel(configurationPrompt(locale), rootRows(bot, locale));
        const section = setupSections.find(([id]) => id === action.section);
        if (!section) return;
        const rows = section[2].map(feature => [button(featureName(feature, locale) + " · " + modeLabel(nativeMode(group, feature), locale), "feature", { feature })]);
        rows.push([button(say(locale, "Back", "Назад", "Назад"), "group", { group })]);
        return sendPanel(`${literal(store.group(group).title)} (${group})\n\n` + say(locale, ...section[1]), rows, { group });
      }
      case "feature": return showFeature(group, action.feature, bot, locale);
      case "configure": return configureFeature(group, action.feature, bot, locale);
      case "toggle": {
        if (!await allowedGroup(group, bot, true)) return sendPanel(configurationPrompt(locale), rootRows(bot, locale));
        const feature = action.feature;
        if (featureMode(group, feature) === "unavailable") return showFeature(group, feature, bot, locale);
        const mode = nativeMode(group, feature);
        if (mode === "setup") return configureFeature(group, feature, bot, locale);
        if (feature === "minigames" && mode === "off") {
          const check = checkFeature ? await checkFeature(feature) : { ok: false };
          if (!check.ok) return showFeature(group, feature, bot, locale, say(locale,
            "The game service check failed. Follow the connection instructions and retry.",
            "Проверка игрового сервиса не прошла. Выполни инструкцию подключения и повтори.",
            "Перевірка ігрового сервісу не пройшла. Виконай інструкцію підключення й повтори."));
        }
        const settings = store.group(group);
        if (feature === "moderation" && mode === "off" && !await moderationReady(group, settings.moderation?.userIds, bot)) {
          return showFeature(group, feature, bot, locale, moderationRequirements(locale));
        }
        if (feature === "sticker" && mode === "off" && stickerConflict(store.state, group, settings)) {
          return showFeature(group, feature, bot, locale, say(locale, "This pack is linked to another group.", "Этот пак уже привязан к другой группе.", "Цей пак уже прив’язаний до іншої групи."));
        }
        store.change(state => {
          const target = state.groups[group];
          if (modeFeatures.includes(feature)) {
            target.modes ??= {};
            target.modes[feature] = mode === "off" ? (feature === "memory" ? target.lastMemoryMode || "manual" : "on") : "off";
            if (feature === "memory" && mode !== "off") target.lastMemoryMode = mode;
          } else {
            target.disabled ??= {};
            target.disabled[feature] = !target.disabled[feature];
          }
        });
        return showFeature(group, feature, bot, locale);
      }
      case "input": {
        const draft = store.state.session;
        if (draft?.group && ["group", "rule"].includes(draft.kind) && !await allowedGroup(draft.group, bot, true)) return sendPanel(configurationPrompt(locale), rootRows(bot, locale));
        return handle({ chat: { id: store.ownerId, type: "private" }, from: { id: store.ownerId }, text: action.input, _setupButton: true }, bot);
      }
      case "backDraft": {
        const current = store.state.session;
        if (current?._back?.length) {
          const history = [...current._back];
          const previous = { ...history.pop(), _back: history };
          setSession(previous);
          return sendPanel(draftQuestion(store.state.session, locale), draftRows(store.state.session, locale), { group, draft: true });
        }
        if (current?.editField) {
          setSession(current.resume ?? { kind: "menu", group });
          return current.kind === "rule" ? nativeAction({ type: "rule", rule: current.ruleId }, group, bot, locale) : nativeAction({ type: "game", game: current.game }, group, bot, locale);
        }
        const next = structuredClone(current);
        const keys = next?.kind === "persona" ? ["language", "personality", "name"] : next?.kind === "group" ?
          ["mode", "animation", "players", "game", "packName", "userIds"] : next?.kind === "rule" ? ["deleteId", "announcement", "access", "action", "phrase"] : ["profile"];
        const key = keys.find(key => next?.[key] !== undefined && next[key] !== null);
        if (!key) return nativeAction({ type: group ? "group" : "profiles" }, group, bot, locale);
        delete next[key];
        setSession(next);
        return sendPanel(draftQuestion(next, locale), draftRows(next, locale), { group, draft: true });
      }
      case "game": {
        const game = store.group(group)?.assemble?.games.find(item => item.id === action.game);
        if (!game) return;
        const rows = [[button(say(locale, "Edit players", "Изменить игроков", "Змінити гравців"), "gameField", { game: game.id, field: "players" })],
          [button(say(locale, "Edit animation", "Изменить GIF", "Змінити GIF"), "gameField", { game: game.id, field: "animation" })],
          [button(game.enabled === false ? say(locale, "Enable call", "Включить сбор", "Увімкнути збір") : say(locale, "Disable call", "Выключить сбор", "Вимкнути збір"), "toggleGame", { game: game.id })],
          [button(say(locale, "Delete game settings", "Удалить настройку игры", "Видалити налаштування гри"), "deleteGame", { game: game.id })],
          [button(say(locale, "Preview", "Предпросмотр", "Попередній перегляд"), "game", { game: game.id })],
          [button(say(locale, "Back", "Назад", "Назад"), "feature", { feature: "assemble" })]];
        return sendPanel(`${literal(store.group(group).title)} (${group})\n\n${literal(game.name)}\n${game.players.map(name => "@" + name).join(", ")}`, rows, { group });
      }
      case "gameField": {
        if (!await allowedGroup(group, bot, true)) return sendPanel(configurationPrompt(locale), rootRows(bot, locale));
        const game = store.group(group)?.assemble?.games.find(item => item.id === action.game);
        if (!game) return;
        const draft = keepDraft({ kind: "group", group, feature: "assemble", operation: "set", game: game.id,
          players: game.players, animation: game.animationReference || "", animationPath: game.animationPath, editField: action.field });
        delete draft[action.field];
        if (action.field === "animation") delete draft.animationPath;
        setSession(draft);
        return sendPanel(`${literal(store.group(group).title)} (${group})\n\n` + groupQuestion(draft, locale), draftRows(draft, locale), { group, draft: true });
      }
      case "rule": {
        const rule = store.group(group)?.rules?.find(item => item.id === action.rule);
        if (!rule) return;
        const label = rule.action.type === "animation" ? "GIF" : rule.action.type === "persona" ? featureName("profile", locale) : featureName(rule.action.type, locale);
        return sendPanel(`${literal(store.group(group).title)} (${group})\n\n${literal(rule.phrase)} → ${label}\n` +
          modeLabel(rule.enabled === false ? "off" : "on", locale) + "\n" + literal(rule.announcement || ""), [
          [button(say(locale, "Change action", "Изменить действие", "Змінити дію"), "ruleField", { rule: rule.id, field: "action" })],
          ...(rule.action.type === "persona" ? [] : [[button(say(locale, "Change access", "Изменить доступ", "Змінити доступ"), "ruleField", { rule: rule.id, field: "access" })]]),
          [button(say(locale, "Change announcement", "Изменить объявление", "Змінити оголошення"), "ruleField", { rule: rule.id, field: "announcement" })],
          [button(rule.enabled === false ? say(locale, "Enable rule", "Включить правило", "Увімкнути правило") : say(locale, "Disable rule", "Выключить правило", "Вимкнути правило"), "toggleRule", { rule: rule.id })],
          [button(say(locale, "Delete rule", "Удалить правило", "Видалити правило"), "deleteRule", { rule: rule.id })],
          [button(say(locale, "Back", "Назад", "Назад"), "feature", { feature: "reaction" })],
        ], { group });
      }
      case "ruleField": {
        if (!await allowedGroup(group, bot, true)) return sendPanel(configurationPrompt(locale), rootRows(bot, locale));
        const rule = store.group(group)?.rules?.find(item => item.id === action.rule);
        if (!rule) return;
        const draft = keepDraft({ kind: "rule", group, operation: "create", phrase: rule.phrase,
          action: structuredClone(rule.action), access: rule.access, announcement: rule.announcement ?? "", ruleId: rule.id, editField: action.field });
        delete draft[action.field];
        setSession(draft);
        return sendPanel(ruleEditor.question(draft, locale), draftRows(draft, locale), { group, draft: true });
      }
      case "toggleGame":
      case "toggleRule":
      case "confirmDeleteGame": {
        if (!await allowedGroup(group, bot, true)) return sendPanel(configurationPrompt(locale), rootRows(bot, locale));
        store.change(state => {
          const settings = state.groups[group];
          if (action.type === "toggleRule") {
            const rule = settings.rules?.find(item => item.id === action.rule);
            if (rule) rule.enabled = rule.enabled === false;
          } else if (action.type === "toggleGame") {
            const game = settings.assemble?.games.find(item => item.id === action.game);
            if (game) game.enabled = game.enabled === false;
          } else if (settings.assemble) settings.assemble.games = settings.assemble.games.filter(item => item.id !== action.game);
        });
        return action.type === "toggleRule" ? nativeAction({ type: "rule", rule: action.rule }, group, bot, locale) : showFeature(group, "assemble", bot, locale);
      }
      case "deleteGame":
        return sendPanel(say(locale, "Delete game settings: ", "Удалить настройки игры: ", "Видалити налаштування гри: ") +
          (store.group(group)?.assemble?.games.find(game => game.id === action.game)?.name ?? action.game) + "?", [
          [button(say(locale, "Delete", "Удалить", "Видалити"), "confirmDeleteGame", { game: action.game })],
          [button(say(locale, "Back", "Назад", "Назад"), "game", { game: action.game })]], { group });
      case "deleteRule": {
        const draft = keepDraft({ kind: "rule", group, operation: "delete", deleteId: action.rule });
        setSession(draft);
        return sendPanel(ruleEditor.question(draft, locale), draftRows(draft, locale), { group, draft: true });
      }
      case "operator": {
        const draft = structuredClone(store.state.session);
        if (draft?.feature !== "moderation" || !draft.operators?.some(item => item.id === action.id)) return;
        draft.userIds ??= [];
        draft.userIds = draft.userIds.includes(action.id) ? draft.userIds.filter(id => id !== action.id) : [...draft.userIds, action.id];
        setSession(draft);
        return sendPanel(groupQuestion(draft, locale), draftRows(draft, locale), { group, draft: true });
      }
      case "checkConnection": {
        const check = checkFeature ? await checkFeature(action.feature) : { ok: false };
        return showFeature(group, action.feature, bot, locale, check.ok ? say(locale,
          "Configured game services are reachable. Also verify Main Mini App registration in BotFather and launch the selected game in Telegram.",
          "Настроенные игровые сервисы доступны. Также проверь регистрацию Main Mini App в BotFather и запуск выбранной игры в Telegram.",
          "Налаштовані ігрові сервіси доступні. Також перевір реєстрацію Main Mini App у BotFather і запуск вибраної гри в Telegram.") : say(locale,
          "No working game connection was verified. Follow the per-game instructions and retry.",
          "Работающее подключение игры не подтверждено. Выполни инструкцию для выбранной игры и повтори.",
          "Робоче підключення гри не підтверджене. Виконай інструкцію для вибраної гри й повтори."));
      }
      case "test":
        return showFeature(group, action.feature, bot, locale, action.feature === "voice" ? say(locale,
          "Send an ordinary voice in the group, then ask me to summarize it. To test a reply, send a voice replying to my message.",
          "Отправь обычное голосовое в группу, затем попроси пересказать его. Для проверки ответа отправь голосовое ответом на моё сообщение.",
          "Надішли звичайне голосове до групи, потім попроси переказати його. Для перевірки відповіді надішли голосове відповіддю на моє повідомлення.") :
          say(locale, "Use the example above in this group. For connection diagnostics, use /status. No group action has been executed by this preview.",
            "Используй пример выше в этой группе. Для диагностики подключений открой /status. Этот предпросмотр не выполнял действий в группе.",
            "Використай приклад вище в цій групі. Для діагностики підключень відкрий /status. Цей попередній перегляд не виконував дій у групі."));
      case "finish":
        setSession(pendingDraft(store.state.session) ? { ...pendingDraft(store.state.session), paused: true } : null);
        return sendPanel(say(locale, "Settings retained. Talk to me or return with /setup.", "Настройки сохранены. Можешь общаться или вернуться через /setup.", "Налаштування збережено. Можеш спілкуватися або повернутися через /setup."), rootRows(bot, locale));
    }
  }

  async function handleCallback(query, bot) {
    const consumed = await controls.consume(query);
    if (!consumed) return false;
    if (consumed.invalid) return true;
    editMessageId = consumed.messageId;
    try {
      await nativeAction(consumed.action, consumed.action.group ?? consumed.group, bot, store.state.session?.kind === "persona" ? store.state.session.locale : store.state.locale);
    } catch {
      await sendPanel(say(store.state.locale, "Could not apply this step. Your saved settings remain; open /setup and try again.",
        "Не удалось выполнить шаг. Сохранённые настройки остаются; открой /setup и попробуй снова.",
        "Не вдалося виконати крок. Збережені налаштування залишаються; відкрий /setup і спробуй ще раз."), rootRows(bot, store.state.locale));
    } finally { editMessageId = undefined; }
    return true;
  }

  let handling = Promise.resolve();
  function serialHandle(message, bot) {
    const run = handling.catch(() => {}).then(() => handle(message, bot));
    handling = run;
    return run;
  }
  return { handle: serialHandle, settingIsOn, isSetupRequest,
    observe: (update, bot) => {
      const run = handling.catch(() => {}).then(() => observe(update, bot));
      handling = run;
      return run;
    },
    handleCallback: (query, bot) => {
      const run = handling.catch(() => {}).then(() => handleCallback(query, bot));
      handling = run;
      return run;
    } };
}
