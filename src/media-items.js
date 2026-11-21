import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { sourceIdentityError } from "./media-source.js";

export const maxPublicationItems = 35;

const validIdentity = value => typeof value === "string" && /^[\w:.-]{1,300}$/u.test(value);

// Called only on freshly retrieved, publication-verified original files, before
// conversion. Native child IDs survive CDN/encoding changes. Where a provider
// has no child identity, original bytes give a conservative recovery boundary.
export async function identifyMediaItems(files, source) {
  if (!Array.isArray(files) || !files.length || files.length > maxPublicationItems || files.some(file => !["image", "video"].includes(file.mediaKind))) {
    throw sourceIdentityError("MEDIA_SOURCE_UNVERIFIED", source.provider);
  }
  const nativeIds = new Set();
  for (const file of files) {
    if (file.sourceItemId !== undefined) {
      if (!validIdentity(file.sourceItemId) || (!file.sourceItemId.startsWith("sha256:") && nativeIds.has(file.sourceItemId))) throw sourceIdentityError("MEDIA_SOURCE_UNVERIFIED", source.provider);
      nativeIds.add(file.sourceItemId);
    } else {
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(file.filePath)) hash.update(chunk);
      file.sourceItemId = `sha256:${hash.digest("hex")}`;
    }
  }
  return mediaItemSnapshot(files);
}

export function mediaItemSnapshot(files) {
  return files.map(({ sourceItemId, mediaKind }) => ({ sourceItemId, mediaKind }));
}

export function assertSameMediaItems(expected, actual, provider) {
  // Old prepared entries remain reusable. Fresh replacement cannot retroactively
  // certify a legacy album by its positions, count or prepared-file hashes.
  if (!Array.isArray(expected) || !expected.length || expected.some(item => !validIdentity(item.sourceItemId))) {
    throw sourceIdentityError("MEDIA_SOURCE_UNVERIFIED", provider);
  }
  if (expected.length !== actual.length || expected.some((item, index) =>
    item.sourceItemId !== actual[index].sourceItemId || item.mediaKind !== actual[index].mediaKind)) {
    throw sourceIdentityError("MEDIA_SOURCE_MISMATCH", provider);
  }
}

export function hasMediaItemIdentity(files) {
  return Array.isArray(files) && files.length > 0 && files.every(item => validIdentity(item.sourceItemId));
}
