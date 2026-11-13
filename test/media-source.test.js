import test from 'node:test';
import assert from 'node:assert/strict';
import { mediaReference, nativeExtractorSource, verifiedMediaSource, assertVerifiedMediaSource, instagramMediaCode } from '../src/media-source.js';

test('one story is matched to the native shortcode and actual account, not the requested URL echo', () => {
  const url='https://www.instagram.com/stories/owner/64/?tracking=private';
  const info={extractor_key:'InstagramStory',id:'BA',channel:'owner',webpage_url:url};
  const source=nativeExtractorSource(url,info);
  assert.equal(instagramMediaCode('64'),'BA');
  assert.equal(source.requested.id,'64');assert.equal(source.resolved.id,'BA');
  assert.equal(source.requested.url,'https://www.instagram.com/stories/owner/64/');
  assert.deepEqual(assertVerifiedMediaSource(source,url),source);
  for(const changed of [{id:'BB'},{channel:'other'},{id:null},{extractor_key:'Generic'}]) {
    assert.throws(()=>nativeExtractorSource(url,{...info,...changed}),error=>['MEDIA_SOURCE_MISMATCH','MEDIA_SOURCE_UNVERIFIED'].includes(error.code));
  }
});

test('a returned URL alone and the unbound legacy provider cannot certify media', () => {
  const url='https://www.instagram.com/reel/real/';
  assert.throws(()=>nativeExtractorSource(url,{extractor_key:'Instagram',webpage_url:url}),{code:'MEDIA_SOURCE_UNVERIFIED'});
  assert.throws(()=>nativeExtractorSource(url,{extractor_key:'Instagram',webpage_url:url,id:'another'}),{code:'MEDIA_SOURCE_MISMATCH'});
  assert.throws(()=>verifiedMediaSource(url,{provider:'snapinsta',id:'real'}),{code:'MEDIA_SOURCE_UNVERIFIED'});
  assert.throws(()=>assertVerifiedMediaSource({status:'verified'},url),{code:'MEDIA_SOURCE_UNVERIFIED'});
});

test('native video identity keeps real handles separate from display names', () => {
  const source=nativeExtractorSource('https://www.tiktok.com/@actual/video/123/',{
    extractor_key:'TikTok',id:'123',uploader:'actual',channel:'Display Name',uploader_id:'999',
  });
  assert.equal(source.resolved.owner,'actual');
  const idOnly=nativeExtractorSource('https://www.tiktok.com/@_/video/123/',{extractor_key:'TikTok',id:'123',uploader:'actual'});
  assert.equal(idOnly.resolved.url,'https://www.tiktok.com/@actual/video/123/');
  assert.throws(()=>assertVerifiedMediaSource(source,'https://www.tiktok.com/@actual/video/456/'),{code:'MEDIA_SOURCE_UNVERIFIED'});
});

test('short/share links retain their own request and require a resolved platform object', () => {
  const share='https://www.threads.net/share/token/';
  const source=verifiedMediaSource(share,{provider:'threads-page',resolvedUrl:'https://www.threads.com/@author/post/exact/',id:'exact',owner:'author'});
  assert.equal(source.requested.kind,'share');assert.equal(source.resolved.id,'exact');
  assert.deepEqual(assertVerifiedMediaSource(source,share),source);
  assert.throws(()=>verifiedMediaSource(share,{provider:'threads-page',id:'exact',owner:'author'}),{code:'MEDIA_SOURCE_UNVERIFIED'});
  assert.throws(()=>assertVerifiedMediaSource(source,'https://www.threads.com/share/different/'),{code:'MEDIA_SOURCE_UNVERIFIED'});
  for(const url of ['http://www.instagram.com/reel/a/','https://instagram.com.evil.test/reel/a/','https://u:p@www.instagram.com/reel/a/','https://www.instagram.com:8443/reel/a/'])assert.equal(mediaReference(url),null);
});
