import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { prepareMediaEvidence } from "../src/media-evidence.js";
const available = ["ffmpeg", "ffprobe"].every(binary => spawnSync(binary, ["-version"], { stdio: "ignore" }).status === 0);

test("real video frames and mono audio come from the requested file", { skip: !available }, async t => {
  const directory = await temporaryDirectory(t), source = path.join(directory, "source.mp4");
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=10",
    "-f", "lavfi", "-i", "sine=frequency=700:sample_rate=48000", "-t", "1.5", "-c:v", "libx264", "-threads", "1", "-c:a", "aac", source], { timeout: 15000 });
  let observedAudio = false;
  const evidence = await prepareMediaEvidence(source, { directory, kind: "video", transcribe: async (audio, options) => {
    const metadata = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,sample_rate,channels", "-of", "json", audio], { encoding: "utf8" }));
    assert.equal(metadata.streams[0].codec_type, "audio");
    assert.equal(metadata.streams[0].sample_rate, "16000");
    assert.equal(metadata.streams[0].channels, 1);
    assert.ok(options.signal);
    observedAudio = true;
    return "Контрольний текст";
  } });
  assert.equal(observedAudio, true);
  assert.ok(evidence.images.length > 0 && evidence.images.length <= 6);
  assert.equal((await fs.readFile(evidence.images[0])).subarray(0, 2).toString("hex"), "ffd8");
  assert.equal(evidence.transcript, "Контрольний текст");
  assert.equal(evidence.audio.status, "transcribed");
  assert.match(evidence.evidenceSummary, /вибіркових кадрів/);
});

test("audio-less video and pure audio preserve their actual evidence boundaries", { skip: !available }, async t => {
  const directory = await temporaryDirectory(t), silent = path.join(directory, "silent.mp4"), audio = path.join(directory, "source.wav");
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=blue:size=160x120:rate=5", "-t", "0.5", "-c:v", "libx264", "-threads", "1", silent]);
  const evidence = await prepareMediaEvidence(silent, { directory, kind: "video", transcribe: () => { throw new Error("Must not transcribe absent audio"); } });
  assert.equal(evidence.audio.status, "absent");
  assert.match(evidence.evidenceSummary, /немає аудіодоріжки/);
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440", "-t", "0.5", audio]);
  const pure = await prepareMediaEvidence(audio, { directory, kind: "audio", transcribe: async () => "" });
  assert.equal(pure.images.length, 0);
  assert.equal(pure.audio.status, "no_text");
  assert.match(pure.evidenceSummary, /не доводить відсутності/);
});

test("duration caps and metadata failures stop analysis before conversion", async t => {
  const directory = await temporaryDirectory(t), source = path.join(directory, "source.mp4");
  await fs.writeFile(source, "fixture");
  let calls = 0;
  await assert.rejects(prepareMediaEvidence(source, { directory, maxDurationSeconds: 9999, execute: async () => {
    calls++;
    return { stdout: JSON.stringify({ format: { duration: "301" }, streams: [{ codec_type: "video" }] }) };
  } }), error => error.code === "SOCIAL_VIDEO_DURATION_LIMIT" && error.actualDurationSeconds === 301);
  assert.equal(calls, 1);
  await assert.rejects(prepareMediaEvidence(source, { execute: async () => ({ stdout: "{}" }) }), error => error.code === "MEDIA_DURATION_UNKNOWN");
  await assert.rejects(prepareMediaEvidence(source, { execute: async () => { throw Object.assign(new Error("probe timeout"), { killed: true }); } }), /probe timeout/);
});

test("transcription timeout is explicit unavailable evidence and signals cancellation", async t => {
  const directory = await temporaryDirectory(t), source = path.join(directory, "source.wav");
  await fs.writeFile(source, "fixture");
  let signal;
  const evidence = await prepareMediaEvidence(source, { directory, kind: "audio", transcriptionTimeoutMs: 5,
    execute: async (_command, args, options) => {
      assert.ok(options.timeout <= 45000);
      assert.ok(args.includes("file,pipe"));
      if (args.includes("-show_entries")) return { stdout: JSON.stringify({ format: { duration: 1 }, streams: [{ codec_type: "audio" }] }) };
      await fs.writeFile(args.at(-1), Buffer.alloc(100));
      return {};
    },
    transcribe: async (_audio, options) => { signal = options.signal; return new Promise(() => {}); },
  });
  assert.equal(signal.aborted, true);
  assert.equal(evidence.audio.status, "unavailable");
  assert.equal(evidence.audio.errorCode, "MEDIA_EVIDENCE_TIMEOUT");
  assert.equal(evidence.transcript, "");
  assert.match(evidence.evidenceSummary, /зміст звуку невідомий/);
});

async function temporaryDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "media-evidence-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}
