import fs from "node:fs";
import path from "node:path";
import { CodexBackend } from "../src/codex-backend.js";
import { ClaudeBackend } from "../src/claude-backend.js";
import { loadPersonaProfile } from "../src/persona-policy.js";

async function check() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const owner = process.env.BOT_OWNER_ID;
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(token || "")) throw new Error("Set TELEGRAM_BOT_TOKEN in the private bot.env");
  if (!/^[1-9]\d*$/.test(owner || "") || !Number.isSafeInteger(Number(owner))) {
    throw new Error("Set BOT_OWNER_ID to the owner's numeric Telegram user ID");
  }
  const claude = process.env.ANSWER_BACKEND === "claude";
  if (claude && !process.env.ANTHROPIC_API_KEY) throw new Error("Set ANTHROPIC_API_KEY in the private bot.env");
  const home = claude ? "HOME" : "CODEX_HOME";
  for (const key of [home, "AI_AGENT_DIR", "BOT_SETUP_FILE"]) {
    if (!path.isAbsolute(process.env[key] || "")) throw new Error(`Configure the absolute ${key} path`);
  }
  for (const dir of [process.env[home], process.env.AI_AGENT_DIR, path.dirname(process.env.BOT_SETUP_FILE)]) {
    if (!fs.existsSync(dir)) throw new Error("Create the instance's Codex, agent and runtime directories");
    fs.accessSync(dir, fs.constants.R_OK | fs.constants.W_OK);
  }
  let bot;
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/getMe`, { signal: AbortSignal.timeout(10000) });
    const data = await response.json();
    if (!response.ok || !data.ok || !data.result?.username) throw new Error();
    bot = data.result;
  } catch {
    throw new Error("Telegram getMe failed. Check the token and VPS network.");
  }
  try {
    const profile = loadPersonaProfile(process.env.BOT_PROFILE_FILE, process.env.BOT_PROFILE);
    const backend = claude ? new ClaudeBackend({ profile, timeoutMs: 60000 }) : new CodexBackend({ profile, timeoutMs: 60000 });
    await backend.ask({ prompt: "Reply with the word OK." });
  } catch {
    throw new Error(claude ? "Claude did not answer. Check ANTHROPIC_API_KEY, its credit balance and CLAUDE_MODEL in the private bot.env."
      : "Codex did not answer. Check its login and AI_MODELS in the private bot.env.");
  }
  console.log(`Telegram and ${claude ? "Claude" : "Codex"} are ready. Open https://t.me/${bot.username} as the configured owner.`);
}

check().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
