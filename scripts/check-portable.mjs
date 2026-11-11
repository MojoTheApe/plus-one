import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CodexBackend } from '../src/codex-backend.js';
import { ClaudeBackend } from '../src/claude-backend.js';
import { loadPersonaProfile } from '../src/persona-policy.js';

const execute = promisify(execFile);
export async function checkAI({ env = process.env, createBackend } = {}) {
  const claude = env.ANSWER_BACKEND === 'claude';
  if (env.ANSWER_BACKEND && !['codex','claude'].includes(env.ANSWER_BACKEND)) throw new Error('Portable setup supports Codex CLI or the Claude API-key connection.');
  if (claude && !env.ANTHROPIC_API_KEY) throw new Error('Set ANTHROPIC_API_KEY in the private bot.env');
  for (const key of [claude ? 'HOME' : 'CODEX_HOME', 'AI_AGENT_DIR']) {
    if (!path.isAbsolute(env[key] || '')) throw new Error(`Configure the absolute ${key} path`);
    fs.accessSync(env[key], fs.constants.R_OK | fs.constants.W_OK);
  }
  try {
    const profile = loadPersonaProfile(env.BOT_PROFILE_FILE, env.BOT_PROFILE);
    const backend = createBackend ? createBackend({ claude, profile }) : claude ? new ClaudeBackend({ profile, timeoutMs: 60000 }) : new CodexBackend({ profile, timeoutMs: 60000 });
    await backend.ask({ prompt: 'Reply with the word OK.' });
  } catch {
    throw new Error(claude ? 'Claude did not answer. Check ANTHROPIC_API_KEY, its credit balance and available models.'
      : 'Codex did not answer. Complete your own login and check AI_MODELS.');
  }
  return claude ? 'Claude' : 'Codex';
}

export async function checkTelegram({ env = process.env, fetchImpl = fetch } = {}) {
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(env.TELEGRAM_BOT_TOKEN || '')) throw new Error('Set TELEGRAM_BOT_TOKEN in the private bot.env');
  if (!/^[1-9]\d*$/.test(env.BOT_OWNER_ID || '') || !Number.isSafeInteger(Number(env.BOT_OWNER_ID))) {
    throw new Error("Set BOT_OWNER_ID to the owner's numeric Telegram user ID; a username is not sufficient.");
  }
  let bot;
  try {
    const response = await fetchImpl(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getMe`, { signal: AbortSignal.timeout(10000) });
    const data = await response.json();
    if (!response.ok || !data.ok || !data.result?.username) throw new Error();
    bot = data.result;
  } catch { throw new Error('Telegram getMe failed. Check the token and network.'); }
  if (bot.can_join_groups === false) throw new Error('Enable Group Joining in BotFather before starting.');
  if (bot.can_read_all_group_messages !== true) throw new Error('Disable Group Privacy in BotFather before starting; then run this check again.');
  return bot;
}

export async function checkMedia({ env = process.env, run = execute } = {}) {
  if (env.SOCIAL_VIDEO_ENABLED !== 'false') {
    for (const [command, args] of [[env.SOCIAL_VIDEO_DOWNLOADER || 'yt-dlp', ['--version']],
      [env.SOCIAL_VIDEO_FFMPEG || 'ffmpeg', ['-version']], [env.SOCIAL_VIDEO_FFPROBE || 'ffprobe', ['-version']]]) {
      try { await run(command, args, { timeout: 15000, maxBuffer: 1024 * 1024 }); }
      catch { throw new Error('The media downloader or FFmpeg tools are unavailable. Rebuild the supported image or install the native dependencies.'); }
    }
  }
  if (env.VOICE_TRANSCRIPTION_ENABLED !== 'false') {
    const code = 'import sys; from faster_whisper import WhisperModel; WhisperModel(sys.argv[1], device=sys.argv[2], compute_type=sys.argv[3])';
    try {
      await run(env.WHISPER_PYTHON || 'python3', ['-c', code, env.WHISPER_MODEL || 'base', env.WHISPER_DEVICE || 'cpu', env.WHISPER_COMPUTE_TYPE || (env.WHISPER_DEVICE && env.WHISPER_DEVICE !== 'cpu' ? 'float16' : 'int8')],
        { timeout: 600000, maxBuffer: 2 * 1024 * 1024 });
    } catch { throw new Error('The speech model could not be loaded. Check the Whisper installation, download access and writable model cache; then retry --media-only.'); }
  }
}

export async function checkPortable({ phase = 'all', env = process.env, ai = checkAI, telegram = checkTelegram, media = checkMedia } = {}) {
  if (!['all','ai','telegram','media'].includes(phase)) throw new Error('Unknown installation check phase');
  const result = {};
  if (phase === 'ai' || phase === 'all') result.ai = await ai({ env });
  if (phase === 'media' || phase === 'all') { await media({ env }); result.media = 'model loaded; tools available'; }
  if (phase === 'telegram' || phase === 'all') result.bot = await telegram({ env });
  if (phase === 'all') {
    if (!path.isAbsolute(env.BOT_SETUP_FILE || '')) throw new Error('Configure the absolute BOT_SETUP_FILE path');
    fs.accessSync(path.dirname(env.BOT_SETUP_FILE), fs.constants.R_OK | fs.constants.W_OK);
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const flags = process.argv.slice(2);
  const phases = { '--ai-only': 'ai', '--telegram-only': 'telegram', '--media-only': 'media' };
  if (flags.length > 1 || flags.some(flag => !phases[flag])) {
    console.error('Use --ai-only, --media-only, --telegram-only, or no flag for all checks.');
    process.exitCode = 1;
  } else {
    checkPortable({ phase: phases[flags[0]] || 'all' }).then(result => {
      console.log(result.bot ? `Telegram is ready. Open https://t.me/${result.bot.username} as the configured owner and press Start.` : `${result.ai || 'Media model and tools'} ready. Continue with the next installation step.`);
    }).catch(error => { console.error(error.message); process.exitCode = 1; });
  }
}
