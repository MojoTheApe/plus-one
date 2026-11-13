import path from "node:path";
import { decodeHtmlEntities, escapeRegex } from "./helpers.js";

export function formatSocialVideoCaption(url, title) {
  let host = "video";
  try {
    host = new URL(url).hostname.replace(/^www\./, "");
  } catch {}
  const cleanedTitle = String(title || "").replace(/\s+/g, " ").trim();
  return cleanedTitle ? `${cleanedTitle}\n${host}` : `Video from ${host}`;
}

export function formatSocialVideoError(error, options = {}) {
  const cleanErrorMessage = options.cleanErrorMessage || ((value) => String(value?.message || value || ""));
  const maxDurationSeconds = Number(options.maxDurationSeconds) || 0;
  const message = cleanErrorMessage(error);
  if (error?.code === "SOCIAL_VIDEO_PROVIDER_COOLDOWN" || /cooling down/i.test(message)) {
    return "Зараз цей сервіс для завантаження медіа тимчасово недоступний. Я спробую знову пізніше.";
  }
  if (/AbortError|aborted|timeout|timed out/i.test(message)) {
    return "Сервіс відповідав занадто довго, тому я зупинив спробу завантаження.";
  }
  if (/longer than/i.test(message)) {
    return `Це відео довше за дозволений ліміт ${Math.floor(maxDurationSeconds / 60)} хв, тому я не можу його надіслати.`;
  }
  if (/max-filesize|exceeds|larger than|File is larger/i.test(message)) {
    return "Цей файл завеликий для поточного ліміту Telegram.";
  }
  if (/private|login|sign in|cookies|not available|empty media response|unavailable/i.test(message)) {
    return "Я можу завантажувати лише публічні медіа, які не потребують входу в акаунт.";
  }
  if (/ENOENT|not found/i.test(message)) {
    return "На сервері зараз недоступний інструмент для завантаження відео.";
  }
  if (/ffprobe|media validator/i.test(message)) {
    return "На сервері зараз недоступна перевірка медіафайлів.";
  }
  if (/did not contain an? video stream|remote media type is not supported|returned HTML/i.test(message)) {
    return "Я знайшов медіа, але не зміг перетворити його у файл для Telegram.";
  }
  return "Не вдалося завантажити це медіа як файл.";
}

export function socialVideoDurationLimitError(maxDurationSeconds, actualDurationSeconds) {
  const error = new Error(`video is longer than ${maxDurationSeconds} seconds`);
  error.code = "SOCIAL_VIDEO_DURATION_LIMIT";
  error.maxDurationSeconds = maxDurationSeconds;
  if (Number.isFinite(actualDurationSeconds)) error.actualDurationSeconds = actualDurationSeconds;
  return error;
}

export function isSocialVideoDurationLimitError(error, cleanErrorMessage = (value) => String(value?.message || value || "")) {
  return error?.code === "SOCIAL_VIDEO_DURATION_LIMIT" || /longer than/i.test(cleanErrorMessage(error));
}

export function shouldReportSocialVideoFailure(error, cleanErrorMessage = (value) => String(value?.message || value || "")) {
  const code = String(error?.code || "").toUpperCase();
  if (["SOCIAL_VIDEO_DURATION_LIMIT", "SOCIAL_VIDEO_PROVIDER_COOLDOWN"].includes(code)) return false;

  const message = cleanErrorMessage(error);
  return !(
    /private|login|sign in|cookies|deleted|age[- ]gated|age restriction|geo[- ]blocked|drm/i.test(message) ||
    /requested content is not available|content is unavailable|post (?:is )?not found/i.test(message) ||
    /rate[- ]?limit|too many requests|\b429\b/i.test(message) ||
    /max-filesize|exceeds|larger than|file is larger/i.test(message) ||
    /fetch failed: (?:401|403|404|410|429)\b/i.test(message)
  );
}

export function socialVideoOpsComponent(provider) {
  const normalized = String(provider || "unknown").toLowerCase();
  return `social-media-${["instagram", "threads", "tiktok"].includes(normalized) ? normalized : "unknown"}`;
}

export function isTikTokSocialVideoUrl(url) {
  return socialVideoHost(url, (host) => host === "tiktok.com" || host.endsWith(".tiktok.com"));
}

export function isInstagramSocialVideoUrl(url) {
  return socialVideoHost(url, (host) => host === "instagram.com" || host.endsWith(".instagram.com"));
}

