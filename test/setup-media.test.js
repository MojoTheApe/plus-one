import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createSetupMedia, setupAnimation } from '../src/setup-media.js';

const executable=process.env.STICKER_FFMPEG||'ffmpeg',probe=process.env.STICKER_FFPROBE||'ffprobe';
const available=spawnSync(executable,['-version'],{stdio:'ignore'}).status===0;
const tinyVideo=()=>{
  const result=spawnSync(executable,['-v','error','-f','lavfi','-i','color=c=red:s=24x24:r=5','-t','1','-an','-c:v','libx264','-threads','1','-movflags','frag_keyframe+empty_moov','-f','mp4','pipe:1']);
  assert.equal(result.status,0,String(result.stderr));return result.stdout;
};
function media(buffer){
  const uploads=[];
  const api=createSetupMedia({telegram:async()=>({file_path:'documents/fixture.media'}),fileApi:'https://fixture.invalid',ffmpeg:executable,ffprobe:probe,
    fetchFile:async()=>new Response(buffer),telegramMultipart:async(method,form)=>{
      const prepared=Buffer.from(await form.get('animation').arrayBuffer());uploads.push({method,chat:form.get('chat_id'),prepared});
      return {message_id:5,animation:{file_id:'new-animation-id',file_unique_id:'animation-unique'}};
    }});
  return {api,uploads};
}

test('genuine Telegram animation is reused; GIF documents with generic MIME remain candidates',async()=>{
  const {api,uploads}=media(Buffer.alloc(0));
  assert.equal((await api.animation({animation:{file_id:'native',file_size:100,duration:2}},101)).fileId,'native');assert.equal(uploads.length,0);
  assert.equal(setupAnimation({document:{file_id:'gif',file_name:'fun.GIF',mime_type:'application/octet-stream'}}).file_id,'gif');
  assert.equal(setupAnimation({document:{file_id:'pdf',file_name:'other.pdf'}}),null);
});

test('oversized and long animation inputs are rejected before file access',async()=>{
  const api=createSetupMedia({telegram:()=>assert.fail('No Telegram access')});
  await assert.rejects(api.animation({video:{file_id:'x',file_size:21*1024*1024}},101),/SIZE/);
  await assert.rejects(api.animation({animation:{file_id:'x',duration:61}},101),/DURATION/);
});

test('actual short MP4 is decoded, converted and uploaded as animation rather than reusing its video ID',{skip:!available},async()=>{
  const {api,uploads}=media(tinyVideo());
  const result=await api.animation({video:{file_id:'source-video',file_size:2000,duration:1}},101);
  assert.equal(result.fileId,'new-animation-id');assert.notEqual(result.fileId,'source-video');assert.equal(result.previewMessageId,5);
  assert.equal(uploads[0].method,'sendAnimation');assert.equal(uploads[0].chat,'101');
  const checked=spawnSync(probe,['-v','error','-show_entries','stream=codec_type,codec_name,width,height','-of','json','pipe:0'],{input:uploads[0].prepared});
  assert.equal(checked.status,0,String(checked.stderr));const streams=JSON.parse(checked.stdout).streams;
  assert.equal(streams.length,1);assert.equal(streams[0].codec_name,'h264');assert.ok(streams[0].width<=720&&streams[0].height<=720);
});

test('actual GIF document is accepted by probing and uploaded as animation',{skip:!available},async()=>{
  const gif=spawnSync(executable,['-v','error','-i','pipe:0','-threads','1','-f','gif','pipe:1'],{input:tinyVideo()});assert.equal(gif.status,0,String(gif.stderr));
  const {api,uploads}=media(gif.stdout);assert.equal((await api.animation({document:{file_id:'source-document',file_name:'fun.gif'}},101)).fileId,'new-animation-id');assert.equal(uploads.length,1);
});

test('mislabelled files and streaming oversize fail without uploading',{skip:!available},async()=>{
  const bad=media(Buffer.from('not an actual GIF'));await assert.rejects(bad.api.animation({document:{file_id:'invalid',mime_type:'image/gif'}},101));assert.equal(bad.uploads.length,0);
  const large=media(Buffer.alloc(21*1024*1024));await assert.rejects(large.api.animation({video:{file_id:'oversize'}},101),/SIZE/);assert.equal(large.uploads.length,0);
});
