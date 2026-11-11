import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const durationText = n => { const seconds = Math.ceil(n); return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`; };
export function mediaFailure(error, { maxDurationSeconds = 300, maxUploadBytes = 48 * 1024 * 1024, stage = "download" } = {}) {
  if(error?.code === 'SOCIAL_DOWNLOAD_TIMEOUT') return {
    code:'TIMEOUT',retryable:true,stage,status:null,reason:'Вичерпано час цієї спроби; роботу зупинено. Можна повторити пізніше.',
    ...(Number.isFinite(error.elapsedSeconds)?{elapsedSeconds:error.elapsedSeconds}:{}),
    ...(error.attempts?.length?{causes:error.attempts.map(attempt=>({provider:attempt.provider,...mediaFailure(attempt.error,{maxDurationSeconds,maxUploadBytes,stage})}))}:{}),
  };
  if (Array.isArray(error?.attempts) && error.attempts.length) {
    const causes = error.attempts.slice(0, 6).map(attempt => ({ provider: String(attempt.provider || "downloader").slice(0, 32),
      ...mediaFailure(attempt.error, { maxDurationSeconds, maxUploadBytes, stage }) }));
    // Prefer the first useful cause, rather than the last, often empty, fallback.
    const selected = causes.find(cause => !["UNKNOWN", "NO_MEDIA"].includes(cause.code)) || causes[0];
    const { provider, ...failure } = selected;
    return { ...failure, causes, ...(Number.isFinite(error.elapsedSeconds) ? { elapsedSeconds: error.elapsedSeconds } : {}) };
  }
  // execFile's message includes the entire command. Options such as
  // --socket-timeout are not evidence that a timeout actually happened.
  const message = String(error?.stderr || error?.message || "").replace(/^Command failed:[^\n]*\n?/u, "");
  const status = error?.status || error?.statusCode;
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
  } else if (error?.code === "SOCIAL_VIDEO_PROVIDER_COOLDOWN" || status === 429 || /cooling down|rate.?limit|too many requests|\b429\b/i.test(message)) {
    code = "RATE_LIMIT"; retryable = true;
    reason = "Сервіс тимчасово обмежив кількість запитів. Спробуй ще раз пізніше.";
  } else if (error?.killed || error?.name === "AbortError" || error?.code === "SOCIAL_DOWNLOAD_TIMEOUT" || /AbortError|aborted|timeout|timed out/i.test(message)) {
    code = "TIMEOUT"; retryable = true;
    reason = "Сервіс не відповів за відведений час, тому спробу зупинено. Можна повторити завантаження.";
    if (Number.isFinite(error.elapsedSeconds)) reason += ` Спроба тривала ${Math.round(error.elapsedSeconds)} с.`;
  } else if (status === 401 || /private|log[ -]?in|sign[ -]?in|authentication|login.required|cookies? (?:are )?required|use --cookies/i.test(message)) {
    code = "AUTH_REQUIRED"; reason = "Цей спосіб завантаження повідомив, що потрібен вхід в акаунт або доступ до приватного медіа. Можна надіслати сам файл.";
  } else if (/unsupported URL|no suitable extractor|unsupported site/i.test(message)) {
    code = "UNSUPPORTED"; reason = "Завантажувач не підтримує цей формат посилання. Повтор тієї самої спроби не допоможе; можна надіслати пряме посилання на допис або сам файл.";
  } else if (status === 403 || status === 404 || /deleted|not available|unavailable|not accessible|audience|geo.?restrict|\b404\b/i.test(message)) {
    code = "UNAVAILABLE"; reason = "Сервіс не повернув доступне медіа: допис міг бути видалений, обмежений або недоступний через цей спосіб завантаження.";
  } else if (/no (?:downloadable |playable )?(?:media|images|video)|empty media response|media response was empty|returned no media/i.test(message)) {
    code = "NO_MEDIA"; retryable = true; reason = "Спосіб завантаження не повернув медіафайлів. Саме по собі це не пояснює, чому допис недоступний.";
  } else if (/ENOENT|ffprobe|media validator/i.test(message)) {
    code = "SERVER_TOOL"; reason = "На сервері не вдалося запустити інструмент завантаження або перевірки медіа. Потрібна перевірка конфігурації.";
  } else if (/stream|returned HTML|media type|convert|encode/i.test(message)) {
    code = "FORMAT"; reason = "Сервіс повернув непідтримуваний або пошкоджений медіафайл; підготувати його для Telegram не вдалося.";
  } else if (status >= 500 || /ECONNRESET|fetch failed|network/i.test(message)) {
    code = "SERVICE_ERROR"; retryable = true; reason = "Сервіс завантаження або Telegram повернув тимчасову мережеву помилку. Можна повторити спробу.";
  } else {
    retryable = true;
    reason = "Точну причину поки не визначено. Діагностику збережено для перевірки; спробуй інше публічне посилання або надішли файл.";
  }
  return { code, retryable, reason, stage, status: status || null,
    ...(Number.isFinite(error?.retryAfterSeconds) ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
    ...(Number.isFinite(error.actualDurationSeconds) ? { actualDurationSeconds: error.actualDurationSeconds } : {}),
    ...(Number.isFinite(error.actualBytes) ? { actualBytes: error.actualBytes } : {}) };
}

export function failureMessage(failure, id) {
  const stages = { download: "отримання медіа", prepare: "перевірка й підготовка", upload: "надсилання до Telegram" };
  return `Не вдалося надіслати медіа: ${failure.reason}\nЕтап: ${stages[failure.stage] || failure.stage}. Код: ${failure.code}${id ? ` · ${id}` : ""}.`;
}

export function isMediaRetryText(text, username = "") {
  const value = String(text || "").replace(new RegExp("@" + username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "gi"), "").trim();
  // A cheap path for canonical commands only; semantic routing owns other wording.
  return /^(?:(?:будь ласка|please)[,\s]+)?(?:repeat|retry|try again|повтори|повторити|спробуй(?:\s+ще)?\s+раз)(?:[,\s]+(?:будь ласка|please))?[.!?\s]*$/iu.test(value);
}

export class MediaOperations {
  constructor(file, now = Date.now) { this.file = file; this.now = now; this.queue = Promise.resolve(); }
  async read() {
    try {
      const data = JSON.parse(await fs.readFile(this.file, "utf8"));
      if (data.version !== 1 || !Array.isArray(data.operations)) throw new Error("Invalid media operations state");
      return data.operations.filter(op => this.now() - op.updatedAt < 48 * 3600 * 1000);
    } catch (error) { if (error.code !== "ENOENT") throw error; return []; }
  }
  async record(operation) {
    const work = this.queue.then(async () => {
      const all = await this.read();
      const previous = all.find(op => op.id === operation.id);
      const entry = { ...previous, ...operation, id: operation.id || randomUUID().slice(0, 8), updatedAt: this.now() };
      entry.topicId = operation.topicId !== undefined ? operation.topicId : entry.topicId ?? entry.threadId ?? null;
      entry.threadId = entry.topicId;
      entry.referenceMessageIds = [...new Set([...operationReferences(previous), ...operationReferences(entry)])].slice(-50);
      const next = [entry, ...all.filter(op => op.id !== entry.id)].slice(0, 300);
      await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const temp = `${this.file}.${randomUUID()}.tmp`;
      try { await fs.writeFile(temp, JSON.stringify({ version: 1, operations: next }), { mode: 0o600 }); await fs.rename(temp, this.file); }
      finally { await fs.rm(temp, { force: true }); }
      return entry;
    });
    this.queue = work.catch(() => {}); return work;
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
}

function operationReferences(operation) {
  if (!operation) return [];
  return [operation.sourceMessageId, operation.errorMessageId, operation.sentMessageId,
    ...(operation.sentMessageIds || []), ...(operation.referenceMessageIds || [])].filter(Number.isSafeInteger);
}
