import { randomUUID } from "node:crypto";
import { createRuleEditor, ruleListRequest } from "./setup-rules.js";
import { ruleRequest } from "./message-rules.js";
import {
  assignGroupProfile, assignmentIntent, creationIntent, initialProfileSettings,
  isSetupRequest, profileListIntent, profileTitle, releaseInactiveStickerBindings, selectProfile, stickerConflict,
} from "./setup-profiles.js";
import { actionableAssembleText, normalizeGamePlayers } from "./assemble.js";
import { escapeRegex, parseBotCommandText } from "./helpers.js";
import { catalogue, editableGroupFeature, featureDetail, featureName, matchFeature, modeFeatures, modeLabel, modeOptions, say } from "./setup-copy.js";

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
  return intent;
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
  const { locale, name, personality, language } = draft;
  if (!name) return draft.makeDefault && locale === "en" ?
    "> connection open\nYou there? Looks like I made it through. What do you want to call me?" :
    say(locale, "What name should I use?", "Какое имя мне использовать?", "Яке ім’я мені використовувати?");
  if (!personality) return say(locale,
    `Okay. I’m ${name}. Now tell me what I’m like. Describe me like you’d describe someone you know. How do I talk? What do I find funny? How do I act when things get serious? A couple of lines in your own words is enough.`,
    `Хорошо, я ${name}. Теперь опиши меня, как описал бы знакомого. Как я разговариваю, над чем смеюсь и как веду себя, когда разговор серьёзный? Пары строк своими словами достаточно.`,
    `Добре, я ${name}. Тепер опиши мене, як описав би знайомого. Як я розмовляю, над чим сміюся і як поводжуся, коли розмова серйозна? Достатньо кількох рядків своїми словами.`);
  if (!language) return say(locale,
    "One more thing. What language should I reply in? You can pick one or ask me to use whatever language people write to me in.",
    "На каком языке мне отвечать? Можно выбрать один язык или отвечать на языке собеседника.",
    "Якою мовою мені відповідати? Можна вибрати одну мову або відповідати мовою співрозмовника.");
  const label = draft.label && draft.label !== name ? say(locale,
    `Profile “${draft.label}”\n`, `Профиль «${draft.label}»\n`, `Профіль «${draft.label}»\n`) : "";
  const target = targetTitle ? say(locale, `For ${targetTitle}\n`, `Группа «${targetTitle}»\n`, `Група «${targetTitle}»\n`) : "";
  return label + target + say(locale,
    `I’m ${name}. My character and behavior\n${personality}\n\nReply language — ${languageText(locale, language)}. Save that, or tell me what to change?`,
    `Я ${name}. Мой характер и поведение\n${personality}\n\nЯзык ответов — ${languageText(locale, language)}. Сохранить или хочешь что-то изменить?`,
    `Я ${name}. Мій характер і поведінка\n${personality}\n\nМова відповідей — ${languageText(locale, language)}. Зберегти чи хочеш щось змінити?`);
}

function editPersona(draft, text) {
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
  const withModes = feature === "memory" || feature === "voice";
  if (withModes && /automatic|автомат|автоответ|автовідпов/iu.test(text)) return "auto";
  if (/enable|turn on|^on$|включ|увімк|on request|when addressed|по просьбе|при обращении|за запитом|при зверненні/iu.test(text)) return withModes ? "manual" : "on";
  return undefined;
}

