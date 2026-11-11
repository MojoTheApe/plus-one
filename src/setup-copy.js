import { say } from "./helpers.js";
export { say } from "./helpers.js";

// Each feature has one owner-facing description and a scope. Only the group
// features with a live editor offer a "configure" instruction.
const features = [
  ["chat", /conversation|chatting|talk|общени|разговор|спілкуван/i, ["Questions and conversation","Ответы и общение","Відповіді та спілкування"]],
  ["profile", /profil|persona|personality|характер|личност|особист|профил|профіл/i, ["Bot personality","Личность бота","Особистість бота"]],
  ["search", /search|research|web|поиск|интернет|пошук|інтернет/i, ["Web search","Поиск в интернете","Пошук в інтернеті"]],
  ["judge", /judge|dispute|debat|разбор спор|розбір супереч|спор|супереч|вердикт/i, ["Debates","Разбор споров","Розбір суперечок"]],
  ["history", /history|истори|переписк|історі|листуван/i, ["Chat history","История чата","Історія чату"]],
  ["memory", /memory|пам[я’ʼ]|запомин|запам/i, ["Memory","Память","Пам’ять"]],
  ["voice", /voice|audio|голос|аудио|аудіо/i, ["Voice messages","Голосовые","Голосові"]],
  ["download", /download|скач|загруз|завантаж/i, ["Media downloads","Скачивание по ссылкам","Завантаження за посиланнями"]],
  ["analysis", /analy[sz]|photo|video|анализ|аналіз|фото|видео|відео/i, ["Photo and video analysis","Анализ фото и видео","Аналіз фото й відео"]],
  ["assemble", /assembl|gather|game calls|players|сбор|соб(ери|рать)|игрок|гравц|зб[іо]р|зібр/i, ["Game calls","Сборы игроков","Збори гравців"]],
  ["minigames", /mini.?games?|mini apps|мини.?игр|міні.?ігор|міні.?ігр|flappy|occupiers|duel/i, ["Telegram Mini Apps","Мини-игры в Telegram","Мініігри в Telegram"]],
  ["reaction", /react|phrase|реакц|фраз/i, ["Phrase reactions","Реакции на фразы","Реакції на фрази"]],
  ["sticker", /sticker|ст[иі]кер/i, ["Sticker pack","Стикерпак","Стікерпак"]],
  ["moderation", /moderat|kick|модерац|видал.*учас|удал.*участ/i, ["Moderation","Модерация","Модерація"]],
  ["status", /status|health|статус|стан бота|диагност|діагност/i, ["Status","Статус бота","Стан бота"]],
];

const sections = [
  [["Conversation", "Общение", "Спілкування"], ["chat", "profile", "judge", "search"]],
  [["History and memory", "История и память", "Історія й пам’ять"], ["history", "memory"]],
  [["Voice and media", "Голос, фото и видео", "Голос, фото й відео"], ["voice", "analysis", "download"]],
  [["Games", "Сборы и игры", "Збори й ігри"], ["assemble", "minigames"]],
  [["Reactions and stickers", "Реакции и стикеры", "Реакції та стікери"], ["reaction", "sticker"]],
  [["Management", "Управление", "Керування"], ["moderation", "status"]],
];

const featureScope = { profile: "profile", assemble: "group", reaction: "group", sticker: "group",
  memory: "group", voice: "group", analysis: "group", download: "group", minigames: "group", moderation: "server" };