export function isThreadsSocialVideoUrl(url) {
  return socialVideoHost(
    url,
    (host) => host === "threads.com" || host.endsWith(".threads.com") || host === "threads.net" || host.endsWith(".threads.net"),
  );
}

export async function selectSocialMediaFiles(files, maxItems, sourceUrl = "") {
  if (isThreadsSocialVideoUrl(sourceUrl)) {
    return uniqueMediaFiles(files).slice(0, maxItems);
  }

  const videos = files.filter((file) => file.mediaKind === "video");
  const videosWithAudio = videos.filter((file) => file.hasAudio);
  if (videosWithAudio.length) {
    const sortedVideos = uniqueMediaFiles(videosWithAudio).sort(mediaComparatorForSource(sourceUrl));
    return [sortedVideos[0]];
  }

  if (isInstagramReelRequest(sourceUrl)) {
    if (videos.length) return [uniqueMediaFiles(videos).sort(compareInstagramReelMediaQuality)[0]];
    return [];
  }

  const images = uniqueMediaFiles(files.filter((file) => file.mediaKind === "image"));
  if (images.length) {
    if (isInstagramCarouselRequest(sourceUrl)) return images.slice(0, maxItems);
    const sortedImages = images.sort(compareMediaQuality);
    if (!isThreadsSocialVideoUrl(sourceUrl) && sortedImages.length <= 2) return [sortedImages[0]];
    return sortedImages.slice(0, maxItems);
  }

  if (videos.length) {
    const sortedVideos = uniqueMediaFiles(videos).sort(mediaComparatorForSource(sourceUrl));
    return [sortedVideos[0]];
  }
  return [];
}

