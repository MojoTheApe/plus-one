import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const maxBytes = 12 * 1024 * 1024;

export async function prepareTelegramStickerImage(media, { telegram, fileApi, fetchFile = fetch, ffmpeg = "ffmpeg", ffprobe = "ffprobe" }) {
  if (media.file_size > maxBytes) throw new Error("Sticker image exceeds download limit");
  const file = await telegram("getFile", { file_id: media.file_id });
  if (!file.file_path || file.file_size > maxBytes) throw new Error("Invalid or oversized Telegram image");
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "telegram-sticker-"));
  try {
    const response = await fetchFile(`${fileApi}/${file.file_path}`, { signal: AbortSignal.timeout(30000) });
    if (!response.ok || Number(response.headers.get("content-length") || 0) > maxBytes) throw new Error("Sticker image download failed");
    const reader = response.body.getReader();
    const chunks = []; let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        size += value.length;
        if (size > maxBytes) { await reader.cancel(); throw new Error("Sticker image exceeds download limit"); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const buffer = Buffer.concat(chunks);
    const png = buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const jpeg = buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255;
    const webp = buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP";
    if (!png && !jpeg && !webp) throw new Error("Only JPEG, PNG and WebP images are supported");
    const input = path.join(temp, "input.image"), output = path.join(temp, "sticker.webp");
    await fs.writeFile(input, buffer);
    const options = { timeout: 30000, maxBuffer: 1024 * 1024, env: { PATH: process.env.PATH || "/usr/bin:/bin" } };
    const { stdout } = await run(ffprobe, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "json", input], options);
    const { width, height } = JSON.parse(stdout).streams?.[0] || {};
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0 || width * height > 40000000) throw new Error("Invalid or oversized image dimensions");
    for (const quality of ["lossless", "90", "75"]) {
      await run(ffmpeg, ["-v", "error", "-y", "-threads", "1", "-i", input, "-frames:v", "1", "-an",
        "-vf", "scale=512:512:force_original_aspect_ratio=decrease", "-c:v", "libwebp", "-pix_fmt", "bgra", "-threads", "1",
        ...(quality === "lossless" ? ["-lossless", "1"] : ["-quality", quality]), output], options);
      const result = await fs.readFile(output);
      if (result.length <= 512 * 1024) return { buffer: result };
    }
    throw new Error("Image cannot fit Telegram sticker limits");
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
}
