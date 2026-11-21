import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MediaOperations } from "../src/media-operations.js";
import {
  createSocialDownloader,
  downloadRemoteBinaryFile,
  downloadRemoteMediaFile,
  downloadInstagramWithSnapinsta,
  downloadSocialVideo,
  downloadSocialVideoWithYtDlp,
  downloadTikTokWithFallbackApi,
  downloadThreadsFromPage,
  fetchWithTimeout,
  inspectSocialVideo,
  selectFallback,
  downloadInstagramPost,
  resolveSocialMediaUrl,
} from "../src/social-downloader.js";
import { mediaFailure, failureMessage } from "../src/media-operations.js";

test('a transient native metadata failure recovers once and still verifies the exact requested publication', async () => {
  let inspections = 0, downloads = 0;
  const first = Object.assign(new Error('upstream busy'), { status: 503 });
  const result = await downloadSocialVideoWithYtDlp('https://www.instagram.com/reel/recovery/', '/tmp/social', {
    ...baseDeps(mockFs()),
    execFileAsync: async (_command, args) => {
      if (args.includes('--dump-single-json')) {
        if (++inspections === 1) throw first;
        return { stdout: JSON.stringify({ extractor_key: 'Instagram', id: 'recovery', duration: 1 }) };
      }
      downloads++; return { stdout: '' };
    },
    findDownloadedVideo: async () => ({ filePath: '/tmp/social/recovery.mp4', size: 100 }),
  });
  assert.equal(inspections, 2); assert.equal(downloads, 1);
  assert.equal(result.source.status, 'verified'); assert.equal(result.source.resolved.id, 'recovery');
  assert.equal(result.previousFailure, first);
});

test('persistent native throttling stays retryable and the disabled fallback never replaces it', async () => {
  let inspections = 0, fetches = 0;
  const deps = { ...baseDeps(mockFs()),
    execFileAsync: async () => { inspections++; throw Object.assign(new Error('upstream busy'), { status: 429 }); },
    shouldTryInstagramFallback: () => true,
    fetch: async () => { fetches++; throw new Error('No external fallback transfer'); },
  };
  deps.downloadInstagram = (url, dir) => downloadInstagramWithSnapinsta(url, dir, deps);
  await assert.rejects(downloadSocialVideo('https://www.instagram.com/reel/recovery/', deps), error => {
    const failure = mediaFailure(error);
    assert.equal(failure.code, 'RATE_LIMIT'); assert.equal(failure.retryable, true);
    assert.equal(failure.causes, undefined);
    assert.doesNotMatch(failureMessage(failure), /SOURCE_UNVERIFIED|неперевірен/);
    return true;
  });
  assert.equal(inspections, 1); assert.equal(fetches, 0);
});

test('native retry never repeats authentication, absent media or identity failures', async () => {
  for (const message of ['Login required', 'No video formats found', 'Unsupported URL']) {
    let inspections = 0;
    const error = new Error(message);
    await assert.rejects(downloadSocialVideoWithYtDlp('https://www.instagram.com/reel/recovery/', '/tmp/social', {
      ...baseDeps(mockFs()), execFileAsync: async () => { inspections++; throw error; },
    }), candidate => candidate === error);
    assert.equal(inspections, 1);
  }
  let calls = 0;
  await assert.rejects(downloadSocialVideoWithYtDlp('https://www.instagram.com/reel/recovery/', '/tmp/social', {
    ...baseDeps(mockFs()), execFileAsync: async () => { calls++; return { stdout: JSON.stringify({ extractor_key: 'Instagram', id: 'wrong' }) }; },
  }), { code: 'MEDIA_SOURCE_MISMATCH' });
  assert.equal(calls, 1);
});

test('insufficient total budget skips the metadata retry without starting another extractor', async () => {
  const files = mockFs(); let calls = 0, fallbacks = 0;
  const downloader = createSocialDownloader({ ...baseDeps(files), totalTimeoutMs: 30,
    execFileAsync: async () => { calls++; throw Object.assign(new Error('upstream busy'), { status: 429 }); },
    shouldTryInstagramFallback: () => true,
    downloadInstagram: async () => { fallbacks++; throw new Error('unused'); },
  });
  await assert.rejects(downloader.download('https://www.instagram.com/reel/recovery/'), error => mediaFailure(error).code === 'RATE_LIMIT');
  assert.equal(calls, 1); assert.equal(fallbacks, 0); assert.equal(files.removed.length, 1);
});

test('cancellation during metadata backoff stops before a second extractor or any download', async () => {
  const controller = new AbortController(); let calls = 0;
  const timer = setTimeout(() => controller.abort(), 30);
  try {
    await assert.rejects(downloadSocialVideoWithYtDlp('https://www.instagram.com/reel/recovery/', '/tmp/social', {
      ...baseDeps(mockFs()), signal: controller.signal,
      execFileAsync: async () => { calls++; throw Object.assign(new Error('upstream busy'), { status: 503 }); },
    }), { name: 'AbortError' });
    assert.equal(calls, 1);
  } finally { clearTimeout(timer); }
});

