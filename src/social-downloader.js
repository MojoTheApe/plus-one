import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { mediaReference, nativeExtractorSource, verifiedMediaSource, sourceIdentityError } from "./media-source.js";
import {
  isCircuitBreakerOpen,
  recordCircuitBreakerFailure,
  recordCircuitBreakerSuccess,
} from "./helpers.js";
import {
  extensionFromUrl,
  extractHtmlMetaContent,
  extractTargetThreadsPost,
  extractThreadsPostFromHtml,
  inferRemoteMediaKind,
  isThreadsSocialVideoUrl,
  mediaExtensionForMimeType,
  normalizeMediaMimeType,
  uniqueStrings,
} from "./social-video.js";

export function createSocialDownloader(deps) {
  return {
    download: (url, options) => downloadWithinDeadline(url, deps, options),
    downloadInstagram: (url, tempDir) => downloadInstagramWithSnapinsta(url, tempDir, deps),
    downloadTikTok: (url, tempDir, titleHint = "") => downloadTikTokWithFallbackApi(url, tempDir, titleHint, deps),
    downloadThreads: (url, tempDir) => downloadThreadsFromPage(url, tempDir, deps),
    downloadWithYtDlp: (url, tempDir) => downloadSocialVideoWithYtDlp(url, tempDir, deps),
    downloadRemoteBinaryFile: (url, filePath, options = {}) => downloadRemoteBinaryFile(url, filePath, options, deps),
    downloadRemoteMediaFile: (url, tempDir, baseName, referer = deps.defaultReferer, forcedMediaKind = "") =>
      downloadRemoteMediaFile(url, tempDir, baseName, referer, forcedMediaKind, deps),
    fetchWithTimeout: (url, options = {}, timeoutMs = deps.httpTimeoutMs) => fetchWithTimeout(url, options, timeoutMs, deps.fetch),
    inspect: (url) => inspectSocialVideo(url, deps),
    runFallback: (provider, operation) => runSocialVideoFallback(provider, operation, deps),
  };
}

async function downloadWithinDeadline(url, deps, options = {}) {
  const controller = new AbortController();
  const budgetMs = Math.max(1, Math.min(deps.totalTimeoutMs || 90000, (options.deadline || Infinity) - Date.now()));
  const deadline = Date.now() + budgetMs;
  const timer = setTimeout(() => controller.abort(), budgetMs);
  const scoped = { ...deps, signal: controller.signal,
    fetch: (input, options = {}) => deps.fetch(input, { ...options,
      signal: options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal }),
    execFileAsync: (file, args, options = {}) => deps.execFileAsync(file, args, { ...options,
      signal: controller.signal, timeout: Math.max(1, Math.min(options.timeout || budgetMs, deadline - Date.now())) }),
  };
  scoped.validateDownloadedVideo = (file, options = {}) => deps.validateDownloadedVideo(file, {...options,deadline,signal:controller.signal});
  scoped.downloadThreads = (input, dir) => downloadThreadsFromPage(input, dir, scoped);
  scoped.downloadInstagram = (input, dir) => downloadInstagramWithSnapinsta(input, dir, scoped);
  scoped.downloadTikTok = (input, dir) => downloadTikTokWithFallbackApi(input, dir, "", scoped);
  try {
    const result = await downloadSocialVideo(url, scoped);
    if (controller.signal.aborted) {
      if (result.tempDir) await deps.fs.promises.rm(result.tempDir,{recursive:true,force:true});
      throw Object.assign(new Error("Download deadline exceeded"),{code:"SOCIAL_DOWNLOAD_TIMEOUT"});
    }
    return result;
  }
  catch (error) {
    if (controller.signal.aborted) error.code = "SOCIAL_DOWNLOAD_TIMEOUT";
    throw error;
  } finally { clearTimeout(timer); }
}

