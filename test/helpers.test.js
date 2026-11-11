import assert from "node:assert/strict";
import test from "node:test";
import {
  escapeHtml,
  escapeHtmlAttribute,
  escapeRegex,
  buildLanguageRoutingInstructionText,
  buildRotatingOpenClawSessionKey,
  buildWebResearchInstructionText,
  formatDurationSeconds,
  formatHealthReport,
  getOpenAIWebSearchStatus,
  getOpenClawWebSearchStatus,
  extractSocialVideoUrlFromText,
  hasDistinctUkrainianOrthographyText,
  isAssembleRequestText,
  isBotDirectedInsultText,
  isExplicitWebSearchRequestText,
  isModerationAllowedUserByPolicy,
  isSocialVideoHostName,
  normalizeMemoryPrivacyMode,
  parseBotCommandText,
  parseCountRequestText,
  parseHistoryRequestText,
  parseReferencedMessageIdsText,
  parseJudgeRequestText,
  parseNaturalJudgeRequestText,
  parseModerationAllowlist,
  recordCircuitBreakerFailure,
  recordCircuitBreakerSuccess,
  selectHistoryItems,
  shouldAttemptPassiveMemoryForChat,
  socialVideoProviderForUrl,
  telegramRetryDelayMsForError,
  isCircuitBreakerOpen,
} from "../src/helpers.js";

test("parseBotCommandText parses bare commands and trims args", () => {
  assert.deepEqual(parseBotCommandText("/judge   last 50 messages"), {
    name: "judge",
    args: "last 50 messages",
  });
});

test("parseBotCommandText accepts matching bot mention and rejects other bots", () => {
  assert.deepEqual(parseBotCommandText("/ping@ExampleAIBot", "ExampleAIBot"), {
    name: "ping",
    args: "",
  });
  assert.equal(parseBotCommandText("/ping@OtherBot", "ExampleAIBot"), null);
});

test("isAssembleRequestText detects Fortnite assemble phrases", () => {
  for (const text of [
    "/assemble",
    "Го форт?",
    "Форт?",
    "Фортик?",
    "Фортік?",
    "Збір",
    "Катнемо?",
    "хто в фортік?",
    "fortnite assemble",
  ]) {
    assert.equal(isAssembleRequestText(text), true, text);
  }

  for (const text of ["фортепіано?", "збір коштів", "катнемо завтра о 20?", "summarize chat"]) {
    assert.equal(isAssembleRequestText(text), false, text);
  }
});

test("isBotDirectedInsultText detects insults aimed at the bot", () => {
  const options = {
    botUsername: "FixtureGroupBot",
    aliases: ["оріон", "боте"],
  };

  assert.equal(isBotDirectedInsultText("@FixtureGroupBot you are an idiot", options), true);
  assert.equal(isBotDirectedInsultText("Оріон, ти довбойоб", options), true);
  assert.equal(isBotDirectedInsultText("Боте, ти тупий", options), true);
  assert.equal(isBotDirectedInsultText("you are useless", { ...options, replyToBot: true }), true);
  assert.equal(isBotDirectedInsultText("Нарешті, дякую залупа", { ...options, replyToBot: true }), true);
});

test("isBotDirectedInsultText ignores neutral bot messages and insults aimed elsewhere", () => {
  const options = {
    botUsername: "FixtureGroupBot",
    aliases: ["оріон", "боте"],
  };

  assert.equal(isBotDirectedInsultText("@FixtureGroupBot what is the weather?", options), false);
  assert.equal(isBotDirectedInsultText("that player is an idiot", options), false);
  assert.equal(isBotDirectedInsultText("the trash bin is full", options), false);
});

test("isBotDirectedInsultText supports configured aliases and extra terms", () => {
  assert.equal(
    isBotDirectedInsultText("Kody, you are a toaster", {
      aliases: ["kody"],
      extraTerms: ["toaster"],
    }),
    true,
  );
});

test("parseJudgeRequestText handles count, hours, today, and clamps count", () => {
  const options = {
    chatBufferMaxAgeHours: 24,
    historySliceMaxMessages: 300,
    judgeDefaultMessageCount: 150,
    judgeMaxMessageCount: 300,
  };

  assert.deepEqual(parseJudgeRequestText("50", options), {
    type: "messages",
    count: 50,
    description: "last 50 messages",
  });
  assert.deepEqual(parseJudgeRequestText("за останні 5 годин", options), {
    type: "hours",
    hours: 5,
    description: "last 5 hours",
  });
  assert.deepEqual(parseJudgeRequestText("today", options), {
    type: "today",
    description: "today",
  });
  assert.equal(parseJudgeRequestText("9999", options).count, 300);
});