test('replay: Threads login redirect is diagnosed as authentication, not a timeout or missing media', async()=>{
  const response=new Response('<html>login</html>');Object.defineProperty(response,'url',{value:'https://www.threads.com/login/'});
  await assert.rejects(downloadThreadsFromPage('https://www.threads.com/share/example','/tmp/threads',{
    ...baseDeps(mockFs()),fetch:async()=>response,
  }),/authentication required/);
});
test('a Threads page with disabled server content reports its actual restriction, never an unsupported video format',async()=>{
  await assert.rejects(downloadThreadsFromPage('https://www.threads.com/@user/post/abc','/tmp/threads',{
    ...baseDeps(mockFs()),fetch:async()=>new Response('<script type="application/json">{"status":"fail_ssr_disabled"}</script>'),
  }),error=>error.code==='THREADS_RENDER_UNAVAILABLE');
  let extractorCalls=0;
  const result=await downloadSocialVideo('https://www.threads.com/share/fixture',{
    ...baseDeps(mockFs()),execFileAsync:async()=>{extractorCalls++;throw new Error('unsupported URL');},
    downloadThreads:async()=>({files:[],title:'Actual page result'}),
  });
  assert.equal(extractorCalls,0);assert.equal(result.title,'Actual page result');
});
test('the primary downloader accepts a valid video without an audio track',async()=>{
  const result=await downloadSocialVideoWithYtDlp('https://www.instagram.com/reel/silent','/tmp/social',{
    ...baseDeps(mockFs()),execFileAsync:async(_file,args)=>({stdout:args.includes('--dump-single-json')?JSON.stringify({extractor_key:'Instagram',id:'silent',channel:'fixture',duration:1}):''}),
    findDownloadedVideo:async()=>({filePath:'/tmp/social/silent.mp4',size:100}),
    validateDownloadedVideo:async(_file,options)=>{assert.equal(options.requireAudio,false);return {hasAudio:false,duration:1};},
  });
  assert.equal(result.mediaKind,'video');
});

test('one download budget aborts a running extractor and cleans its temporary directory', async()=>{
  const files=mockFs();
  const downloader=createSocialDownloader({...baseDeps(files),totalTimeoutMs:20,
    execFileAsync:async(_file,_args,options)=>new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(Object.assign(new Error('aborted'),{name:'AbortError'})),{once:true})),
  });
  await assert.rejects(downloader.download('https://example.com/video'),error=>error.code==='SOCIAL_DOWNLOAD_TIMEOUT');
  assert.equal(files.removed.length,1);
});

test("selectFallback chooses providers in expected order", () => {
  const deps = {
    shouldTryTikTokFallback: () => false,
    shouldTryInstagramFallback: () => true,
    shouldTryThreadsFallback: () => true,
    downloadInstagram: () => {},
  };

  assert.equal(selectFallback("https://example.com", deps).provider, "threads");
  deps.shouldTryThreadsFallback = () => false;
  assert.equal(selectFallback("https://www.instagram.com/p/fixture/", deps), null);
});

test("downloadSocialVideo returns primary downloader result without fallback", async () => {
  const fsMock = mockFs();
  const result = await downloadSocialVideo("https://www.instagram.com/reel/primary/", {
    ...baseDeps(fsMock),
    execFileAsync: async (_command, args) => {
      if (args.includes("--dump-single-json")) return { stdout: JSON.stringify({ extractor_key: "Instagram", id: "primary", title: "primary", duration: 12 }) };
      return { stdout: "" };
    },
    findDownloadedVideo: async (tempDir) => ({ filePath: `${tempDir}/video.mp4`, size: 1024 }),
    validateDownloadedVideo: async () => ({ hasAudio: true, duration: 12, width: 720, height: 1280 }),
  });

  assert.equal(result.title, "primary");
  assert.equal(fsMock.removed.length, 0);
});

test("downloadSocialVideo uses fallback and records provider cooldown failures", async () => {
  const fsMock = mockFs();
  const circuitByProvider = new Map();

  await assert.rejects(
    downloadSocialVideo("https://example.com/video", {
      ...baseDeps(fsMock),
      circuitByProvider,
      circuitFailureThreshold: 1,
      execFileAsync: async () => {
        throw new Error("primary failed");
      },
      shouldTryTikTokFallback: () => true,
      downloadTikTok: async () => {
        throw Object.assign(new Error("fallback failed"), { status: 503 });
      },
    }),
    /fallback failed/,
  );

  assert.equal(circuitByProvider.get("tiktok").failures, 1);
  assert.equal(fsMock.removed.length, 1);
});

test("downloadSocialVideo blocks open fallback circuit", async () => {
  const fsMock = mockFs();
  const circuitByProvider = new Map([["tiktok", { failures: 3, openedUntil: Date.now() + 60000 }]]);

  await assert.rejects(
    downloadSocialVideo("https://example.com/video", {
      ...baseDeps(fsMock),
      circuitByProvider,
      execFileAsync: async () => {
        throw new Error("primary failed");
      },
      shouldTryTikTokFallback: () => true,
    }),
    /cooling down/,
  );
});