// Keep the actual failures together. A fallback saying "no media" must not erase
// an access restriction reported by the primary downloader.
export function socialDownloadFailure(primary, fallback, provider) {
  const error = new Error(`Primary downloader failed; ${provider} fallback failed: ${fallback.message}`, { cause: primary });
  error.code = "SOCIAL_DOWNLOAD_FAILED";
  error.attempts = [
    ...(Array.isArray(primary.attempts) ? primary.attempts : [{ provider: "yt-dlp", error: primary }]),
    { provider, error: fallback },
  ];
  return error;
}

function httpFailure(message, status) {
  return Object.assign(new Error(`${message}: ${status}`), { status });
}

export async function downloadTikTokWithFallbackApi(url, tempDir, titleHint = "", deps) {
  if (!deps.tiktokFallbackApiUrl) throw new Error("TikTok fallback API is disabled");
  let resolvedUrl = url;
  if (!mediaReference(url)?.id) {
    const redirect = await fetchWithTimeout(url, { method: "HEAD" }, deps.httpTimeoutMs, deps.fetch);
    resolvedUrl = redirect.url || url;
    await redirect.body?.cancel();
    if (mediaReference(resolvedUrl)?.platform !== "tiktok" || !mediaReference(resolvedUrl)?.id) throw sourceIdentityError("MEDIA_SOURCE_UNVERIFIED", "tiktok-api");
  }
  const apiUrl = new URL(deps.tiktokFallbackApiUrl);
  apiUrl.searchParams.set("url", url);

  const response = await fetchWithTimeout(
    apiUrl,
    {
      headers: {
        accept: "application/json,text/plain,*/*",
        "user-agent": "Mozilla/5.0 TelegramSocialVideoBot/1.0",
      },
    },
    deps.httpTimeoutMs,
    deps.fetch,
  );
  if (!response.ok) throw httpFailure("TikTok fallback API failed", response.status);

  const body = await response.json().catch(() => null);
  if (!body || body.code !== 0 || !body.data) {
    throw new Error(`TikTok fallback API returned no media: ${body?.msg || "unknown error"}`);
  }
  if (body.data.aweme_id && body.data.id && String(body.data.aweme_id) !== String(body.data.id)) throw sourceIdentityError("MEDIA_SOURCE_MISMATCH", "tiktok-api");
  const source = verifiedMediaSource(url, { provider: "tiktok-api", resolvedUrl,
    id: body.data.aweme_id || body.data.id, owner: body.data.author?.unique_id });

  const title = titleHint || (typeof body.data.title === "string" ? body.data.title : "");
  const maxItems = deps.getMaxMediaItems();
  const imageUrls = uniqueStrings(Array.isArray(body.data.images) ? body.data.images : []);
  if (imageUrls.length) {
    const files = [];
    for (const [index, imageUrl] of imageUrls.slice(0, maxItems).entries()) {
      const downloaded = await downloadRemoteMediaFile(
        imageUrl,
        tempDir,
        `tiktok-image-${Date.now()}-${index + 1}`,
        url,
        "image",
        deps,
      );
      downloaded.title = "TikTok image";
      files.push(downloaded);
    }

    const selectedFiles = deps.uniqueMediaFiles(files).slice(0, maxItems);
    if (!selectedFiles.length) throw new Error("TikTok fallback API returned no downloadable images");
    return {
      source,
      tempDir,
      files: selectedFiles,
      title: title || "TikTok images",
    };
  }

  const mediaUrl = body.data.play || body.data.wmplay;
  if (!mediaUrl) throw new Error("TikTok fallback API returned no playable video");

  const downloaded = await downloadRemoteMediaFile(
    mediaUrl,
    tempDir,
    `tiktok-video-${Date.now()}`,
    body.data.play || url,
    "",
    deps,
  );
  if (downloaded.mediaKind !== "video") {
    await deps.fs.promises.rm(downloaded.filePath, { force: true }).catch(() => {});
    throw new Error("TikTok fallback API media was not a video");
  }

  const video = await deps.validateDownloadedVideo(downloaded.filePath, { requireAudio: false });
  downloaded.hasAudio = video.hasAudio;
  downloaded.duration = video.duration;
  downloaded.width = video.width;
  downloaded.height = video.height;
  downloaded.title = "TikTok video";
  return {
    source,
    tempDir,
    files: [downloaded],
    title: title || downloaded.title,
  };
}