test("parseNaturalJudgeRequestText detects multilingual judge intents", () => {
  const options = {
    chatBufferMaxAgeHours: 24,
    historySliceMaxMessages: 300,
    judgeDefaultMessageCount: 150,
    judgeMaxMessageCount: 300,
  };

  assert.deepEqual(parseNaturalJudgeRequestText("who is right here? last 40 messages", options), {
    type: "messages",
    count: 40,
    description: "last 40 messages",
  });
  assert.deepEqual(parseNaturalJudgeRequestText("розсуди нас за останні 2 години", options), {
    type: "hours",
    hours: 2,
    description: "last 2 hours",
  });
  assert.deepEqual(parseNaturalJudgeRequestText("кто прав сегодня?", options), {
    type: "today",
    description: "today",
  });
  assert.equal(parseNaturalJudgeRequestText("/judge 50", options), null);
  assert.equal(parseNaturalJudgeRequestText("summarize last 20 messages", options), null);
});

test("parseHistoryRequestText detects multilingual history scopes", () => {
  const options = { chatBufferMaxAgeHours: 24, historySliceMaxMessages: 300 };

  assert.deepEqual(parseHistoryRequestText("summarize last 25 messages", options), {
    type: "messages",
    count: 25,
    description: "last 25 messages",
  });
  assert.deepEqual(parseHistoryRequestText("проаналізуй останні 2 годин", options), {
    type: "hours",
    hours: 2,
    description: "last 2 hours",
  });
  assert.equal(parseHistoryRequestText("what is the weather?", options), null);
});

test("parseReferencedMessageIdsText detects explicit Telegram message references", () => {
  assert.deepEqual(parseReferencedMessageIdsText("Що було в повідомленні №132771?"), [132771]);
  assert.deepEqual(parseReferencedMessageIdsText("answer message #132771 and msg 132700"), [132771, 132700]);
  assert.deepEqual(parseReferencedMessageIdsText("відповідай на сообщение номер 132650"), [132650]);
});

test("parseReferencedMessageIdsText ignores ordinary counts and deduplicates IDs", () => {
  assert.deepEqual(parseReferencedMessageIdsText("summarize the last 40 messages"), []);
  assert.deepEqual(parseReferencedMessageIdsText("message 132771, then #132771"), [132771]);
  assert.deepEqual(parseReferencedMessageIdsText("message 1 message 2 message 3", { maxIds: 2 }), [1, 2]);
});

test("explicit web search detection covers direct requests and Ukrainian follow-ups", () => {
  for (const text of [
    "Перевір це в інтернеті",
    "Пошукай онлайн, чи це правда",
    "Ну так перевір",
    "Ну так перевір, будь ласка",
    "check this online",
    "search the web for an official source",
  ]) {
    assert.equal(isExplicitWebSearchRequestText(text), true, text);
  }

  for (const text of [
    "Я вже перевірив це вчора",
    "Я вже перевірив це онлайн",
    "Як перевірити інформацію в інтернеті?",
    "перевір код у цьому файлі",
    "what do you remember about it?",
    "summarize the last 40 messages",
  ]) {
    assert.equal(isExplicitWebSearchRequestText(text), false, text);
  }
});

test("web research and Ukrainian language instructions are added only when applicable", () => {
  const researchInstruction = buildWebResearchInstructionText("Ну так перевір");
  assert.match(researchInstruction, /MUST call web_search/);
  assert.match(researchInstruction, /Do not answer from memory/);
  assert.equal(buildWebResearchInstructionText("Дякую"), "");

  assert.equal(hasDistinctUkrainianOrthographyText("Ну так перевір"), true);
  assert.match(buildLanguageRoutingInstructionText("Ну так перевір"), /Ukrainian-specific orthography/);
  assert.equal(buildLanguageRoutingInstructionText("check online"), "");
});

