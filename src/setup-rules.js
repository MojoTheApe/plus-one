import { randomUUID } from "node:crypto";
import { isRulePhrase, normalizePhrase, validateMessageRules } from "./message-rules.js";
import { profileTitle, selectProfile } from "./setup-profiles.js";
import { say } from "./setup-copy.js";

export const ruleListRequest = /(?:list|show|список|покажи|выведи|перечисли).*(?:rule|trigger|правил|триггер|тригер)/iu;

export function createRuleEditor({ store, games, targetPrompt, resolveTarget }) {
  const settings = draft => draft.profileId ? store.state.profiles[draft.profileId]?.settings : store.group(draft.group);
  const title = draft => draft.profileId ? profileTitle(store.state.profiles[draft.profileId]) : store.group(draft.group)?.title;
  const saveDraft = draft => store.change(state => { state.session = draft; });
  const label = (action, locale) => ({
    judge: say(locale, "review the dispute", "разобрать спор", "розібрати суперечку"),
    assemble: say(locale, "call players", "собрать игроков", "зібрати гравців"),
    animation: say(locale, "send an animation", "отправить GIF", "надіслати GIF"),
    persona: say(locale, "change personality", "сменить личность", "змінити особистість"),
  })[action.type];

  function list(draft, locale) {
    const rules = settings(draft)?.rules ?? [];
    return title(draft) + "\n" + (rules.map((rule, index) => `${index + 1}. ${rule.phrase} → ${label(rule.action, locale)}`).join("\n") ||
      say(locale, "No message rules yet. Say “create a rule”.", "Правил пока нет. Напиши «создай правило».", "Правил поки немає. Напиши «створи правило»."));
  }

  function question(draft, locale) {
    if (!settings(draft)) return targetPrompt(locale);
    if (draft.operation === "delete") {
      const existing = settings(draft).rules?.find(rule => rule.id === draft.deleteId);
      return existing ? say(locale, `Delete “${existing.phrase}” from ${title(draft)}? Save?`,
        `Удалить правило «${existing.phrase}» для «${title(draft)}»? Сохранить?`,
        `Видалити правило «${existing.phrase}» для «${title(draft)}»? Зберегти?`) :
        list(draft, locale) + "\n\n" + say(locale, "Which rule? Send its number or exact phrase.", "Какое правило удалить? Напиши номер или полную фразу.", "Яке правило видалити? Напиши номер або повну фразу.");
    }
    if (!draft.phrase) return say(locale,
      "What exact message should trigger the action? Send the whole phrase in your next message.",
      "На какую фразу реагировать? Пришли её целиком следующим сообщением.",
      "На яку фразу реагувати? Надішли її повністю наступним повідомленням.");
    if (!draft.action) return say(locale,
      "What should I do: review a dispute, call players, send a GIF, or change personality?",
      "Что делать: разобрать спор, собрать игроков, отправить GIF или сменить личность?",
      "Що робити: розібрати суперечку, зібрати гравців, надіслати GIF чи змінити особистість?");
    if (draft.action.type === "persona" && !draft.action.profile) return say(locale, "Which personality? Reply with a profile name.",
      "Какую личность включать? Напиши название профиля.", "Яку особистість вмикати? Напиши назву профілю.") + "\n" +
      Object.values(store.state.profiles).map(profile => "• " + profileTitle(profile)).join("\n");
    if (draft.action.type === "assemble" && !draft.action.game) return say(locale, "Which game, or everyone?", "Какая игра или общий сбор?", "Яка гра чи загальний збір?") + "\n" + games.map(game => game.name).join(" · ");
    if (draft.action.type === "animation" && !draft.action.animation) return say(locale, "Send the GIF to use.", "Пришли нужный GIF.", "Надішли потрібний GIF.");
    if (!draft.access) return say(locale, "Who may trigger it: only you, or group members?", "Кто может запускать: только ты или участники группы?", "Хто може запускати: лише ти чи учасники групи?");
    if (draft.announcement === undefined) return say(locale,
      "What should I post when it runs? Write the exact text, or “skip” for no announcement.",
      "Что написать при срабатывании? Пришли готовый текст или напиши «пропустить», чтобы обойтись без сообщения.",
      "Що написати при спрацюванні? Надішли готовий текст або напиши «пропустити», щоб обійтися без повідомлення.");
    const replacement = (settings(draft).rules ?? []).some(rule => normalizePhrase(rule.phrase) === normalizePhrase(draft.phrase));
    return [
      title(draft),
      say(locale, `Exact phrase: ${draft.phrase}`, `Полная фраза: ${draft.phrase}`, `Повна фраза: ${draft.phrase}`),
      label(draft.action, locale) + (draft.action.profile ? " — " + profileTitle(store.state.profiles[draft.action.profile]) : draft.action.game ? " — " + draft.action.game : ""),
      draft.action.type === "persona" ? say(locale, "Personality and language only; feature settings and memory stay with this group.", "Меняются только личность и язык. Настройки функций и память группы сохраняются.", "Змінюються лише особистість і мова. Налаштування функцій і пам’ять групи зберігаються.") : "",
      draft.access === "owner" ? say(locale, "Only the owner can trigger this.", "Запускать может только владелец.", "Запускати може лише власник.") : say(locale, "Group members can trigger this within the feature's permissions.", "Запускать могут участники с учётом прав самой функции.", "Запускати можуть учасники з урахуванням прав самої функції."),
      draft.announcement ? say(locale, `Public announcement:\n${draft.announcement}`, `Сообщение в группе:\n${draft.announcement}`, `Повідомлення у групі:\n${draft.announcement}`) : say(locale, "No extra announcement.", "Без дополнительного сообщения.", "Без додаткового повідомлення."),
      replacement ? say(locale, "This replaces the existing rule for that phrase.", "Существующее правило этой фразы будет заменено.", "Поточне правило цієї фрази буде замінено.") : "",
      settings(draft).disabled?.reaction ? say(locale, "Phrase reactions will be enabled.", "Реакции на фразы будут включены.", "Реакції на фрази будуть увімкнені.") : "",
      say(locale, "Save?", "Сохранить?", "Зберегти?"),
    ].filter(Boolean).join("\n\n");
  }

  async function handle(draft, text, animation, bot, locale, confirmed) {
    const next = structuredClone(draft);
    if (!settings(next)) {
      const target = await resolveTarget(text, bot);
      if (!target) return targetPrompt(locale);
      Object.assign(next, target);
    } else if (next.operation === "delete") {
      const rules = settings(next).rules ?? [];
      if (!next.deleteId) {
        const found = /^\d+$/u.test(text.trim()) ? rules[Number(text.trim()) - 1] : rules.find(rule => normalizePhrase(rule.phrase) === normalizePhrase(text));
        if (found) next.deleteId = found.id;
      } else if (confirmed) {
        return persist(next, locale);
      }
    } else if (!next.phrase) {
      if (isRulePhrase(text)) next.phrase = text.trim();
    } else if (!next.action) {
      const profile = selectProfile(store.state.profiles, text);
      if (/judge|dispute|рассуд|судь|спор|супереч/iu.test(text)) next.action = { type: "judge", scope: /all|все|всі/iu.test(text) ? "all" : "single" };
      else if (/assembl|call|gather|сбор|собрать|собери|зб[іо]р|зібрати/iu.test(text)) next.action = { type: "assemble" };
      else if (/gif|animation|гиф|гіф|анимац|анімац/iu.test(text) || animation) next.action = { type: "animation", animation };
      else if (profile || /person|profil|личност|профил|особист|профіл/iu.test(text)) next.action = { type: "persona", profile };
      if (next.action?.type === "persona") next.access = "owner";
    } else if (next.action.type === "persona" && !next.action.profile) {
      next.action.profile = selectProfile(store.state.profiles, text);
    } else if (next.action.type === "assemble" && !next.action.game) {
      const value = normalizePhrase(text);
      const game = games.find(item => [item.id, item.name, ...item.aliases].some(alias => normalizePhrase(alias) === value));
      if (game) next.action.game = game.id;
      else if (/everyone|global|all|всех|всіх|общий|загальний/iu.test(text)) next.action.game = "global";
    } else if (next.action.type === "animation" && !next.action.animation) {
      if (animation) next.action.animation = animation;
    } else if (!next.access) {
      if (/\b(?:owner|only|me)\b|владел|только|мне|власник|лише/iu.test(text)) next.access = "owner";
      else if (/member|everyone|all|участ|все|всім/iu.test(text)) next.access = "members";
    } else if (next.announcement === undefined) {
      if (/^(?:skip|none|no|пропустить|пропусти|нет|пропустити|пропусти|ні)[.!]?$/iu.test(text.trim())) next.announcement = "";
      else if (text.trim() && text.length <= 2000) next.announcement = text.trim();
    } else if (confirmed) return persist(next, locale);
    if (next.operation === "list" && settings(next)) {
      saveDraft({ kind: "menu", group: next.group, profileId: next.profileId });
      return list(next, locale);
    }
    saveDraft(next);
    return question(next, locale);
  }

  function persist(draft, locale) {
    const current = settings(draft);
    let rules = current.rules ?? [];
    if (draft.operation === "delete") rules = rules.filter(rule => rule.id !== draft.deleteId);
    else {
      const existing = rules.find(rule => normalizePhrase(rule.phrase) === normalizePhrase(draft.phrase));
      if (!existing && rules.length >= 32) return say(locale,
        "This target already has 32 rules. Cancel this draft and delete a rule first.",
        "Здесь уже 32 правила. Отмени черновик и сначала удали одно из правил.",
        "Тут уже 32 правила. Скасуй чернетку й спочатку видали одне з правил.");
      const rule = { id: existing?.id ?? randomUUID(), phrase: draft.phrase, action: draft.action, access: draft.access, announcement: draft.announcement, createdAt: new Date().toISOString() };
      rules = validateMessageRules([...rules.filter(item => item.id !== existing?.id), rule]);
    }
    store.change(state => {
      const target = draft.profileId ? state.profiles[draft.profileId].settings : state.groups[draft.group];
      target.rules = rules;
      target.disabled ??= {};
      if (draft.operation !== "delete") target.disabled.reaction = false;
      if (!draft.profileId) {
        if (!target.configured) target.modes = { memory: "off", voice: "off", analysis: "off", download: "off", minigames: "off" };
        target.configured = true;
      }
      state.session = draft.resume ?? { kind: "menu", group: draft.group, profileId: draft.profileId };
    });
    return say(locale, "Message rules saved.", "Правила сохранены.", "Правила збережено.");
  }

  return { question, handle, list };
}
