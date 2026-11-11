import test from "node:test";
import assert from "node:assert/strict";
import {
  buildJudgeCaseSessionKey,
  buildJudgeHistoryExcerpt,
  filterJudgeCandidatesForThread,
  judgeThreadId,
  parseJudgeScopeText,
  selectRelevantJudgeMessages,
} from "../src/judge.js";

test("judgeThreadId and thread filtering isolate Telegram forum topics", () => {
  assert.equal(judgeThreadId({ chat: { is_forum: true }, message_thread_id: 42 }), 42);
  assert.equal(judgeThreadId({ is_topic_message: true, message_thread_id: 42 }), 42);
  assert.equal(judgeThreadId({ message_thread_id: 42 }), null);
  assert.equal(judgeThreadId({ chat: { is_forum: false }, message_thread_id: 42 }), null);
  assert.equal(judgeThreadId({}), null);

  const items = [
    { messageId: 1, messageThreadId: null },
    { messageId: 2, messageThreadId: 42 },
    { messageId: 3, messageThreadId: 99 },
    { messageId: 4 },
  ];
  assert.deepEqual(filterJudgeCandidatesForThread(items, 42).map((item) => item.messageId), [2]);
  assert.deepEqual(filterJudgeCandidatesForThread(items, null).map((item) => item.messageId), [1, 4]);
});

test("judge case sessions are fresh per command, thread, phase, and retry", () => {
  const first = buildJudgeCaseSessionKey(-100123, "v7", 501, {
    threadId: 42,
    phase: "scope",
  });
  const verdict = buildJudgeCaseSessionKey(-100123, "v7", 501, {
    threadId: 42,
    phase: "verdict",
  });
  const nextCase = buildJudgeCaseSessionKey(-100123, "v7", 502, {
    threadId: 42,
    phase: "verdict",
  });
  const retry = buildJudgeCaseSessionKey(-100123, "v7", 501, {
    threadId: 42,
    phase: "verdict",
    attempt: 2,
  });

  assert.match(first, /judge-t42-m501-scope$/);
  assert.notEqual(first, verdict);
  assert.notEqual(verdict, nextCase);
  assert.match(retry, /verdict-r2$/);
});

test("judge scope parser accepts fenced JSON and rejects unknown message IDs", () => {
  const parsed = parseJudgeScopeText(`Result:\n\`\`\`json
  {
    "status": "ready",
    "topic": "Phone battery dispute",
    "messageIds": [10, "11", 999, 10],
    "materialPublicClaims": [
      {"speaker": "@a", "claim": "Model X has a 5000 mAh battery"},
      "Model Y launched in 2025"
    ],
    "clarificationQuestion": "",
    "reason": ""
  }
  \`\`\``, [10, 11, 12]);

  assert.equal(parsed.status, "ready");
  assert.equal(parsed.topic, "Phone battery dispute");
  assert.deepEqual(parsed.messageIds, [10, 11]);
  assert.deepEqual(parsed.materialPublicClaims, [
    { speaker: "@a", claim: "Model X has a 5000 mAh battery" },
    { speaker: "", claim: "Model Y launched in 2025" },
  ]);
});

test("relevant-message selection preserves the anchor and its complete reply chain", () => {
  const candidates = [
    { messageId: 1, replyToMessageId: null },
    { messageId: 2, replyToMessageId: 1 },
    { messageId: 3, replyToMessageId: 2 },
    { messageId: 4, replyToMessageId: null },
  ];

  assert.deepEqual(
    selectRelevantJudgeMessages(candidates, [2], 1).map((item) => item.messageId),
    [1, 2, 3],
  );
  assert.deepEqual(
    selectRelevantJudgeMessages(candidates, [], null).map((item) => item.messageId),
    [1, 2, 3, 4],
  );
});

test("judge prompt trimming preserves the reply anchor and newest evidence", () => {
  const items = Array.from({ length: 8 }, (_, index) => ({
    messageId: index + 1,
    text: `message-${index + 1}-${"x".repeat(180)}`,
  }));
  const excerpt = buildJudgeHistoryExcerpt(items, 650, {
    anchorMessageId: 2,
    formatter: (item) => `#${item.messageId} ${item.text}`,
  });

  assert.ok(excerpt.includedItems.some((item) => item.messageId === 2));
  assert.ok(excerpt.includedItems.some((item) => item.messageId === 8));
  assert.ok(excerpt.text.length <= 650);
  assert.ok(excerpt.omittedCount > 0);
});
