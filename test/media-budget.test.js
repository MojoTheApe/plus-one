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