export function uniqueMediaFiles(files) {
  const seen = new Set();
  const unique = [];
  for (const file of files) {
    const key = file.hash || `${file.mimeType}:${file.size}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(file);
  }
  return unique;
}

export function compareMediaQuality(a, b) {
  return (b.size || 0) - (a.size || 0);
}

export function mediaComparatorForSource(sourceUrl) {
  return isVerticalSocialVideoRequest(sourceUrl) ? compareVerticalMediaQuality : compareMediaQuality;
}

export function compareInstagramReelMediaQuality(a, b) {
  return compareVerticalMediaQuality(a, b);
}

export function compareVerticalMediaQuality(a, b) {
  const aspectDiff = verticalAspectScore(b) - verticalAspectScore(a);
  if (aspectDiff !== 0) return aspectDiff;
  const heightDiff = (b.height || 0) - (a.height || 0);
  if (heightDiff !== 0) return heightDiff;
  return compareMediaQuality(a, b);
}

export function instagramReelAspectScore(file) {
  return verticalAspectScore(file);
}

export function verticalAspectScore(file) {
  const width = Number(file.width);
  const height = Number(file.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return 0;
  const ratio = height / width;
  if (ratio >= 1.65) return 3;
  if (ratio >= 1.25) return 2;
  if (ratio > 1.02) return 1;
  return 0;
}

export function isInstagramCarouselRequest(value) {
  try {
    const url = new URL(value);
    return isInstagramSocialVideoUrl(value) && /\/p\//i.test(url.pathname);
  } catch {
    return false;
  }
}

export function isInstagramReelRequest(value) {
  try {
    const url = new URL(value);
    return isInstagramSocialVideoUrl(value) && /\/reels?\//i.test(url.pathname);
  } catch {
    return false;
  }
}

export function isVerticalSocialVideoRequest(value) {
  return isInstagramReelRequest(value) || isTikTokSocialVideoUrl(value);
}

function socialVideoHost(value, predicate) {
  try {
    const host = new URL(value).hostname.toLowerCase().replace(/^www\./, "").replace(/^m\./, "");
    return predicate(host);
  } catch {
    return false;
  }
}

export function normalizeSocialMediaUrl(value) {
  try {
    return new URL(
      String(value || "")
        .replaceAll("\\/", "/")
        .replaceAll("\\u0026", "&")
        .replaceAll("\\u00253D", "%3D")
        .replaceAll("&amp;", "&")
        .replaceAll("&#064;", "@")
        .replace(/\\+$/g, "")
        .trim(),
    ).toString();
  } catch {
    return "";
  }
}

export function isLikelyMediaDownloadUrl(value) {
  try {
    const url = new URL(value);
    return (
      /d\.rapidcdn\.app$/i.test(url.hostname) ||
      /\.(mp4|webm|mov|m4v|jpg|jpeg|png|webp)(?:[?#]|$)/i.test(url.pathname) ||
      url.searchParams.get("dl") === "1"
    );
  } catch {
    return /\.(mp4|webm|mov|m4v|jpg|jpeg|png|webp)(?:[?#]|$)/i.test(String(value || ""));
  }
}

export function uniqueStrings(values) {
  return [...new Set(values.filter(Boolean))];
}

export function extractHtmlMetaContent(html, propertyName) {
  const escaped = escapeRegex(propertyName);
  const patterns = [
    new RegExp(`<meta[^>]+property=["']${escaped}["'][^>]+content=["']([^"']+)["']`, "i"),
    new RegExp(`<meta[^>]+name=["']${escaped}["'][^>]+content=["']([^"']+)["']`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${escaped}["']`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+name=["']${escaped}["']`, "i"),
  ];
  for (const pattern of patterns) {
    const match = String(html || "").match(pattern);
    if (match?.[1]) return decodeHtmlEntities(match[1]);
  }
  return "";
}

export function extractSnapinstaMediaUrls(html) {
  const candidates = [];
  const push = (value) => {
    const normalized = normalizeSocialMediaUrl(value);
    if (normalized) candidates.push(normalized);
  };

  for (const match of String(html || "").matchAll(/\bhref=\\?["']([^"']+)\\?["']/gi)) push(match[1]);
  for (const match of String(html || "").matchAll(/https?:\\?\/\\?\/[^"'<>\s)]+/gi)) push(match[0]);

  const decoded = [];
  for (const candidate of candidates) {
    if (/d\.rapidcdn\.app/i.test(candidate)) decoded.push(candidate);
    decoded.push(...extractUrlsFromSnapinstaToken(candidate));
  }

  return uniqueStrings([...decoded, ...candidates]).filter(isLikelyMediaDownloadUrl);
}

export function extractThreadsPostFromHtml(html, sourceUrl = "") {
  const metaUrl = extractHtmlMetaContent(html, "og:url");
  // Some share pages keep the short URL but expose the target in public metadata.
  // Never substitute a different post when the requested permalink is known.
  const resolvedUrl = !threadsShortcodeFromUrl(sourceUrl) && isThreadsSocialVideoUrl(metaUrl) && threadsShortcodeFromUrl(metaUrl) ? metaUrl : sourceUrl;
  const targetPost = extractTargetThreadsPost(html, resolvedUrl);
  if (targetPost) {
    return {
      mediaUrls: extractThreadsPostMediaUrls(targetPost),
      caption: extractThreadsPostCaption(targetPost),
    };
  }

  if (metaUrl && threadsShortcodeFromUrl(resolvedUrl) &&
      (threadsShortcodeFromUrl(metaUrl) !== threadsShortcodeFromUrl(resolvedUrl) ||
       (threadsHandleFromUrl(metaUrl) && threadsHandleFromUrl(resolvedUrl) && threadsHandleFromUrl(metaUrl).toLowerCase() !== threadsHandleFromUrl(resolvedUrl).toLowerCase()))) {
    return { mediaUrls: [], caption: "" };
  }

  const metaVideoUrl = extractHtmlMetaContent(html, "og:video") || extractHtmlMetaContent(html, "og:video:url") || extractHtmlMetaContent(html, "twitter:player:stream");
  if (metaVideoUrl && threadsShortcodeFromUrl(resolvedUrl) &&
      (!metaUrl || threadsShortcodeFromUrl(metaUrl) === threadsShortcodeFromUrl(resolvedUrl))) {
    const normalized = normalizeSocialMediaUrl(metaVideoUrl);
    if (normalized && isLikelyThreadsPostMediaUrl(normalized)) return { mediaUrls: [normalized],
      caption: extractHtmlMetaContent(html, "og:description") || extractHtmlMetaContent(html, "description") };
  }
  const metaImageUrl = extractHtmlMetaContent(html, "og:image") || extractHtmlMetaContent(html, "twitter:image");
  if (metaImageUrl) {
    const normalized = normalizeSocialMediaUrl(metaImageUrl);
    if (normalized && isLikelyThreadsPostMediaUrl(normalized)) {
      return {
        mediaUrls: [normalized],
        caption: extractHtmlMetaContent(html, "og:description") || extractHtmlMetaContent(html, "description"),
      };
    }
  }

  return { mediaUrls: [], caption: "" };
}

export function extractTargetThreadsPost(html, sourceUrl) {
  const shortcode = threadsShortcodeFromUrl(sourceUrl);
  if (!shortcode) return null;

  const handle = threadsHandleFromUrl(sourceUrl);
  const posts = [];
  for (const match of String(html || "").matchAll(/<script[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    const jsonText = match[1];
    if (!jsonText.includes(shortcode)) continue;
    try {
      collectThreadsPostsByCode(JSON.parse(jsonText), shortcode, posts);
    } catch {}
  }

  const matchingPosts = posts.filter((post) => {
    if (!handle) return true;
    return String(post?.user?.username || "").toLowerCase() === handle.toLowerCase();
  });
  return matchingPosts[0] || null;
}

export function collectThreadsPostsByCode(value, shortcode, posts, depth = 0) {
  if (!value || typeof value !== "object" || depth > 40) return;
  if (!Array.isArray(value) && value.code === shortcode && (value.video_versions || value.image_versions2 || value.carousel_media)) {
    posts.push(value);
  }

  if (Array.isArray(value)) {
    for (const item of value) collectThreadsPostsByCode(item, shortcode, posts, depth + 1);
    return;
  }
  for (const key of Object.keys(value)) collectThreadsPostsByCode(value[key], shortcode, posts, depth + 1);
}

export function extractThreadsPostMediaUrls(post) {
  const mediaItems = Array.isArray(post.carousel_media) && post.carousel_media.length ? post.carousel_media : [post];
  const mediaUrls = [];
  for (const item of mediaItems) {
    const videoUrl = bestThreadsVideoUrl(item);
    if (videoUrl) {
      mediaUrls.push(videoUrl);
      continue;
    }
    const imageUrl = bestThreadsImageUrl(item);
    if (imageUrl) mediaUrls.push(imageUrl);
  }
  return uniqueStrings(mediaUrls.map(normalizeSocialMediaUrl).filter(Boolean)).filter(isLikelyThreadsPostMediaUrl);
}

export function extractThreadsPostCaption(post) {
  const candidates = [
    post?.caption?.text,
    post?.caption,
    post?.text_post_app_info?.share_info?.quoted_post?.caption?.text,
    post?.text_post_app_info?.text_fragments?.fragments?.map((fragment) => fragment?.plaintext).filter(Boolean).join(""),
    post?.accessibility_caption,
  ];

  for (const candidate of candidates) {
    const caption = String(candidate || "").replace(/\s+/g, " ").trim();
    if (caption && caption !== "[object Object]") return caption;
  }
  return "";
}

export function bestThreadsVideoUrl(item) {
  const versions = Array.isArray(item?.video_versions) ? item.video_versions : [];
  const sorted = versions.filter((version) => version?.url).sort((a, b) => mediaCandidateScore(b) - mediaCandidateScore(a));
  return sorted[0]?.url || "";
}

export function bestThreadsImageUrl(item) {
  const candidates = Array.isArray(item?.image_versions2?.candidates) ? item.image_versions2.candidates : [];
  const sorted = candidates.filter((candidate) => candidate?.url).sort((a, b) => mediaCandidateScore(b) - mediaCandidateScore(a));
  return sorted[0]?.url || "";
}

export function mediaCandidateScore(candidate) {
  const width = Number(candidate?.width) || 0;
  const height = Number(candidate?.height) || 0;
  const area = width * height;
  const typeScore = Number(candidate?.type) === 101 ? 1000000000 : 0;
  return typeScore + area;
}

export function threadsShortcodeFromUrl(value) {
  try {
    return new URL(value).pathname.match(/\/post\/([^/?#]+)/i)?.[1] || "";
  } catch {
    return "";
  }
}

export function threadsHandleFromUrl(value) {
  try {
    const match = new URL(value).pathname.match(/^\/@([^/]+)\/post\//i);
    return match ? decodeURIComponent(match[1]).replace(/^@/, "") : "";
  } catch {
    return "";
  }
}

export function extractUrlsFromSnapinstaToken(value) {
  const token = new URL(value).searchParams.get("token");
  if (!token) return [];

  const urls = [];
  for (const part of token.split(".")) {
    try {
      const json = JSON.parse(Buffer.from(padBase64Url(part), "base64").toString("utf8"));
      if (json?.url && isLikelyMediaDownloadUrl(json.filename || json.url)) urls.push(json.url);
    } catch {}
  }
  return urls;
}

export function padBase64Url(value) {
  let normalized = String(value).replace(/-/g, "+").replace(/_/g, "/");
  while (normalized.length % 4) normalized += "=";
  return normalized;
}

export function isLikelyThreadsPostMediaUrl(value) {
  try {
    const url = new URL(value);
    if (!/scontent-[^/]+\.cdninstagram\.com$/i.test(url.hostname) && !/(?:^|\.)fbcdn\.net$/i.test(url.hostname)) return false;
    if (/\/t51\.(?:2885|82787)-19\//i.test(url.pathname)) return false;
    if (/profile_pic|s150x150|s640x640/i.test(value)) return false;
    return /\.(mp4|webm|mov|m4v|jpg|jpeg|png|webp)(?:[?#]|$)/i.test(url.pathname) || /\/o1\/v\/t16\//i.test(url.pathname);
  } catch {
    return false;
  }
}

export function bestMediaUrlPerIdentity(values) {
  const byIdentity = new Map();
  for (const value of uniqueStrings(values)) {
    const identity = mediaUrlIdentity(value);
    const current = byIdentity.get(identity);
    if (!current || mediaUrlQualityScore(value) > mediaUrlQualityScore(current)) byIdentity.set(identity, value);
  }
  return [...byIdentity.values()];
}

export function mediaUrlIdentity(value) {
  try {
    const url = new URL(value);
    const cacheKey = url.searchParams.get("ig_cache_key");
    if (cacheKey) return cacheKey.replace(/%3D/gi, "=");
    const filename = path.basename(url.pathname).replace(/\.(?:jpg|jpeg|png|webp|mp4|mov|m4v)$/i, "");
    return filename || url.pathname;
  } catch {
    return value;
  }
}

export function mediaUrlQualityScore(value) {
  let score = 0;
  try {
    const url = new URL(value);
    const stp = url.searchParams.get("stp") || "";
    for (const match of stp.matchAll(/(?:p|s)(\d{3,4})x/gi)) score = Math.max(score, Number(match[1]));
    if (!stp) score += 2000;
    if (/\.(mp4|mov|m4v)(?:[?#]|$)/i.test(url.pathname)) score += 5000;
  } catch {}
  return score;
}

export function inferRemoteMediaKind(url, contentType) {
  if (contentType.startsWith("image/")) return "image";
  if (contentType.startsWith("video/")) return "video";
  const extension = extensionFromUrl(url);
  if (/^(jpg|jpeg|png|webp)$/i.test(extension)) return "image";
  if (/^(mp4|webm|mov|m4v)$/i.test(extension)) return "video";
  if (!contentType || contentType === "application/octet-stream" || contentType === "binary/octet-stream") {
    const parsedUrl = new URL(url);
    if (/d\.rapidcdn\.app/i.test(parsedUrl.hostname)) return "video";
    if (/scontent-[^/]+\.cdninstagram\.com$/i.test(parsedUrl.hostname) && /\/o1\/v\/t16\//i.test(parsedUrl.pathname)) return "video";
  }
  return "";
}

export function normalizeMediaMimeType(contentType, mediaKind) {
  const mimeType = String(contentType || "").split(";")[0].trim().toLowerCase();
  if (mimeType.startsWith("image/") || mimeType.startsWith("video/")) return mimeType;
  return mediaKind === "image" ? "image/jpeg" : "video/mp4";
}

export function mediaExtensionForMimeType(mimeType) {
  switch (String(mimeType || "").toLowerCase()) {
    case "image/jpeg":
    case "image/jpg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    case "video/webm":
      return "webm";
    case "video/quicktime":
      return "mov";
    case "video/x-m4v":
      return "m4v";
    case "video/mp4":
      return "mp4";
    default:
      return "";
  }
}

export function extensionFromUrl(value) {
  try {
    return path.extname(new URL(value).pathname).replace(/^\./, "").toLowerCase();
  } catch {
    const match = String(value || "").match(/\.([a-z0-9]{2,5})(?:[?#]|$)/i);
    return match ? match[1].toLowerCase() : "";
  }
}