test("web search status requires an executed tool call without failures", () => {
  assert.deepEqual(
    getOpenClawWebSearchStatus({ result: { meta: { toolSummary: { tools: ["web_search"], failures: 0 } } } }),
    { executed: true, succeeded: true, failures: 0 },
  );
  assert.deepEqual(
    getOpenClawWebSearchStatus({ result: { meta: { toolSummary: { tools: ["openclaw.web_search"], failures: 0 } } } }),
    { executed: true, succeeded: true, failures: 0 },
  );
  assert.deepEqual(
    getOpenClawWebSearchStatus({ result: { meta: { toolSummary: { tools: ["web_search"], failures: 1 } } } }),
    { executed: true, succeeded: false, failures: 1 },
  );
  assert.deepEqual(getOpenClawWebSearchStatus({ result: { meta: {} } }), {
    executed: false,
    succeeded: false,
    failures: 0,
  });

  assert.deepEqual(
    getOpenAIWebSearchStatus({ output: [{ type: "web_search_call", status: "completed" }] }),
    { executed: true, succeeded: true, failures: 0 },
  );
  assert.deepEqual(
    getOpenAIWebSearchStatus({ output: [{ type: "web_search_preview_call", status: "failed" }] }),
    { executed: true, succeeded: false, failures: 1 },
  );
  assert.deepEqual(
    getOpenAIWebSearchStatus({ output: [{ type: "web_search_call", status: "in_progress" }] }),
    { executed: true, succeeded: false, failures: 1 },
  );
});

test("rotating OpenClaw session keys are stable inside a window and isolate research", () => {
  const hour = 60 * 60 * 1000;
  const first = buildRotatingOpenClawSessionKey(-100123, "v7", {
    timestampMs: 100 * hour,
    windowHours: 24,
  });
  assert.equal(first, buildRotatingOpenClawSessionKey(-100123, "v7", {
    timestampMs: 119 * hour,
    windowHours: 24,
  }));
  assert.notEqual(first, buildRotatingOpenClawSessionKey(-100123, "v7", {
    timestampMs: 124 * hour,
    windowHours: 24,
  }));
  assert.notEqual(first, buildRotatingOpenClawSessionKey(-100123, "v7", {
    timestampMs: 100 * hour,
    windowHours: 24,
    purpose: "research",
  }));
});

test("selectHistoryItems excludes current message and respects scopes", () => {
  const now = new Date("2026-08-09T12:00:00Z").getTime();
  const items = [
    { messageId: 1, date: now - 3 * 60 * 60 * 1000, text: "old" },
    { messageId: 2, date: now - 30 * 60 * 1000, text: "recent" },
    { messageId: 3, date: now, text: "current" },
  ];

  assert.deepEqual(selectHistoryItems(items, { type: "messages", count: 2 }, 3, now).map((item) => item.messageId), [1, 2]);
  assert.deepEqual(selectHistoryItems(items, { type: "hours", hours: 1 }, 3, now).map((item) => item.messageId), [2]);
});

test("parseCountRequestText extracts English, Ukrainian, and Russian count terms", () => {
  assert.deepEqual(parseCountRequestText('count "test" in last 20 messages'), { term: "test" });
  assert.deepEqual(parseCountRequestText("порахуй каву за сьогодні"), { term: "каву" });
  assert.deepEqual(parseCountRequestText("посчитай мем за день"), { term: "мем" });
});

test("telegramRetryDelayMsForError honors Telegram retry_after and caps fallback", () => {
  assert.equal(telegramRetryDelayMsForError({ retryAfterSeconds: 5 }, 1000), 5250);
  assert.equal(telegramRetryDelayMsForError(new Error("Too Many Requests: retry after 7"), 1000), 7250);
  assert.equal(telegramRetryDelayMsForError({}, 50), 100);
  assert.equal(telegramRetryDelayMsForError({}, 9999999), 600000);
});

test("extractSocialVideoUrlFromText returns supported social URLs and trims punctuation", () => {
  assert.equal(extractSocialVideoUrlFromText("watch https://www.instagram.com/reel/abc123),"), "https://www.instagram.com/reel/abc123");
  assert.equal(extractSocialVideoUrlFromText("watch https://youtube.com/shorts/abc123"), "");
  assert.equal(extractSocialVideoUrlFromText("read https://example.com/video"), "");
  assert.equal(isSocialVideoHostName("m.tiktok.com"), true);
  assert.equal(isSocialVideoHostName("youtu.be"), false);
  assert.equal(isSocialVideoHostName("evilinstagram.com"), false);
});

