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
 def _field(self,*keys):
  assert keys==('edge_sidecar_to_children','edges')
  return [{'node':{'id':str(100+i),'is_video':i==1,'video_url':'https://cdn.example/second.mp4'}} for i in range(3)]
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
assert [item['mediaId'] for item in result['items']]==['100','101']
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

test('typed source restrictions and explicit HTTP facts take precedence over digits in publication URLs', () => {
  const program = `
import importlib.util,sys,io,json,contextlib
spec=importlib.util.spec_from_file_location('adapter',sys.argv[1]);adapter=importlib.util.module_from_spec(spec);spec.loader.exec_module(adapter)
cases=[('QueryReturnedNotFoundException','404 Not Found when querying https://www.instagram.com/p/BA429/','UNAVAILABLE',404),('QueryReturnedForbiddenException','https://www.instagram.com/p/BA401/','UNAVAILABLE',403),('LoginRequiredException','Login required for https://www.instagram.com/p/BA429/','AUTH_REQUIRED',None),('ConnectionException','Query failed for https://www.instagram.com/p/429/','SERVICE_ERROR',None),('ConnectionException','401 Unauthorized when querying https://www.instagram.com/p/BA429/','AUTH_REQUIRED',401),('ConnectionException','HTTP status: 503 at https://www.instagram.com/p/401/','SERVICE_ERROR',503),('TooManyRequestsException','https://www.instagram.com/p/401/','RATE_LIMIT',429)]
for name,message,code,status in cases:
 error=type(name,(Exception,),{})(message)
 def fail(*args):raise error
 adapter.resolve=fail;sys.argv=['adapter','--url','https://www.instagram.com/p/fixture/']
 output=io.StringIO()
 with contextlib.redirect_stdout(output):adapter.main()
 result=json.loads(output.getvalue())['error']
 assert result['code']==code and result['status']==status,(name,result)
 assert 'instagram.com' not in output.getvalue()
print(json.dumps({'cases':len(cases)}))
`;
  const result = spawnSync('python3', ['-B', '-c', program, path.resolve('scripts/instagram-media.py')], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { cases: 7 });
});

test('the explicit session is loaded for every Instagram alias without browser access', () => {
  const program = `
import importlib.util,sys,json,tempfile,pathlib
from types import SimpleNamespace
spec=importlib.util.spec_from_file_location('adapter',sys.argv[1]);adapter=importlib.util.module_from_spec(spec);spec.loader.exec_module(adapter)
loaded=[]
class Loader:
 def __init__(self,**kwargs):
  assert kwargs['max_connection_attempts']==1 and kwargs['request_timeout']==15
  self.context=SimpleNamespace(load_session=lambda username,cookies:loaded.append((username,cookies)))
class Post:
 mediaid=64;shortcode='BA';mediacount=1;typename='GraphImage';owner_username='fixture';caption='';is_video=False;url='https://one.cdninstagram.com/photo.jpg'
 mediaid_to_shortcode=staticmethod(lambda value:'BA')
 from_shortcode=staticmethod(lambda context,code:Post())
sys.modules['instaloader']=SimpleNamespace(Instaloader=Loader,Post=Post,RateController=object)
with tempfile.TemporaryDirectory() as root:
 session=pathlib.Path(root)/'session.json';session.write_text(json.dumps({'username':'dedicated','cookies':{'sessionid':'private-fixture'}}))
 for alias in ['p','reel','reels','tv']:
  result=adapter.resolve('https://www.instagram.com/'+alias+'/BA/',20,str(session))
  assert result['items'][0]['mediaId']=='64'
assert loaded==[('dedicated',{'sessionid':'private-fixture'})]*4
print('session verified')
`;
  const result = spawnSync('python3', ['-B', '-c', program, path.resolve('scripts/instagram-media.py')], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout.trim(), 'session verified');
});