test("one inaccessible publication cannot open the provider circuit for other posts", async () => {
  const state = new Map(), downloader = createSocialDownloader({ ...baseDeps(mockFs()), circuitByProvider: state, circuitFailureThreshold: 1 });
  await assert.rejects(downloader.runFallback("threads", async () => { throw Object.assign(new Error("Login required"), { status: 401 }); }));
  assert.equal(state.has("threads"), false);
  assert.equal(await downloader.runFallback("threads", async () => "retrieved another post"), "retrieved another post");
});

test("stream validation triggers only one provider fallback and preserves both causes", async () => {
  let fallbackCalls = 0;
  const primary = new Error("downloaded media did not contain a video stream");
  await assert.rejects(downloadSocialVideo("https://www.tiktok.com/@u/video/1", {
    ...baseDeps(mockFs()),
    execFileAsync: async (_command, args) => args.includes("--dump-single-json")
      ? { stdout: JSON.stringify({ extractor_key: "TikTok", id: "1", uploader: "u", duration: 2 }) } : { stdout: "" },
    findDownloadedVideo: async () => ({ filePath: "/tmp/source.mp4", size: 100 }),
    validateDownloadedVideo: async () => { throw primary; },
    isTikTokUrl: () => true,
    shouldTryTikTokFallback: () => true,
    downloadTikTok: async () => { fallbackCalls++; throw new Error("fallback returned no media"); },
  }), error => {
    assert.equal(error.cause, primary);
    assert.equal(error.attempts.length, 2);
    assert.equal(error.attempts[1].provider, "tiktok");
    return true;
  });
  assert.equal(fallbackCalls, 1);
});

test("inspectSocialVideo and downloadSocialVideoWithYtDlp call yt-dlp with expected args", async () => {
  const calls = [];
  const deps = {
    ...baseDeps(mockFs()),
    execFileAsync: async (command, args) => {
      calls.push({ command, args });
      if (args.includes("--dump-single-json")) return { stdout: JSON.stringify({ extractor_key: "Instagram", id: "abc", title: "clip", duration: 5 }) };
      return { stdout: "" };
    },
    findDownloadedVideo: async (tempDir) => ({ filePath: `${tempDir}/clip.mp4`, size: 4096 }),
    validateDownloadedVideo: async () => ({ hasAudio: true, duration: 5, width: 640, height: 360 }),
  };

  const url = "https://www.instagram.com/reel/abc";
  assert.deepEqual(await inspectSocialVideo(url, deps), { extractor_key: "Instagram", id: "abc", title: "clip", duration: 5 });
  const result = await downloadSocialVideoWithYtDlp(url, "/tmp/social", deps);

  assert.equal(result.title, "clip");
  assert.equal(calls[0].command, "yt-dlp");
  assert.equal(calls[0].args.includes("--dump-single-json"), true);
  assert.equal(calls[1].args.includes("--dump-single-json"), true);
  assert.equal(calls[2].args.includes("--max-filesize"), true);
  assert.equal(calls[2].args.includes("--merge-output-format"), true);
  assert.equal(calls[2].args.includes("--load-info-json"), true);
  assert.equal(calls[2].args.includes(url), false, "The download consumes verified metadata instead of extracting the URL again");
});

test("Instagram photos and mixed albums preserve native identity and order without an unbound fallback", async () => {
  const storage = mockFs(), fetched = [];
  const manifest = { id: "BA", publicationId: "64", owner: "fixture", url: "https://www.instagram.com/p/BA/", title: "Original title", count: 2,
    items: [{ index: 0, mediaId: "100", kind: "image", url: "https://scontent.example.cdninstagram.com/photo.jpg" },
      { index: 1, mediaId: "101", kind: "video", url: "https://video.example.fbcdn.net/clip.mp4" }] };
  const deps = { ...baseDeps(storage), instagramScript: "/adapter.py", execFileAsync: async () => ({ stdout: JSON.stringify(manifest) }),
    fetch: async url => { fetched.push(url); return mockResponse({ headers: { "content-type": url.endsWith("jpg") ? "image/jpeg" : "video/mp4" } }); } };
  const result = await downloadInstagramPost("https://www.instagram.com/p/BA/?igsh=tracking", "/tmp/social", deps);
  assert.equal(result.source.status, "verified"); assert.equal(result.source.provider, "instaloader");
  assert.deepEqual(result.files.map(file => file.mediaKind), ["image", "video"]);
  assert.deepEqual(result.files.map(file => file.sourceItemId), ["native:100", "native:101"]);
  assert.deepEqual(fetched, manifest.items.map(item => item.url));
  manifest.publicationId = "65"; fetched.length = 0;
  await assert.rejects(downloadInstagramPost("https://www.instagram.com/p/BA/", "/tmp/social", deps), { code: "MEDIA_SOURCE_UNVERIFIED" });
  assert.deepEqual(fetched, []);
  manifest.publicationId = "64"; manifest.items[0].url = "https://unrelated.example/preview.jpg";
  await assert.rejects(downloadInstagramPost("https://www.instagram.com/p/BA/", "/tmp/social", deps), { code: "MEDIA_SOURCE_UNVERIFIED" });
  assert.deepEqual(fetched, []);
});

