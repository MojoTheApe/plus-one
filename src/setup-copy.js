export function say(locale, english, russian, ukrainian) {
  return locale === "ru" ? russian : locale === "uk" ? ukrainian : english;
}

// Each feature has one owner-facing description and a scope. Only the group
// features with a live editor offer a "configure" instruction.
const features = [
  ["profile", /profil|persona|характер|профил|профіл/i,
    ["Profile", "Профиль", "Профіль"],
    ["Name, personality and language. Create another profile or assign one to a group. Set humor with /humor where permitted.", "Имя, характер и язык. Можно создать другой профиль или назначить его группе. Юмор меняется командой /humor там, где она доступна.", "Ім’я, характер і мова. Можна створити інший профіль або призначити його групі. Гумор змінюється командою /humor там, де вона доступна."]],
  ["search", /search|research|web|поиск|интернет|пошук|інтернет/i,
    ["Web search", "Поиск в интернете", "Пошук в інтернеті"],
    ["Ask me to check something online. I’ll look for sources and cite them when available.", "Попроси проверить что-то в интернете. Я поищу источники и дам ссылки.", "Попроси перевірити щось в інтернеті. Я пошукаю джерела й дам посилання."]],
  ["judge", /judge|dispute|спор|супереч|вердикт/i,
    ["Debates", "Разбор споров", "Розбір суперечок"],
    ["Reply to a message with /judge to review that discussion, or use /judge all to find separate disputes.", "Ответь на сообщение командой /judge, чтобы разобрать этот спор. Для нескольких споров есть /judge all.", "Відповідай на повідомлення командою /judge, щоб розібрати цю суперечку. Для кількох суперечок є /judge all."]],
  ["history", /history|истори|переписк|історі|листуван/i,
    ["Chat history", "История чата", "Історія чату"],
    ["Ask for a summary of a period or for a message by number. I use the history available to this chat.", "Попроси сводку за период или сообщение по номеру. Я использую доступную историю этого чата.", "Попроси підсумок за період або повідомлення за номером. Я використовую доступну історію цього чату."]],
  ["memory", /memory|пам[я’ʼ]|запомин|запам/i,
    ["Memory", "Память", "Пам’ять"],
    ["Use /remember, /memory and /forget when memory is enabled. In a group, select commands only, automatic capture from requests, or off.", "Используй /remember, /memory и /forget, когда память включена. В группе выбери режим по просьбе, автоматическое сохранение из обращений или выключение.", "Використовуй /remember, /memory і /forget, коли пам’ять увімкнена. У групі вибери режим за запитом, автоматичне збереження зі звернень або вимкнення."]],
  ["voice", /voice|audio|голос|аудио|аудіо/i,
    ["Voice messages", "Голосовые", "Голосові"],
    ["I can transcribe voice messages and answer from the transcript. For each group, choose when I’m addressed, automatic replies, or off.", "Я могу расшифровать голосовое и ответить по тексту. Для группы можно выбрать расшифровку при обращении, автоответы или выключение.", "Я можу розшифрувати голосове й відповісти за текстом. Для групи можна вибрати розшифрування при зверненні, автовідповіді або вимкнення."]],
  ["download", /download|скач|загруз|завантаж/i,
    ["Media downloads", "Скачивание по ссылкам", "Завантаження за посиланнями"],
    ["I can send public media from supported links. Enable downloads for the group and give me the required Telegram permissions.", "Я могу присылать публичное медиа по поддерживаемым ссылкам. Скачивание можно включить или выключить для группы. В Telegram мне нужны подходящие права.", "Я можу надсилати публічні медіа за підтримуваними посиланнями. Завантаження можна ввімкнути або вимкнути для групи. У Telegram мені потрібні відповідні права."]],
  ["analysis", /analy[sz]|photo|video|анализ|аналіз|фото|видео|відео/i,
    ["Photo and video analysis", "Анализ фото и видео", "Аналіз фото й відео"],
    ["Send media and ask what you want to know. Video analysis uses frames and available speech. Analysis can be switched on or off for a group.", "Пришли файл и задай вопрос. В видео я анализирую кадры и доступную речь. Анализ можно включить или выключить для группы.", "Надішли файл і постав питання. У відео я аналізую кадри й доступне мовлення. Аналіз можна ввімкнути або вимкнути для групи."]],
  ["assemble", /assembl|gather|game calls|сбор|соб(ери|рать)|зб[іо]р|зібр/i,
    ["Game calls", "Сборы игроков", "Збори гравців"],
    ["I can call the right players for a game. In a group profile you can choose a game, list its players, add a GIF and turn calls on or off.", "Я могу позвать нужных игроков. В профиле группы можно выбрать игру, задать состав, добавить GIF и включить или выключить сборы.", "Я можу покликати потрібних гравців. У профілі групи можна вибрати гру, задати склад, додати GIF та увімкнути або вимкнути збори."]],
  ["minigames", /mini.?games?|мини.?игр|міні.?ігор|міні.?ігр|flappy|occupiers|duel/i,
    ["Telegram Mini Apps", "Мини-игры в Telegram", "Мініігри в Telegram"],
    ["Mini Apps need their own HTTPS services and BotFather registration. Set their URLs on the server, then choose which groups can launch them through me. Links already opened use the game service.", "Мини-играм нужны свои HTTPS-сервисы и регистрация в BotFather. Ссылки задаются на сервере. По группам можно включать и выключать запуск через меня. Уже открытые игры работают на своём сервисе.", "Мінііграм потрібні власні HTTPS-сервіси й реєстрація в BotFather. Посилання задаються на сервері. По групах можна вмикати й вимикати запуск через мене. Вже відкриті ігри працюють на своєму сервісі."]],
  ["reaction", /react|phrase|реакц|фраз/i,
    ["Phrase reactions", "Реакции на фразы", "Реакції на фрази"],
    ["Connect an exact message to an action: review a dispute, call players, send a GIF, or change personality. Say “create a rule”, “show rules”, or “delete a rule”. Choose a group or saved profile, review and confirm. Personality changes are owner-only and keep feature settings. Existing addressed phrase GIFs can also be configured.", "Свяжи полную фразу с действием: разобрать спор, собрать игроков, отправить GIF или сменить личность. Напиши «создай правило», «покажи правила» или «удали правило». Выбери группу или сохранённый профиль, проверь и подтверди. Менять личность может только владелец; настройки функций сохраняются. Можно также настроить прежний GIF в ответ на обращение.", "Пов’яжи повну фразу з дією: розібрати суперечку, зібрати гравців, надіслати GIF або змінити особистість. Напиши «створи правило», «покажи правила» чи «видали правило». Вибери групу або збережений профіль, перевір і підтвердь. Змінювати особистість може лише власник; налаштування функцій зберігаються. Можна також налаштувати попередній GIF у відповідь на звернення."]],
  ["sticker", /sticker|ст[иі]кер/i,
    ["Sticker pack", "Стикерпак", "Стікерпак"],
    ["Connect an existing pack for this bot. Group admins can then add or remove individual stickers. You can turn this off for the group.", "Привяжи существующий пак этого бота. Администраторы группы смогут добавлять и удалять отдельные стикеры. Привязку можно отключить.", "Прив’яжи наявний пак цього бота. Адміністратори групи зможуть додавати й видаляти окремі стікери. Прив’язку можна вимкнути."]],
  ["moderation", /moderat|kick|модерац|видал.*учас|удал.*участ/i,
    ["Moderation", "Модерация", "Модерація"],
    ["Authorized operators can remove a member using /kick. Set the allowlist on the server and grant the bot permissions in Telegram.", "Уполномоченные пользователи могут удалить участника через /kick. Список доступа задаётся на сервере, права бота выдаются в Telegram.", "Уповноважені користувачі можуть видалити учасника через /kick. Список доступу задається на сервері, права бота надаються в Telegram."]],
  ["status", /status|health|статус|диагност|діагност/i,
    ["Status", "Статус бота", "Стан бота"],
    ["Use /ping to see whether I’m online. Authorized users can check /status.", "Напиши /ping, чтобы проверить, на связи ли я. Подробный /status доступен уполномоченным пользователям.", "Напиши /ping, щоб перевірити, чи я на зв’язку. Докладний /status доступний уповноваженим користувачам."]],
];

