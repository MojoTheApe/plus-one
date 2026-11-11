import { say } from './helpers.js';
export { say } from './helpers.js';

const features = [
  ['chat', /conversation|chatting|talk|общени|разговор|спілкуван/i, ['Questions and conversation','Ответы и общение','Відповіді та спілкування']],
  ['profile', /profil|persona|personality|характер|личност|особист|профил|профіл/i, ['Bot personality','Личность бота','Особистість бота']],
  ['search', /search|research|web|поиск|интернет|пошук|інтернет/i, ['Web search','Поиск в интернете','Пошук в інтернеті']],
  ['judge', /judge|dispute|debat|разбор спор|розбір супереч|спор|супереч|вердикт/i, ['Debates','Разбор споров','Розбір суперечок']],
  ['history', /history|истори|переписк|історі|листуван/i, ['Chat history','История чата','Історія чату']],
  ['memory', /memory|пам[я’ʼ]|запомин|запам/i, ['Memory','Память','Пам’ять']],
  ['voice', /voice|audio|голос|аудио|аудіо/i, ['Voice messages','Голосовые','Голосові']],
  ['download', /download|скач|загруз|завантаж/i, ['Media downloads','Скачивание по ссылкам','Завантаження за посиланнями']],
  ['analysis', /analy[sz]|photo|video|анализ|аналіз|фото|видео|відео/i, ['Photo and video analysis','Анализ фото и видео','Аналіз фото й відео']],
  ['assemble', /assembl|gather|game calls|players|сбор|соб(ери|рать)|игрок|гравц|зб[іо]р|зібр/i, ['Game calls','Сборы игроков','Збори гравців']],
  ['minigames', /mini.?games?|mini apps|мини.?игр|міні.?ігор|міні.?ігр|flappy|occupiers|duel/i, ['Telegram Mini Apps','Мини-игры в Telegram','Мініігри в Telegram']],
  ['reaction', /react|phrase|реакц|фраз/i, ['Phrase reactions','Реакции на фразы','Реакції на фрази']],
  ['sticker', /sticker|ст[иі]кер/i, ['Sticker pack','Стикерпак','Стікерпак']],
  ['moderation', /moderat|kick|модерац|видал.*учас|удал.*участ/i, ['Moderation','Модерация','Модерація']],
  ['status', /status|health|статус|стан бота|диагност|діагност/i, ['Status','Статус бота','Стан бота']],
];
export const setupSections = [
  ['conversation', ['Conversation and memory','Общение и память','Спілкування й пам’ять'], ['chat','search','judge','history','memory']],
  ['media', ['Voice and media','Голос и медиа','Голос і медіа'], ['voice','analysis','download']],
  ['games', ['Games','Игры','Ігри'], ['assemble','minigames']],
  ['reactions', ['Reactions and stickers','Реакции и стикеры','Реакції та стікери'], ['reaction','sticker']],
  ['management', ['Management','Управление','Керування'], ['moderation','status']],
];
export const modeFeatures = ['chat','search','judge','history','memory','voice','analysis','download','minigames'];
export const editableGroupFeature = id => modeFeatures.includes(id) || ['assemble','reaction','sticker','moderation'].includes(id);

