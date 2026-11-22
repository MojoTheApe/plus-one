import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { mediaReference, nativeExtractorSource, verifiedMediaSource, assertVerifiedMediaSource, sourceIdentityError, instagramMediaCode } from "./media-source.js";
import { maxPublicationItems } from "./media-items.js";
import { mediaFailure } from "./media-operations.js";
import {
  isCircuitBreakerOpen,
  recordCircuitBreakerFailure,
  recordCircuitBreakerSuccess,
} from "./helpers.js";
import {
  extensionFromUrl,
  extractHtmlMetaContent,
  extractThreadsPublication,
  inferRemoteMediaKind,
  isThreadsSocialVideoUrl,
  mediaExtensionForMimeType,
  normalizeMediaMimeType,
} from "./social-video.js";

export function createSocialDownloader(deps) {
  const sources = new Map();
  const download = (url, options) => {
    const provider = mediaReference(url)?.platform || "unknown";
    const previous = sources.get(provider) || Promise.resolve();
    const work = previous.catch(() => {}).then(() => downloadWithinDeadline(url, deps, options));
    sources.set(provider, work);
    work.finally(() => { if (sources.get(provider) === work) sources.delete(provider); }).catch(() => {});
    return work;
  };
  return {
    download,
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
  if (Date.now() >= (options.deadline || Infinity)) throw Object.assign(new Error("Media attempt deadline exceeded"), { code: "SOCIAL_DOWNLOAD_TIMEOUT" });
  const provider = mediaReference(url)?.platform;
  const state = await deps.journal?.sourceState(provider);
  if (state?.notBefore > Date.now()) throw Object.assign(new Error("Source request cooldown"), {
    code: "SOCIAL_VIDEO_PROVIDER_COOLDOWN", confirmedRateLimit: state.confirmedRateLimit,
    retryAfterSeconds: Math.ceil((state.notBefore - Date.now()) / 1000) });
  const controller = new AbortController();
  const budgetMs = Math.max(1, Math.min(deps.totalTimeoutMs || 90000, (options.deadline || Infinity) - Date.now()));
  const deadline = Date.now() + budgetMs;
  const timer = setTimeout(() => controller.abort(), budgetMs);
  const scoped = { ...deps, signal: controller.signal, deadline, downloadBudget: { bytes: 0, maxBytes: 256 * 1024 * 1024 },
    fetch: (input, options = {}) => deps.fetch(input, { ...options,
      signal: options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal }),
    execFileAsync: (file, args, options = {}) => deps.execFileAsync(file, args, { ...options,
      signal: controller.signal, timeout: Math.max(1, Math.min(options.timeout || budgetMs, deadline - Date.now())) }),
  };
  scoped.validateDownloadedVideo = (file, options = {}) => deps.validateDownloadedVideo(file, {...options,deadline,signal:controller.signal});
  scoped.downloadThreads = (input, dir) => downloadThreadsFromPage(input, dir, scoped);
  scoped.downloadTikTok = (input, dir) => downloadTikTokWithFallbackApi(input, dir, "", scoped);
  let result, completed = false;
  try {
    const resolvedUrl = await resolveSocialMediaUrl(url, scoped);
    if (resolvedUrl !== url && options.onResolved) {
      const duplicate = await options.onResolved(resolvedUrl);
      if (duplicate?.duplicateOf || duplicate?.photoUrl) return duplicate;
    }
    result = await downloadSocialVideo(resolvedUrl, scoped);
    if (resolvedUrl !== url) {
      const native = assertVerifiedMediaSource(result.source, resolvedUrl);
      result.source = verifiedMediaSource(url, { provider: native.provider, resolvedUrl: native.resolved.url,
        id: native.resolved.id, owner: native.resolved.owner, kind: native.resolved.kind });
    }
    if (controller.signal.aborted) {
      throw Object.assign(new Error("Download deadline exceeded"),{code:"SOCIAL_DOWNLOAD_TIMEOUT"});
    }
    await deps.journal?.sourceResult(provider);
    completed = true;
    return result;
  }
  catch (error) {
    if (controller.signal.aborted) error.code = "SOCIAL_DOWNLOAD_TIMEOUT";
    const failure = mediaFailure(error);
    const wait = await deps.journal?.sourceResult(provider, failure);
    if (failure.code === "RATE_LIMIT" && Number.isFinite(wait)) error.retryAfterSeconds = wait;
    throw error;
  } finally {
    clearTimeout(timer);
    if (!completed && result?.tempDir) await deps.fs.promises.rm(result.tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function resolveSocialMediaUrl(url, deps) {
  const requested = mediaReference(url);
  // Threads exposes its canonical post together with the page contents; its
  // page adapter resolves both in one request instead of fetching twice.
  if (!requested || requested.id || requested.platform === "threads") return url;
  let current = url;
  for (let redirects = 0; redirects < 5; redirects++) {
    const response = await fetchWithTimeout(current, { redirect: "manual", headers: { "user-agent": "Mozilla/5.0" } }, deps.httpTimeoutMs, deps.fetch);
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      const next = location && new URL(location, current).href;
      if (!next || mediaReference(next)?.platform !== requested.platform) throw sourceIdentityError("MEDIA_SOURCE_MISMATCH", "redirect");
      current = next;
      if (mediaReference(current)?.id) return current;
      continue;
    }
    if (!response.ok) throw httpFailure("Short media link failed", response.status, response.headers);
    const reader = response.body?.getReader(), chunks = [];
    let size = 0;
    if (reader) {
      try {
        while (size < 1024 * 1024) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.length;
          chunks.push(Buffer.from(chunk.value));
        }
      } finally { await reader.cancel().catch(() => {}); }
    }
    const canonical = extractHtmlMetaContent(Buffer.concat(chunks).toString("utf8"), "og:url");
    if (mediaReference(canonical)?.platform === requested.platform && mediaReference(canonical)?.id) return canonical;
    throw sourceIdentityError("MEDIA_SOURCE_UNVERIFIED", "redirect");
  }
  throw sourceIdentityError("MEDIA_SOURCE_UNVERIFIED", "redirect");
}

// Keep the actual failures together. A fallback saying "no media" must not erase
// an access restriction reported by the primary downloader.
export function socialDownloadFailure(primary, fallback, provider) {
  const error = new Error(`Primary downloader failed; ${provider} fallback failed: ${fallback.message}`, { cause: primary });
  error.code = "SOCIAL_DOWNLOAD_FAILED";
  error.downloader = primary.downloader || "yt-dlp";
  error.attempts = [
    ...(Array.isArray(primary.attempts) ? primary.attempts : [{ provider: primary.downloader || "yt-dlp", error: primary }]),
    { provider, error: fallback },
  ];
  return error;
}

function httpFailure(message, status, headers) {
  const value = headers?.get?.("retry-after");
  const seconds = value ? Number.isFinite(Number(value)) ? Number(value) : (Date.parse(value) - Date.now()) / 1000 : NaN;
  return Object.assign(new Error(`${message}: ${status}`), { status,
    ...(Number.isFinite(seconds) && seconds > 0 ? { retryAfterSeconds: Math.ceil(seconds) } : {}) });
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
  if (!response.ok) throw httpFailure("TikTok fallback API failed", response.status, response.headers);

  const body = await response.json().catch(() => null);
  if (!body || body.code !== 0 || !body.data) {
    throw new Error(`TikTok fallback API returned no media: ${body?.msg || "unknown error"}`);
  }
  if (body.data.aweme_id && body.data.id && String(body.data.aweme_id) !== String(body.data.id)) throw sourceIdentityError("MEDIA_SOURCE_MISMATCH", "tiktok-api");
  const source = verifiedMediaSource(url, { provider: "tiktok-api", resolvedUrl,
    id: body.data.aweme_id || body.data.id, owner: body.data.author?.unique_id });

  const title = titleHint || (typeof body.data.title === "string" ? body.data.title : "");
  const imageUrls = Array.isArray(body.data.images) ? body.data.images : [];
  if ((body.data.image_count != null && body.data.image_count !== imageUrls.length) ||
      imageUrls.length > Math.min(maxPublicationItems, deps.getMaxMediaItems()) ||
      imageUrls.some(url => typeof url !== "string" || !URL.canParse(url) || new URL(url).protocol !== "https:")) {
    throw sourceIdentityError("MEDIA_SOURCE_UNVERIFIED", "tiktok-api");
  }
  if (imageUrls.length) {
    const files = [];
    for (const [index, imageUrl] of imageUrls.entries()) {
      const downloaded = await downloadRemoteMediaFile(
        imageUrl,
        tempDir,
        `tiktok-image-${Date.now()}-${index + 1}`,
        url,
        "",
        deps,
      );
      if (downloaded.mediaKind !== "image") throw sourceIdentityError("MEDIA_SOURCE_MISMATCH", "tiktok-api");
      downloaded.title = "TikTok image";
      files.push(downloaded);
    }

    return {
      source,
      tempDir,
      files,
      title: title || "TikTok images",
    };
  }

  if (mediaReference(resolvedUrl)?.kind === "photo") throw sourceIdentityError("MEDIA_SOURCE_UNVERIFIED", "tiktok-api");
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
  if (!response.ok) throw httpFailure("Threads fetch failed", response.status, response.headers);

  const html = await response.text();
  const resolvedUrl = response.url || url;
  if (mediaReference(resolvedUrl)?.platform !== "threads") throw sourceIdentityError("MEDIA_SOURCE_UNVERIFIED", "threads-page");
  if (/\/(?:accounts\/)?login(?:\/|\?|$)/iu.test(new URL(resolvedUrl).pathname)) {
    throw Object.assign(new Error("Threads redirected to login; authentication required"), { code: "AUTH_REQUIRED" });
  }
  checkThreadsRegionGate(html, url, resolvedUrl);
  const extracted = extractThreadsPublication(html, resolvedUrl);
  if (!extracted.items.length) {
    if (/"status"\s*:\s*"fail_ssr_disabled"/u.test(html)) {
      throw Object.assign(new Error("Threads returned a page without server-rendered post contents"), { code: "THREADS_RENDER_UNAVAILABLE" });
    }
    if (!extracted.post && ["og:image", "twitter:image", "og:video", "og:video:url", "twitter:player:stream"].some(key => extractHtmlMetaContent(html, key))) {
      throw sourceIdentityError("MEDIA_SOURCE_UNVERIFIED", "threads-page");
    }
    if (!extracted.post) throw Object.assign(new Error("Threads did not return the post"), { code: "THREADS_RENDER_UNAVAILABLE" });
    const error = new Error("Threads fetch returned no media");
    error.code = "THREADS_MEDIA_NOT_FOUND";
    throw error;
  }
  const ref = mediaReference(extracted.resolvedUrl);
  const source = verifiedMediaSource(url, { provider: "threads-page", resolvedUrl: extracted.resolvedUrl,
    id: extracted.post?.code || ref?.id, owner: extracted.post?.user?.username || ref?.owner });
  if (extracted.items.length > Math.min(20, deps.getMaxMediaItems())) throw sourceIdentityError("MEDIA_SOURCE_UNVERIFIED", "threads-page");

  const files = [];
  for (const [index, item] of extracted.items.entries()) {
    const downloaded = await downloadRemoteMediaFile(item.url, tempDir, `threads-media-${Date.now()}-${index + 1}`, resolvedUrl, "", deps);
    if (downloaded.mediaKind !== item.kind) throw sourceIdentityError("MEDIA_SOURCE_MISMATCH", "threads-page");
    if (downloaded.mediaKind === "video") {
      const video = await deps.validateDownloadedVideo(downloaded.filePath, { requireAudio: false });
      downloaded.hasAudio = video.hasAudio;
      downloaded.duration = video.duration;
      downloaded.width = video.width;
      downloaded.height = video.height;
    }
    files.push(downloaded);
  }

  return {
    source,
    tempDir,
    files,
    title: extracted.caption || (files.length > 1 ? "Threads media" : files[0].title.replace(/^Instagram/, "Threads")),
  };
}

// Threads can serve its region gate with HTTP 200 and fail_ssr_disabled.
// Module preloads, translated strings and other posts on the page do not
// identify the active application route or the publication it belongs to.
function checkThreadsRegionGate(html, url, resolvedUrl) {
  if (!html.includes("BarcelonaGeoBlockRoute")) return;
  const requested = mediaReference(url), resolved = mediaReference(resolvedUrl);
  // Each server initializer is [module, method, dependencies, arguments].
  const callArguments = (calls, module, method) => Array.isArray(calls)
    ? calls.filter(call => call?.[0] === module && call[1] === method && Array.isArray(call[3])).flatMap(call => call[3]) : [];
  for (const script of html.matchAll(/<script\b[^>]*\stype=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/giu)) {
    if (!script[1].includes("BarcelonaGeoBlockRoute")) continue;
    let bootstrap;
    try { bootstrap = JSON.parse(script[1]); } catch { continue; }
    for (const batch of callArguments(bootstrap?.require, "ScheduledServerJS", "handle")) {
      for (const init of callArguments(batch?.__bbox?.require, "CometPlatformRootClient", "initialize")) {
        const route = init?.initialRouteInfo?.route;
        if (route?.canonicalRouteName !== "comet.barcelonawebloggedout.BarcelonaGeoBlockRoute" ||
            route.rootView?.resource?.__dr !== "BarcelonaGeoBlockedErrorRoot.react") continue;
        const pk = route.rootView.props?.mediaPk;
        const bound = typeof route.url === "string" && URL.canParse(route.url, resolvedUrl)
          ? mediaReference(new URL(route.url, resolvedUrl)) : null;
        if (bound?.platform === "threads" && resolved?.id && resolved.id === bound.id && resolved.owner === bound.owner &&
            (!requested?.id || (requested.id === bound.id && requested.owner === bound.owner)) &&
            typeof pk === "string" && /^[1-9]\d{0,24}$/u.test(pk) && instagramMediaCode(pk) === bound.id) {
          throw Object.assign(new Error("Threads restricted this post in the bot's region"), { code: "REGION_RESTRICTED" });
        }
        throw Object.assign(new Error("Threads did not identify the post on its access screen"), { code: "THREADS_RENDER_UNAVAILABLE" });
      }
    }
  }
}

export async function downloadInstagramWithSnapinsta(url, tempDir, deps) {
  // This legacy HTML adapter exposes arbitrary download links but no binding
  // to a native item/owner. Do not send a private link to it or certify its
  // files merely because they are decodable media. Native retrieval remains.
  throw Object.assign(sourceIdentityError("MEDIA_SOURCE_UNVERIFIED", "snapinsta"), { fallbackDisabled: true });
}

function isInstagramAssetUrl(value) {
  try {
    const target = new URL(value);
    return target.protocol === "https:" && !target.username && !target.password && (!target.port || target.port === "443") &&
      [".cdninstagram.com", ".fbcdn.net"].some(suffix => target.hostname.endsWith(suffix));
  } catch { return false; }
}

export async function downloadInstagramPost(url, tempDir, deps) {
  let manifest;
  try {
    const { stdout } = await deps.execFileAsync(deps.python || "python3", [deps.instagramScript, "--url", url,
      "--max-items", String(Math.min(20, deps.getMaxMediaItems())),
      ...(deps.instagramSession ? ["--session", deps.instagramSession] : [])], {
      timeout: 45000, maxBuffer: 2 * 1024 * 1024,
      env: { PATH: process.env.PATH || "/usr/bin:/bin", LANG: "C.UTF-8" },
    });
    manifest = JSON.parse(stdout);
    if (manifest.error) throw Object.assign(new Error(`Instagram retrieval: ${manifest.error.code}`), manifest.error);
  } catch (error) { error.downloader = "instaloader"; throw error; }
  if (!/^\d+$/u.test(String(manifest.publicationId)) || instagramMediaCode(manifest.publicationId) !== manifest.id) {
    throw sourceIdentityError("MEDIA_SOURCE_UNVERIFIED", "instaloader");
  }
  const source = verifiedMediaSource(url, { provider: "instaloader", resolvedUrl: manifest.url, id: manifest.id, owner: manifest.owner });
  const count = Number(manifest.count), selected = Math.min(20, deps.getMaxMediaItems(), count);
  if (!Number.isSafeInteger(count) || count < 1 || !Array.isArray(manifest.items) || manifest.items.length !== count || count > selected) {
    throw sourceIdentityError("MEDIA_SOURCE_UNVERIFIED", "instaloader");
  }
  const files = [];
  const itemIds = new Set();
  let bytes = 0;
  for (const [index, item] of manifest.items.entries()) {
    if (item.index !== index || typeof item.mediaId !== "string" || !/^\d+$/u.test(item.mediaId) || itemIds.has(item.mediaId) ||
        !["image", "video"].includes(item.kind) || !isInstagramAssetUrl(item.url)) {
      throw sourceIdentityError("MEDIA_SOURCE_UNVERIFIED", "instaloader");
    }
    itemIds.add(item.mediaId);
    const file = await downloadRemoteMediaFile(item.url, tempDir, `instagram-${index + 1}`, source.resolved.url, item.kind,
      { ...deps, maxBytes: Math.min(deps.maxBytes, 256 * 1024 * 1024 - bytes) });
    bytes += file.size;
    file.title = manifest.title || "Instagram media";
    file.sourceItemId = count === 1 ? `publication:${source.resolved.id}` : `native:${item.mediaId}`;
    if (item.kind === "video") Object.assign(file, await deps.validateDownloadedVideo(file.filePath, { requireAudio: false }));
    files.push(file);
  }
  return { tempDir, files, source, title: manifest.title || "Instagram media" };
}

export async function downloadSocialVideo(url, deps) {
  const tempDir = await deps.fs.promises.mkdtemp(path.join(os.tmpdir(), "telegram-social-video-"));
  try {
    if (mediaReference(url)?.platform === "instagram" && deps.instagramSession) {
      deps = { ...deps, instagramCookieArgs: await instagramCookieArgs(tempDir, deps) };
    }
    // yt-dlp has no Threads extractor. Its generic unsupported-URL error says
    // nothing about the media format and must not mask the actual page result.
    if (mediaReference(url)?.kind === "photo" && mediaReference(url)?.platform === "tiktok") {
      // A slideshow rendered as a video cannot prove the number and order of original slides.
      return await runSocialVideoFallback("tiktok", () => deps.downloadTikTok(url, tempDir), deps);
    }
    if (isThreadsSocialVideoUrl(url)) return await runSocialVideoFallback("threads", () => deps.downloadThreads(url, tempDir), deps);
    if (mediaReference(url)?.platform === "instagram" && ["post", "reel"].includes(mediaReference(url)?.kind) && deps.instagramScript) {
      try { return await downloadInstagramPost(url, tempDir, deps); }
      catch (error) {
        const failure = mediaFailure(error);
        const isPost = mediaReference(url)?.kind === "post";
        const denied = [401, 403, 404, 410, 451].includes(failure.status) || error.code === "AGE_RESTRICTED" ||
          ["PrivateProfileNotFollowedException", "InstagramPageGate"].includes(error.adapterErrorType);
        if (["MEDIA_SOURCE_UNVERIFIED", "MEDIA_SOURCE_MISMATCH"].includes(error.code) ||
            deps.signal?.aborted || failure.code === "RATE_LIMIT" || denied) throw error;
        // A generic adapter login/unavailable result retains the prior native video path.
        // Only an ordinary source failure opens the additional photo extraction path.
        const nativeDeps = isPost && !["SERVICE_ERROR", "TIMEOUT", "NO_MEDIA"].includes(failure.code)
          ? { ...deps, allowNativePhoto: false } : deps;
        try { return { ...await downloadSocialVideoWithYtDlp(url, tempDir, nativeDeps), previousFailure: error }; }
        catch (native) { throw socialDownloadFailure(error, native, "yt-dlp"); }
      }
    }
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

async function instagramCookieArgs(tempDir, deps) {
  // The same explicitly configured JSON session reaches the native video
  // compatibility path too. Never inspect/import a personal browser profile.
  try {
    const stat = await deps.fs.promises.lstat(deps.instagramSession);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 100000) throw new Error();
    const session = JSON.parse(await deps.fs.promises.readFile(deps.instagramSession, "utf8"));
    if (!/^[\w.]{1,30}$/u.test(session.username || "") || !session.cookies || Array.isArray(session.cookies) || typeof session.cookies !== "object") throw new Error();
    const lines = Object.entries(session.cookies).map(([name, value]) => {
      if (!name || typeof value !== "string" || /[\t\r\n]/u.test(name + value)) throw new Error();
      return [".instagram.com", "TRUE", "/", "TRUE", "0", name, value].join("\t");
    });
    const file = path.join(tempDir, "instagram-cookies.txt");
    await deps.fs.promises.writeFile(file, "# Netscape HTTP Cookie File\n" + lines.join("\n") + "\n", { mode: 0o600, flag: "wx" });
    return ["--cookies", file];
  } catch { throw Object.assign(new Error("Configured Instagram session could not be read"), { code: "AUTH_REQUIRED", downloader: "instaloader" }); }
}

export function selectFallback(url, deps) {
  if (deps.shouldTryTikTokFallback(url)) {
    return {
      provider: "tiktok",
      logEvent: "tiktok_downloader_fallback_triggered",
      download: (tempDir) => deps.downloadTikTok(url, tempDir),
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
    if (!["RATE_LIMIT", "TIMEOUT", "SERVICE_ERROR"].includes(mediaFailure(error).code)) throw error;
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
  let info, previousFailure;
  try {
    info = await inspectSocialVideo(url, deps);
  } catch (error) {
    error.downloader = "yt-dlp";
    const failure = mediaFailure(error);
    const delayMs = 2000;
    if (deps.signal?.aborted || !["TIMEOUT", "SERVICE_ERROR"].includes(failure.code) ||
        (deps.deadline || Infinity) - Date.now() <= delayMs) throw error;
    previousFailure = error;
    deps.logInfo("social_video_metadata_retry", { provider: "yt-dlp", code: failure.code, delayMs });
    await delay(delayMs, undefined, { signal: deps.signal });
    info = await inspectSocialVideo(url, deps);
  }
  const duration = Number(info.duration);
  if (info.is_live === true) throw new Error("live videos are not supported");
  if (Number.isFinite(duration) && duration > deps.maxDurationSeconds) {
    const error = deps.durationLimitError();
    error.actualDurationSeconds = duration;
    throw error;
  }
  if (info.instagram_single_photo) {
    const photo = info.instagram_single_photo;
    const ref = mediaReference(url);
    if (deps.allowNativePhoto === false || ref?.platform !== "instagram" || ref.kind !== "post" || !ref.id || info._type !== "playlist" ||
        !Array.isArray(info.entries) || info.entries.length || typeof photo.publication_id !== "string" ||
        !/^[1-9]\d{0,24}$/u.test(photo.publication_id) || instagramMediaCode(photo.publication_id) !== info.id || !isInstagramAssetUrl(photo.url)) {
      throw sourceIdentityError("MEDIA_SOURCE_UNVERIFIED", "yt-dlp");
    }
    const source = nativeExtractorSource(url, info);
    const file = await downloadRemoteMediaFile(photo.url, tempDir, "instagram-photo", source.resolved.url, "image", deps, { strictImage: true });
    file.sourceItemId = `publication:${source.resolved.id}`;
    return { tempDir, source, files: [file], title: info.title || "Instagram photo", ...(previousFailure ? { previousFailure } : {}) };
  }
  if (info._type === "playlist" || Array.isArray(info.entries)) throw sourceIdentityError("MEDIA_SOURCE_UNVERIFIED", "yt-dlp");
  const source = nativeExtractorSource(url, info);

  const maxMb = Math.max(1, Math.floor(deps.maxBytes / 1024 / 1024));
  const outputTemplate = path.join(tempDir, "%(title).80B.%(id)s.%(ext)s");
  const metadataPath = path.join(tempDir, "verified-info.json");
  await deps.fs.promises.writeFile(metadataPath, JSON.stringify(info), { mode: 0o600 });
  await deps.execFileAsync(
    deps.downloader,
    [
      "--ignore-config",
      ...(deps.instagramCookieArgs || []),
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
      "--load-info-json", metadataPath,
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
    ...(previousFailure ? { previousFailure } : {}),
    tempDir,
    filePath: file.filePath,
    mediaKind: "video",
    sourceItemId: `publication:${source.resolved.id}`,
    mimeType: "video/mp4",
    title: typeof info.title === "string" ? info.title : "",
    duration: file.duration,
    width: file.width,
    height: file.height,
  };
}

export async function inspectSocialVideo(url, deps) {
  const reference = mediaReference(url);
  const pluginArgs = deps.allowNativePhoto !== false && reference?.platform === "instagram" && reference.kind === "post" && reference.id
    ? ["--plugin-dirs", path.join(deps.rootDir, "src", "yt-dlp-plugins")] : [];
  const { stdout } = await deps.execFileAsync(
    deps.downloader,
    [
      "--ignore-config",
      ...pluginArgs,
      ...(deps.instagramCookieArgs || []),
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
  if (!response.ok) throw httpFailure("remote media download failed", response.status, response.headers);

  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > deps.maxBytes) {
    await response.body?.cancel?.().catch(() => {});
    throw new Error("remote media exceeds configured file limit");
  }

  await writeLimitedResponseFile(response, filePath, deps);
}

export async function downloadRemoteMediaFile(url, tempDir, baseName, referer, forcedMediaKind, deps, { strictImage = false } = {}) {
  const response = await fetchWithTimeout(
    url,
    {
      ...(strictImage ? { redirect: "manual" } : {}),
      headers: {
        accept: "video/mp4,video/*,image/*,*/*",
        referer,
        "user-agent": "Mozilla/5.0 TelegramSocialVideoBot/1.0",
      },
    },
    deps.httpTimeoutMs,
    deps.fetch,
  );
  if (strictImage && response.status >= 300 && response.status < 400) {
    await response.body?.cancel?.();
    throw sourceIdentityError("MEDIA_SOURCE_UNVERIFIED", "yt-dlp");
  }
  if (!response.ok) throw httpFailure("remote media download failed", response.status, response.headers);
  const contentType = String(response.headers.get("content-type") || "").toLowerCase();
  if (strictImage && !/^image\/(?:jpeg|png|webp|avif)(?:;|$)/u.test(contentType)) {
    await response.body?.cancel?.();
    throw Object.assign(new Error("Instagram photo returned a different media type"), { code: "MEDIA_IMAGE_INVALID" });
  }
  if (contentType.startsWith("text/html")) throw new Error("remote media returned HTML instead of a file");
  const mediaKind = forcedMediaKind || inferRemoteMediaKind(url, contentType);
  if (!mediaKind) throw new Error(`remote media type is not supported: ${contentType || "unknown content type"}`);

  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > deps.maxBytes) {
    await response.body?.cancel?.().catch(() => {});
    throw new Error("remote media exceeds configured file limit");
  }

  const mimeType = normalizeMediaMimeType(contentType, mediaKind);
  const extension = mediaExtensionForMimeType(mimeType) || extensionFromUrl(url) || (mediaKind === "image" ? "jpg" : "mp4");
  const filePath = path.join(tempDir, `${baseName}.${extension}`);
  const downloaded = await writeLimitedResponseFile(response, filePath, deps);
  return {
    filePath,
    mediaKind,
    mimeType,
    size: downloaded.size,
    hash: downloaded.hash,
    title: mediaKind === "image" ? "Instagram image" : "Instagram video",
  };
}

async function writeLimitedResponseFile(response, filePath, deps) {
  let totalBytes = 0;
  const reader = response.body?.getReader();
  if (!reader) throw new Error("remote media response was empty");
  const file = await deps.fs.promises.open(filePath, "wx", 0o600), hash = crypto.createHash("sha256");
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      totalBytes += chunk.length;
      if (totalBytes > deps.maxBytes) throw new Error("remote media exceeds configured file limit");
      if (deps.downloadBudget) {
        deps.downloadBudget.bytes += chunk.length;
        if (deps.downloadBudget.bytes > deps.downloadBudget.maxBytes) throw new Error("Media operation exceeds configured file limit");
      }
      hash.update(chunk);
      await file.writeFile(chunk);
    }
    if (!totalBytes) throw new Error("remote media response was empty");
    return { size: totalBytes, hash: hash.digest("hex") };
  } catch (error) {
    await reader.cancel?.().catch(() => {});
    await deps.fs.promises.rm(filePath, { force: true }).catch(() => {});
    throw error;
  } finally {
    await file.close();
  }
}