test("socialVideoProviderForUrl classifies supported hosts", () => {
  assert.equal(socialVideoProviderForUrl("https://youtu.be/abc"), "unknown");
  assert.equal(socialVideoProviderForUrl("https://m.tiktok.com/@u/video/1"), "tiktok");
  assert.equal(socialVideoProviderForUrl("https://www.instagram.com/reel/abc"), "instagram");
  assert.equal(socialVideoProviderForUrl("https://threads.net/@u/post/abc"), "threads");
  assert.equal(socialVideoProviderForUrl("https://example.com/video"), "unknown");
});

test("escaping helpers protect Telegram HTML and regex construction", () => {
  assert.equal(escapeHtml("<b>&</b>"), "&lt;b&gt;&amp;&lt;/b&gt;");
  assert.equal(escapeHtmlAttribute('"x" & <y>'), "&quot;x&quot; &amp; &lt;y&gt;");
  assert.equal(escapeRegex("a+b?"), "a\\+b\\?");
});

test("moderation allowlist supports usernames and stable user ids", () => {
  const allowlist = parseModerationAllowlist({
    usernames: "@alice,bob",
    userIds: "1001, 1002",
  });

  assert.equal(isModerationAllowedUserByPolicy({ id: 1001, username: "unknown" }, allowlist), true);
  assert.equal(isModerationAllowedUserByPolicy({ id: 9999, username: "Alice" }, allowlist), true);
  assert.equal(isModerationAllowedUserByPolicy({ id: 9999, username: "charlie" }, allowlist), false);
});

test("memory privacy mode blocks passive group memory unless explicitly enabled", () => {
  const groupMessage = { chat: { type: "supergroup" }, from: { is_bot: false } };
  const privateMessage = { chat: { type: "private" }, from: { is_bot: false } };
  const botMessage = { chat: { type: "private" }, from: { is_bot: true } };

  assert.equal(normalizeMemoryPrivacyMode("bad-value"), "commands_only");
  assert.equal(shouldAttemptPassiveMemoryForChat(groupMessage, { mode: "commands_only" }), false);
  assert.equal(shouldAttemptPassiveMemoryForChat(privateMessage, { mode: "passive_private_only" }), true);
  assert.equal(shouldAttemptPassiveMemoryForChat(groupMessage, { mode: "passive_private_only" }), false);
  assert.equal(shouldAttemptPassiveMemoryForChat(groupMessage, { mode: "passive_groups_enabled" }), true);
  assert.equal(shouldAttemptPassiveMemoryForChat(botMessage, { mode: "passive_groups_enabled" }), false);
});

test("circuit breaker opens after threshold and resets on success", () => {
  const options = { threshold: 2, cooldownMs: 60000 };
  const now = 1000000;
  let state = recordCircuitBreakerFailure(null, options, now);
  assert.equal(isCircuitBreakerOpen(state, now), false);

  state = recordCircuitBreakerFailure(state, options, now + 1);
  assert.equal(isCircuitBreakerOpen(state, now + 2), true);
  assert.equal(isCircuitBreakerOpen(state, now + 60001), false);

  state = recordCircuitBreakerSuccess(state, now + 60002);
  assert.equal(state.failures, 0);
  assert.equal(isCircuitBreakerOpen(state, now + 60003), false);
});

test("formatHealthReport summarizes dependencies and circuit status without secrets", () => {
  const report = formatHealthReport({
    runtime: "running",
    uptimeSeconds: 3661,
    backend: "openclaw",
    sessionVersion: "v16",
    lockOk: true,
    memoryPrivacyMode: "commands_only",
    passiveGroupMemory: false,
    dependencies: [
      { name: "openclaw_cli", ok: true, required: true },
      { name: "ffmpeg", ok: false, required: true },
    ],
    circuits: [
      { provider: "instagram", open: true, cooldownMs: 61000, failures: 3 },
      { provider: "tiktok", open: false, cooldownMs: 0, failures: 1 },
    ],
  });

  assert.match(report, /Bot health/);
  assert.match(report, /Uptime: 1h 1m/);
  assert.match(report, /openclaw_cli: ok/);
  assert.match(report, /ffmpeg: missing required/);
  assert.match(report, /instagram: cooldown 61s/);
  assert.match(report, /tiktok: ok \(1 failures\)/);
  assert.doesNotMatch(report, /TOKEN|KEY|SECRET/i);
});

test("formatDurationSeconds keeps compact day hour minute output", () => {
  assert.equal(formatDurationSeconds(59), "0m");
  assert.equal(formatDurationSeconds(3600), "1h 0m");
  assert.equal(formatDurationSeconds(90061), "1d 1h 1m");
});