const sections = [
  [["Conversation", "Общение", "Спілкування"], ["profile", "judge", "search"]],
  [["History and memory", "История и память", "Історія й пам’ять"], ["history", "memory"]],
  [["Voice and media", "Голос, фото и видео", "Голос, фото й відео"], ["voice", "analysis", "download"]],
  [["Games", "Сборы и игры", "Збори й ігри"], ["assemble", "minigames"]],
  [["Reactions and stickers", "Реакции и стикеры", "Реакції та стікери"], ["reaction", "sticker"]],
  [["Management", "Управление", "Керування"], ["moderation", "status"]],
];

const scopes = {
  profile: ["profile", "профиль", "профіль"],
  group: ["group", "группа", "група"],
  server: ["server", "сервер", "сервер"],
  request: ["on request", "по запросу", "за запитом"],
};
const featureScope = { profile: "profile", assemble: "group", reaction: "group", sticker: "group",
  memory: "group", voice: "group", analysis: "group", download: "group", minigames: "group", moderation: "server" };

export function matchFeature(text) {
  let closest;
  for (const [id, pattern] of features) {
    const match = pattern.exec(text);
    if (match && (!closest || match.index < closest.start)) {
      closest = { id, start: match.index, end: match.index + match[0].length };
    }
  }
  return closest;
}
export const featureName = (id, locale) => say(locale, ...features.find(([key]) => id === key)[2]);
export const featureDetail = (id, locale) => say(locale, ...features.find(([key]) => id === key)[3]);
export const editableGroupFeature = id => featureScope[id] === "group";

