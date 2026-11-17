import test from "node:test";
import assert from "node:assert/strict";
import { MediaBudget } from "../src/media-budget.js";

test("failures do not spend successful downloads, and expose URL backoff separately", () => {
  let now = 1000;
  const budget = new MediaBudget({ hourlyLimit: 1, now: () => now });
  const first = budget.reserve(-1, "https://example.org/broken#one");
  assert.equal(first.allowed, true);
  assert.equal(budget.reserve(-1, "https://example.org/other").reason, "IN_PROGRESS");
  assert.equal(budget.complete(first.reservation, { success: false }), true);
  assert.equal(budget.complete(first.reservation, { success: true }), false);
  const blocked = budget.reserve(-1, "https://example.org/broken#two");
  assert.equal(blocked.reason, "URL_BACKOFF");
  assert.equal(blocked.retryAfterSeconds, 30);
  now += 15000;
  assert.equal(budget.reserve(-1, "https://example.org/broken").retryAfterSeconds, 15);
  const other = budget.reserve(-1, "https://example.org/other");
  assert.equal(other.allowed, true);
  budget.complete(other.reservation, { success: true });
  assert.equal(budget.reserve(-1, "https://example.org/third").reason, "SUCCESS_QUOTA");
  assert.equal(budget.reserve(-1, "https://example.org/third").retryAfterSeconds, 3600);
  assert.equal(budget.reserve(-2, "https://example.org/third").allowed, true);
  now += 3600000;
  assert.equal(budget.reserve(-1, "https://example.org/third").allowed, true);
});

test("repeated failed attempts have bounded chat cooldown and increasing URL backoff", () => {
  let now = 0;
  const budget = new MediaBudget({ now: () => now, maxFailures: 3 });
  for (const url of ["a", "b", "c"]) {
    const result = budget.reserve(1, url);
    assert.equal(result.allowed, true);
    budget.complete(result.reservation, { success: false });
  }
  assert.equal(budget.reserve(1, "d").reason, "FAILURE_COOLDOWN");
  assert.equal(budget.reserve(1, "d").retryAfterSeconds, 120);
  now = 120000;
  const again = budget.reserve(1, "a");
  assert.equal(again.allowed, true);
  budget.complete(again.reservation, { success: false });
  now += 120000;
  const resumed = budget.reserve(1, "a");
  assert.equal(resumed.allowed, true);
  budget.complete(resumed.reservation, { success: false });
  // New failures cannot consume an hour's quota; this cooldown stays two minutes.
  assert.equal(budget.reserve(1, "a").retryAfterSeconds, 120);
});

test("abandoned reservations expire safely and cannot be completed twice", () => {
  let now = 0;
  const budget = new MediaBudget({ now: () => now, reservationTtlMs: 1000 });
  const abandoned = budget.reserve(1, "one");
  now = 1000;
  assert.equal(budget.reserve(1, "one").reason, "URL_BACKOFF");
  assert.equal(budget.complete(abandoned.reservation, { success: true }), false);
  const next = budget.reserve(1, "two");
  assert.equal(next.allowed, true);
  budget.complete(next.reservation, { success: false });
  now += 3600000;
  budget.reserve(2, "three");
  assert.equal(budget.chats.has("1"), false);
});
test("tracking parameters and post/reel aliases cannot bypass publication backoff", () => {
  const budget = new MediaBudget({ now: () => 100000 });
  const reserved = budget.reserve(-1, "https://www.instagram.com/p/BA/?igsh=first");
  budget.complete(reserved.reservation, { success: false });
  assert.equal(budget.reserve(-1, "https://www.instagram.com/reel/BA/?igsh=second").reason, "URL_BACKOFF");
  assert.equal(budget.reserve(-1, "https://www.instagram.com/p/OTHER/").allowed, true);
});

test('prepared delivery bypasses source quota/cooldown while holding the same concurrency slot', () => {
  const budget = new MediaBudget({ hourlyLimit: 1, now: () => 1000, maxFailures: 1 });
  const first = budget.reserve(1, 'first', { source: false });
  assert.equal(budget.reserveSource(first.reservation).allowed, true);
  budget.completeSource(first.reservation, { success: true });
  budget.complete(first.reservation, { success: false }); // Telegram failed, source succeeded.
  const cached = budget.reserve(1, 'first', { source: false });
  assert.equal(cached.allowed, true);
  assert.equal(budget.reserve(1, 'parallel', { source: false }).reason, 'IN_PROGRESS');
  assert.equal(budget.reserveSource(cached.reservation).reason, 'SUCCESS_QUOTA');
  budget.complete(cached.reservation, { success: true });
  assert.equal(budget.chats.get('1').successes.length, 1);
  assert.equal(budget.chats.get('1').failures.length, 0);
  const failed = budget.reserve(2, 'broken', { source: false });
  budget.reserveSource(failed.reservation); budget.completeSource(failed.reservation, { success: false });
  budget.complete(failed.reservation, { success: false });
  const reuse = budget.reserve(2, 'broken', { source: false });
  assert.equal(reuse.allowed, true);
  assert.equal(budget.reserveSource(reuse.reservation).reason, 'FAILURE_COOLDOWN');
  budget.complete(reuse.reservation, { success: true });
  assert.equal(budget.chats.get('2').failures.length, 1);
});

test('abandoned cache work and upload/cache errors never invent upstream failures', () => {
  let now = 0;
  const budget = new MediaBudget({ now: () => now, reservationTtlMs: 100 });
  budget.reserve(1, 'cached', { source: false }); now = 100;
  const next = budget.reserve(1, 'cached', { source: false });
  assert.equal(next.allowed, true);
  budget.complete(next.reservation, { success: false });
  assert.equal(budget.reserve(1, 'cached').allowed, true);
});