test("short links resolve only inside their platform and retain a native post key", async () => {
  const visited = [];
  const deps = { httpTimeoutMs: 1000, fetch: async (url, options) => {
    visited.push(url); assert.equal(options.redirect, "manual");
    return new Response(null, { status: 302, headers: { location: "https://www.instagram.com/p/BA/?igsh=two" } });
  } };
  assert.equal(await resolveSocialMediaUrl("https://www.instagram.com/share/fixture/", deps), "https://www.instagram.com/p/BA/?igsh=two");
  assert.equal(visited.length, 1);
  deps.fetch = async () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1/private" } });
  await assert.rejects(resolveSocialMediaUrl("https://www.instagram.com/share/fixture/", deps), { code: "MEDIA_SOURCE_MISMATCH" });
});

test("source throttling is shared across URLs and survives a downloader and journal restart", async t => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "source-backoff-"));
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  let calls = 0;
  const make = () => createSocialDownloader({ ...baseDeps(mockFs()), journal: new MediaOperations(path.join(directory, "operations.json")),
    execFileAsync: async () => { calls++; throw Object.assign(new Error("Busy"), { status: 429, retryAfterSeconds: 120 }); } });
  await assert.rejects(make().download("https://www.instagram.com/reel/first/"), error => mediaFailure(error).code === "RATE_LIMIT");
  await assert.rejects(make().download("https://www.instagram.com/reel/second/"), error => error.code === "SOCIAL_VIDEO_PROVIDER_COOLDOWN" && error.retryAfterSeconds > 100);
  assert.equal(calls, 1);
  const state = await new MediaOperations(path.join(directory, "operations.json")).sourceState("instagram");
  assert.ok(state.notBefore > Date.now() + 100000);
});

test("remote media streams to a private file and an oversized body is cancelled and removed", async t => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "stream-media-"));
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  let cancelled = false, index = 0;
  const response = { ok: true, headers: new Headers({ "content-type": "image/jpeg" }), body: { getReader: () => ({
    read: async () => index++ < 3 ? { value: Buffer.alloc(3), done: false } : { done: true }, cancel: async () => { cancelled = true; },
  }) } };
  await assert.rejects(downloadRemoteMediaFile("https://cdn.example/photo.jpg", directory, "bounded", "", "image", {
    ...baseDeps(fs), fs, maxBytes: 5, fetch: async () => response,
  }), /exceeds/);
  assert.equal(cancelled, true);
  assert.deepEqual(await fs.promises.readdir(directory), []);
});

test("downloadSocialVideoWithYtDlp rejects live and overlong videos", async () => {
  await assert.rejects(
    downloadSocialVideoWithYtDlp("https://example.com/live", "/tmp/social", {
      ...baseDeps(mockFs()),
      execFileAsync: async () => ({ stdout: JSON.stringify({ is_live: true }) }),
    }),
    /live videos/,
  );

  await assert.rejects(
    downloadSocialVideoWithYtDlp("https://example.com/long", "/tmp/social", {
      ...baseDeps(mockFs()),
      execFileAsync: async () => ({ stdout: JSON.stringify({ duration: 9999 }) }),
    }),
    /duration limit/,
  );
});

test("downloadRemoteMediaFile writes media and returns metadata", async () => {
  const fsMock = mockFs();
  const deps = {
    ...baseDeps(fsMock),
    fetch: async () => mockResponse({
      headers: {
        "content-type": "image/jpeg",
        "content-length": "4",
      },
      chunks: [Buffer.from("test")],
    }),
    maxBytes: 10,
  };

  const result = await downloadRemoteMediaFile("https://example.com/photo.jpg", "/tmp/media", "photo", "https://ref", "", deps);

  assert.equal(result.filePath, "/tmp/media/photo.jpg");
  assert.equal(result.mediaKind, "image");
  assert.equal(result.mimeType, "image/jpeg");
  assert.equal(result.size, 4);
  assert.equal(fsMock.writes.get("/tmp/media/photo.jpg").toString(), "test");
});

test("downloadRemoteMediaFile rejects oversized content length and HTML", async () => {
  await assert.rejects(
    downloadRemoteMediaFile("https://example.com/big.mp4", "/tmp/media", "big", "", "", {
      ...baseDeps(mockFs()),
      fetch: async () => mockResponse({ headers: { "content-length": "99", "content-type": "video/mp4" } }),
      maxBytes: 10,
    }),
    /exceeds/,
  );

  await assert.rejects(
    downloadRemoteMediaFile("https://example.com/page", "/tmp/media", "page", "", "", {
      ...baseDeps(mockFs()),
      fetch: async () => mockResponse({ headers: { "content-type": "text/html" }, chunks: [Buffer.from("<html>")] }),
    }),
    /HTML/,
  );
});

test("downloadRemoteBinaryFile writes raw bytes", async () => {
  const fsMock = mockFs();
  await downloadRemoteBinaryFile("https://example.com/audio.mp3", "/tmp/audio.mp3", { accept: "audio/*" }, {
    ...baseDeps(fsMock),
    fetch: async () => mockResponse({ chunks: [Buffer.from("audio")] }),
  });

  assert.equal(fsMock.writes.get("/tmp/audio.mp3").toString(), "audio");
});

test("fetchWithTimeout forwards abort signal to fetch implementation", async () => {
  let sawSignal = false;
  await fetchWithTimeout("https://example.com", {}, 1000, async (_url, options) => {
    sawSignal = Boolean(options.signal);
    return mockResponse();
  });
  assert.equal(sawSignal, true);
});