export function catalogue(locale) {
  const lines = sections.map(([title, ids]) => [
    say(locale, ...title),
    ...ids.map(id => `• ${featureName(id, locale)} · ${say(locale, ...scopes[featureScope[id] ?? "request"])}`),
  ].join("\n"));
  return [
    say(locale, "> available features", "> возможности", "> можливості"),
    ...lines,
    say(locale, 'Say “tell me about voice messages” or “configure game calls”. Say “later” to leave setup.',
      'Напиши «расскажи про голосовые» или «настрой сборы». Чтобы выйти, скажи «позже».',
      'Напиши «розкажи про голосові» або «налаштуй збори». Щоб вийти, скажи «пізніше».'),
  ].join("\n\n");
}

export const modeFeatures = ["memory", "voice", "analysis", "download", "minigames"];
export const modeLabel = (mode, locale) => say(locale, ...({
  on: ["on", "включено", "увімкнено"],
  off: ["off", "выключено", "вимкнено"],
  manual: ["on request", "по просьбе", "за запитом"],
  auto: ["automatic", "автоматически", "автоматично"],
  unavailable: ["needs a server connection", "нужно подключение на сервере", "потрібне підключення на сервері"],
}[mode]));

export function modeOptions(feature, locale) {
  if (feature === "memory") return say(locale, "Say “on request”, “automatic”, or “off”.", "Напиши «по просьбе», «автоматически» или «выключить».", "Напиши «за запитом», «автоматично» або «вимкнути».");
  if (feature === "voice") return say(locale, "Say “when addressed”, “automatic replies”, or “off”.", "Напиши «при обращении», «автоответы» или «выключить».", "Напиши «при зверненні», «автовідповіді» або «вимкнути».");
  return say(locale, "Say “on” or “off”.", "Напиши «включить» или «выключить».", "Напиши «увімкнути» або «вимкнути».");
}
