import assert from "node:assert/strict";
import test from "node:test";
import { socialVideoCircuitStatus } from "../src/health.js";

test("socialVideoCircuitStatus reports all known fallback providers", () => {
  const now = 1000000;
  const circuits = new Map([
    ["instagram", { failures: 3, openedUntil: now + 120000 }],
    ["tiktok", { failures: 1, openedUntil: 0 }],
  ]);

  assert.deepEqual(socialVideoCircuitStatus(circuits, now), [
    { provider: "tiktok", failures: 1, open: false, cooldownMs: 0 },
    { provider: "instagram", failures: 3, open: true, cooldownMs: 120000 },
    { provider: "threads", failures: 0, open: false, cooldownMs: 0 },
  ]);
});
