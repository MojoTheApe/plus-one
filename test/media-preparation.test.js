import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { crc32, deflateSync } from "node:zlib";
import { prepareMediaForTelegram, telegramPhotoBudget } from "../src/media-preparation.js";
const available = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;
test('an expired overall deadline prevents preparation before reading or launching tools',async()=>{
  await assert.rejects(prepareMediaForTelegram([{filePath:'/nonexistent',mediaKind:'image'}],{deadline:Date.now()-1}),error=>error.code==='SOCIAL_DOWNLOAD_TIMEOUT');
});
test('a small silent VP9 file is converted to compatible H264 MP4 without inventing audio or cutting duration', {skip:!available}, async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'format-qa-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const input=path.join(root,'source.webm');
  execFileSync('ffmpeg',['-v','error','-y','-f','lavfi','-i','testsrc2=size=96x64:rate=10','-t','1','-c:v','libvpx-vp9','-threads','1',input],{timeout:15000});
  assert.ok((await fs.stat(input)).size<100000);
  const [result]=await prepareMediaForTelegram([{filePath:input,mediaKind:'video',mimeType:'video/webm'}]);
  assert.equal(result.converted,true);assert.equal(result.hasAudio,false);assert.equal(result.mimeType,'video/mp4');
  const probe=JSON.parse(execFileSync('ffprobe',['-v','error','-show_streams','-show_format','-of','json',result.filePath],{encoding:'utf8'}));
  assert.equal(probe.streams[0].codec_name,'h264');assert.equal(probe.streams[0].pix_fmt,'yuv420p');assert.equal(probe.streams.length,1);
  assert.ok(Math.abs(Number(probe.format.duration)-1)<0.1);
});
test("real compression fits the upload budget without cropping duration", { skip: !available }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "compress-qa-")); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "source.mp4");
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=24", "-t", "4", "-c:v", "libx264", "-crf", "10", "-threads", "1", file], { timeout: 15000 });
  const before = await fs.stat(file), budget = 100000;
  assert.ok(before.size > budget);
  const [after] = await prepareMediaForTelegram([{ filePath: file, mediaKind: "video" }], { maxUploadBytes: budget });
  assert.equal(after.compressed, true); assert.ok((await fs.stat(after.filePath)).size <= budget);
  assert.ok(Math.abs(after.duration - 4) < 0.1); assert.ok(after.width && after.height);
});

test("a real oversized photograph is decoded and reduced before sending; a counterfeit image is rejected", { skip: !available }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "photo-qa-")); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const width = 2048, height = 2048, header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) randomBytes(width * 3).copy(raw, y * (width * 3 + 1) + 1);
  const chunk = (name, bytes) => {
    const type = Buffer.from(name), size = Buffer.alloc(4), checksum = Buffer.alloc(4);
    size.writeUInt32BE(bytes.length); checksum.writeUInt32BE(crc32(Buffer.concat([type, bytes])));
    return Buffer.concat([size, type, bytes, checksum]);
  };
  const input = path.join(root, "large.png");
  await fs.writeFile(input, Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]));
  assert.ok((await fs.stat(input)).size > telegramPhotoBudget);
  const [prepared] = await prepareMediaForTelegram([{ filePath: input, mediaKind: "image", mimeType: "image/png" }]);
  assert.equal(prepared.converted, true); assert.equal(prepared.mimeType, "image/jpeg");
  assert.ok(prepared.size <= telegramPhotoBudget); assert.equal(prepared.width, width); assert.equal(prepared.height, height);
  const counterfeit = path.join(root, "wrong.jpg"); await fs.writeFile(counterfeit, "not an image");
  await assert.rejects(prepareMediaForTelegram([{ filePath: counterfeit, mediaKind: "image", mimeType: "image/jpeg" }]));
});

test("extreme photograph geometry is padded into Telegram limits without cropping", { skip: !available }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "photo-geometry-")); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, "wide.png");
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=3200x32", "-frames:v", "1", "-threads", "1", filePath]);
  const [prepared] = await prepareMediaForTelegram([{ filePath, mediaKind: "image", mimeType: "image/png" }]);
  assert.equal(prepared.converted, true); assert.ok(prepared.width / prepared.height <= 20);
  assert.ok(prepared.width + prepared.height <= 10000);
});

test("odd-sized source image keeps every edge when converted to a Telegram photo", {skip:!available}, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'odd-photo-'));
  t.after(() => fs.rm(root,{recursive:true,force:true}));
  const filePath = path.join(root,'odd.webp');
  execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','testsrc=size=321x241',
    '-frames:v','1','-c:v','libwebp','-lossless','1','-threads','1',filePath]);
  const [file] = await prepareMediaForTelegram([{filePath,mediaKind:'image',mimeType:'image/webp'}]);
  assert.equal(file.mimeType,'image/jpeg');
  assert.equal(file.width,322);
  assert.equal(file.height,242);
});