export async function downloadThreadsFromPage(url, tempDir, deps) {
  const response = await fetchWithTimeout(
    url,
    {
      headers: {
        accept: "text/html",
        "user-agent": "Mozilla/5.0 TelegramSocialVideoBot/1.0",
      },
    },
    deps.httpTimeoutMs,
    deps.fetch,
  );
  if (!response.ok) throw httpFailure("Threads fetch failed", response.status);

  const html = await response.text();
  const resolvedUrl = response.url || url;
  if (mediaReference(resolvedUrl)?.platform !== "threads") throw sourceIdentityError("MEDIA_SOURCE_UNVERIFIED", "threads-page");
  if (/\/(?:accounts\/)?login(?:\/|\?|$)/iu.test(new URL(resolvedUrl).pathname)) {
    throw Object.assign(new Error("Threads redirected to login; authentication required"), { code: "AUTH_REQUIRED" });
  }
  const extracted = extractThreadsPostFromHtml(html, resolvedUrl);
  const mediaUrls = extracted.mediaUrls;
  if (!mediaUrls.length) {
    if (/"status"\s*:\s*"fail_ssr_disabled"/u.test(html)) {
      throw Object.assign(new Error("Threads returned a page without server-rendered post contents"), { code: "THREADS_RENDER_UNAVAILABLE" });
    }
    const error = new Error("Threads fetch returned no media");
    error.code = "THREADS_MEDIA_NOT_FOUND";
    throw error;
  }
  const nativeMetaUrl = extractHtmlMetaContent(html, "og:url");
  const identityUrl = mediaReference(resolvedUrl)?.id ? resolvedUrl : nativeMetaUrl;
  const post = extractTargetThreadsPost(html, identityUrl);
  const meta = mediaReference(nativeMetaUrl);
  const nativeVideo = extractHtmlMetaContent(html, "og:video") || extractHtmlMetaContent(html, "og:video:url") || extractHtmlMetaContent(html, "twitter:player:stream");
  // A generic OG image can be an avatar/preview. It does not establish that
  // the provider actually exposed the requested post's media.
  if (!post && (!nativeVideo || !meta?.id)) throw sourceIdentityError("MEDIA_SOURCE_UNVERIFIED", "threads-page");
  const source = verifiedMediaSource(url, { provider: "threads-page", resolvedUrl: identityUrl,
    id: post?.code || meta.id, owner: post?.user?.username || meta.owner });

  const files = [];
  const maxItems = deps.getMaxMediaItems();
  for (const [index, mediaUrl] of mediaUrls.slice(0, maxItems).entries()) {
    const downloaded = await downloadRemoteMediaFile(mediaUrl, tempDir, `threads-media-${Date.now()}-${index + 1}`, resolvedUrl, "", deps);
    if (downloaded.mediaKind === "video") {
      const video = await deps.validateDownloadedVideo(downloaded.filePath, { requireAudio: false });
      downloaded.hasAudio = video.hasAudio;
      downloaded.duration = video.duration;
      downloaded.width = video.width;
      downloaded.height = video.height;
    }
    files.push(downloaded);
  }

  const selectedFiles = await deps.selectMediaFiles(files, maxItems, resolvedUrl);
  if (!selectedFiles.length) throw new Error("Threads fetch returned no downloadable media");
  return {
    source,
    tempDir,
    files: selectedFiles,
    title: extracted.caption || (selectedFiles.length > 1 ? "Threads media" : selectedFiles[0].title.replace(/^Instagram/, "Threads")),
  };
}

export async function downloadInstagramWithSnapinsta(url, tempDir, deps) {
  // This legacy HTML adapter exposes arbitrary download links but no binding
  // to a native item/owner. Do not send a private link to it or certify its
  // files merely because they are decodable media. Native retrieval remains.
  throw sourceIdentityError("MEDIA_SOURCE_UNVERIFIED", "snapinsta");
}