test("unbound Instagram fallback refuses the request before third-party transfer or any media download", async () => {
  let calls=0;
  for(const url of ['https://www.instagram.com/stories/fixture/64/','https://www.instagram.com/reel/abc/','https://www.instagram.com/p/abc/']) {
    await assert.rejects(downloadInstagramWithSnapinsta(url,'/tmp/social',{
      ...baseDeps(mockFs()),fetch:async()=>{calls++;throw new Error('Must not send the input to this unbound provider');},
    }),{code:'MEDIA_SOURCE_UNVERIFIED'});
  }
  assert.equal(calls,0);
});

test("downloadThreadsFromPage fetches page, downloads media, and uses caption", async () => {
  const fsMock = mockFs();
  const calls = [];
  const html = `<script type="application/json">${JSON.stringify({
    data: {
      code: "abc",
      user: { username: "user" },
      caption: { text: "Thread caption" },
      video_versions: [{ url: "https://scontent-lax3-1.cdninstagram.com/o1/v/t16/high.mp4", width: 720, height: 1280 }],
    },
  })}</script>`;
  const result = await downloadThreadsFromPage("https://www.threads.net/@user/post/abc", "/tmp/social", {
    ...baseDeps(fsMock),
    fetch: async (url, options = {}) => {
      calls.push({ url: String(url), options });
      if (calls.length === 1) return mockTextResponse(html);
      return mockResponse({
        headers: {
          "content-type": "video/mp4",
          "content-length": "6",
        },
        chunks: [Buffer.from("thread")],
      });
    },
  });

  assert.equal(result.title, "Thread caption");
  assert.equal(result.files[0].hasAudio, true);
  assert.equal(calls[0].options.headers.accept, "text/html");
  assert.equal(calls[1].options.headers.referer, "https://www.threads.net/@user/post/abc");
});

test("downloadThreadsFromPage rejects empty media responses", async () => {
  await assert.rejects(
    downloadThreadsFromPage("https://www.threads.net/@user/post/abc", "/tmp/social", {
      ...baseDeps(mockFs()),
      fetch: async () => mockTextResponse("<html></html>"),
    }),
    /returned no media/,
  );
});

test("downloadThreadsFromPage parses and references the final permalink after a share redirect", async () => {
  const fsMock = mockFs();
  const calls = [];
  const finalUrl = "https://www.threads.com/@user/post/abc";
  const html = `<script type="application/json">${JSON.stringify({
    data: {
      code: "abc",
      user: { username: "user" },
      caption: { text: "Redirected thread" },
      video_versions: [{ url: "https://scontent-lax3-1.cdninstagram.com/o1/v/t16/video.mp4", width: 720, height: 1280 }],
    },
  })}</script>`;

  const result = await downloadThreadsFromPage("https://www.threads.com/share/example/", "/tmp/social", {
    ...baseDeps(fsMock),
    fetch: async (url, options = {}) => {
      calls.push({ url: String(url), options });
      if (calls.length === 1) return mockTextResponse(html, { url: finalUrl });
      return mockResponse({
        headers: { "content-type": "video/mp4", "content-length": "6" },
        chunks: [Buffer.from("thread")],
      });
    },
  });

  assert.equal(result.title, "Redirected thread");
  assert.equal(calls[1].options.headers.referer, finalUrl);
});

test("downloadTikTokWithFallbackApi downloads image carousels", async () => {
  const fsMock = mockFs();
  const calls = [];
  const result = await downloadTikTokWithFallbackApi("https://www.tiktok.com/@u/video/1", "/tmp/social", "", {
    ...baseDeps(fsMock),
    fetch: async (url, options = {}) => {
      calls.push({ url: String(url), options });
      if (calls.length === 1) {
        return mockJsonResponse({
          code: 0,
          data: {
            id: "1", author: { unique_id: "u" }, title: "Photo set",
            images: ["https://cdn.example.com/a.jpg", "https://cdn.example.com/a.jpg", "https://cdn.example.com/b.jpg"],
          },
        });
      }
      return mockResponse({
        headers: {
          "content-type": "image/jpeg",
          "content-length": "5",
        },
        chunks: [Buffer.from("image")],
      });
    },
  });

  assert.equal(result.title, "Photo set");
  assert.equal(result.files.length, 2);
  assert.equal(result.files[0].title, "TikTok image");
  assert.match(calls[0].url, /^https:\/\/tikwm\.test\/api\/\?url=/);
});