const help = {
  chat: [
    ['Answers questions when addressed.','Отвечаю на вопросы при обращении.','Відповідаю на запитання при зверненні.'],
    ['Needs a working AI. Mention me by username/name or reply to my message. This switch controls ordinary conversation; separate commands keep their own permissions.', 'Нужен работающий AI. Обратись по имени, упомяни меня или ответь на моё сообщение. Переключатель управляет обычным общением; отдельные команды имеют свои настройки и права.', 'Потрібен робочий AI. Звернися на ім’я, згадай мене або відповідай на моє повідомлення. Перемикач керує звичайним спілкуванням; окремі команди мають власні налаштування й права.']],
  profile: [
    ['My name, character and language. Reuse a personality in several groups.','Моё имя, характер и язык. Одну личность можно использовать в нескольких группах.','Моє ім’я, характер і мова. Одну особистість можна використовувати в кількох групах.'],
    ['Create a new profile before or after joining groups. Features belong to each group. Switching personality preserves players, rules, settings and history. Editing a shared profile updates its linked personalities after confirmation.', 'Создай новый профиль до или после добавления в группы. Функции принадлежат каждой группе. Смена личности сохраняет игроков, правила, настройки и историю. Правка общего профиля обновляет связанные личности после подтверждения.', 'Створи новий профіль до чи після додавання до груп. Функції належать кожній групі. Зміна особистості зберігає гравців, правила, налаштування й історію. Редагування спільного профілю оновлює пов’язані особистості після підтвердження.']],
  search: [
    ['Checks current facts and finds sources.','Проверяю актуальные факты и ищу источники.','Перевіряю актуальні факти й шукаю джерела.'],
    ['Ask me to check something online. Sources must support the answer. The current Claude adapter has no web connection; a switch cannot create that connection.', 'Попроси проверить информацию в интернете. Ответ должен опираться на источники. У текущего адаптера Claude поиск не подключён; переключатель не заменяет подключение.', 'Попроси перевірити інформацію в інтернеті. Відповідь має спиратися на джерела. У поточного адаптера Claude пошук не підключений; перемикач не замінює підключення.']],
  judge: [
    ['Reviews a dispute using available messages.','Разбираю спор по доступной переписке.','Розбираю суперечку за доступним листуванням.'],
    ['Reply to the relevant message with /judge or ask me to review it. /judge all handles separate disputes. Needs working AI and available discussion; unavailable evidence is never guessed.', 'Ответь на нужную реплику командой /judge или попроси разобрать спор. /judge all разбирает отдельные споры. Нужны AI и доступная переписка; недоступные аргументы не выдумываются.', 'Відповідай на потрібну репліку командою /judge або попроси розібрати суперечку. /judge all розбирає окремі суперечки. Потрібні AI й доступне листування; недоступні аргументи не вигадуються.']],
  history: [
    ['Uses received messages and voice transcripts for context.','Учитываю полученные сообщения и расшифровки голосовых.','Враховую отримані повідомлення й розшифровки голосових.'],
    ['Received chat history is retained for seven days, isolated by group and topic. Ask for a summary or message number. Old Telegram history is not automatically imported. Disabling stops new history records; it does not delete retained data or the AI provider’s dialogue.', 'Полученная история хранится семь дней отдельно по группам и темам. Попроси сводку или сообщение по номеру. Старая история Telegram автоматически не загружается. Выключение прекращает новые записи, сохраняя прежние данные и диалог у AI-провайдера.', 'Отримана історія зберігається сім днів окремо за групами й темами. Попроси підсумок або повідомлення за номером. Стара історія Telegram автоматично не завантажується. Вимкнення припиняє нові записи, зберігаючи попередні дані й діалог у AI-провайдера.']],
  memory: [
    ['Saves useful long-term notes on request.','Сохраняю полезные сведения надолго по просьбе.','Зберігаю корисні відомості надовго за проханням.'],
    ['Default: explicit /remember, /memory and /forget. Optionally capture notes from addressed requests, or disable memory. This is different from chat history: transcribing a voice does not turn every statement into a permanent fact.', 'По умолчанию: явные /remember, /memory и /forget. Можно сохранять сведения из обращений или выключить память. Это отличается от истории: расшифровка голосового не превращает каждую реплику в постоянный факт.', 'За замовчуванням: явні /remember, /memory і /forget. Можна зберігати відомості зі звернень або вимкнути пам’ять. Це відрізняється від історії: розшифрування голосового не перетворює кожну репліку на постійний факт.']],
  voice: [
    ['Transcribes all received group voices for context; replies only when needed.','Расшифровываю все полученные голосовые для контекста; отвечаю при необходимости.','Розшифровую всі отримані голосові для контексту; відповідаю за потреби.'],
    ['All received eligible voices are transcribed into this group’s history. I answer an addressed request or a reply to me, and execute permitted commands/rules. Ordinary voices get no reply. Transcription needs its installed model; size, duration and processing limits or failures are reported honestly.', 'Все доступные голосовые расшифровываются в историю этой группы. Отвечаю на обращение или ответ мне, выполняю разрешённые команды и правила. Обычные голосовые остаются без ответа. Нужна установленная модель; ограничения размера, длительности, обработки и ошибки указываются честно.', 'Усі доступні голосові розшифровуються в історію цієї групи. Відповідаю на звернення чи відповідь мені, виконую дозволені команди й правила. Звичайні голосові залишаються без відповіді. Потрібна встановлена модель; обмеження розміру, тривалості, обробки й помилки вказуються чесно.']],
  analysis: [
    ['Analyzes photos and video on request.','Разбираю фото и видео по запросу.','Розбираю фото й відео за запитом.'],
    ['Send media and ask a question or reply to it. Video evidence uses selected frames and recognized speech, not a full audiovisual viewing. The current Claude adapter does not accept images. Telegram retrieval and processing limits may require a smaller file.', 'Пришли медиа с вопросом или ответь на него. Видео разбирается по выборочным кадрам и распознанной речи, а не как полный просмотр. Текущий адаптер Claude не принимает изображения. Из-за ограничений получения и обработки может потребоваться меньший файл.', 'Надішли медіа із запитанням або відповідай на нього. Відео розбирається за вибірковими кадрами й розпізнаним мовленням, а не як повний перегляд. Поточний адаптер Claude не приймає зображення. Через обмеження отримання й обробки може знадобитися менший файл.']],
  download: [
    ['Automatically sends media from supported public links.','Автоматически присылаю медиа по поддерживаемым публичным ссылкам.','Автоматично надсилаю медіа за підтримуваними публічними посиланнями.'],
    ['Enabled by default for newly assigned groups. Send a public Instagram, Threads or TikTok link. Needs administrator rights and a connected downloader. Private/login-restricted posts, provider blocks, file limits and quotas may prevent a download. Saved off settings stay off.', 'По умолчанию включено для новых настроенных групп. Пришли публичную ссылку Instagram, Threads или TikTok. Нужны права администратора и подключённое скачивание. Закрытые публикации, авторизация, блокировки сайтов, размеры и квоты могут помешать загрузке. Сохранённое выключение сохраняется.', 'За замовчуванням увімкнено для нових налаштованих груп. Надішли публічне посилання Instagram, Threads або TikTok. Потрібні права адміністратора й підключене завантаження. Закриті публікації, авторизація, блокування сайтів, розміри й квоти можуть завадити завантаженню. Збережене вимкнення зберігається.']],
  assemble: [
    ['Calls the configured players for a game.','Зову настроенных игроков на выбранную игру.','Кличу налаштованих гравців до вибраної гри.'],
    ['Choose a supported game, send Telegram @usernames, optionally add a GIF, then review and save. Players are specific to this group. Edit players or GIF separately. A call to everyone additionally needs a complete verified roster; preview never summons anyone.', 'Выбери поддерживаемую игру, пришли Telegram-имена игроков, при желании добавь GIF, проверь и сохрани. Состав относится только к этой группе. Игроков и GIF можно менять отдельно. Для общего сбора нужен полный проверенный состав; предпросмотр никого не вызывает.', 'Вибери підтримувану гру, надішли Telegram-імена гравців, за бажанням додай GIF, перевір і збережи. Склад належить лише цій групі. Гравців і GIF можна змінювати окремо. Для загального збору потрібен повний перевірений склад; попередній перегляд нікого не викликає.']],
  minigames: [
    ['Launches separately connected games. Initially off.','Запускаю отдельно подключённые игры. Изначально выключено.','Запускаю окремо підключені ігри. Спочатку вимкнено.'],
    ['Mini Apps require their own services, public HTTPS addresses, BotFather registration and game-specific public IDs/state. Open the installation guide for the selected game, verify it, then allow it for this group. Never put the bot token in a game client.', 'Мини-играм нужны отдельные сервисы, публичные HTTPS-адреса, регистрация в BotFather и параметры выбранной игры. Открой инструкцию, проверь подключение, затем разреши запуск для этой группы. Токен бота нельзя помещать в клиент игры.', 'Мінііграм потрібні окремі сервіси, публічні HTTPS-адреси, реєстрація в BotFather і параметри вибраної гри. Відкрий інструкцію, перевір підключення, потім дозволь запуск для цієї групи. Токен бота не можна розміщувати в клієнті гри.']],
  reaction: [
    ['Runs configured actions for exact phrases.','Выполняю настроенные действия по полным фразам.','Виконую налаштовані дії за повними фразами.'],
    ['Create a rule: whole phrase, action, required parameters, permitted actor and optional announcement. Review and save. Actions include judging, player calls, GIFs and owner-only personality changes. Quotes and forwarded messages do not trigger rules.', 'Создай правило: полная фраза, действие, параметры, разрешённый исполнитель и необязательное объявление. Проверь и сохрани. Доступны разбор спора, сбор игроков, GIF и смена личности владельцем. Цитаты и пересланные сообщения не запускают правила.', 'Створи правило: повна фраза, дія, параметри, дозволений виконавець і необов’язкове оголошення. Перевір і збережи. Доступні розбір суперечки, збір гравців, GIF і зміна особистості власником. Цитати й переслані повідомлення не запускають правила.']],
  sticker: [
    ['Manages a linked existing sticker pack.','Управляю привязанным существующим стикерпаком.','Керую прив’язаним наявним стікерпаком.'],
    ['Send the existing pack link. The pack must belong to this bot and be unique to this group. After connection group administrators can add/remove individual stickers; disabling retains the binding parameters.', 'Пришли ссылку на существующий пак этого бота. Он может быть привязан только к одной группе. После подключения администраторы группы могут добавлять и удалять отдельные стикеры. Выключение сохраняет параметры привязки.', 'Надішли посилання на наявний пак цього бота. Він може бути прив’язаний лише до однієї групи. Після підключення адміністратори групи можуть додавати й видаляти окремі стікери. Вимкнення зберігає параметри прив’язки.']],
  moderation: [
    ['Lets permitted administrators remove a member.','Позволяю разрешённым администраторам удалить участника.','Дозволяю уповноваженим адміністраторам видалити учасника.'],
    ['Configure numeric Telegram IDs of permitted operators for this group, then confirm. Operators must also be group administrators. The bot needs permission to restrict members. /kick works by reply or a known recent username. Group owners/admins are not removed.', 'Укажи цифровые Telegram ID разрешённых исполнителей для этой группы и подтверди. Они также должны быть администраторами группы. Боту нужно право ограничивать участников. /kick работает ответом или по известному недавнему имени. Владелец и администраторы не удаляются.', 'Укажи цифрові Telegram ID дозволених виконавців для цієї групи й підтвердь. Вони також мають бути адміністраторами групи. Боту потрібне право обмежувати учасників. /kick працює відповіддю або за відомим недавнім ім’ям. Власник і адміністратори не видаляються.']],
  status: [
    ['Checks availability and owner-only diagnostics.','Проверяю доступность и показываю владельцу диагностику.','Перевіряю доступність і показую власнику діагностику.'],
    ['Use /ping to check the bot and /status for owner-only dependency diagnostics. An enabled switch is not proof that a model, provider or public game service is healthy; inspect the reported result and next step.', 'Используй /ping для проверки ответа и /status для диагностики подключений владельцем. Включённый переключатель не доказывает исправность модели, сайта или игрового сервиса; смотри результат проверки и следующий шаг.', 'Використовуй /ping для перевірки відповіді й /status для діагностики підключень власником. Увімкнений перемикач не доводить справність моделі, сайту чи ігрового сервісу; дивися результат перевірки й наступний крок.']],
};

