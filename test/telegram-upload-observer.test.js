import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { channel } from 'node:diagnostics_channel';
import { observeTelegramUpload } from '../src/telegram-upload-observer.js';

test('native fetch reports body transfer and delayed response without logging request secrets',async t=>{
  const server=http.createServer((request,response)=>{request.resume();request.on('end',()=>setTimeout(()=>{response.setHeader('content-type','application/json');response.end('{"ok":true}');},35));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  let report;
  const form=new FormData();form.set('photo',new Blob(['payload']),'test.jpg');
  const result=await observeTelegramUpload(async()=>{
    const response=await fetch(`http://127.0.0.1:${server.address().port}/botSECRET/sendPhoto`,{method:'POST',body:form});return response.json();
  },{report:value=>{report=value;}});
  assert.equal(result.ok,true);assert.ok(report.connectionReadyMs>=0);assert.ok(report.bodyTransferMs>=0);
  assert.ok(report.responseWaitMs>=20);assert.ok(report.responseBodyMs>=0);
  assert.doesNotMatch(JSON.stringify(report),/SECRET|payload|test\.jpg|127\.0\.0\.1/);
});

test('concurrent attempts retain their own observations and unknown phases stay null',async()=>{
  let clock=0,a,b,release;const gate=new Promise(resolve=>{release=resolve;});
  const first=observeTelegramUpload(async()=>{
    const request={};channel('undici:request:create').publish({request});clock=4;channel('undici:client:sendHeaders').publish({request});
    await gate;clock=15;channel('undici:request:bodySent').publish({request});clock=35;channel('undici:request:headers').publish({request});
  },{now:()=>clock,report:value=>{a=value;}});
  await observeTelegramUpload(async()=>{clock=5;},{now:()=>clock,report:value=>{b=value;}});
  release();await first;
  assert.equal(a.bodyTransferMs,11);assert.equal(a.responseWaitMs,20);assert.equal(b.connectionReadyMs,null);assert.equal(b.bodyTransferMs,null);
});

test('transport failures and successful results survive observer failures without invented timings',async()=>{
  const subscribedBefore=channel('undici:request:create').hasSubscribers;
  const original=Object.assign(new Error('network failure'),{code:'ECONNRESET'});let report;
  await assert.rejects(observeTelegramUpload(async()=>{throw original;},{report:value=>{report=value;}}),error=>error===original);
  assert.equal(report.connectionReadyMs,null);assert.equal(report.waitingForResponseMs,null);
  assert.equal(await observeTelegramUpload(async()=>42,{report:()=>{throw new Error('log failed');}}),42);
  assert.equal(channel('undici:request:create').hasSubscribers,subscribedBefore);
});