for (const provider of ['tiktok', 'threads']) {
  test(`${provider}: a failed selected item cannot become a verified complete album; successful selection keeps native order and cap`, async () => {
    const media = ['https://scontent.example.fbcdn.net/first.jpg','https://scontent.example.fbcdn.net/second.jpg','https://scontent.example.fbcdn.net/third.jpg'];
    for (const fail of [true,false]) {
      const calls=[],files=mockFs();
      const deps={...baseDeps(files),fetch:async url=>{
        calls.push(String(url));
        if(calls.length===1) return provider==='tiktok'
          ? mockJsonResponse({code:0,data:{id:'1',author:{unique_id:'u'},images:media}})
          : mockTextResponse(`<script type="application/json">${JSON.stringify({code:'abc',user:{username:'u'},carousel_media:media.map(url=>({image_versions2:{candidates:[{url,width:100,height:100}]}}))})}</script>`);
        if(fail&&String(url)===media[0])return mockResponse({ok:false,status:503});
        return mockResponse({headers:{'content-type':'image/jpeg'},chunks:[Buffer.from(String(url).includes('first')?'first':'second')]});
      }};
      const retrieve=()=>provider==='tiktok'
        ? downloadTikTokWithFallbackApi('https://www.tiktok.com/@u/photo/1','/tmp/social','',deps)
        : downloadThreadsFromPage('https://www.threads.com/@u/post/abc','/tmp/social',deps);
      if(fail){await assert.rejects(retrieve(),error=>error.status===503);assert.equal(calls.length,2);}
      else{const result=await retrieve();assert.deepEqual(calls.slice(1),media.slice(0,2));assert.equal(result.files.length,2);assert.deepEqual(result.files.map(file=>files.writes.get(file.filePath).toString()),['first','second']);}
    }
  });
}

test("downloadTikTokWithFallbackApi downloads and validates video", async () => {
  const fsMock = mockFs();
  let requestCount = 0;
  const result = await downloadTikTokWithFallbackApi("https://www.tiktok.com/@u/video/1", "/tmp/social", "Hint title", {
    ...baseDeps(fsMock),
    fetch: async () => {
      requestCount += 1;
      if (requestCount === 1) {
        return mockJsonResponse({
          code: 0,
          data: {
            id: "1", author: { unique_id: "u" }, play: "https://cdn.example.com/video.mp4",
          },
        });
      }
      return mockResponse({
        headers: {
          "content-type": "video/mp4",
          "content-length": "5",
        },
        chunks: [Buffer.from("video")],
      });
    },
  });

  assert.equal(result.title, "Hint title");
  assert.equal(result.files[0].mediaKind, "video");
  assert.equal(result.files[0].hasAudio, true);
});

test('structured fallback checks the returned item and account before downloading any files',async()=>{
  for(const data of [{id:'2',author:{unique_id:'u'}},{id:'1',author:{unique_id:'other'}},{title:'Only an echoed request'}]){
    let calls=0;
    await assert.rejects(downloadTikTokWithFallbackApi('https://www.tiktok.com/@u/video/1','/tmp/social','',{
      ...baseDeps(mockFs()),fetch:async()=>{calls++;return mockJsonResponse({code:0,data:{...data,play:'https://cdn.example.com/unrelated.mp4'}});},
    }),error=>['MEDIA_SOURCE_MISMATCH','MEDIA_SOURCE_UNVERIFIED'].includes(error.code));
    assert.equal(calls,1);
  }
});

test('a native preview-only page cannot stand in for post media or be served from a foreign redirect',async()=>{
  const html='<meta property="og:url" content="https://www.threads.com/@u/post/abc"><meta property="og:image" content="https://scontent.example.fbcdn.net/avatar.jpg">';
  for(const resolvedUrl of ['https://www.threads.com/@u/post/abc','https://unrelated.example/post/abc']){
    let calls=0;
    await assert.rejects(downloadThreadsFromPage('https://www.threads.com/@u/post/abc','/tmp/social',{
      ...baseDeps(mockFs()),fetch:async()=>{calls++;return mockTextResponse(html,{url:resolvedUrl});},
    }),{code:'MEDIA_SOURCE_UNVERIFIED'});assert.equal(calls,1);
  }
});

test("downloadTikTokWithFallbackApi rejects disabled and empty API responses", async () => {
  await assert.rejects(
    downloadTikTokWithFallbackApi("https://www.tiktok.com/@u/video/1", "/tmp/social", "", {
      ...baseDeps(mockFs()),
      tiktokFallbackApiUrl: "",
    }),
    /disabled/,
  );

  await assert.rejects(
    downloadTikTokWithFallbackApi("https://www.tiktok.com/@u/video/1", "/tmp/social", "", {
      ...baseDeps(mockFs()),
      fetch: async () => mockJsonResponse({ code: 1, msg: "nope" }),
    }),
    /nope/,
  );
});

function baseDeps(fsMock) {
  return {
    circuitByProvider: new Map(),
    circuitCooldownMs: 60000,
    circuitFailureThreshold: 3,
    cleanErrorMessage: (error) => error.message,
    downloader: "yt-dlp",
    durationLimitError: () => {
      const error = new Error("duration limit");
      error.code = "SOCIAL_VIDEO_DURATION_LIMIT";
      return error;
    },
    downloadInstagram: async (_url, tempDir) => ({ tempDir, title: "instagram" }),
    downloadThreads: async (_url, tempDir) => ({ tempDir, title: "threads" }),
    downloadTikTok: async (_url, tempDir) => ({ tempDir, title: "tiktok" }),
    execFileAsync: async () => {
      throw new Error("primary failed");
    },
    findDownloadedVideo: async () => null,
    fs: fsMock,
    isDurationLimitError: () => false,
    isTikTokUrl: () => false,
    logError: () => {},
    logInfo: () => {},
    maxBytes: 100 * 1024 * 1024,
    maxDurationSeconds: 600,
    rootDir: "/tmp",
    getMaxMediaItems: () => 2,
    selectMediaFiles: async (files) => files,
    shouldTryInstagramFallback: () => false,
    shouldTryThreadsFallback: () => false,
    shouldTryTikTokFallback: () => false,
    validateDownloadedVideo: async () => ({ hasAudio: true }),
    snapinstaBaseUrl: "https://snap.test",
    tiktokFallbackApiUrl: "https://tikwm.test/api/",
    uniqueMediaFiles: (files) => files,
  };
}

