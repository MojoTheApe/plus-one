import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

// This module only reads a local file. Telegram/URL resolution stays in the
// transport, so requesting analysis cannot silently download an unrelated item.
export async function prepareMediaEvidence(filePath, {
  directory, kind, ffmpeg = "ffmpeg", ffprobe = "ffprobe", maxDurationSeconds = 300,
  maxFrames = 6, maxImageDimension = 1280, maxTranscriptChars = 16000,
  transcribe, execute = run, now = Date.now, maxProcessingMs = 180000,
  transcriptionTimeoutMs = 120000,
} = {}) {
  if (!path.isAbsolute(filePath)) throw evidenceError("MEDIA_SOURCE", "Media evidence requires an absolute local path");
  const source = await fs.stat(filePath);
  if (!source.isFile()) throw evidenceError("MEDIA_SOURCE", "Media evidence source is not a regular file");
  const deadline = now() + bounded(maxProcessingMs, 1000, 180000, 180000);
  const processOptions = timeout => ({ timeout: Math.max(1, Math.min(timeout, deadline - now())), killSignal: "SIGKILL",
    maxBuffer: 1024 * 1024, env: { PATH: process.env.PATH || "/usr/bin:/bin" } });
  const executeBounded = async (command, args, timeout) => {
    if (now() >= deadline) throw evidenceError("MEDIA_EVIDENCE_TIMEOUT", "Media evidence preparation timed out");
    return execute(command, args, processOptions(timeout));
  };
  const { stdout } = await executeBounded(ffprobe, ["-v", "error", "-protocol_whitelist", "file,pipe",
    "-show_entries", "format=duration:stream=codec_type,duration", "-of", "json", filePath], 15000);
  let metadata;
  try { metadata = JSON.parse(stdout); } catch { throw evidenceError("MEDIA_METADATA", "Media metadata could not be decoded"); }
  const streams = Array.isArray(metadata.streams) ? metadata.streams : [];
  const hasVideo = streams.some(stream => stream.codec_type === "video");
  const hasAudio = streams.some(stream => stream.codec_type === "audio");
  const duration = Number(metadata.format?.duration) || Math.max(0, ...streams.map(stream => Number(stream.duration) || 0));
  if (!Number.isFinite(duration) || duration <= 0) throw evidenceError("MEDIA_DURATION_UNKNOWN", "Media duration unavailable");
  const durationLimit = bounded(maxDurationSeconds, 1, 300, 300);
  if (duration > durationLimit) throw evidenceError("SOCIAL_VIDEO_DURATION_LIMIT", "Media is longer than allowed",
    { actualDurationSeconds: duration, maxDurationSeconds: durationLimit });
  if (!hasVideo && !hasAudio) throw evidenceError("MEDIA_STREAM", "Media did not contain a video or audio stream");
  if (kind === "video" && !hasVideo || ["audio", "voice"].includes(kind) && !hasAudio) {
    throw evidenceError("MEDIA_STREAM", "Requested media stream is missing");
  }
  const parent = directory || path.dirname(filePath);
  await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  const outputDirectory = await fs.mkdtemp(path.join(parent, "evidence-"));
  const images = [], limitations = [];
  try {
    if (hasVideo && !["audio", "voice"].includes(kind)) {
      const count = Math.min(bounded(maxFrames, 1, 6, 6), Math.max(1, Math.ceil(duration / 10)));
      const dimension = bounded(maxImageDimension, 128, 1280, 1280);
      for (let index = 0; index < count; index++) {
        const frame = path.join(outputDirectory, `frame-${index + 1}.jpg`);
        await executeBounded(ffmpeg, ["-v", "error", "-y", "-protocol_whitelist", "file,pipe", "-ss",
          String(Number(((index + 0.5) * duration / count).toFixed(3))), "-i", filePath,
          "-map", "0:v:0", "-frames:v", "1", "-vf", `scale=w='min(${dimension},iw)':h='min(${dimension},ih)':force_original_aspect_ratio=decrease`,
          "-q:v", "3", "-threads", "1", frame], 20000);
        if ((await fs.stat(frame)).size === 0) throw evidenceError("MEDIA_FRAME", "Video frame extraction returned an empty image");
        await fs.chmod(frame, 0o600);
        images.push(frame);
      }
    }
    let transcript = "", audio = { status: "absent", hasAudio: false };
    if (hasAudio) {
      audio = { status: "unavailable", hasAudio: true };
      if (typeof transcribe !== "function") {
        limitations.push("Аудіодоріжка є, але розпізнавання мовлення недоступне; її зміст не перевірено.");
      } else {
        try {
          const audioPath = path.join(outputDirectory, "audio.wav");
          await executeBounded(ffmpeg, ["-v", "error", "-y", "-protocol_whitelist", "file,pipe", "-i", filePath,
            "-map", "0:a:0", "-vn", "-t", String(durationLimit), "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", audioPath], 45000);
          if ((await fs.stat(audioPath)).size <= 44) throw evidenceError("MEDIA_AUDIO", "Audio extraction returned no samples");
          await fs.chmod(audioPath, 0o600);
          const remaining = Math.min(bounded(transcriptionTimeoutMs, 1, 120000, 120000), deadline - now());
          if (remaining <= 0) throw evidenceError("MEDIA_EVIDENCE_TIMEOUT", "Audio transcription timed out");
          const value = await transcribeWithDeadline(transcribe, audioPath, remaining);
          const text = typeof value === "string" ? value : value?.text ?? value?.transcript;
          if (typeof text !== "string") throw evidenceError("MEDIA_TRANSCRIPTION", "Audio transcription returned no valid result");
          const limit = bounded(maxTranscriptChars, 1, 24000, 16000);
          transcript = text.trim().slice(0, limit);
          audio.status = transcript ? "transcribed" : "no_text";
          if (text.trim().length > limit) limitations.push("Розшифровку скорочено до робочого ліміту.");
          if (!transcript) limitations.push("Розпізнавання не повернуло тексту; це не доводить відсутності звуку або мовлення.");
        } catch (error) {
          audio = { ...audio, errorCode: error.code || (error.killed ? "MEDIA_EVIDENCE_TIMEOUT" : "MEDIA_TRANSCRIPTION") };
          limitations.push("Аудіодоріжка є, але її не вдалося розпізнати; зміст звуку невідомий.");
        }
      }
    } else {
      limitations.push("У файлі немає аудіодоріжки.");
    }
    const visualSummary = images.length ? `Доступно ${images.length} вибіркових кадрів відео; це не повний покадровий перегляд.` : "Візуальних кадрів немає.";
    const audioSummary = transcript ? "Доступна розшифровка аудіодоріжки; це текст розпізнавання, а не перевірка всіх звуків." : "";
    return { images, transcript, audio, durationSeconds: duration, directory: outputDirectory,
      evidenceSummary: [`Тривалість файлу: ${duration.toFixed(1)} с.`, visualSummary, audioSummary, ...limitations].filter(Boolean).join(" ") };
  } catch (error) {
    await fs.rm(outputDirectory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

function evidenceError(code, message, details = {}) { return Object.assign(new Error(message), { code, ...details }); }
function bounded(value, min, max, fallback) { return Number.isFinite(Number(value)) ? Math.max(min, Math.min(max, Math.floor(Number(value)))) : fallback; }
async function transcribeWithDeadline(transcribe, filePath, timeoutMs) {
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(() => transcribe(filePath, { signal: controller.signal, timeoutMs })),
      new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(evidenceError("MEDIA_EVIDENCE_TIMEOUT", "Audio transcription timed out")); }, timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}