export async function fetchSnapinstaToken(deps) {
  const response = await fetchWithTimeout(
    `${deps.snapinstaBaseUrl}/`,
    {
      headers: {
        accept: "text/html",
        "user-agent": "Mozilla/5.0 TelegramSocialVideoBot/1.0",
      },
    },
    deps.httpTimeoutMs,
    deps.fetch,
  );
  if (!response.ok) throw httpFailure("third-party Instagram token fetch failed", response.status);

  const body = await response.text();
  const match =
    body.match(/name=["']token["'][^>]*value=["']([^"']+)["']/i) ||
    body.match(/value=["']([^"']+)["'][^>]*name=["']token["']/i);
  if (!match) throw new Error("third-party Instagram token not found");
  return match[1];
}

export function decodeSnapinstaActionResponse(jsCode) {
  const match = String(jsCode || "").match(/\("([^"]+)",\d+,"([^"]+)",(\d+),(\d+),\d+\)/);
  if (!match) throw new Error("third-party Instagram response could not be decoded");
  const decoded = decodeSnapinstaObfuscated(match[1], match[2], Number(match[3]), Number(match[4]));
  return decodeByteString(decoded);
}

function decodeSnapinstaObfuscated(source, alphabet, offset, base) {
  let decoded = "";
  let index = 0;
  while (index < source.length) {
    let chunk = "";
    while (index < source.length && source[index] !== alphabet[base]) {
      chunk += source[index];
      index++;
    }
    const encoded = chunk
      .split("")
      .map((char) => alphabet.indexOf(char))
      .join("");
    decoded += String.fromCharCode(Number.parseInt(convertSnapinstaBase(encoded, base, 10), 10) - offset);
    index++;
  }
  return decoded;
}

function convertSnapinstaBase(value, fromBase, toBase) {
  const alphabet = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ+/";
  const fromAlphabet = alphabet.slice(0, fromBase);
  const toAlphabet = alphabet.slice(0, toBase);
  const decimal = value
    .split("")
    .reverse()
    .reduce((sum, char, index) => {
      const digit = fromAlphabet.indexOf(char);
      return digit === -1 ? sum : sum + digit * Math.pow(fromBase, index);
    }, 0);

  let result = "";
  let remaining = decimal;
  while (remaining) {
    result = toAlphabet[remaining % toBase] + result;
    remaining = Math.floor(remaining / toBase);
  }
  return result || "0";
}

function decodeByteString(value) {
  try {
    const bytes = Uint8Array.from(String(value), (char) => char.charCodeAt(0) & 0xff);
    return new TextDecoder().decode(bytes);
  } catch {
    return value;
  }
}

export async function downloadSocialVideo(url, deps) {
  const tempDir = await deps.fs.promises.mkdtemp(path.join(os.tmpdir(), "telegram-social-video-"));
  try {
    // yt-dlp has no Threads extractor. Its generic unsupported-URL error says
    // nothing about the media format and must not mask the actual page result.
    if (isThreadsSocialVideoUrl(url)) return await runSocialVideoFallback("threads", () => deps.downloadThreads(url, tempDir), deps);
    try {
      return await downloadSocialVideoWithYtDlp(url, tempDir, deps);
    } catch (error) {
      if (deps.isDurationLimitError(error) || deps.signal?.aborted) throw error;
      const fallback = selectFallback(url, deps);
      if (!fallback) throw error;
      deps.logInfo(fallback.logEvent, { error: deps.cleanErrorMessage(error) });
      try {
        const result = await runSocialVideoFallback(fallback.provider, () => fallback.download(tempDir), deps);
        return { ...result, previousFailure: error };
      } catch (fallbackError) {
        throw socialDownloadFailure(error, fallbackError, fallback.provider);
      }
    }
  } catch (error) {
    await deps.fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

export function selectFallback(url, deps) {
  if (deps.shouldTryTikTokFallback(url)) {
    return {
      provider: "tiktok",
      logEvent: "tiktok_downloader_fallback_triggered",
      download: (tempDir) => deps.downloadTikTok(url, tempDir),
    };
  }
  if (deps.shouldTryInstagramFallback(url)) {
    return {
      provider: "instagram",
      logEvent: "instagram_downloader_fallback_triggered",
      download: (tempDir) => deps.downloadInstagram(url, tempDir),
    };
  }
  if (deps.shouldTryThreadsFallback(url)) {
    return {
      provider: "threads",
      logEvent: "threads_downloader_fallback_triggered",
      download: (tempDir) => deps.downloadThreads(url, tempDir),
    };
  }
  return null;
}

export async function runSocialVideoFallback(provider, operation, deps) {
  const state = deps.circuitByProvider.get(provider);
  if (isCircuitBreakerOpen(state)) {
    const error = new Error(`${provider} fallback is cooling down after repeated failures`);
    error.code = "SOCIAL_VIDEO_PROVIDER_COOLDOWN";
    error.retryAfterSeconds = Math.max(1, Math.ceil((state.openedUntil - Date.now()) / 1000));
    throw error;
  }

  try {
    const result = await operation();
    deps.circuitByProvider.set(provider, recordCircuitBreakerSuccess(state));
    return result;
  } catch (error) {
    if (deps.signal?.aborted) throw error;
    if (["MEDIA_SOURCE_UNVERIFIED", "MEDIA_SOURCE_MISMATCH"].includes(error.code)) throw error;
    const nextState = recordCircuitBreakerFailure(
      state,
      {
        threshold: deps.circuitFailureThreshold,
        cooldownMs: deps.circuitCooldownMs,
      },
    );
    deps.circuitByProvider.set(provider, nextState);
    deps.logError("social_video_fallback_provider_failed", error, {
      provider,
      failures: nextState.failures,
      cooldownMs: Math.max(0, nextState.openedUntil - Date.now()),
    });
    throw error;
  }
}

export async function downloadSocialVideoWithYtDlp(url, tempDir, deps) {
  const info = await inspectSocialVideo(url, deps);
  const duration = Number(info.duration);
  if (info.is_live === true) throw new Error("live videos are not supported");
  if (Number.isFinite(duration) && duration > deps.maxDurationSeconds) {
    const error = deps.durationLimitError();
    error.actualDurationSeconds = duration;
    throw error;
  }
  if (info._type === "playlist" || Array.isArray(info.entries)) throw sourceIdentityError("MEDIA_SOURCE_UNVERIFIED", "yt-dlp");
  const source = nativeExtractorSource(url, info);

  const maxMb = Math.max(1, Math.floor(deps.maxBytes / 1024 / 1024));
  const outputTemplate = path.join(tempDir, "%(title).80B.%(id)s.%(ext)s");
  await deps.execFileAsync(
    deps.downloader,
    [
      "--ignore-config",
      "--js-runtimes", "node",
      "--no-playlist",
      "--no-warnings",
      "--socket-timeout",
      "20",
      "--retries",
      "2",
      "--fragment-retries",
      "2",
      "--restrict-filenames",
      "--no-mtime",
      "--max-filesize",
      `${maxMb}M`,
      "-f",
      "bv*[ext=mp4]+ba[ext=m4a]/bv*+ba/b[ext=mp4]/b",
      "--merge-output-format",
      "mp4",
      "-o",
      outputTemplate,
      url,
    ],
    {
      cwd: deps.rootDir,
      timeout: 120000,
      maxBuffer: 2 * 1024 * 1024,
      env: process.env,
    },
  );

  const file = await deps.findDownloadedVideo(tempDir);
  if (!file) throw new Error("download completed without a file");
  if (file.size > deps.maxBytes) throw new Error(`downloaded file exceeds ${maxMb} MB`);
  // Provider fallback belongs to downloadSocialVideo. Keeping it at one layer
  // prevents one failed validation from silently executing the same fallback twice.
  const video = await deps.validateDownloadedVideo(file.filePath, { requireAudio: false });
  file.hasAudio = video.hasAudio;
  file.duration = video.duration;
  file.width = video.width;
  file.height = video.height;

  return {
    source,
    tempDir,
    filePath: file.filePath,
    mediaKind: "video",
    mimeType: "video/mp4",
    title: typeof info.title === "string" ? info.title : "",
    duration: file.duration,
    width: file.width,
    height: file.height,
  };
}

export async function inspectSocialVideo(url, deps) {
  const { stdout } = await deps.execFileAsync(
    deps.downloader,
    [
      "--ignore-config",
      "--js-runtimes", "node",
      "--no-playlist",
      "--no-warnings",
      "--socket-timeout",
      "20",
      "--dump-single-json",
      url,
    ],
    {
      cwd: deps.rootDir,
      timeout: 60000,
      maxBuffer: 4 * 1024 * 1024,
      env: process.env,
    },
  );
  return JSON.parse(stdout);
}

export async function fetchWithTimeout(url, options = {}, timeoutMs = 30000, fetchImpl = fetch) {
  // Keep the timeout alive while the body streams, not just until headers arrive.
  const timeout = AbortSignal.timeout(timeoutMs);
  return fetchImpl(url, { ...options, signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout });
}

export async function downloadRemoteBinaryFile(url, filePath, { accept = "*/*", referer = "" } = {}, deps) {
  const response = await fetchWithTimeout(
    url,
    {
      headers: {
        accept,
        ...(referer ? { referer } : {}),
        "user-agent": "Mozilla/5.0 TelegramSocialVideoBot/1.0",
      },
    },
    deps.httpTimeoutMs,
    deps.fetch,
  );
  if (!response.ok) throw httpFailure("remote media download failed", response.status);

  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > deps.maxBytes) {
    throw new Error("remote media exceeds configured file limit");
  }

  const buffer = await readLimitedResponseBuffer(response, deps.maxBytes);
  await deps.fs.promises.writeFile(filePath, buffer);
}

export async function downloadRemoteMediaFile(url, tempDir, baseName, referer, forcedMediaKind, deps) {
  const response = await fetchWithTimeout(
    url,
    {
      headers: {
        accept: "video/mp4,video/*,image/*,*/*",
        referer,
        "user-agent": "Mozilla/5.0 TelegramSocialVideoBot/1.0",
      },
    },
    deps.httpTimeoutMs,
    deps.fetch,
  );
  if (!response.ok) throw httpFailure("remote media download failed", response.status);
  const contentType = String(response.headers.get("content-type") || "").toLowerCase();
  if (contentType.startsWith("text/html")) throw new Error("remote media returned HTML instead of a file");
  const mediaKind = forcedMediaKind || inferRemoteMediaKind(url, contentType);
  if (!mediaKind) throw new Error(`remote media type is not supported: ${contentType || "unknown content type"}`);

  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > deps.maxBytes) {
    throw new Error("remote media exceeds configured file limit");
  }

  const buffer = await readLimitedResponseBuffer(response, deps.maxBytes);
  const mimeType = normalizeMediaMimeType(contentType, mediaKind);
  const extension = mediaExtensionForMimeType(mimeType) || extensionFromUrl(url) || (mediaKind === "image" ? "jpg" : "mp4");
  const filePath = path.join(tempDir, `${baseName}.${extension}`);
  await deps.fs.promises.writeFile(filePath, buffer);
  const stat = await deps.fs.promises.stat(filePath);
  return {
    filePath,
    mediaKind,
    mimeType,
    size: stat.size,
    hash: crypto.createHash("sha256").update(buffer).digest("hex"),
    title: mediaKind === "image" ? "Instagram image" : "Instagram video",
  };
}

async function readLimitedResponseBuffer(response, maxBytes) {
  const chunks = [];
  let totalBytes = 0;
  const reader = response.body?.getReader();
  if (!reader) throw new Error("remote media response was empty");

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = Buffer.from(value);
    totalBytes += chunk.length;
    if (totalBytes > maxBytes) throw new Error("remote media exceeds configured file limit");
    chunks.push(chunk);
  }

  if (!totalBytes) throw new Error("remote media response was empty");
  return Buffer.concat(chunks);
}
