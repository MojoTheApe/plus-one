import assert from "node:assert/strict";
import test from "node:test";
import {
  isRestartablePollingError,
  pollingFailureDecision,
} from "../src/polling-health.js";

test("pollingFailureDecision requests a recycle after the configured transport failure threshold", () => {
  const error = new TypeError("fetch failed", { cause: { code: "UND_ERR_SOCKET" } });
  const first = pollingFailureDecision({ currentFailures: 0, error, threshold: 3 });
  const second = pollingFailureDecision({ currentFailures: first.consecutiveFailures, error, threshold: 3 });
  const third = pollingFailureDecision({ currentFailures: second.consecutiveFailures, error, threshold: 3 });

  assert.deepEqual(first, { consecutiveFailures: 1, restart: false, restartable: true });
  assert.deepEqual(second, { consecutiveFailures: 2, restart: false, restartable: true });
  assert.deepEqual(third, { consecutiveFailures: 3, restart: true, restartable: true });
});

test("pollingFailureDecision does not recycle for Telegram authentication errors", () => {
  const decision = pollingFailureDecision({
    currentFailures: 2,
    error: Object.assign(new Error("Unauthorized"), { status: 401 }),
    threshold: 3,
  });

  assert.deepEqual(decision, { consecutiveFailures: 0, restart: false, restartable: false });
});

test("isRestartablePollingError accepts Telegram throttling and server failures", () => {
  assert.equal(isRestartablePollingError({ status: 429 }), true);
  assert.equal(isRestartablePollingError({ status: 502 }), true);
  assert.equal(isRestartablePollingError({ status: 400 }), false);
});
