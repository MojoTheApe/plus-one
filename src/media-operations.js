import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { assertVerifiedMediaSource, mediaPublicationKey, mediaReference } from "./media-source.js";
import { conversationThreadId } from "./conversation-store.js";
import { say } from "./helpers.js";

const durationText = n => { const seconds = Math.ceil(n); return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`; };
function limitedInstagramFallback(causes) {
  if (causes?.length === 2 && causes[0].provider === "instaloader" && causes[0].code === "AUTH_REQUIRED" &&
      causes[1].provider === "yt-dlp" && causes[1].code === "RATE_LIMIT" && causes[1].retryable && !causes[1].fallbackDisabled) return causes[1];
}

export function mediaFailure(error, { maxDurationSeconds = 300, maxUploadBytes = 48 * 1024 * 1024, stage = "download" } = {}) {
  if (error?.code === "MEDIA_SOURCE_QUOTA") return { code: error.budgetReason === "SUCCESS_QUOTA" ? "GROUP_RATE_LIMIT" : error.budgetReason,
    retryable: true, stage: "download", status: null, retryAfterSeconds: error.retryAfterSeconds,
    reason: `Для нового завантаження з джерела потрібна пауза приблизно ${error.retryAfterSeconds} с. Готові файли можна надсилати повторно.` };
  if (["MEDIA_SOURCE_UNVERIFIED", "MEDIA_SOURCE_MISMATCH"].includes(error?.code)) return {
    code: error.code === "MEDIA_SOURCE_MISMATCH" ? "SOURCE_MISMATCH" : "SOURCE_UNVERIFIED", retryable: false, stage: "download", status: null,
    ...(error.fallbackDisabled === true ? { fallbackDisabled: true } : {}),
    reason: error.code === "MEDIA_SOURCE_MISMATCH"
      ? "Отриманий матеріал не збігається з конкретною публікацією за посиланням. Не надсилаю підміну."
      : "Завантажувач не підтвердив, що файли належать саме цій публікації. Не надсилаю неперевірений набір; можна надіслати сам потрібний файл.",
  };
  if (error?.deliveryUnknown) return { code: "UPLOAD_UNKNOWN", retryable: true, stage: "upload", status: error.status || null,
    transportCode: error.transportCode || error.cause?.code || null,
    reason: "Не отримав підтвердження від Telegram. Файл міг уже з’явитися в чаті, тому автоматично його не дублюю. Перевір чат; якщо файлу немає, попроси повторити надсилання." };
  if (error?.code === "MEDIA_RETRY_CACHE_MISSING") return { code: "RETRY_CACHE_MISSING", retryable: false, stage: "prepare", status: null,
    reason: "Частину файлів уже надіслано, але підготовлена копія решти більше недоступна. Не повторюю весь набір, щоб не дублювати вже надіслане. Потрібні відсутні файли окремо." };
  if (error?.code === "MEDIA_CACHE_CAPACITY") return { code: "CACHE_BUSY", retryable: true, stage: "prepare", status: null,
    reason: "Місце для підготовлених файлів зайняте незавершеними надсиланнями. Цю публікацію ще не надіслано; повтори пізніше." };
  if (error?.code === "THREADS_RENDER_UNAVAILABLE") return { code: "SOURCE_CONTENT_UNAVAILABLE", retryable: true, stage: "download", status: null,
    reason: "Threads повернув сторінку без самого вмісту публікації, тому отримати файл цим способом зараз не вдалося. Це не помилка формату відео. Можна надіслати сам файл або іншу доступну копію." };
  if(error?.code === 'SOCIAL_DOWNLOAD_TIMEOUT') return {
    code:'TIMEOUT',retryable:true,stage,status:null,reason:'Вичерпано час цієї спроби; роботу зупинено. Можна повторити пізніше.',
    ...(Number.isFinite(error.elapsedSeconds)?{elapsedSeconds:error.elapsedSeconds}:{}),
    ...(error.attempts?.length?{causes:error.attempts.map(attempt=>({provider:attempt.provider,...mediaFailure(attempt.error,{maxDurationSeconds,maxUploadBytes,stage})}))}:{}),
  };
  if (Array.isArray(error?.attempts) && error.attempts.length) {
    const causes = error.attempts.slice(0, 6).map(attempt => ({ provider: String(attempt.provider || "downloader").slice(0, 32),
      ...mediaFailure(attempt.error, { maxDurationSeconds, maxUploadBytes, stage }) }));
    // Prefer the first useful cause, rather than the last, often empty, fallback.
    const available = causes.filter(cause => !cause.fallbackDisabled);
    const selected = limitedInstagramFallback(available) || available.find(cause => ["SOURCE_MISMATCH", "SOURCE_UNVERIFIED"].includes(cause.code)) ||
      available.find(cause => !["UNKNOWN", "NO_MEDIA"].includes(cause.code)) || available[0] || causes[0];
    const { provider, ...failure } = selected;
    return { ...failure, causes, ...(Number.isFinite(error.retryAfterSeconds) ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
      ...(Number.isFinite(error.elapsedSeconds) ? { elapsedSeconds: error.elapsedSeconds } : {}) };
  }
  // execFile's message includes the entire command. Options such as
  // --socket-timeout are not evidence that a timeout actually happened.
  const message = String(error?.stderr || error?.message || "").replace(/^Command failed:[^\n]*\n?/u, "");
  const status = error?.status || error?.statusCode;
  // yt-dlp also mentions rate limits when a webpage redirects to login.
  // Only an actual HTTP status is evidence for unattended source retries.
  const rateLimited = status === 429 || /\bHTTP(?:\/\d(?:\.\d)?)?\s+(?:Error\s+)?429\b|\b429\s+Too Many Requests\b/iu.test(
    message.replace(/https?:\/\/\S+/gu, ""));
  let code = "UNKNOWN", retryable = false, reason;
  if (error?.code === "SOCIAL_VIDEO_DURATION_LIMIT" || /longer than/i.test(message)) {
    code = "DURATION_LIMIT";
    reason = Number.isFinite(error.actualDurationSeconds)
      ? `Відео триває ${durationText(error.actualDurationSeconds)}, а дозволений максимум — ${durationText(maxDurationSeconds)}.`
      : `Відео довше за дозволений максимум ${durationText(maxDurationSeconds)}.`;
    reason += " За поточним правилом я його не надсилаю.";
  } else if (error?.code === "MEDIA_DURATION_UNKNOWN") {
    code = "METADATA"; reason = `Не вдалося визначити тривалість відео, тому я не можу перевірити ліміт ${durationText(maxDurationSeconds)}.`;
  } else if (error?.code === "MEDIA_UPLOAD_SIZE" || status === 413 || /Request Entity Too Large|Payload Too Large|max-filesize|exceeds|larger than|file is too big/i.test(message)) {
    code = "SIZE_LIMIT";
    const size = Number.isFinite(error.actualBytes) ? `Файл має розмір ${(error.actualBytes / 1024 / 1024).toFixed(1)} МіБ. ` : "";
    reason = size + (stage === "upload" || error.code === "MEDIA_UPLOAD_SIZE"
      ? `Файл перевищує допустимий розмір надсилання (робочий ліміт ${(maxUploadBytes / 1024 / 1024).toFixed(0)} МіБ). Потрібна менша версія.`
      : "Файл перевищує ліміт завантаження або сервіс відхилив завеликий запит. Потрібна менша версія.");
  } else if (["RATE_LIMIT", "SOCIAL_VIDEO_PROVIDER_COOLDOWN"].includes(error?.code) || rateLimited || /cooling down|^too many requests$/i.test(message.trim())) {
    code = "RATE_LIMIT"; retryable = true;
    reason = "Сервіс тимчасово обмежив кількість запитів. Спробуй ще раз пізніше.";
    if (Number.isFinite(error.retryAfterSeconds) && error.retryAfterSeconds > 0) reason += ` Наступна спроба — приблизно через ${Math.ceil(error.retryAfterSeconds)} с.`;
  } else if (error?.code === "SERVICE_ERROR" || (status >= 500 && status <= 599)) {
    code = "SERVICE_ERROR"; retryable = true;
    reason = "Сервіс завантаження або Telegram повернув тимчасову мережеву помилку. Можна повторити спробу.";
  } else if (error?.killed || error?.name === "AbortError" || error?.code === "SOCIAL_DOWNLOAD_TIMEOUT" || /AbortError|aborted|timeout|timed out/i.test(message)) {
    code = "TIMEOUT"; retryable = true;
    reason = "Сервіс не відповів за відведений час, тому спробу зупинено. Можна повторити завантаження.";
    if (Number.isFinite(error.elapsedSeconds)) reason += ` Спроба тривала ${Math.round(error.elapsedSeconds)} с.`;
  } else if (/not available, rate-limit reached or login required/iu.test(message)) {
    code = "UNAVAILABLE"; reason = "Instagram не повернув публікацію. Завантажувач не визначив точну причину.";
  } else if (error?.code === "AUTH_REQUIRED" || status === 401 || /private|log[ -]?in|sign[ -]?in|authentication|login.required|cookies? (?:are )?required|use --cookies/i.test(message)) {
    code = "AUTH_REQUIRED"; reason = "Цей спосіб завантаження повідомив, що потрібен вхід в акаунт або доступ до приватного медіа. Можна надіслати сам файл.";
  } else if (/unsupported URL|no suitable extractor|unsupported site/i.test(message)) {
    code = "UNSUPPORTED"; reason = "Завантажувач не підтримує цей формат посилання. Повтор тієї самої спроби не допоможе; можна надіслати пряме посилання на допис або сам файл.";
  } else if (error?.code === "UNAVAILABLE" || status === 403 || status === 404 || /deleted|not available|unavailable|not accessible|audience|geo.?restrict|\b404\b/i.test(message)) {
    code = "UNAVAILABLE"; reason = "Сервіс не повернув доступне медіа: допис міг бути видалений, обмежений або недоступний через цей спосіб завантаження.";
  } else if (error?.code === "NO_MEDIA" || /no (?:downloadable |playable )?(?:media|images|video)|empty media response|media response was empty|returned no media/i.test(message)) {
    code = "NO_MEDIA"; retryable = true; reason = "Спосіб завантаження не повернув медіафайлів. Саме по собі це не пояснює, чому допис недоступний.";
  } else if (error?.code === "MEDIA_ADAPTER_MISSING" || /ENOENT|ffprobe|media validator/i.test(message)) {
    code = "SERVER_TOOL"; reason = "На сервері не вдалося запустити інструмент завантаження або перевірки медіа. Потрібна перевірка конфігурації.";
  } else if (error?.code === "MEDIA_IMAGE_INVALID" || /stream|returned HTML|media type|convert|encode/i.test(message)) {
    code = "FORMAT"; reason = "Сервіс повернув непідтримуваний або пошкоджений медіафайл; підготувати його для Telegram не вдалося.";
  } else if (status >= 500 || /ECONNRESET|fetch failed|network/i.test(message)) {
    code = "SERVICE_ERROR"; retryable = true; reason = "Сервіс завантаження або Telegram повернув тимчасову мережеву помилку. Можна повторити спробу.";
  } else {
    retryable = true;
    reason = "Точну причину поки не визначено. Діагностику збережено для перевірки; спробуй інше публічне посилання або надішли файл.";
  }
  return { code, retryable, reason, stage, status: status || null,
    ...(code === "RATE_LIMIT" && (rateLimited || error.confirmedRateLimit === true) ? { confirmedRateLimit: true } : {}),
    ...(Number.isFinite(error?.retryAfterSeconds) ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
    ...(code === "DURATION_LIMIT" ? { maxDurationSeconds } : {}),
    ...(Number.isFinite(error.actualDurationSeconds) ? { actualDurationSeconds: error.actualDurationSeconds } : {}),
    ...(Number.isFinite(error.actualBytes) ? { actualBytes: error.actualBytes } : {}) };
}

// Detailed stages, causes and case IDs stay in the operation journal.
export function failureMessage(failure, locale = "uk") {
  const text = (...messages) => say(locale, ...messages);
  const wait = Math.ceil(failure.retryAfterSeconds || 0);
  switch (failure.code) {
    case "SOURCE_RETRY_EXHAUSTED":
      return text("Instagram kept limiting requests. I couldn’t retrieve this post.", "Instagram продолжает ограничивать запросы. Не удалось получить эту публикацию.", "Instagram продовжує обмежувати запити. Не вдалося отримати цю публікацію.");
    case "GROUP_RATE_LIMIT": case "URL_BACKOFF": case "RATE_LIMIT": case "IN_PROGRESS": case "CAPACITY": case "FAILURE_COOLDOWN":
      return wait > 0
        ? text(`Try again in ${wait} s.`, `Повтори через ${wait} с.`, `Повтори через ${wait} с.`)
        : text("Too many requests. Try again later.", "Много запросов. Повтори позже.", "Забагато запитів. Повтори пізніше.");
    case "UPLOAD_UNKNOWN":
      return text("Telegram hasn’t confirmed delivery. If the file is missing, reply “retry”.", "Telegram не подтвердил отправку. Если файла нет, ответь «повтори».", "Telegram не підтвердив надсилання. Якщо файлу немає, відповідай «повтори».");
    case "AUTH_REQUIRED":
      return text("This post requires sign-in. Attach the file.", "Для этой публикации нужен вход. Пришли файл.", "Для цієї публікації потрібен вхід. Надішли файл.");
    case "SOURCE_MISMATCH":
      return text("The file is from another post. Attach the original.", "Это файл из другой публикации. Пришли оригинал.", "Це файл з іншої публікації. Надішли оригінал.");
    case "SOURCE_UNVERIFIED":
      return text("Couldn’t verify the file’s source. Attach the original.", "Не удалось проверить источник файла. Пришли оригинал.", "Не вдалося перевірити джерело файлу. Надішли оригінал.");
    case "DURATION_LIMIT":
      if (Number.isFinite(failure.maxDurationSeconds) && Number.isFinite(failure.actualDurationSeconds)) {
        const duration = durationText(failure.actualDurationSeconds), limit = durationText(failure.maxDurationSeconds);
        return text(`Video is ${duration}. Send up to ${limit}.`, `Видео длится ${duration}. Пришли до ${limit}.`, `Відео триває ${duration}. Надішли до ${limit}.`);
      }
      return text("Video too long. Send a shorter clip.", "Видео слишком длинное. Пришли короче.", "Відео задовге. Надішли коротше.");
    case "SIZE_LIMIT":
      return text("File too large. Send a smaller one.", "Файл слишком большой. Пришли поменьше.", "Файл завеликий. Надішли менший.");
    case "TIMEOUT":
      return text("Timed out. Try again later.", "Время ожидания истекло. Повтори позже.", "Час очікування минув. Повтори пізніше.");
    case "CACHE_BUSY": case "SERVICE_ERROR": case "INTERRUPTED":
      return text("Temporary error. Try again later.", "Временный сбой. Повтори позже.", "Тимчасовий збій. Повтори пізніше.");
    case "RETRY_CACHE_MISSING":
      return text("The remaining files expired. Attach them separately.", "Копия оставшихся файлов истекла. Пришли их отдельно.", "Копія решти файлів застаріла. Надішли їх окремо.");
    case "FORMAT": case "METADATA":
      return text("Couldn’t prepare this file. Attach the original.", "Не удалось подготовить файл. Пришли оригинал.", "Не вдалося підготувати файл. Надішли оригінал.");
    case "NO_MEDIA": case "UNAVAILABLE": case "UNSUPPORTED": case "SOURCE_CONTENT_UNAVAILABLE":
      return text("Couldn’t get the file from this link. Attach it here.", "Не удалось получить файл по ссылке. Пришли его сюда.", "Не вдалося отримати файл за посиланням. Надішли його сюди.");
    default:
      return text("Couldn’t send the file. Try again later.", "Не удалось отправить файл. Повтори позже.", "Не вдалося надіслати файл. Повтори пізніше.");
  }
}

export function canRetryMediaOperation(operation) {
  if (operation.failure?.retryable) return true;
  if (operation.status === "failed" && operation.failure?.code === "AUTH_REQUIRED" &&
      operation.failure.stage === "download" && limitedInstagramFallback(operation.failure.causes)) return true;
  // TG-64 stored the disabled adapter's rejection over the native transient
  // failure. Permit a fresh verified retrieval, never reuse its unverified files.
  const causes = operation.failure?.causes;
  return Boolean(operation.status === "failed" && operation.failure?.code === "SOURCE_UNVERIFIED" &&
    operation.downloader === "snapinsta" && operation.source?.status === "unverified" &&
    !operation.sentMessageIds?.length && !operation.deliveredFileCount && causes?.length === 2 &&
    causes[0].provider === "yt-dlp" && causes[0].retryable === true &&
    ["RATE_LIMIT", "TIMEOUT", "SERVICE_ERROR", "NO_MEDIA"].includes(causes[0].code) &&
    causes[1].provider === "instagram" && causes[1].code === "SOURCE_UNVERIFIED");
}

export function instagramRetryWait(operation, now = Date.now()) {
  const failure = operation?.failure;
  const limited = limitedInstagramFallback(failure?.causes);
  if (operation?.status !== "failed" || !["AUTH_REQUIRED", "RATE_LIMIT"].includes(failure?.code) ||
      !limited) return 0;
  const seconds = failure.retryAfterSeconds || limited.retryAfterSeconds || 60;
  return Math.max(0, Math.ceil((operation.updatedAt + seconds * 1000 - now) / 1000));
}

export function isMediaRetryText(text, username = "") {
  const value = String(text || "").replace(new RegExp("@" + username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "gi"), "").trim();
  // A cheap path for canonical commands only; semantic routing owns other wording.
  return /^(?:(?:будь ласка|please)[,\s]+)?(?:repeat|retry|try again|повтори|повторити|спробуй(?:\s+ще)?\s+раз)(?:[,\s]+(?:будь ласка|please))?[.!?\s]*$/iu.test(value);
}

export class MediaOperations {
  constructor(file, now = Date.now) { this.file = file; this.now = now; this.queue = Promise.resolve(); }
  async readState() {
    try {
      const data = JSON.parse(await fs.readFile(this.file, "utf8"));
      if (data.version !== 1 || !Array.isArray(data.operations)) throw new Error("Invalid media operations state");
      data.operations = data.operations.filter(op => this.now() - op.updatedAt < 48 * 3600 * 1000);
      data.providers ||= {};
      return data;
    } catch (error) { if (error.code !== "ENOENT") throw error; return { version: 1, operations: [], providers: {} }; }
  }
  async read() { return (await this.readState()).operations; }
  async change(update) {
    const work = this.queue.then(async () => {
      const state = await this.readState(), result = update(state);
      if (result === false) return false;
      await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const temp = `${this.file}.${randomUUID()}.tmp`;
      try { await fs.writeFile(temp, JSON.stringify(state), { mode: 0o600 }); await fs.rename(temp, this.file); }
      finally { await fs.rm(temp, { force: true }); }
      return result;
    });
    this.queue = work.catch(() => {});
    return work;
  }
  async sourceState(provider) {
    const entry = (await this.readState()).providers[provider];
    return { notBefore: Number(entry?.notBefore) || 0, failures: Math.min(10, Number(entry?.failures) || 0),
      confirmedRateLimit: entry?.confirmedRateLimit === true };
  }
  async sourceResult(provider, failure = null) {
    if (!["instagram", "tiktok", "threads"].includes(provider)) return;
    return this.change(state => {
      const previous = state.providers[provider] || {}, failures = Math.min(10, (previous.failures || 0) + 1);
      // A concurrent request that started before a 429 must not shorten the
      // provider's wait when its own response arrives later.
      const liveLimit = previous.confirmedRateLimit && previous.notBefore > this.now();
      if (liveLimit && !failure?.confirmedRateLimit) return Math.ceil((previous.notBefore - this.now()) / 1000);
      if (!failure) state.providers[provider] = { notBefore: 0, failures: 0 };
      else if (["RATE_LIMIT", "TIMEOUT", "SERVICE_ERROR"].includes(failure.code)) {
        const seconds = Math.max(Number(failure.retryAfterSeconds) || 0,
          liveLimit ? Math.ceil((previous.notBefore - this.now()) / 1000) : 0,
          Math.min(900, (failure.code === "RATE_LIMIT" ? 60 : 5) * 2 ** (failures - 1)));
        state.providers[provider] = { failures, notBefore: this.now() + seconds * 1000,
          confirmedRateLimit: failure.confirmedRateLimit === true };
        return seconds;
      }
    });
  }
  async coalescedPublication(chatId, topicId, url, updateId) {
    const key = mediaPublicationKey(url);
    return (await this.read()).find(op => op.sourceRetry && op.chatId === chatId &&
      (op.topicId ?? op.threadId ?? null) === topicId && mediaPublicationKey(op.url) === key &&
      (["waiting_source", "running", "prepared", "uploading"].includes(op.status) ||
        (updateId >= op.sourceRetry.updateId && updateId <= op.sourceRetry.throughUpdateId)));
  }
  async record(operation, { beginUpload = false } = {}) {
    return this.change(state => {
      const all = state.operations;
      const previous = all.find(op => op.id === operation.id);
      const entry = { ...previous, ...operation, id: operation.id || randomUUID().slice(0, 8), updatedAt: this.now() };
      if (entry.status === "running" && ["unknown", "uploading"].includes(previous?.status)) {
        entry.priorUploadFailure = previous.failure || mediaFailure({ deliveryUnknown: true }, { stage: "upload" });
      }
      if (beginUpload && previous?.observedMessageId) {
        entry.status = "unknown";
        entry.failure = entry.priorUploadFailure || mediaFailure({ deliveryUnknown: true }, { stage: "upload" });
      }
      if (entry.status === "done" || entry.status === "unknown") delete entry.priorUploadFailure;
      entry.topicId = operation.topicId !== undefined ? operation.topicId : entry.topicId ?? entry.threadId ?? null;
      entry.threadId = entry.topicId;
      entry.referenceMessageIds = [...new Set([...operationReferences(previous), ...operationReferences(entry)])].slice(-50);
      const recent = [entry, ...all.filter(op => op.id !== entry.id)];
      state.operations = recent.filter((op, index) => index < 300 || (op.sourceRetry &&
        ["waiting_source", "running", "prepared", "uploading"].includes(op.status)));
      const day = new Date(this.now()).toISOString().slice(0, 10);
      state.metrics ||= {};
      for (const key of Object.keys(state.metrics)) if (key < new Date(this.now() - 30 * 86400000).toISOString().slice(0, 10)) delete state.metrics[key];
      if (previous?.status !== entry.status && ["done", "failed", "unknown"].includes(entry.status)) {
        const counter = state.metrics[day] ||= {}, outcome = entry.status === "failed" ? entry.failure?.code || "UNKNOWN_ERROR" : entry.status;
        counter[outcome] = (counter[outcome] || 0) + 1;
      }
      return entry;
    });
  }
  async linkRetryNotice(id, requestId, noticeId) {
    return this.change(state => {
      const op = state.operations.find(item => item.id === id);
      if (op) op.referenceMessageIds = [...new Set([...operationReferences(op), requestId, noticeId]
        .filter(Number.isSafeInteger))].slice(-50);
    });
  }
  async observeVideoReply(message, botId) {
    const video = message.reply_to_message;
    const topicId = conversationThreadId(message);
    if (!video?.video?.file_id || !Number.isSafeInteger(botId) || video.from?.id !== botId || !video.from.is_bot ||
        !["supergroup", "group"].includes(message.chat.type) || video.chat?.id !== message.chat.id ||
        conversationThreadId(video) !== topicId ||
        video.forward_origin || video.forward_date || video.forward_from || video.forward_from_chat || video.via_bot ||
        video.sender_chat || video.media_group_id || !Number.isSafeInteger(video.message_id) ||
        video.message_id <= 0 || video.message_id >= message.message_id) return;
    const permalink = mediaReference(video.caption?.trim().split("\n").at(-1));
    if (!permalink?.id) return;
    await this.change(state => {
      const found = state.operations.filter(op => {
        if (op.chatId !== message.chat.id || (op.topicId ?? op.threadId ?? null) !== topicId ||
            !Number.isSafeInteger(op.sourceMessageId) || op.sourceMessageId >= video.message_id || !op.source) return false;
        try {
          const checked = assertVerifiedMediaSource(op.source, op.url);
          return checked.resolved.url === permalink.url && op.source.resolved.url === checked.resolved.url;
        } catch { return false; }
      });
      if (found.length !== 1) return false;
      const op = found[0];
      if (video.edit_date && video.message_id !== op.videoReplyId) return false;
      if (!(op.priorUploadFailure || ["unknown", "uploading"].includes(op.status)) || op.observedMessageId || op.deliveredFileCount ||
          op.sentMessageIds?.length || op.mediaItems?.length !== 1 || op.mediaItems[0]?.mediaKind !== "video") return false;
      // The bot-authored video is visible. It is not a receipt for a specific upload
      // and does not authorize binding a Telegram file_id to the prepared bytes.
      op.observedMessageId = video.message_id;
    });
  }
  async find(message, allowLatest = false, scope = {}) {
    const chatId = scope.chatId ?? message.chat.id;
    const topicId = scope.topicId !== undefined ? scope.topicId : message.is_topic_message === true ? message.message_thread_id ?? null : null;
    const all = (await this.read()).filter(op => String(op.chatId) === String(chatId) && (op.topicId ?? op.threadId ?? null) === topicId);
    const targets = [...(scope.referenceMessageIds || [])];
    let reply = message.reply_to_message;
    for (let depth = 0; reply && depth < 8; depth++, reply = reply.reply_to_message) targets.push(reply.message_id);
    // Exact references are allowed across participants, but never across chats/topics.
    for (const target of targets) {
      const operation = all.find(op => operationReferences(op).includes(target));
      if (operation) return operation;
    }
    if (targets.length) return null;
    return allowLatest ? all.find(op => op.userId === message.from?.id && op.status !== "done") || null : null;
  }
  async evidence(message, { referenceMessageIds = [], topicId = null } = {}) {
    const references = new Set(referenceMessageIds.filter(Number.isSafeInteger));
    return (await this.read()).filter(operation => String(operation.chatId) === String(message.chat.id) &&
      (operation.topicId ?? operation.threadId ?? null) === topicId && operationReferences(operation).every(id => id < message.message_id) &&
      operationReferences(operation).some(id => references.has(id)))
      .slice(0, 4).map(operation => ({ id: operation.id, sourceMessageId: operation.sourceMessageId,
        trigger: operation.trigger || null, lastRequest: operation.lastRequest || null, requestedUrl: mediaReference(operation.url)?.url || null,
        sourceVerification: operation.source?.status || "unverified-legacy", verifiedSource: operation.source?.status === "verified" ? operation.source.resolved : null,
        downloader: operation.downloader || operation.source?.provider || "not-recorded", deliveryRoute: operation.deliveryRoute || "not-recorded", attempts: operation.attempts || [],
        status: operation.status, observedMessageId: operation.observedMessageId, sentMessageIds: operation.sentMessageIds || [], deliveredFileCount: operation.deliveredFileCount || 0,
        failure: operation.failure ? { code: operation.failure.code, stage: operation.failure.stage, reason: operation.failure.reason, causes: operation.failure.causes || [] } : null }));
  }
}

function operationReferences(operation) {
  if (!operation) return [];
  return [operation.sourceMessageId, operation.lastRequest?.messageId, operation.trigger?.messageId, operation.errorMessageId, operation.videoReplyId, operation.sentMessageId, operation.observedMessageId,
    ...(operation.sentMessageIds || []), ...(operation.referenceMessageIds || [])].filter(Number.isSafeInteger);
}