// Catalogue summaries and setup instructions share the feature IDs used by the
// existing editors. They describe defaults, not a live AI-connection guarantee.
const help = {
  chat: { kind: "default", summary: ["Answers, explanations and ordinary conversation.", "Ответы на вопросы, объяснения и обычный разговор.", "Відповіді на запитання, пояснення й звичайна розмова."],
    steps: ["Needs a connected AI. Ask a question; no separate setup is required.", "Нужен подключённый AI. Просто задай вопрос — отдельная настройка не нужна.", "Потрібен підключений AI. Просто постав запитання — окреме налаштування не потрібне."] },
  profile: { kind: "optional", summary: ["My name, character, language and reusable profiles.", "Моё имя, характер, язык и сохранённые профили.", "Моє ім’я, характер, мова та збережені профілі."],
    steps: ["Describe my name, character and reply language. Review and confirm. You can prepare profiles before adding any groups. Example: “create a new profile”. To edit one: “edit profile [name]”. Assigning a full profile also applies its feature settings; a personality rule changes only the character and language.", "Задай имя, опиши характер и выбери язык. Проверь итог и подтверди. Профили можно подготовить ещё до добавления в группы. Пример: «создай новый профиль». Для правки: «измени профиль [название]». Назначение полного профиля применяет и его настройки функций; правило смены личности меняет только характер и язык.", "Задай ім’я, опиши характер і вибери мову. Перевір підсумок і підтвердь. Профілі можна підготувати ще до додавання в групи. Приклад: «створи новий профіль». Для редагування: «зміни профіль [назва]». Призначення повного профілю застосовує і його налаштування функцій; правило зміни особистості змінює лише характер і мову."] },
  judge: { kind: "default", summary: ["Reviews a dispute using the available discussion.", "Разбираю спор по доступной переписке.", "Розбираю суперечку за доступним листуванням."],
    steps: ["Needs a connected AI and access to the discussion. Reply to a disputed message with /judge; /judge all reviews separate disputes. No feature setup is required.", "Нужны подключённый AI и доступ к переписке. Ответь на спорную реплику командой /judge; /judge all разбирает отдельные споры. Отдельно настраивать функцию не нужно.", "Потрібні підключений AI і доступ до листування. Відповідай на спірну репліку командою /judge; /judge all розбирає окремі суперечки. Окреме налаштування не потрібне."] },
  search: { kind: "default", summary: ["Checks current facts and finds sources.", "Проверяю актуальные факты и ищу источники.", "Перевіряю актуальні факти й шукаю джерела."],
    steps: ["Needs a connected AI with web search. When using the current Claude adapter, web search is not connected yet. Example: “check the latest news about this”. Results must include supporting sources; an unavailable search is reported rather than guessed.", "Нужен подключённый AI с поиском в интернете. При использовании текущего адаптера Claude веб-поиск пока недоступен. Пример: «проверь последние новости об этом». Для ответа нужны подтверждающие источники; если поиск недоступен, я сообщу об этом.", "Потрібен підключений AI з пошуком в інтернеті. Якщо використовується поточний адаптер Claude, вебпошук поки недоступний. Приклад: «перевір останні новини про це». Для відповіді потрібні джерела; якщо пошук недоступний, я повідомлю про це."] },
  history: { kind: "default", summary: ["Finds messages and summarizes available chat history.", "Нахожу сообщения и делаю сводки доступной переписки.", "Знаходжу повідомлення й підсумовую доступне листування."],
    steps: ["Only history available to this chat is used. Ask for a time period or message number. Example: “summarize this morning”. Summaries need the connected AI.", "Используется только доступная история этого чата. Укажи период или номер сообщения. Пример: «подведи итоги сегодняшнего утра». Для сводки нужен подключённый AI.", "Використовується лише доступна історія цього чату. Укажи період або номер повідомлення. Приклад: «підсумуй сьогоднішній ранок». Для підсумку потрібен підключений AI."] },
  memory: { kind: "optional", summary: ["Keeps useful notes and recalls them when needed.", "Сохраняю полезные сведения и вспоминаю их по запросу.", "Зберігаю корисні відомості й пригадую їх за запитом."],
    steps: ["Default: save on request. /remember stores a note, /memory shows notes and /forget removes them. In a saved profile or group choose on-request, automatic capture from addressed requests, or off. Example: “configure memory in profile [name]”. Automatic mode does not mean recording every group message.", "По умолчанию сохраняю по просьбе. /remember — записать, /memory — посмотреть, /forget — удалить. В профиле или группе можно выбрать сохранение по просьбе, автоматически из обращений или выключить память. Пример: «настрой память в профиле [название]». Автоматический режим не означает запись всех сообщений группы.", "За замовчуванням зберігаю за проханням. /remember — записати, /memory — переглянути, /forget — видалити. У профілі або групі можна вибрати збереження за проханням, автоматично зі звернень або вимкнути пам’ять. Приклад: «налаштуй пам’ять у профілі [назва]». Автоматичний режим не означає запис усіх повідомлень групи."] },
  voice: { kind: "optional", summary: ["Transcribes voice messages and can answer them.", "Расшифровываю голосовые и могу отвечать на них.", "Розшифровую голосові й можу відповідати на них."],
    steps: ["The transcription service must be connected; replies also need AI. Default: when addressed. Choose when addressed, automatic replies, or off in a profile/group. Example: “configure voice messages in profile [name]”. If not connected, ask your installation agent to enable transcription.", "Нужна подключённая расшифровка; для ответов также нужен AI. По умолчанию — при обращении. Для профиля или группы выбери «при обращении», «автоответы» или «выключить». Пример: «настрой голосовые в профиле [название]». Если расшифровка не подключена, попроси агента установки её подключить.", "Потрібне підключене розпізнавання; для відповідей також потрібен AI. За замовчуванням — при зверненні. Для профілю або групи вибери «при зверненні», «автовідповіді» або «вимкнути». Приклад: «налаштуй голосові у профілі [назва]». Якщо розпізнавання не підключене, попроси агента встановлення його підключити."] },
  download: { kind: "optional", summary: ["Sends media from supported public links in a group.", "Присылаю медиа по поддерживаемым публичным ссылкам в группе.", "Надсилаю медіа за підтримуваними публічними посиланнями в групі."],
    steps: ["Enabled by default in new profiles after assignment to a group. Send a supported public Instagram, Threads or TikTok link. The bot needs administrator rights and its downloader enabled. Private or restricted posts may be unavailable. You can turn downloads off/on per profile or group. Example: “configure downloads in profile [name]”. Existing saved off settings stay off.", "В новых профилях включено по умолчанию после назначения группе. Пришли поддерживаемую публичную ссылку Instagram, Threads или TikTok. Боту нужны права администратора и подключённое скачивание. Закрытые или ограниченные публикации могут быть недоступны. Для профиля или группы можно включить или выключить скачивание. Пример: «настрой скачивание в профиле [название]». Ранее сохранённое выключение сохраняется.", "У нових профілях увімкнено за замовчуванням після призначення групі. Надішли підтримуване публічне посилання Instagram, Threads або TikTok. Боту потрібні права адміністратора й підключене завантаження. Закриті чи обмежені публікації можуть бути недоступні. Для профілю або групи можна ввімкнути чи вимкнути завантаження. Приклад: «налаштуй завантаження у профілі [назва]». Раніше збережене вимкнення зберігається."] },
  analysis: { kind: "optional", summary: ["Explains images and available video evidence on request.", "По просьбе разбираю фото и доступное содержимое видео.", "За проханням розбираю фото й доступний вміст відео."],
    steps: ["Needs media analysis and an AI that supports images. When using the current Claude adapter, image input is not connected yet. Send a file and your question. Video uses selected frames and available speech. Enabled by default; turn off/on per profile or group. Example: “configure media analysis in profile [name]”. This does not imply watching or hearing an entire video.", "Нужны подключённый анализ и AI с поддержкой изображений. При использовании текущего адаптера Claude передача изображений пока недоступна. Пришли файл и вопрос. Для видео используются выбранные кадры и доступная речь. По умолчанию включено; можно выключить или включить для профиля или группы. Пример: «настрой анализ фото в профиле [название]». Это не означает полный просмотр и прослушивание видео.", "Потрібні підключений аналіз і AI з підтримкою зображень. Якщо використовується поточний адаптер Claude, передавання зображень поки недоступне. Надішли файл і запитання. Для відео використовуються вибрані кадри й доступне мовлення. За замовчуванням увімкнено; можна вимкнути чи ввімкнути для профілю або групи. Приклад: «налаштуй аналіз фото у профілі [назва]». Це не означає повний перегляд і прослуховування відео."] },
  assemble: { kind: "setup", summary: ["Calls the configured players for a game.", "Зову нужных игроков на игру.", "Кличу потрібних гравців на гру."],
    steps: ["Choose a saved profile or a group, a supported game and its players. List Telegram usernames; a GIF is optional. Review the result and confirm. Games and rosters are kept in the selected profile/group. Example: “configure game calls in profile [name]”. I then ask for the game, @players and animation. Calls can be turned off without deleting the roster.", "Выбери сохранённый профиль или группу, поддерживаемую игру и её участников. Укажи Telegram-имена; GIF необязателен. Проверь итог и подтверди. Игры и составы хранятся в выбранном профиле или группе. Пример: «настрой сборы в профиле [название]». Затем я спрошу игру, @участников и анимацию. Сборы можно выключить без удаления состава.", "Вибери збережений профіль або групу, підтримувану гру та її учасників. Укажи Telegram-імена; GIF необов’язковий. Перевір підсумок і підтвердь. Ігри та склади зберігаються у вибраному профілі або групі. Приклад: «налаштуй збори у профілі [назва]». Потім я запитаю гру, @учасників та анімацію. Збори можна вимкнути без видалення складу."] },
  reaction: { kind: "setup", summary: ["Connects a phrase to a GIF or another bot action.", "Связываю фразу с GIF или другим действием бота.", "Пов’язую фразу з GIF або іншою дією бота."],
    steps: ["Choose a profile/group, the whole phrase, an action and who may use it. Actions: judge, player call, GIF or personality change. Add an optional announcement, review and confirm. Example: “create a rule”. Personality changes are owner-only. Forwarded or quoted phrases do not trigger rules. “Show rules” and “delete a rule” manage them.", "Выбери профиль или группу, полную фразу, действие и кто может запускать. Действия: судья, сбор, GIF или смена личности. Можно добавить сообщение при срабатывании. Проверь и подтверди. Пример: «создай правило». Менять личность может только владелец. Пересланные фразы и цитаты правила не запускают. Управление: «покажи правила» и «удали правило».", "Вибери профіль або групу, повну фразу, дію та хто може запускати. Дії: суддя, збір, GIF або зміна особистості. Можна додати повідомлення при спрацюванні. Перевір і підтвердь. Приклад: «створи правило». Змінювати особистість може лише власник. Переслані фрази й цитати не запускають правила. Керування: «покажи правила» та «видали правило»."] },
  sticker: { kind: "setup", summary: ["Manages individual stickers in a connected group pack.", "Добавляю и удаляю стикеры в подключённом паке группы.", "Додаю й видаляю стікери в підключеному паку групи."],
    steps: ["The pack must belong to this Telegram bot. Choose a profile/group and provide its t.me/addstickers link; review and confirm. Example: “configure sticker pack in profile [name]”. Then group admins can reply to an image with /stickeradd or to a sticker from that pack with /stickerdel. Pack creation/ownership must be prepared separately.", "Пак должен принадлежать этому Telegram-боту. Выбери профиль или группу и пришли ссылку t.me/addstickers; проверь и подтверди. Пример: «настрой стикерпак в профиле [название]». Затем администраторы группы могут ответить на картинку командой /stickeradd, а на стикер из этого пака — /stickerdel. Создание пака и его принадлежность нужно подготовить отдельно.", "Пак має належати цьому Telegram-боту. Вибери профіль або групу й надішли посилання t.me/addstickers; перевір і підтвердь. Приклад: «налаштуй стікерпак у профілі [назва]». Потім адміністратори групи можуть відповісти на зображення командою /stickeradd, а на стікер із цього пака — /stickerdel. Створення пака та його належність потрібно підготувати окремо."] },
  minigames: { kind: "connection", summary: ["Launches separately connected Telegram games.", "Открываю отдельно подключённые игры в Telegram.", "Відкриваю окремо підключені ігри в Telegram."],
    steps: ["Ask your installation agent to deploy the game services, connect their HTTPS addresses and register the Mini App in BotFather. Then enable launches for the desired profile/group: “configure mini-games in profile [name]”. /flappy and /duel open connected games. A chat toggle alone cannot install a missing game service.", "Попроси агента установки развернуть игры, подключить их HTTPS-адреса и зарегистрировать мини-приложение в BotFather. Затем включи запуск для нужного профиля или группы: «настрой мини-игры в профиле [название]». /flappy и /duel открывают подключённые игры. Переключатель в чате сам не устанавливает игровой сервис.", "Попроси агента встановлення розгорнути ігри, підключити їхні HTTPS-адреси й зареєструвати міні-застосунок у BotFather. Потім увімкни запуск для потрібного профілю або групи: «налаштуй міні-ігри у профілі [назва]». /flappy та /duel відкривають підключені ігри. Перемикач у чаті сам не встановлює ігровий сервіс."] },
  moderation: { kind: "connection", summary: ["Lets authorized moderators remove group members.", "Помогаю уполномоченным модераторам удалять участников.", "Допомагаю уповноваженим модераторам видаляти учасників."],
    steps: ["Give the bot the required Telegram administrator rights and ask your installation agent to configure authorized operators. /kick remains subject to those permissions. Moderator access is configured outside this chat editor.", "Выдай боту нужные права администратора в Telegram и попроси агента установки задать уполномоченных пользователей. /kick работает только с этими разрешениями. Список модераторов задаётся вне этого мастера.", "Надай боту потрібні права адміністратора в Telegram і попроси агента встановлення задати уповноважених користувачів. /kick працює лише з цими дозволами. Список модераторів задається поза цим майстром."] },
  status: { kind: "default", summary: ["Checks whether the bot is online.", "Показываю, на связи ли бот.", "Показую, чи бот на зв’язку."],
    steps: ["Use /ping. Detailed /status is available only to authorized users; no feature setup is required.", "Напиши /ping. Подробный /status доступен только уполномоченным пользователям. Отдельная настройка функции не нужна.", "Напиши /ping. Докладний /status доступний лише уповноваженим користувачам. Окреме налаштування функції не потрібне."] },
};

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
export const featureDetail = (id, locale) => [
  featureName(id, locale),
  say(locale, ...help[id].summary),
  say(locale, ...help[id].steps),
].join("\n\n");
export const editableGroupFeature = id => featureScope[id] === "group";

