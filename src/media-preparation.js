import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const run = promisify(execFile);
export const telegramUploadBudget = 48 * 1024 * 1024;
export const telegramPhotoBudget = 9 * 1024 * 1024;
const videoTargetBytes = 18 * 1024 * 1024;

export async function prepareMediaForTelegram(files, { maxDurationSeconds = 300, maxUploadBytes = telegramUploadBudget, ffmpeg = "ffmpeg", ffprobe = "ffprobe", execute = run, deadline = Infinity, photoOutputDir } = {}) {
  const boundedOptions = timeout => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw Object.assign(new Error("Media attempt deadline exceeded"), {code:"SOCIAL_DOWNLOAD_TIMEOUT"});
    return {timeout:Math.max(1,Math.min(timeout,remaining)),maxBuffer:1024*1024,env:{PATH:process.env.PATH || "/usr/bin:/bin"}};
  };
  const prepared = [];
  for (const media of files) {
    boundedOptions(15000);
    let item = { ...media };
    // Only the cache supplies bot-scoped, acknowledged Telegram references.
    if (item.telegramFileId) { prepared.push(item); continue; }
    const stat = await fs.stat(item.filePath);
    if (item.mediaKind === "image") {
      const probe = async file => JSON.parse((await execute(ffprobe,
        ["-v", "error", "-protocol_whitelist", "file,pipe", "-err_detect", "explode", "-count_frames", "-show_entries", "stream=codec_name,width,height,nb_read_frames", "-of", "json", file],
        boundedOptions(15000))).stdout).streams?.[0];
      const image = await probe(item.filePath);
      if (!image || !["mjpeg", "png", "webp", "gif", "av1", "hevc"].includes(image.codec_name) ||
          !(image.width > 0 && image.height > 0) || Number(image.nb_read_frames) !== 1) {
        throw Object.assign(new Error("Invalid image media"), { code: "MEDIA_IMAGE_INVALID" });
      }
      const geometryAllowed = image.width + image.height <= 10000 && Math.max(image.width / image.height, image.height / image.width) <= 20;
      if (photoOutputDir || stat.size > telegramPhotoBudget || !geometryAllowed || !["mjpeg", "png"].includes(image.codec_name)) {
        const output = path.join(photoOutputDir || path.dirname(item.filePath), "telegram-photo-" + path.basename(item.filePath, path.extname(item.filePath)) + ".jpg");
        // Pad extreme aspect ratios rather than cropping away source content.
        await execute(ffmpeg, ["-v", "error", "-y", "-threads", "1", "-protocol_whitelist", "file,pipe", "-i", item.filePath,
          "-frames:v", "1", "-vf", "scale=w='min(2560,iw)':h='min(2560,ih)':force_original_aspect_ratio=decrease,pad=w='ceil(max(iw,ih/20)/2)*2':h='ceil(max(ih,iw/20)/2)*2':x=(ow-iw)/2:y=(oh-ih)/2:color=white",
          "-map_metadata", "-1", "-pix_fmt", "yuvj420p", "-flags:v", "+bitexact", "-q:v", "3", "-threads", "1", output], boundedOptions(30000));
        const checked = await probe(output), size = (await fs.stat(output)).size;
        if (!checked || checked.codec_name !== "mjpeg" || Number(checked.nb_read_frames) !== 1 || !(checked.width > 0 && checked.height > 0) ||
            checked.width + checked.height > 10000 || Math.max(checked.width / checked.height, checked.height / checked.width) > 20 || size > telegramPhotoBudget) {
          throw Object.assign(new Error("Image exceeds Telegram photo limits after conversion"), { code: "MEDIA_UPLOAD_SIZE", actualBytes: size });
        }
        item = { ...item, filePath: output, mimeType: "image/jpeg", width: checked.width, height: checked.height, converted: true };
      } else { item.width = image.width; item.height = image.height; item.mimeType = image.codec_name === "png" ? "image/png" : "image/jpeg"; }
    } else if (item.mediaKind === "video") {
      const options = boundedOptions(15000);
      const probeArgs = ["-v", "error", "-protocol_whitelist", "file,pipe", "-show_entries", "format=duration,format_name:stream=codec_type,codec_name,pix_fmt,width,height", "-of", "json"];
      const { stdout } = await execute(ffprobe, [...probeArgs, item.filePath], options);
      const metadata = JSON.parse(stdout), duration = Number(metadata.format?.duration);
      if (!Number.isFinite(duration) || duration <= 0) throw Object.assign(new Error("Video duration unavailable"), { code: "MEDIA_DURATION_UNKNOWN" });
      if (duration > maxDurationSeconds) throw Object.assign(new Error("Video is longer than allowed"), { code: "SOCIAL_VIDEO_DURATION_LIMIT", actualDurationSeconds: duration, maxDurationSeconds });
      item.duration = duration;
      const stream = metadata.streams?.find(s => s.codec_type === "video");
      if (!stream) throw new Error("Media did not contain a video stream");
      item.width = stream.width; item.height = stream.height;
      item.hasAudio = metadata.streams.some(s => s.codec_type === "audio");
      const audio = metadata.streams.find(s => s.codec_type === "audio");
      const compatible = stream.codec_name === "h264" && ["yuv420p", "yuvj420p"].includes(stream.pix_fmt) &&
        (!audio || audio.codec_name === "aac") && String(metadata.format?.format_name || "").split(",").includes("mp4");
      const targetBytes = Math.min(maxUploadBytes, videoTargetBytes);
      const oversized = stat.size > maxUploadBytes;
      if (oversized || !compatible) {
        const output = path.join(path.dirname(item.filePath), "telegram-" + path.basename(item.filePath, path.extname(item.filePath)) + ".mp4");
        // Tiny budgets need proportionally more room for container/keyframe
        // overhead; do not claim success from an estimated bitrate alone.
        const margin = targetBytes < 1024 * 1024 ? 0.70 : 0.88;
        const kbps = Math.floor(targetBytes * 8 * margin / duration / 1000);
        const videoKbps = Math.max(48, kbps - (audio ? 128 : 0));
        await execute(ffmpeg, ["-v", "error", "-y", "-threads", "2", "-protocol_whitelist", "file,pipe", "-i", item.filePath, "-map", "0:v:0", "-map", "0:a:0?",
          "-vf", "scale=w='min(1280,iw)':h='min(1280,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",
          "-c:v", "libx264", "-preset", "veryfast", ...(oversized ? ["-b:v", `${videoKbps}k`] : ["-crf", "23"]), "-maxrate", `${videoKbps}k`, "-bufsize", `${videoKbps * 2}k`,
          "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", "-threads", "2", output],
        boundedOptions(180000));
        const result = await fs.stat(output);
        if (result.size > maxUploadBytes) throw Object.assign(new Error("Compressed file exceeds upload budget"), { code: "MEDIA_UPLOAD_SIZE", actualBytes: result.size });
        const checked = JSON.parse((await execute(ffprobe, [...probeArgs, output], boundedOptions(15000))).stdout);
        const video = checked.streams?.find(s => s.codec_type === "video");
        const convertedAudio = checked.streams?.find(s => s.codec_type === "audio");
        if (!video || video.codec_name !== "h264" || (convertedAudio && convertedAudio.codec_name !== "aac") ||
          !Number.isFinite(Number(checked.format?.duration)) || Math.abs(Number(checked.format.duration) - duration) > 0.25 ||
          Number(checked.format.duration) > maxDurationSeconds + 0.1) throw new Error("Invalid converted media");
        item = { ...item, filePath: output, mimeType: "video/mp4", width: video.width, height: video.height, size: result.size, compressed: oversized, converted: true };
      }
    } else if (stat.size > maxUploadBytes) {
      throw Object.assign(new Error("Media exceeds upload budget"), { code: "MEDIA_UPLOAD_SIZE", actualBytes: stat.size });
    }
    item.size = (await fs.stat(item.filePath)).size;
    prepared.push(item);
  }
  return prepared;
}
