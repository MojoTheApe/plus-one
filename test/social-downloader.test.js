import assert from "node:assert/strict";
import test from "node:test";
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
} from "../src/social-downloader.js";

test('replay: Threads login redirect is diagnosed as authentication, not a timeout or missing media', async()=>{
  const response=new Response('<html>login</html>');Object.defineProperty(response,'url',{value:'https://www.threads.com/login/'});
  await assert.rejects(downloadThreadsFromPage('https://www.threads.com/share/example','/tmp/threads',{
    ...baseDeps(mockFs()),fetch:async()=>response,
  }),/authentication required/);
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

  assert.equal(selectFallback("https://example.com", deps).provider, "instagram");
});

test("downloadSocialVideo returns primary downloader result without fallback", async () => {
  const fsMock = mockFs();
  const result = await downloadSocialVideo("https://example.com/video", {
    ...baseDeps(fsMock),
    execFileAsync: async (_command, args) => {
      if (args.includes("--dump-single-json")) return { stdout: JSON.stringify({ title: "primary", duration: 12 }) };
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
      shouldTryInstagramFallback: () => true,
      downloadInstagram: async () => {
        throw new Error("fallback failed");
      },
    }),
    /fallback failed/,
  );

  assert.equal(circuitByProvider.get("instagram").failures, 1);
  assert.equal(fsMock.removed.length, 1);
});

test("downloadSocialVideo blocks open fallback circuit", async () => {
  const fsMock = mockFs();
  const circuitByProvider = new Map([["instagram", { failures: 3, openedUntil: Date.now() + 60000 }]]);

  await assert.rejects(
    downloadSocialVideo("https://example.com/video", {
      ...baseDeps(fsMock),
      circuitByProvider,
      execFileAsync: async () => {
        throw new Error("primary failed");
      },
      shouldTryInstagramFallback: () => true,
    }),
    /cooling down/,
  );
});

test("stream validation triggers only one provider fallback and preserves both causes", async () => {
  let fallbackCalls = 0;
  const primary = new Error("downloaded media did not contain an audio stream");
  await assert.rejects(downloadSocialVideo("https://www.tiktok.com/@u/video/1", {
    ...baseDeps(mockFs()),
    execFileAsync: async (_command, args) => args.includes("--dump-single-json")
      ? { stdout: JSON.stringify({ duration: 2 }) } : { stdout: "" },
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
      if (args.includes("--dump-single-json")) return { stdout: JSON.stringify({ title: "clip", duration: 5 }) };
      return { stdout: "" };
    },
    findDownloadedVideo: async (tempDir) => ({ filePath: `${tempDir}/clip.mp4`, size: 4096 }),
    validateDownloadedVideo: async () => ({ hasAudio: true, duration: 5, width: 640, height: 360 }),
  };

  const url = "https://www.instagram.com/reel/abc";
  assert.deepEqual(await inspectSocialVideo(url, deps), { title: "clip", duration: 5 });
  const result = await downloadSocialVideoWithYtDlp(url, "/tmp/social", deps);

  assert.equal(result.title, "clip");
  assert.equal(calls[0].command, "yt-dlp");
  assert.equal(calls[0].args.includes("--dump-single-json"), true);
  assert.equal(calls[1].args.includes("--dump-single-json"), true);
  assert.equal(calls[2].args.includes("--max-filesize"), true);
  assert.equal(calls[2].args.includes("--merge-output-format"), true);
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

test("downloadInstagramWithSnapinsta fetches token, downloads media, and validates video", async () => {
  const fsMock = mockFs();
  const calls = [];
  const selected = [];
  const result = await downloadInstagramWithSnapinsta("https://www.instagram.com/reel/abc/", "/tmp/social", {
    ...baseDeps(fsMock),
    fetch: async (url, options = {}) => {
      calls.push({ url: String(url), options });
      if (calls.length === 1) {
        return mockTextResponse('<input name="token" value="snap-token">');
      }
      if (calls.length === 2) {
        assert.equal(String(options.body), "url=https%3A%2F%2Fwww.instagram.com%2Freel%2Fabc%2F&action=post&token=snap-token");
        return mockTextResponse(snapinstaActionFixture('<a href="https://cdn.example.com/video.mp4">download</a>'));
      }
      return mockResponse({
        headers: {
          "content-type": "video/mp4",
          "content-length": "5",
        },
        chunks: [Buffer.from("video")],
      });
    },
    selectMediaFiles: async (files, maxItems, sourceUrl) => {
      selected.push({ files, maxItems, sourceUrl });
      return files;
    },
  });

  assert.equal(result.title, "Instagram video");
  assert.equal(result.files[0].hasAudio, true);
  assert.equal(calls[0].url, "https://snap.test/");
  assert.equal(calls[1].url, "https://snap.test/action2.php");
  assert.equal(calls[2].options.headers.referer, "https://snap.test");
  assert.equal(selected[0].maxItems, 2);
});

test("downloadInstagramWithSnapinsta rejects token and empty media responses", async () => {
  await assert.rejects(
    downloadInstagramWithSnapinsta("https://www.instagram.com/reel/abc/", "/tmp/social", {
      ...baseDeps(mockFs()),
      fetch: async () => mockTextResponse("<html></html>"),
    }),
    /token not found/,
  );

  let requestCount = 0;
  await assert.rejects(
    downloadInstagramWithSnapinsta("https://www.instagram.com/reel/abc/", "/tmp/social", {
      ...baseDeps(mockFs()),
      fetch: async () => {
        requestCount += 1;
        return requestCount === 1
          ? mockTextResponse('<input name="token" value="snap-token">')
          : mockTextResponse(snapinstaActionFixture("<p>no media</p>"));
      },
    }),
    /returned no media/,
  );
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
            title: "Photo set",
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
            play: "https://cdn.example.com/video.mp4",
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

function snapinstaActionFixture(html) {
  const encoded = [...html].map((char) => String(char.charCodeAt(0))).join("a");
  return `("${encoded}",1,"0123456789a",0,10,1)`;
}