function setupLabel(id, locale, mode) {
  if (mode === "unavailable") return say(locale, "needs connection", "нужно подключить", "потрібно підключити");
  if (mode === "off") return say(locale, "off", "выключено", "вимкнено");
  const kind = help[id].kind === "connection" && id === "minigames" && mode ? "setup" : help[id].kind;
  return say(locale, ...({
    default: ["default", "по умолчанию", "за замовчуванням"],
    optional: ["default; customizable", "по умолчанию; есть настройки", "за замовчуванням; є налаштування"],
    setup: ["set up first", "нужно настроить", "потрібно налаштувати"],
    connection: ["needs connection", "нужно подключить", "потрібно підключити"],
  }[kind]));
}

export function catalogue(locale, getMode = () => undefined) {
  const lines = sections.map(([title, ids]) => [
    say(locale, ...title),
    ...ids.map(id => `${featureName(id, locale)} — ${setupLabel(id, locale, getMode(id))}\n${say(locale, ...help[id].summary)}`),
  ].join("\n\n"));
  return [
    say(locale, "> available features", "> возможности", "> можливості"),
    say(locale, "Defaults apply after basic setup and profile assignment. AI answers, research, judging and media analysis require a connected AI. Group tools may also need Telegram permissions.",
      "Здесь указаны стандартные настройки после создания и назначения профиля. Для ответов, поиска, судьи и анализа нужен подключённый AI. Групповым функциям также могут потребоваться права Telegram.",
      "Тут указані стандартні налаштування після створення й призначення профілю. Для відповідей, пошуку, судді й аналізу потрібен підключений AI. Груповим функціям також можуть знадобитися права Telegram."),
    ...lines,
    say(locale, 'Ask about a feature for settings and an example, or say “configure game calls”. You can talk about another topic and later say “continue setup”.',
      'Спроси о функции — объясню настройки и покажу пример. Для начала настройки: «настрой сборы». Можно поговорить о другом, а затем сказать «продолжим настройку».',
      'Запитай про функцію — поясню налаштування й покажу приклад. Для початку налаштування: «налаштуй збори». Можна поговорити про інше, а потім сказати «продовжимо налаштування».'),
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
