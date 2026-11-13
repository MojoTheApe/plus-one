// Requested URLs and verified object identity are deliberately separate. A URL
// copied from the caller is not evidence about files returned by a provider.
const providers = new Set(["yt-dlp", "threads-page", "tiktok-api"]);
const instagramAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export function instagramMediaCode(value) {
  const text = String(value || "");
  if (!/^\d+$/u.test(text)) return String(value || "");
  let number = BigInt(text), code = "";
  do { code = instagramAlphabet[Number(number % 64n)] + code; number /= 64n; } while (number);
  return code;
}

export function mediaReference(value) {
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) return null;
  const host = url.hostname.toLowerCase().replace(/^www\./u, "");
  const parts = url.pathname.split("/").filter(Boolean);
  let platform, kind = "share", id = "", owner = "";
  if (host === "instagram.com") {
    platform = "instagram";
    if (["p", "reel", "reels", "tv"].includes(parts[0]) && /^[\w-]+$/u.test(parts[1] || "")) {
      kind = parts[0] === "p" ? "post" : "reel"; id = parts[1];
    } else if (parts[0] === "stories" && parts[1] !== "highlights" && /^[\w.]+$/u.test(parts[1] || "") && /^\d+$/u.test(parts[2] || "")) {
      kind = "story"; id = parts[2]; owner = parts[1].toLowerCase();
    }
  } else if (["threads.com", "threads.net"].includes(host)) {
    platform = "threads";
    if (/^@[\w.]+$/u.test(parts[0] || "") && parts[1] === "post" && /^[\w-]+$/u.test(parts[2] || "")) {
      kind = "post"; id = parts[2]; owner = parts[0].slice(1).toLowerCase();
    }
  } else if (host === "tiktok.com" || ["vm.tiktok.com", "vt.tiktok.com", "m.tiktok.com"].includes(host)) {
    platform = "tiktok";
    if (/^@[\w.]+$/u.test(parts[0] || "") && ["video", "photo"].includes(parts[1]) && /^\d+$/u.test(parts[2] || "")) {
      kind = parts[1]; id = parts[2]; owner = parts[0].slice(1).toLowerCase();
      if (owner === "_") owner = ""; // Native TikTok ID-only canonical links.
    }
  } else return null;
  const canonicalHost = platform === "threads" ? "www.threads.com" : platform === "instagram" ? "www.instagram.com" : url.hostname;
  return { platform, kind, id, key: platform === "instagram" && kind === "story" ? instagramMediaCode(id) : id,
    owner, url: `https://${canonicalHost}/${parts.join("/")}/` };
}

function sameObject(expected, actual) {
  if (!expected?.id || !actual?.id || expected.platform !== actual.platform) return false;
  return expected.key === actual.key && (expected.kind === "story") === (actual.kind === "story") &&
    (!expected.owner || expected.owner === actual.owner);
}

export function sourceIdentityError(code = "MEDIA_SOURCE_UNVERIFIED", provider = "", check = {}) {
  return Object.assign(new Error(code === "MEDIA_SOURCE_MISMATCH" ? "Retrieved media identity differs from the requested object" : "The downloader did not prove the requested media identity"),
    { code, downloader: provider, sourceCheck: { status: code === "MEDIA_SOURCE_MISMATCH" ? "mismatch" : "unverified", provider, ...check } });
}

export function verifiedMediaSource(requestUrl, { provider, resolvedUrl = requestUrl, id, owner = "", kind } = {}) {
  const requested = mediaReference(requestUrl), resolvedRequest = mediaReference(resolvedUrl);
  const handle = typeof owner === "string" ? owner.replace(/^@/u, "").toLowerCase() : "";
  if (!providers.has(provider) || !requested || !resolvedRequest?.id ||
      !(typeof id === "string" || Number.isSafeInteger(id)) || !id || String(id).length > 256 ||
      handle.length > 80 || (handle && !/^[\w.]+$/u.test(handle)) || ((requested.owner || resolvedRequest.owner) && !handle)) throw sourceIdentityError("MEDIA_SOURCE_UNVERIFIED", provider);
  const resolved = { ...resolvedRequest, id: String(id), key: String(id), owner: handle, kind: kind || resolvedRequest.kind };
  if (resolved.platform === "tiktok" && /^[\w.]+$/u.test(resolved.owner)) resolved.url = `https://www.tiktok.com/@${resolved.owner}/${resolved.kind}/${resolved.id}/`;
  if (!sameObject(resolvedRequest, resolved) || (requested.id && !sameObject(requested, resolved)) || requested.platform !== resolved.platform) {
    throw sourceIdentityError("MEDIA_SOURCE_MISMATCH", provider, { requested, resolved });
  }
  return { version: 1, status: "verified", provider, requested, resolvedRequest, resolved };
}

export function assertVerifiedMediaSource(source, requestUrl) {
  const requested = mediaReference(requestUrl);
  if (source?.version !== 1 || source.status !== "verified" || !requested || source.requested?.url !== requested.url || !source.resolvedRequest?.url || !source.resolved?.kind) {
    throw sourceIdentityError("MEDIA_SOURCE_UNVERIFIED", source?.provider);
  }
  const checked = verifiedMediaSource(requestUrl, { provider: source.provider, resolvedUrl: source.resolvedRequest?.url,
    id: source.resolved?.id, owner: source.resolved?.owner, kind: source.resolved?.kind });
  return checked;
}

export function nativeExtractorSource(url, info) {
  const requested = mediaReference(url);
  const key = String(info.extractor_key || info.extractor || "").toLowerCase();
  const nativeStory = ["instagramstory", "instagram:story"].includes(key);
  const supported = requested?.platform === "instagram" ? key === "instagram" || nativeStory : requested?.platform === "tiktok" && key === "tiktok";
  if (!supported || !info.id) throw sourceIdentityError("MEDIA_SOURCE_UNVERIFIED", "yt-dlp");
  if (requested.platform === "instagram" && (requested.kind === "story") !== nativeStory) throw sourceIdentityError("MEDIA_SOURCE_MISMATCH", "yt-dlp");
  // InstagramStoryIE reports its numeric story PK as a shortcode. Its channel
  // is the username; uploader/uploader_id mean a display name/numeric account.
  const id = String(info.id);
  const resolvedUrl = requested.id ? url : requested.platform === "tiktok" && info.uploader
    ? `https://www.tiktok.com/@${info.uploader}/video/${id}/` : info.webpage_url;
  return verifiedMediaSource(url, { provider: "yt-dlp", resolvedUrl, id,
    owner: requested.platform === "tiktok" ? info.uploader : info.channel, kind: requested.kind === "story" ? "story" : undefined });
}
