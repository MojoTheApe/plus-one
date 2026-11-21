import assert from "node:assert/strict";
import test from "node:test";
import {
  formatSocialVideoCaption,
  formatSocialVideoError,
  extractSnapinstaMediaUrls,
  extractThreadsPostFromHtml,
  selectSocialMediaFiles,
  uniqueMediaFiles,
  inferRemoteMediaKind,
  isSocialVideoDurationLimitError,
  isThreadsSocialVideoUrl,
  mediaExtensionForMimeType,
  normalizeMediaMimeType,
  normalizeSocialMediaUrl,
  shouldReportSocialVideoFailure,
  socialVideoDurationLimitError,
  socialVideoOpsComponent,
} from "../src/social-video.js";

test("formatSocialVideoCaption includes title and host", () => {
  assert.equal(
    formatSocialVideoCaption("https://www.instagram.com/reel/abc", "  Nice   Reel "),
    "Nice Reel\ninstagram.com",
  );
  assert.equal(formatSocialVideoCaption("not-url", ""), "Video from video");
});

test("formatSocialVideoError maps operational failures to safe user messages", () => {
  const options = { maxDurationSeconds: 600 };
  assert.match(formatSocialVideoError({ code: "SOCIAL_VIDEO_PROVIDER_COOLDOWN" }, options), /тимчасово недоступний/);
  assert.match(formatSocialVideoError(new Error("AbortError: aborted"), options), /занадто довго/);
  assert.match(formatSocialVideoError(new Error("video is longer than 600 seconds"), options), /10 хв/);
  assert.match(formatSocialVideoError(new Error("ffprobe missing"), options), /перевірка медіафайлів/);
  assert.match(formatSocialVideoError(new Error("unknown provider failure"), options), /Не вдалося завантажити/);
});

test("social video duration limit error carries stable code", () => {
  const error = socialVideoDurationLimitError(600);
  assert.equal(error.code, "SOCIAL_VIDEO_DURATION_LIMIT");
  assert.equal(isSocialVideoDurationLimitError(error), true);
  assert.equal(isSocialVideoDurationLimitError(new Error("video is longer than expected")), true);
});

test("social media Ops classification reports unexpected failures without alerting on expected limits", () => {
  assert.equal(shouldReportSocialVideoFailure(Object.assign(new Error("Threads fetch returned no media"), { code: "THREADS_MEDIA_NOT_FOUND" })), true);
  assert.equal(shouldReportSocialVideoFailure(new Error("provider timed out")), true);
  assert.equal(shouldReportSocialVideoFailure(new Error("Requested content is not available, login required")), false);
  assert.equal(shouldReportSocialVideoFailure(new Error("remote media exceeds Telegram file limit")), false);
  assert.equal(shouldReportSocialVideoFailure(Object.assign(new Error("cooling down"), { code: "SOCIAL_VIDEO_PROVIDER_COOLDOWN" })), false);
  assert.equal(socialVideoOpsComponent("threads"), "social-media-threads");
  assert.equal(socialVideoOpsComponent("unexpected/provider"), "social-media-unknown");
});

test("social URL helpers classify supported hosts", () => {
  assert.equal(isThreadsSocialVideoUrl("https://threads.net/@u/post/abc"), true);
});

test("normalizeSocialMediaUrl handles escaped social URLs", () => {
  assert.equal(
    normalizeSocialMediaUrl("https:\\/\\/scontent.cdninstagram.com\\/v\\/file.mp4?x=1\\u0026dl=1"),
    "https://scontent.cdninstagram.com/v/file.mp4?x=1&dl=1",
  );
});

test("extractSnapinstaMediaUrls finds direct and token media URLs", () => {
  const tokenPayload = Buffer.from(JSON.stringify({ url: "https://cdn.example.com/video.mp4", filename: "video.mp4" })).toString("base64url");
  const html = `<a href="https://d.rapidcdn.app/file.mp4">download</a> https://example.com/?token=${tokenPayload}`;
  assert.deepEqual(extractSnapinstaMediaUrls(html), [
    "https://d.rapidcdn.app/file.mp4",
    "https://cdn.example.com/video.mp4",
  ]);
});

test("extractThreadsPostFromHtml chooses matching post and best media", () => {
  const html = `<script type="application/json">${JSON.stringify({
    data: {
      code: "abc123",
      user: { username: "user" },
      caption: { text: "Hello Threads" },
      video_versions: [
        { url: "https://scontent-lax3-1.cdninstagram.com/o1/v/t16/low.mp4", width: 320, height: 568 },
        { url: "https://scontent-lax3-1.cdninstagram.com/o1/v/t16/high.mp4", width: 720, height: 1280 },
      ],
    },
  })}</script>`;

  assert.deepEqual(extractThreadsPostFromHtml(html, "https://threads.net/@user/post/abc123"), {
    mediaUrls: ["https://scontent-lax3-1.cdninstagram.com/o1/v/t16/high.mp4"],
    caption: "Hello Threads",
  });
});
test('a short Threads URL can use its exact public video metadata and a changed CDN host',()=>{
  const html='<meta property="og:url" content="https://www.threads.com/@user/post/abc123"><meta property="og:video" content="https://scontent.example.fbcdn.net/video.mp4"><meta property="og:description" content="A public clip">';
  assert.deepEqual(extractThreadsPostFromHtml(html,'https://www.threads.com/share/short'),{mediaUrls:['https://scontent.example.fbcdn.net/video.mp4'],caption:'A public clip'});
  assert.equal(extractThreadsPostFromHtml(html,'https://www.threads.com/@user/post/different').mediaUrls.length,0);
});
test('a Threads payload belonging to a different author cannot replace the requested post',()=>{
  const html=`<script type="application/json">${JSON.stringify({code:'abc123',user:{username:'other'},video_versions:[{url:'https://scontent-one.cdninstagram.com/file.mp4'}]})}</script>`;
  assert.equal(extractThreadsPostFromHtml(html,'https://www.threads.com/@user/post/abc123').mediaUrls.length,0);
});