export function createSetup({ store, games, telegram, featureMode, classifyTurn }) {
  async function observe(update) {
    const event = update.my_chat_member ?? update.message;
    if (!isGroup(event?.chat) || !Number.isSafeInteger(event.chat.id) || !event.chat.title) return;
    const membership = update.my_chat_member;
    if (!membership && event.from?.id !== store.ownerId && !store.group(event.chat.id)) return;
    const { id, title } = event.chat;
    const wasKnown = store.group(id);
    const leaving = membership && !activeMember(membership.new_chat_member);
    const arriving = membership && activeMember(membership.new_chat_member) &&
      !activeMember(membership.old_chat_member);
    if (!wasKnown || wasKnown.title !== title || membership) {
      store.change(state => {
        const group = state.groups[id] ?? { configured: false, awaitingProfile: true };
        state.groups[id] = { ...group, title };
        if (leaving) state.groups[id].active = false;
        if (arriving) {
          state.groups[id].active = true;
          if (!group.configured) Object.assign(state.groups[id], {
            awaitingProfile: true, notificationId: null, notificationAttempted: false,
          });
        }
      });
    }
    const group = store.group(id);
    if (leaving || group.notificationId || group.notificationAttempted || (!group.awaitingProfile && wasKnown)) return;
    store.change(state => { state.groups[id].notificationAttempted = true; });
    const locale = store.state.locale;
    const text = say(locale,
      `I joined “${title}”. Which profile should I use there? Reply to this message with a profile name, or ask me to create one.`,
      `Вижу группу «${title}». Какой профиль использовать в ней? Ответь на это сообщение названием профиля или попроси создать новый.`,
      `Бачу групу «${title}». Який профіль використовувати в ній? Відповідай на це повідомлення назвою профілю або попроси створити новий.`);
    try {
      const sent = await telegram("sendMessage", { chat_id: store.ownerId, text: text + "\n\n" + profileList(locale) });
      if (Number.isSafeInteger(sent?.message_id)) {
        store.change(state => { state.groups[id].notificationId = sent.message_id; });
      }
    } catch { /* Binding stays pending if Telegram cannot deliver a private message. */ }
  }

  const setSession = session => store.change(state => { state.session = session; });
  const pendingDraft = session => draftKinds.has(session?.kind) ? session : draftKinds.has(session?.resume?.kind) ? session.resume : null;
  const keepDraft = draft => {
    const previous = pendingDraft(store.state.session);
    if (previous) draft.resume = { ...previous, paused: true };
    return draft;
  };
  const groupEntries = () => Object.entries(store.state.groups).filter(([, group]) => group.title && group.active !== false);
  const settingIsOn = (group, id) => Boolean((group?.[id] || (id === "reaction" && group?.rules?.length)) && !group.disabled?.[id]);
  const ruleEditor = createRuleEditor({ store, games, targetPrompt: configurationPrompt, resolveTarget: resolveConfigurationTarget });
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
    const profile = selectProfile(store.state.profiles, text);
    const group = groupChoice(groupEntries(), text, true);
    if (profile && (/profile|профил|профіл/iu.test(text) || !group)) return { profileId: profile };
    if (group && await allowedGroup(group, bot)) return { group };
    return null;
  }

  function configuration(draft) {
    if (!draft.profileId) return store.group(draft.group);
    const profile = store.state.profiles[draft.profileId];
    return profile ? { ...profile.settings, title: profileTitle(profile) } : null;
  }

  function profileList(locale) {
    const entries = Object.values(store.state.profiles).map(profile => "• " + profileTitle(profile));
    return say(locale, "Available profiles", "Доступные профили", "Доступні профілі") + "\n" +
      (entries.join("\n") || say(locale, "Create a new profile to get started.", "Начни с сообщения «создай новый профиль».", "Почни з повідомлення «створи новий профіль»."));
  }

  async function allowedGroup(id, bot) {
    if (!store.group(id)?.title) return false;
    try {
      const [owner, member] = await Promise.all([
        telegram("getChatMember", { chat_id: Number(id), user_id: store.ownerId }),
        telegram("getChatMember", { chat_id: Number(id), user_id: bot.id }),
      ]);
      return activeMember(owner) && activeMember(member);
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
        return `${index + 1}. ${group.title}${sameTitle ? ` (${id})` : ""}`;
      }).join("\n");
  }

  function configurationPrompt(locale) {
    return say(locale, "Which saved profile or group should I configure? You can write “profile Night”.",
      "Какой сохранённый профиль или группу настроить? Можно написать «профиль Игровой».",
      "Який збережений профіль чи групу налаштувати? Можна написати «профіль Ігровий».") +
      "\n\n" + profileList(locale) + "\n\n" + groupPrompt(locale);
  }

  function groupFeatureStatus(id, key, locale) {
    const group = store.group(id);
    const mode = modeFeatures.includes(key) ? featureMode(id, key) : settingIsOn(group, key) ? "on" : "off";
    return `${featureName(key, locale)} — ${modeLabel(mode, locale)}`;
  }

  function groupSummary(id, locale) {
    const group = store.group(id);
    const profile = group.character?.persona ?? group.persona ?? store.state.profiles[group.profile ?? store.state.defaultProfile];
      const roster = group.assemble?.games.map(game => {
      const animation = game.animationReference || game.animationPath ?
        say(locale, "animation on", "с анимацией", "з анімацією") : say(locale, "no animation", "без анимации", "без анімації");
      return `${game.name} — ${game.players.map(player => "@" + player).join(", ")} (${animation})`;
    }).join("\n");
    return [
      group.title,
      `${featureName("profile", locale)} — ${profile ? profileTitle(profile) : say(locale, "default", "общий", "загальний")}`,
      ...["assemble", "reaction", "sticker", ...modeFeatures].map(key => groupFeatureStatus(id, key, locale)),
      roster,
    ].filter(Boolean).join("\n");
  }

  function groupQuestion(draft, locale) {
    const group = configuration(draft);
    if (!group) return configurationPrompt(locale);
    if (modeFeatures.includes(draft.feature)) {
      if (featureMode(draft.group, draft.feature) === "unavailable" && draft.mode !== "off") return featureDetail(draft.feature, locale) + "\n" + modeLabel("unavailable", locale) + ".";
      if (!draft.mode) return modeOptions(draft.feature, locale);
      return `${group.title}
${featureName(draft.feature, locale)} — ${modeLabel(draft.mode, locale)}. ` +
        say(locale, "Save?", "Сохранить?", "Зберегти?");
    }
    if (draft.operation !== "set") {
      const enabling = draft.operation === "enable";
      const label = featureName(draft.feature, locale);
      return say(locale, `${group.title} — ${enabling ? "enable" : "disable"} ${label}? Say “save” to confirm.`,
        `${group.title} — ${enabling ? "включить" : "выключить"} «${label}»? Напиши «сохрани» для подтверждения.`,
        `${group.title} — ${enabling ? "увімкнути" : "вимкнути"} «${label}»? Напиши «збережи» для підтвердження.`);
    }
    switch (draft.feature) {
      case "assemble":
        if (!draft.game) return say(locale, "Which game?", "Какая игра?", "Яка гра?") + "\n" + games.map(game => game.name).join(" · ");
        if (!draft.players) return say(locale, "Who plays? Send their @usernames.", "Кто играет? Напиши их @имена.", "Хто грає? Напиши їхні @імена.");
        if (draft.animation === undefined) return say(locale, 'Send a GIF, or say “no animation”.', 'Пришли GIF или напиши «без анимации».', 'Надішли GIF або напиши «без анімації».');
        return say(locale, `${group.title} — call ${draft.players.map(name => "@" + name).join(", ")} for ${games.find(game => game.id === draft.game).name}${draft.animation ? " with a GIF" : ""}. Save and enable?`,
          `${group.title} — сбор на ${games.find(game => game.id === draft.game).name}. Зову ${draft.players.map(name => "@" + name).join(", ")}${draft.animation ? " с GIF" : " без анимации"}. Сохранить и включить?`,
          `${group.title} — збір на ${games.find(game => game.id === draft.game).name}. Кличу ${draft.players.map(name => "@" + name).join(", ")}${draft.animation ? " з GIF" : " без анімації"}. Зберегти й увімкнути?`);
      case "reaction":
        if (!draft.terms) return say(locale, "What phrases should trigger the reaction? Separate them with commas.", "На какие фразы реагировать? Перечисли их через запятую.", "На які фрази реагувати? Перелічи їх через кому.");
        if (!draft.animation) return say(locale, "Send the GIF you want me to reply with.", "Пришли GIF, которым я буду отвечать.", "Надішли GIF, яким я відповідатиму.");
        return say(locale, `${group.title} — react to ${draft.terms.join(", ")} with this GIF. Save and enable?`,
          `${group.title} — отвечаю этим GIF на фразы «${draft.terms.join("», «")}». Сохранить и включить?`,
          `${group.title} — відповідаю цим GIF на фрази «${draft.terms.join("», «")}». Зберегти й увімкнути?`);
      case "sticker":
        if (!draft.packName) return say(locale, "Send the link to your existing sticker pack.", "Пришли ссылку на свой существующий стикерпак.", "Надішли посилання на свій наявний стікерпак.");
        return say(locale, `${group.title} — connect ${draft.packName}. Save and enable?`, `${group.title} — подключаю ${draft.packName}. Сохранить и включить?`, `${group.title} — підключаю ${draft.packName}. Зберегти й увімкнути?`);
    }
  }

  function updateGroup(draft) {
    store.change(state => {
      const group = draft.profileId ? state.profiles[draft.profileId].settings : state.groups[draft.group];
      if (!draft.profileId) group.configured = true;
      state.session = draft.resume ?? { kind: "menu", group: draft.group, profileId: draft.profileId };
      if (modeFeatures.includes(draft.feature)) {
        group.modes ??= {};
        group.modes[draft.feature] = draft.mode;
        return;
      }
      group.disabled ??= {};
      group.disabled[draft.feature] = draft.operation === "disable";
      if (draft.operation !== "set") {
        if (!draft.profileId && draft.feature === "sticker") releaseInactiveStickerBindings(state, draft.group, group);
        return;
      }
      if (draft.feature === "assemble") {
        const game = games.find(item => item.id === draft.game);
        const current = group.assemble ?? { games: [] };
        group.assemble = {
          ...current,
          games: [...current.games.filter(item => item.id !== game.id), { ...game, players: draft.players, animationReference: draft.animation }],
        };
      } else if (draft.feature === "reaction") {
        group.reaction = { terms: draft.terms, animation: draft.animation };
      } else {
        group.sticker = { packName: draft.packName, ownerId: store.ownerId };
        if (!draft.profileId) releaseInactiveStickerBindings(state, draft.group, group);
      }
    });
  }

  async function collectGroupInputs(draft, text, animation, bot, fullRequest) {
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
      profileTitle(profile),
      `${profile.name} — ${profile.personality ?? say(locale, "private personality configured on the server", "частная личность, подключённая на сервере", "приватна особистість, підключена на сервері")}`,
      languageText(locale, profile.language),
      settingsSummary(profile.settings ?? initialProfileSettings(), locale),
    ].join("\n");
  }

  function assignmentQuestion(draft, locale) {
    if (!draft.global && !draft.group) return groupPrompt(locale);
    if (draft.profile === undefined) return profileList(locale) + "\n\n" +
      say(locale, "Which profile should I use? Reply with its name.", "Какой профиль использовать? Напиши его название.", "Який профіль використовувати? Напиши його назву.");
    const id = draft.profile ?? store.state.defaultProfile;
    const selected = store.state.profiles[id];
    if (!selected) return profileList(locale);
    const name = profileTitle(selected);
    if (draft.global) return say(locale, `Make ${name} the default profile? Save?`,
      `Сделать ${name} общим профилем? Сохранить?`, `Зробити ${name} загальним профілем? Зберегти?`);
    const selectedGroup = store.group(draft.group);
    const duplicate = groupEntries().some(([id, item]) => id !== draft.group && normalize(item.title) === normalize(selectedGroup.title));
    const title = selectedGroup.title + (duplicate ? ` (${draft.group})` : "");
    return say(locale, `Apply ${name} in ${title}? This replaces the group's managed profile settings.\n\n`,
      `В группе «${title}» применю профиль «${name}». Его личность и настройки заменят текущие настройки профиля этой группы.\n\n`,
      `У групі «${title}» застосую профіль «${name}». Його особистість і налаштування замінять поточні налаштування профілю цієї групи.\n\n`) +
      profileSummary(id, locale) + "\n\n" + say(locale, "Save?", "Сохранить?", "Зберегти?");
  }

  const askPersona = draft => personaQuestion(draft, store.group(draft.target)?.title);

  async function editGroup(draft, text, animation, bot, locale) {
    const next = { ...draft };
    if (!next.group && !next.profileId) {
      const profile = next.feature ? selectProfile(store.state.profiles, text) : undefined;
      const group = groupChoice(groupEntries(), text, true);
      const explicitProfile = /profile|профил|профіл/iu.test(text);
      if (profile && (explicitProfile || !group)) next.profileId = profile;
      else {
        if (!group || !await allowedGroup(group, bot)) {
          return next.feature ? configurationPrompt(locale) : groupPrompt(locale);
        }
        next.group = group;
        if (next.view) { setSession({ kind: "menu", group, resume: next.resume }); return groupSummary(group, locale); }
        if (next.createPersona) {
          const persona = { kind: "persona", locale, target: group, resume: next.resume };
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
    const complete = modeSetting || next.operation !== "set" || (next.feature === "assemble" ? next.game && next.players && next.animation !== undefined :
      next.feature === "reaction" ? next.terms && next.animation : next.packName);
    if (complete && yes.test(text)) {
      if (!next.profileId && !await allowedGroup(next.group, bot)) {
        return say(locale, "I can’t verify access to that group.", "Не получилось проверить доступ к группе.", "Не вдалося перевірити доступ до групи.");
      }
      const sticker = next.packName ? { packName: next.packName } : configuration(next).sticker;
      if (!next.profileId && next.feature === "sticker" && next.operation !== "disable" &&
        stickerConflict(store.state, next.group, { sticker })) {
        return say(locale, "That pack is already linked to another group.", "Этот пак уже привязан к другой группе.", "Цей пак уже прив’язаний до іншої групи.");
      }
      const title = configuration(next).title;
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
      const draft = keepDraft({ kind: "persona", locale, target, label });
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
    if (presetRequest && !presetId) return profileList(locale);
    const profileId = presetId ?? (!presetRequest && !groupChoice(groups, targetWords) ? store.state.session?.profileId : undefined);
    const explicitGroup = profileId ? undefined : groupChoice(groups, targetWords);
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
      const draft = keepDraft({ ...store.state.profiles[editId], kind: "persona", editId });
      setSession(draft);
      return askPersona(draft);
    }
    if (feature && !asksAbout && editableGroupFeature(feature) && configure.test(text)) {
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
        `To change it, say “configure ${featureName(feature, locale)}” and choose a saved profile or a group.`,
        `Чтобы изменить, напиши «настрой ${featureName(feature, locale).toLowerCase()}» и выбери сохранённый профиль или группу.`,
        `Щоб змінити, напиши «налаштуй ${featureName(feature, locale).toLowerCase()}» та вибери збережений профіль або групу.`) : "";
      return detail + selected + hint;
    }
    return catalogueRequest.test(text) ? showCatalogue(locale) : null;
  }

  async function menuOrChat(text, bot, locale, animation) {
    const candidate = matchFeature(text) || catalogueRequest.test(text) || profileViewRequest.test(text) || ruleRequest.test(text);
    if (!candidate) return null;
    if (classifyTurn) {
      try {
        const intent = readTurnIntent(await classifyTurn({ kind: "menu", paused: false, question: "No pending field. Is this a request about the bot's features/settings, or ordinary conversation?", message: text.slice(0, 4000) }));
        if (intent !== "setup") return null;
      } catch { return null; } // No draft to change; the normal AI path reports its own failure.
    }
    return menu(text, bot, locale, animation);
  }

  async function handle(message, bot) {
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
    let session = store.state.session;
    const locale = session?.kind === "persona" ? session.locale : store.state.locale;
    const reply = async response => {
      if (response === null) return false;
      let remaining = response;
      while (remaining.length > 3900) {
        const split = remaining.lastIndexOf("\n", 3900);
        const length = split > 0 ? split : 3899;
        await telegram("sendMessage", { chat_id: store.ownerId, text: remaining.slice(0, length) });
        remaining = remaining.slice(length).trimStart();
      }
      await telegram("sendMessage", { chat_id: store.ownerId, text: remaining });
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
        const draft = { kind: "persona", makeDefault: true, locale: "en" };
        setSession(draft);
        return reply(askPersona(draft));
      }
      setSession({ kind: "menu", group: session?.group, profileId: session?.profileId });
      return reply(showCatalogue(locale));
    }
    if (!session) return reply(await menuOrChat(text, bot, locale, message.animation?.file_id));
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
      if (!yes.test(text) && !(message.animation && expectedAnimation) && classifyTurn) {
        let intent;
        try {
          intent = readTurnIntent(await classifyTurn({ kind: pending.kind, paused: Boolean(pending.paused), question: currentQuestion.slice(0, 3500), message: text.slice(0, 4000) }));
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
    if (session.kind === "rule") return reply(await ruleEditor.handle(session, text, message.animation?.file_id, bot, locale, yes.test(text)));

    if (session.kind === "persona") {
      if (session.name && session.personality && session.language && yes.test(text)) {
        if (session.target && !await allowedGroup(session.target, bot)) return reply(groupPrompt(locale));
        const { name, personality, language } = session;
        if (Object.entries(store.state.profiles).some(([id, item]) => id !== session.editId && normalize(profileTitle(item)) === normalize(session.label || name))) {
          if (session.label) return reply(say(locale, "That profile label is already in use. Ask me to create a profile with another label.",
            "Профиль с таким названием уже есть. Попроси создать профиль с другим названием.",
            "Профіль із такою назвою вже є. Попроси створити профіль з іншою назвою."));
          return reply(say(locale, "That profile name is already in use. Say “change name”.", "Профиль с таким именем уже есть. Напиши «поменяй имя».", "Профіль із таким ім’ям уже є. Напиши «зміни ім’я»."));
        }
        store.change(state => {
          const id = session.editId ?? randomUUID();
          state.profiles[id] = {
            ...state.profiles[id], name, label: session.label || name, personality, language, locale,
            settings: state.profiles[id]?.settings ?? initialProfileSettings(), revision: randomUUID(),
          };
          if (session.makeDefault || !state.defaultProfile) state.defaultProfile = id;
          state.locale = locale;
          state.session = session.target ? { kind: "assignment", group: session.target, profile: id, resume: session.resume } : session.resume ?? { kind: "discover" };
        });
        if (session.target) return reply(say(locale, "> profile saved\n\n", "> профиль сохранён\n\n", "> профіль збережено\n\n") +
          assignmentQuestion(store.state.session, locale));
        if (session.resume) return reply(say(locale, "Profile saved. Your earlier draft is safe; say “continue setup” to return.", "Профиль сохранён. Предыдущий черновик сохранён; напиши «продолжим настройку», чтобы вернуться.", "Профіль збережено. Попередню чернетку збережено; напиши «продовжимо налаштування», щоб повернутися."));
        return reply(say(locale, "> profile saved\nWant to see what I can do?", "> профиль сохранён\nХочешь, расскажу, что я умею?", "> профіль збережено\nХочеш, розкажу, що я вмію?"));
      }
      const next = { ...session };
      editPersona(next, text);
      if (session.name && session.personality && !session.language && !next.language && text) {
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
      const selected = store.state.profiles[next.profile ?? store.state.defaultProfile];
      if (!selected) return reply(profileList(locale));
      if (next.group && stickerConflict(store.state, next.group, selected.settings ?? {})) {
        return reply(say(locale, "That sticker pack is in use by another group. Change or disable it in this profile before applying.",
          "Стикерпак этого профиля уже используется в другой группе. Измени или выключи его в профиле перед применением.",
          "Стікерпак цього профілю вже використовується в іншій групі. Зміни або вимкни його в профілі перед застосуванням."));
      }
      store.change(state => {
        if (next.group) assignGroupProfile(state, next.group, next.profile, randomUUID());
        else {
          state.defaultProfile = next.profile;
          state.defaultRevision = randomUUID();
        }
        state.session = next.resume ?? { kind: "menu", group: next.group };
      });
      return reply(say(locale, "Profile assignment saved.", "Назначение профиля сохранено.", "Призначення профілю збережено."));
    }
    if (session.kind === "group") return reply(await editGroup(session, text, message.animation?.file_id, bot, locale));
    if (session.kind === "discover") {
      setSession({ kind: "menu", group: session.group, profileId: session.profileId });
      if (yes.test(text) || /(?:see|show|what|посмотр|покажи|что|подив|покажи|що).*(?:next|дальше|далі)/iu.test(text)) return reply(showCatalogue(locale));
    }
    return reply(await menuOrChat(text, bot, locale, message.animation?.file_id));
  }

  let handling = Promise.resolve();
  function serialHandle(message, bot) {
    const run = handling.catch(() => {}).then(() => handle(message, bot));
    handling = run;
    return run;
  }
  return { handle: serialHandle, observe, settingIsOn, isSetupRequest };
}
