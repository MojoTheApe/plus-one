import fs from "node:fs";
import process from "node:process";
import { formatHealthReport } from "./helpers.js";

export async function maybeHandleStatusCommand(message, deps) {
  const command = deps.parseBotCommand(message);
  if (!command || !["status", "health"].includes(command.name)) return false;

  if (!deps.isAllowedUser(message.from)) {
    await deps.telegram("sendMessage", {
      chat_id: message.chat.id,
      text: "Status is available only to configured bot operators.",
      reply_to_message_id: message.message_id,
      disable_web_page_preview: true,
    });
    return true;
  }

  const status = await collectHealthStatus(deps);
  await deps.telegram("sendMessage", {
    chat_id: message.chat.id,
    text: deps.formatTelegramHtml(formatHealthReport(status)),
    parse_mode: "HTML",
    reply_to_message_id: message.message_id,
    disable_web_page_preview: true,
  });
  deps.logInfo("health_status_sent", deps.messageLogMeta(message));
  return true;
}

export async function collectHealthStatus(deps) {
  const dependencies = await collectDependencyStatus(deps);
  const now = Date.now();
  return {
    runtime: "running",
    uptimeSeconds: process.uptime(),
    backend: deps.answerBackend,
    sessionVersion: deps.openclawSessionVersion,
    lockOk: currentProcessOwnsLock(deps.botLockFile),
    memoryPrivacyMode: deps.memoryPrivacyMode,
    passiveGroupMemory: deps.memoryPassiveGroupCapture,
    dependencies,
    circuits: socialVideoCircuitStatus(deps.socialVideoCircuitByProvider, now),
  };
}

export async function collectDependencyStatus(deps) {
  return Promise.all([
    deps.answerBackend === "codex"
      ? deps.checkExecutable("codex_cli", process.env.CODEX_CLI || "codex", ["--version"], { required: true })
      : deps.checkExecutable("openclaw_cli", deps.openclawCli, ["--version"], { required: deps.answerBackend === "openclaw" }),
    deps.checkExecutable("social_video_downloader", deps.socialVideoDownloader, ["--version"], { required: deps.socialVideoEnabled }),
    deps.checkExecutable("ffprobe", deps.socialVideoFfprobe, ["-version"], { required: deps.socialVideoEnabled }),
    deps.checkExecutable("ffmpeg", deps.socialVideoFfmpeg, ["-version"], { required: deps.socialVideoEnabled }),
    deps.checkExecutable("whisper_python", deps.whisperPython, ["--version"], { required: deps.voiceTranscriptionEnabled }),
  ]);
}

export function currentProcessOwnsLock(botLockFile) {
  try {
    return fs.existsSync(botLockFile) && fs.readFileSync(botLockFile, "utf8").trim() === String(process.pid);
  } catch {
    return false;
  }
}

export function socialVideoCircuitStatus(circuitByProvider, now = Date.now()) {
  const providers = ["tiktok", "instagram", "threads"];
  return providers.map((provider) => {
    const state = circuitByProvider?.get(provider) || {};
    const cooldownMs = Math.max(0, Number(state.openedUntil || 0) - now);
    return {
      provider,
      failures: Number(state.failures || 0),
      open: cooldownMs > 0,
      cooldownMs,
    };
  });
}
