import fs from "node:fs";
const file = process.env.BOT_STATUS_FILE || "/state/runtime/status.json";
try {
  const state = JSON.parse(fs.readFileSync(file, "utf8"));
  const pid = Number(fs.readFileSync(process.env.BOT_LOCK_FILE || "/state/runtime/bot.pid", "utf8"));
  process.kill(pid, 0);
  if (state.backend !== "codex" || state.pid !== pid || !state.lastPollAt || Date.now() - state.lastPollAt > 240000) process.exit(1);
} catch { process.exit(1); }
