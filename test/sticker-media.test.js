import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { prepareTelegramStickerImage } from "../src/sticker-media.js";

const executable = process.env.STICKER_FFMPEG || "ffmpeg";
const probe = process.env.STICKER_FFPROBE || "ffprobe";
const ffmpegAvailable = spawnSync(executable, ["-version"], { stdio: "ignore" }).status === 0;
const options = buffer => ({ telegram: async () => ({ file_path: "fixture.png" }), fileApi: "https://fixture.invalid",
  fetchFile: async () => new Response(buffer), ffmpeg: executable, ffprobe: probe });

test("oversized advertised images are rejected before downloads", async () => {
  await assert.rejects(prepareTelegramStickerImage({ file_size: 13 * 1024 * 1024 }, { telegram: () => assert.fail("No Telegram request") }), /limit/);
});

test("streaming download cap does not trust missing content-length", async () => {
  await assert.rejects(prepareTelegramStickerImage({ file_id: "fixture" }, options(Buffer.alloc(13 * 1024 * 1024))), /limit/);
});

test("SVG or video masquerading as image/png cannot enter the decoder", async () => {
  await assert.rejects(prepareTelegramStickerImage({ file_id: "fixture" }, options(Buffer.from("<svg>fixture</svg>"))), /Only JPEG/);
});

test("real image conversion preserves aspect ratio and alpha and produces a Telegram-sized WebP", { skip: !ffmpegAvailable }, async () => {
  const rgba = Buffer.alloc(4 * 8 * 4);
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = 200; rgba[i + 1] = 80; rgba[i + 2] = 20;
    const row = Math.floor(i / (4 * 4)); rgba[i + 3] = row < 2 ? 0 : row >= 6 ? 255 : 128;
  }
  const png = spawnSync(executable, ["-v", "error", "-f", "rawvideo", "-pixel_format", "rgba", "-video_size", "4x8", "-i", "pipe:0", "-frames:v", "1", "-f", "image2pipe", "-c:v", "png", "-threads", "1", "pipe:1"], { input: rgba, maxBuffer: 1024 * 1024 });
  assert.equal(png.status, 0, String(png.stderr));
  const result = await prepareTelegramStickerImage({ file_id: "fixture" }, options(png.stdout));
  assert.equal(result.buffer.toString("ascii", 0, 4), "RIFF"); assert.ok(result.buffer.length <= 512 * 1024);
  const decoded = spawnSync(executable, ["-v", "error", "-threads", "1", "-i", "pipe:0", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "-threads", "1", "pipe:1"], { input: result.buffer, maxBuffer: 2 * 1024 * 1024 });
  assert.equal(decoded.status, 0, String(decoded.stderr));
  assert.equal(decoded.stdout.length, 256 * 512 * 4);
  assert.equal(decoded.stdout[3], 0);
  assert.equal(decoded.stdout.at(-1), 255);
  // FFmpeg's scaler may round an intermediate alpha value by one 8-bit step.
  assert.ok(Math.abs(decoded.stdout[(256 * 256) * 4 + 3] - 128) <= 1);
});
