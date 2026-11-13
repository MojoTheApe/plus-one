import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { prepareMediaForTelegram } from "../src/media-preparation.js";
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
