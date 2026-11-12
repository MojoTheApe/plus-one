import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { prepareTelegramStickerImage } from './sticker-media.js';
import { stickerMedia } from './stickers.js';

const execute = promisify(execFile);
const maximumBytes = 20 * 1024 * 1024;
const mediaError = code => Object.assign(new Error(code), { code });
export const setupAnimation = message => message.animation || message.video ||
  (message.document && (/^(?:image\/gif|video\/mp4)$/iu.test(message.document.mime_type ?? '') || /\.(?:gif|mp4)$/iu.test(message.document.file_name ?? '')) ? message.document : null);

// Telegram animation IDs are reusable. Documents/videos are new uploads after
// bounded inspection/conversion, never reused as a different Telegram media type.
export function createSetupMedia({ telegram, telegramMultipart, fileApi, fetchFile = fetch, ffmpeg = 'ffmpeg', ffprobe = 'ffprobe', run = execute }) {
  async function animation(message, ownerId) {
    const media = setupAnimation(message);
    if (!media || !media.file_id) throw mediaError('SETUP_MEDIA_FORMAT');
    if (media.file_size > maximumBytes) throw mediaError('SETUP_MEDIA_SIZE');
    if (media.duration > 60) throw mediaError('SETUP_MEDIA_DURATION');
    if (message.animation) return { fileId: media.file_id, uniqueId: media.file_unique_id };
    const file = await telegram('getFile', { file_id: media.file_id });
    if (!file.file_path || file.file_path.includes('..') || file.file_path.startsWith('/') || file.file_size > maximumBytes) throw mediaError('SETUP_MEDIA_SIZE');
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'setup-animation-'));
    try {
      const response = await fetchFile(`${fileApi}/${file.file_path}`, { signal: AbortSignal.timeout(30000) });
      if (!response.ok || Number(response.headers.get('content-length')) > maximumBytes) throw mediaError('SETUP_MEDIA_DOWNLOAD');
      const reader = response.body.getReader(), chunks = []; let size = 0;
      try {
        while (true) {
          const { value, done } = await reader.read(); if (done) break;
          size += value.length;
          if (size > maximumBytes) { await reader.cancel(); throw mediaError('SETUP_MEDIA_SIZE'); }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      const input = path.join(directory, 'input.media'), output = path.join(directory, 'animation.mp4');
      await fs.writeFile(input, Buffer.concat(chunks), { mode: 0o600 });
      const options = { timeout: 30000, maxBuffer: 1024 * 1024, env: { PATH: process.env.PATH || '/usr/bin:/bin' } };
      const { stdout } = await run(ffprobe, ['-v','error','-protocol_whitelist','file,pipe','-show_entries','format=duration:stream=codec_type,width,height,duration','-of','json',input], options);
      const metadata = JSON.parse(stdout), video = metadata.streams?.find(stream => stream.codec_type === 'video');
      const duration = Number(metadata.format?.duration ?? video?.duration);
      if (!video || !Number.isFinite(duration) || duration <= 0 || !Number.isSafeInteger(video.width) || !Number.isSafeInteger(video.height) || video.width <= 0 || video.height <= 0 || video.width * video.height > 40000000) throw mediaError('SETUP_MEDIA_FORMAT');
      if (duration > 60) throw mediaError('SETUP_MEDIA_DURATION');
      await run(ffmpeg, ['-v','error','-y','-protocol_whitelist','file,pipe','-i',input,'-map','0:v:0','-an','-t','60',
        '-vf','scale=720:720:force_original_aspect_ratio=decrease:force_divisible_by=2','-c:v','libx264','-pix_fmt','yuv420p','-preset','veryfast','-crf','26','-threads','1','-movflags','+faststart',output], options);
      const buffer = await fs.readFile(output);
      if (!buffer.length || buffer.length > maximumBytes) throw mediaError('SETUP_MEDIA_SIZE');
      const form = new FormData(); form.set('chat_id', String(ownerId));
      form.set('animation', new Blob([buffer], { type: 'video/mp4' }), 'animation.mp4');
      const sent = await telegramMultipart('sendAnimation', form);
      if (!sent?.animation?.file_id) throw mediaError('SETUP_MEDIA_UPLOAD');
      return { fileId: sent.animation.file_id, uniqueId: sent.animation.file_unique_id, previewMessageId: sent.message_id };
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
  }

  async function sticker(message, ownerId) {
    const media = stickerMedia(message);
    if (!media || media.is_animated || media.is_video) throw mediaError('SETUP_STICKER_FORMAT');
    const { buffer } = await prepareTelegramStickerImage(media, { telegram, fileApi, fetchFile, ffmpeg, ffprobe });
    const preview = new FormData(); preview.set('chat_id', String(ownerId));
    preview.set('sticker', new Blob([buffer], { type: 'image/webp' }), 'sticker.webp');
    const sent = await telegramMultipart('sendSticker', preview);
    const form = new FormData(); form.set('user_id', String(ownerId)); form.set('sticker_format','static');
    form.set('sticker', new Blob([buffer], { type: 'image/webp' }), 'sticker.webp');
    const file = await telegramMultipart('uploadStickerFile', form);
    if (!file?.file_id || !sent?.sticker?.file_unique_id) throw mediaError('SETUP_STICKER_UPLOAD');
    return { fileId: file.file_id, uniqueId: sent.sticker.file_unique_id };
  }
  return { animation, sticker };
}
