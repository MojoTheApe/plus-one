import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

test('the Instagram adapter binds native numeric identity and preserves ordered photo/video children and the selection cap', () => {
  const program = `
import importlib.util,sys,json
from types import SimpleNamespace
spec=importlib.util.spec_from_file_location('adapter',sys.argv[1]);adapter=importlib.util.module_from_spec(spec);spec.loader.exec_module(adapter)
class Post:
 mediaid=64
 shortcode='BA'
 mediacount=3
 typename='GraphSidecar'
 owner_username='fixture'
 caption='Original caption'
 @staticmethod
 def mediaid_to_shortcode(value):
  assert value==64
  return 'BA'
 def get_sidecar_nodes(self,start,end):
  nodes=[SimpleNamespace(is_video=False,display_url='https://cdn.example/first.jpg',video_url=None),SimpleNamespace(is_video=True,display_url='https://cdn.example/preview.jpg',video_url='https://cdn.example/second.mp4'),SimpleNamespace(is_video=False,display_url='https://cdn.example/third.jpg',video_url=None)]
  return nodes[start:end+1]
post=Post();result=adapter.publication_manifest(post,2)
assert result['publicationId']=='64' and result['count']==3 and result['owner']=='fixture'
assert [item['url'] for item in result['items']]==['https://cdn.example/first.jpg','https://cdn.example/second.mp4']
assert [item['kind'] for item in result['items']]==['image','video']
post.shortcode='OTHER'
try:adapter.publication_manifest(post,2);raise AssertionError('mismatch accepted')
except ValueError as error:assert str(error)=='MEDIA_SOURCE_MISMATCH'
print(json.dumps({'identity':'verified','order':'preserved','mismatch':'rejected'}))
`;
  const result = spawnSync('python3', ['-B', '-c', program, path.resolve('scripts/instagram-media.py')], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { identity: 'verified', order: 'preserved', mismatch: 'rejected' });
});

test('the adapter exposes a bounded source wait without publishing its private exception text', () => {
  const program = `
import importlib.util,sys
spec=importlib.util.spec_from_file_location('adapter',sys.argv[1]);adapter=importlib.util.module_from_spec(spec);spec.loader.exec_module(adapter)
def fail(*args):raise adapter.SourceWait(120)
adapter.resolve=fail
sys.argv=['adapter','--url','https://www.instagram.com/p/fixture/']
adapter.main()
`;
  const result = spawnSync('python3', ['-B', '-c', program, path.resolve('scripts/instagram-media.py')], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { error: { code: 'RATE_LIMIT', status: null, adapterErrorType: 'SourceWait', retryAfterSeconds: 120 } });
  assert.doesNotMatch(result.stdout, /fixture|instagram.com/);
});