test("Threads chooses the complete compatible native carousel independently of script order", () => {
  const source = "https://www.threads.com/@fixture/post/test/";
  const base = {code:"test", user:{username:"fixture"}};
  const pic = name => ({ media_type:1, image_versions2:{candidates:[{url:"https://scontent-test.cdninstagram.com/" + name + ".jpg"}]} });
  const video = {media_type:2, video_versions:[{url:"https://scontent-test.cdninstagram.com/two.mp4"}]};
  const first = pic("one"), card = {...base,...first};
  const full = {...base, media_type:8, carousel_media_count:2, carousel_media:[first,video], caption:{text:"Album"}};
  const parse = posts => extractThreadsPostFromHtml(posts.map(p => '<script type="application/json">' + JSON.stringify(p) + '</script>').join(''), source);
  const expected = [first.image_versions2.candidates[0].url, video.video_versions[0].url];
  for (const variant of [card, {...full,carousel_media:[first]}, {...full,carousel_media:undefined}, structuredClone(full)]) {
    for (const pair of [[variant,full],[full,variant]]) assert.deepEqual(parse(pair), {mediaUrls:expected,caption:"Album"});
  }
  const headed = {...full,carousel_media:[{...first,pk:"1"},{...video,pk:"2"}]};
  const conflicts = [
    {...card,...pic("different-cover")}, {...full,carousel_media_count:3},
    {...full,carousel_media:[video,first]}, {...full,carousel_media:[{...first,pk:"other"},video]},
    {...full,carousel_media:[first,{...pic("two")}]},
  ];
  for (const other of conflicts) {
    for (const pair of [[other,headed],[headed,other]]) {
      assert.throws(() => parse(pair), error => error.code === "MEDIA_SOURCE_UNVERIFIED");
    }
  }
});

test("media type helpers infer kind, mime, and extension", () => {
  assert.equal(inferRemoteMediaKind("https://example.com/photo.webp", ""), "image");
  assert.equal(inferRemoteMediaKind("https://d.rapidcdn.app/file", "application/octet-stream"), "video");
  assert.equal(normalizeMediaMimeType("video/mp4; charset=utf-8", "video"), "video/mp4");
  assert.equal(normalizeMediaMimeType("application/octet-stream", "image"), "image/jpeg");
  assert.equal(mediaExtensionForMimeType("video/quicktime"), "mov");
});

test("uniqueMediaFiles removes duplicate hashes and size keys", () => {
  const files = [
    { hash: "a", size: 1, mimeType: "image/jpeg" },
    { hash: "a", size: 2, mimeType: "image/jpeg" },
    { size: 3, mimeType: "video/mp4" },
    { size: 3, mimeType: "video/mp4" },
  ];

  assert.deepEqual(uniqueMediaFiles(files), [files[0], files[2]]);
});

test("selectSocialMediaFiles keeps Threads items and Instagram carousel images", async () => {
  const files = [
    { mediaKind: "image", hash: "a", size: 10 },
    { mediaKind: "image", hash: "b", size: 20 },
    { mediaKind: "image", hash: "c", size: 30 },
  ];

  assert.deepEqual(await selectSocialMediaFiles(files, 3, "https://threads.net/@user/post/abc"), files);
  await assert.rejects(selectSocialMediaFiles(files, 2, "https://threads.net/@user/post/abc"), { code: "MEDIA_SOURCE_UNVERIFIED" });
  assert.deepEqual(await selectSocialMediaFiles(files, 2, "https://www.instagram.com/p/abc/"), [files[0], files[1]]);
});

test("selectSocialMediaFiles prefers audio videos and vertical reel quality", async () => {
  const wideAudio = { mediaKind: "video", hasAudio: true, hash: "wide", size: 100, width: 1280, height: 720 };
  const verticalAudio = { mediaKind: "video", hasAudio: true, hash: "vertical", size: 50, width: 720, height: 1280 };
  const silentVertical = { mediaKind: "video", hasAudio: false, hash: "silent", size: 200, width: 720, height: 1280 };

  assert.deepEqual(
    await selectSocialMediaFiles([wideAudio, verticalAudio, silentVertical], 3, "https://www.instagram.com/reel/abc/"),
    [verticalAudio],
  );
  assert.deepEqual(await selectSocialMediaFiles([wideAudio, verticalAudio], 3, "https://example.com/video"), [wideAudio]);
});

test("selectSocialMediaFiles chooses largest image for normal posts", async () => {
  const small = { mediaKind: "image", hash: "small", size: 10 };
  const large = { mediaKind: "image", hash: "large", size: 20 };

  assert.deepEqual(await selectSocialMediaFiles([small, large], 3, "https://example.com/post"), [large]);
});