export function matchFeature(text) {
  let closest;
  for (const [id, pattern] of features) {
    const match = pattern.exec(text);
    if (match && (!closest || match.index < closest.start)) closest = { id, start: match.index, end: match.index + match[0].length };
  }
  return closest;
}
export const featureName = (id, locale) => say(locale, ...features.find(([key]) => id === key)[2]);
export const featureDetail = (id, locale) => [featureName(id, locale), ...help[id].map(words => say(locale, ...words))].join('\n\n');
export const modeLabel = (mode, locale) => say(locale, ...({
  on: ['on','включено','увімкнено'], off: ['off','выключено','вимкнено'],
  manual: ['on request','по просьбе','за проханням'], auto: ['from addressed requests','из обращений','зі звернень'],
  unavailable: ['needs connection','нужно подключить','потрібно підключити'], setup: ['set up first','нужно настроить','потрібно налаштувати'],
  error: ['last attempt failed','последняя попытка не удалась','остання спроба не вдалася'],
}[mode] ?? ['available','доступно','доступно']));
export function modeOptions(feature, locale) {
  return feature === 'memory' ? say(locale, 'Choose on request, capture from addressed requests, or off.', 'Выбери: по просьбе, из обращений или выключить.', 'Вибери: за проханням, зі звернень або вимкнути.') :
    say(locale, 'Choose on or off.', 'Выбери: включить или выключить.', 'Вибери: увімкнути або вимкнути.');
}
export function introduction(locale) {
  return say(locale,
    'Profiles define my name, character and language. Reuse one in several groups; each group has independent features, players, rules, history and memory. Switching personality keeps those settings. Ask about any feature. Add me to a group, choose its profile and make me an administrator to configure features.',
    'Профиль задаёт моё имя, характер и язык. Одну личность можно использовать в нескольких группах. У каждой группы свои функции, игроки, правила, история и память. Смена личности сохраняет эти настройки. Спроси о любой функции. Для настройки добавь меня в группу, выбери её профиль и назначь меня администратором.',
    'Профіль задає моє ім’я, характер і мову. Одну особистість можна використовувати в кількох групах. Кожна група має власні функції, гравців, правила, історію й пам’ять. Зміна особистості зберігає ці налаштування. Запитай про будь-яку функцію. Для налаштування додай мене до групи, вибери її профіль і признач мене адміністратором.');
}
export function catalogue(locale, getMode = () => undefined) {
  const lines = setupSections.map(([, title, ids]) => [say(locale, ...title), ...ids.map(id => {
    const mode = getMode(id) ?? (['assemble','reaction','sticker','moderation'].includes(id) ? 'setup' : id === 'minigames' ? 'off' : 'on');
    return featureName(id, locale) + ' — ' + modeLabel(mode, locale) + '\n' + say(locale, ...help[id][0]);
  })].join('\n\n'));
  return [say(locale, 'Available features', 'Возможности', 'Можливості'), introduction(locale), featureName('profile', locale) + ' — ' + modeLabel('on', locale) + '\n' + say(locale, ...help.profile[0]), ...lines].join('\n\n');
}