function mockFs() {
  const removed = [];
  const writes = new Map();
  return {
    removed,
    writes,
    promises: {
      mkdtemp: async (prefix) => `${prefix}mock`,
      rm: async (target) => {
        removed.push(target);
      },
      stat: async (target) => ({ size: writes.get(target)?.length || 0 }),
      writeFile: async (target, buffer) => {
        writes.set(target, Buffer.from(buffer));
      },
      open: async target => {
        writes.set(target, Buffer.alloc(0));
        return { writeFile: async chunk => writes.set(target, Buffer.concat([writes.get(target), Buffer.from(chunk)])), close: async () => {} };
      },
    },
  };
}

function mockResponse({ ok = true, status = 200, headers = {}, chunks = [Buffer.from("ok")] } = {}) {
  const entries = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  let index = 0;
  return {
    ok,
    status,
    headers: {
      get: (key) => entries.get(String(key).toLowerCase()) || null,
    },
    body: {
      getReader: () => ({
        read: async () => {
          if (index >= chunks.length) return { done: true };
          return { done: false, value: chunks[index++] };
        },
      }),
    },
  };
}

function mockJsonResponse(body, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    json: async () => body,
  };
}

function mockTextResponse(body, { ok = true, status = 200, url = "" } = {}) {
  return {
    ok,
    status,
    url,
    text: async () => body,
  };
}

test('all Instagram post/Reel aliases use the same ordered native adapter and explicit session', async t => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'instagram-session-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const session = path.join(root, 'session.json');
  await fs.promises.writeFile(session, JSON.stringify({ username: 'dedicated', cookies: { sessionid: 'private-fixture' } }), { mode: 0o600 });
  const manifest = { id: 'BA', publicationId: '64', owner: 'fixture', url: 'https://www.instagram.com/p/BA/', count: 2,
    items: [{ index: 0, mediaId: '100', kind: 'image', url: 'https://one.cdninstagram.com/first.jpg' },
      { index: 1, mediaId: '101', kind: 'video', url: 'https://one.cdninstagram.com/second.mp4' }] };
  for (const alias of ['p', 'reel', 'reels', 'tv']) {
    let calls = 0;
    const result = await downloadSocialVideo(`https://www.instagram.com/${alias}/BA/`, {
      ...baseDeps(fs), instagramSession: session, instagramScript: '/adapter.py',
      execFileAsync: async (_command, args) => { calls++; assert.ok(args.includes('/adapter.py')); assert.equal(args[args.indexOf('--session') + 1], session); return { stdout: JSON.stringify(manifest) }; },
      fetch: async () => mockResponse({ headers: { 'content-type': 'application/octet-stream' } }),
    });
    assert.equal(calls, 1); assert.equal(result.files.length, 2);
    assert.deepEqual(result.files.map(item => item.sourceItemId), ['native:100', 'native:101']);
    await fs.promises.rm(result.tempDir, { recursive: true, force: true });
  }
});

test('the native video compatibility extractor receives the same dedicated session at inspection and download', async t => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'instagram-fallback-session-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const session = path.join(root, 'session.json');
  await fs.promises.writeFile(session, JSON.stringify({ username: 'dedicated', cookies: { sessionid: 'private-fixture' } }), { mode: 0o600 });
  const cookies = []; let adapterSession = false;
  const result = await downloadSocialVideo('https://www.instagram.com/reel/BA/', {
    ...baseDeps(fs), instagramSession: session, instagramScript: '/adapter.py',
    execFileAsync: async (_command, args) => {
      if (args.includes('/adapter.py')) { adapterSession = args[args.indexOf('--session') + 1] === session; return { stdout: JSON.stringify({ error: { code: 'AUTH_REQUIRED' } }) }; }
      const file = args[args.indexOf('--cookies') + 1]; cookies.push(file);
      assert.equal((await fs.promises.stat(file)).mode & 0o777, 0o600);
      assert.match(await fs.promises.readFile(file, 'utf8'), /\.instagram.com\tTRUE\t\/\tTRUE\t0\tsessionid\tprivate-fixture/);
      return { stdout: args.includes('--dump-single-json') ? JSON.stringify({ extractor_key: 'Instagram', id: 'BA', duration: 1 }) : '' };
    }, findDownloadedVideo: async () => ({ filePath: path.join(root, 'video.mp4'), size: 10 }),
  });
  assert.equal(adapterSession, true); assert.equal(cookies.length, 2); assert.equal(cookies[0], cookies[1]);
  assert.equal(result.source.status, 'verified');
  await fs.promises.rm(result.tempDir, { recursive: true, force: true });
  await assert.rejects(fs.promises.stat(cookies[0]), { code: 'ENOENT' });
});

test('a post whose photo adapter failed recovers a native image from the same yt-dlp metadata, retaining its publication key', async () => {
  const url = 'https://www.instagram.com/p/BA/';
  const asset = 'https://asset.cdninstagram.com/only-photo.jpg?signature=fixture';
  const calls = [], fetched = [];
  const result = await downloadSocialVideo(url, {
    ...baseDeps(mockFs()), instagramScript: '/adapter.py',
    execFileAsync: async (_cmd, args) => {
      calls.push(args);
      if (args.includes('/adapter.py')) return { stdout: JSON.stringify({ error: { code: 'SERVICE_ERROR' } }) };
      assert.ok(args.includes('--dump-single-json') && args.includes('--plugin-dirs'));
      return { stdout: JSON.stringify({ _type: 'playlist', entries: [], extractor_key: 'Instagram', id: 'BA',
        instagram_single_photo: { publication_id: '64', url: asset } }) };
    },
    fetch: async (target, options) => {
      fetched.push(target);
      assert.equal(options.redirect, 'manual');
      return mockResponse({ headers: { 'content-type': 'image/jpeg' } });
    },
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(fetched, [asset]);
  assert.equal(result.source.provider, 'yt-dlp');
  assert.equal(result.source.resolved.id, 'BA');
  assert.equal(result.files[0].mediaKind, 'image');
  assert.equal(result.files[0].sourceItemId, 'publication:BA');
  assert.equal(result.files[0].mimeType, 'image/jpeg');
});

test('the native photo path rejects a foreign post, an ambiguous collection, an outside CDN, a redirect and a non-image response', async () => {
  const asset = 'https://asset.cdninstagram.com/native';
  const base = { _type: 'playlist', entries: [], extractor_key: 'Instagram', id: 'BA', instagram_single_photo: { publication_id: '64', url: asset } };
  for (const [info, request, status, mime, expected, fetchCount] of [
    [base, 'https://www.instagram.com/p/BB/', 200, 'image/jpeg', 'MEDIA_SOURCE_MISMATCH', 0],
    [{ ...base, entries: [{}] }, 'https://www.instagram.com/p/BA/', 200, 'image/jpeg', 'MEDIA_SOURCE_UNVERIFIED', 0],
    [{ ...base, instagram_single_photo: { publication_id: 64, url: asset } }, 'https://www.instagram.com/p/BA/', 200, 'image/jpeg', 'MEDIA_SOURCE_UNVERIFIED', 0],
    [{ ...base, instagram_single_photo: { publication_id: '64', url: 'https://outside.example/preview.jpg' } }, 'https://www.instagram.com/p/BA/', 200, 'image/jpeg', 'MEDIA_SOURCE_UNVERIFIED', 0],
    [base, 'https://www.instagram.com/p/BA/', 302, 'text/html', 'MEDIA_SOURCE_UNVERIFIED', 1],
    [base, 'https://www.instagram.com/p/BA/', 200, 'video/mp4', 'MEDIA_IMAGE_INVALID', 1],
    [base, 'https://www.instagram.com/reel/BA/', 200, 'image/jpeg', 'MEDIA_SOURCE_UNVERIFIED', 0],
  ]) {
    let requests = 0;
    await assert.rejects(downloadSocialVideoWithYtDlp(request, '/tmp/social', {
      ...baseDeps(mockFs()), execFileAsync: async () => ({ stdout: JSON.stringify(info) }),
      fetch: async () => { requests++; return mockResponse({ status, ok: status === 200, headers: { 'content-type': mime } }); },
    }), { code: expected });
    assert.equal(requests, fetchCount);
  }
});

test('a restricted post stops on evidenced access denial, while generic adapter failures retain the native video route', async () => {
  for (const [error, expectedCalls, plugin] of [
    [{ code: 'RATE_LIMIT', status: 429 }, 1, false],
    [{ code: 'AUTH_REQUIRED', status: 401 }, 1, false],
    [{ code: 'UNAVAILABLE', status: 403 }, 1, false],
    [{ code: 'AUTH_REQUIRED', adapterErrorType: 'PrivateProfileNotFollowedException' }, 1, false],
    [{ code: 'AUTH_REQUIRED' }, 3, false],
    [{ code: 'SERVICE_ERROR' }, 3, true],
  ]) {
    let calls = 0;
    const result = downloadSocialVideo('https://www.instagram.com/p/BA/', {
      ...baseDeps(mockFs()), instagramScript: '/adapter.py',
      execFileAsync: async (_cmd, args) => {
        calls++;
        if (args.includes('/adapter.py')) return { stdout: JSON.stringify({ error }) };
        if (args.includes('--load-info-json')) return { stdout: '' };
        assert.equal(args.includes('--plugin-dirs'), plugin);
        return { stdout: JSON.stringify({ extractor_key: 'Instagram', id: 'BA', title: 'video', duration: 1 }) };
      },
      findDownloadedVideo: async () => ({ filePath: '/tmp/social/video.mp4', size: 1 }),
    });
    if (expectedCalls === 1) await assert.rejects(result);
    else assert.equal((await result).mediaKind, 'video');
    assert.equal(calls, expectedCalls);
  }
});
