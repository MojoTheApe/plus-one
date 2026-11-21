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

test('authenticated alternate URLs must prove the same parent, ordered children and types before selection', () => {
  const program = `
import importlib.util,sys,copy
from types import SimpleNamespace
spec=importlib.util.spec_from_file_location('adapter',sys.argv[1]);adapter=importlib.util.module_from_spec(spec);spec.loader.exec_module(adapter)
class Post:
 mediaid=64;shortcode='BA';mediacount=2;typename='GraphSidecar';owner_username='fixture';caption=''
 mediaid_to_shortcode=staticmethod(lambda value:'BA')
 def __init__(self):
  self._context=SimpleNamespace(iphone_support=True,is_logged_in=True)
  self._iphone_struct={'pk':'64','media_type':8,'carousel_media':[{'pk':str(i),'media_type':1,'image_versions2':{'candidates':[{'url':'https://one.cdninstagram.com/child-'+str(i)+'.jpg'}]}} for i in [100,101]]}
 def _field(self,*keys):return [{'node':{'id':str(i),'is_video':False}} for i in [100,101]]
 def get_sidecar_nodes(self,start,end):
  return [SimpleNamespace(is_video=False,display_url=item['image_versions2']['candidates'][0]['url'],video_url=None) for item in self._iphone_struct['carousel_media'][start:end+1]]
post=Post();result=adapter.publication_manifest(post,20)
assert [item['mediaId'] for item in result['items']]==['100','101']
assert [item['url'].rsplit('/',1)[-1] for item in result['items']]==['child-100.jpg','child-101.jpg']
for change in ['order','parent','missing','duplicate','type','unproven']:
 post=Post()
 if change=='order':post._iphone_struct['carousel_media'].reverse()
 if change=='parent':post._iphone_struct['pk']='65'
 if change=='missing':post._iphone_struct['carousel_media'].pop()
 if change=='duplicate':post._iphone_struct['carousel_media'][1]['pk']='100'
 if change=='type':post._iphone_struct['carousel_media'][1]['media_type']=2
 if change=='unproven':del post._iphone_struct['carousel_media'][1]['pk']
 try:adapter.publication_manifest(post,20);raise AssertionError('unbound alternate accepted: '+change)
 except ValueError as error:assert str(error) in {'MEDIA_SOURCE_MISMATCH','MEDIA_SOURCE_UNVERIFIED'}
# Single photo/video properties also select from the alternate native response.
for video in [False,True]:
 post=Post();post.typename='GraphVideo' if video else 'GraphImage';post.mediacount=1;post.is_video=video
 post._iphone_struct={'pk':'65','media_type':2 if video else 1}
 post.url='https://one.cdninstagram.com/wrong.jpg';post.video_url='https://one.cdninstagram.com/wrong.mp4'
 try:adapter.publication_manifest(post,20);raise AssertionError('wrong single parent accepted')
 except ValueError as error:assert str(error)=='MEDIA_SOURCE_MISMATCH'
print('alternate identities verified')
`;
  const result = spawnSync('python3', ['-B', '-c', program, path.resolve('scripts/instagram-media.py')], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout.trim(), 'alternate identities verified');
});

test('unavailable authenticated high-quality endpoint retains only verified GraphQL URLs and restores context', () => {
  const program = `
import importlib.util,sys
from types import SimpleNamespace
spec=importlib.util.spec_from_file_location('adapter',sys.argv[1]);adapter=importlib.util.module_from_spec(spec);spec.loader.exec_module(adapter)
ConnectionException=type('ConnectionException',(Exception,),{})
class Post:
 mediaid=64;shortcode='BA';mediacount=1;typename='GraphImage';owner_username='fixture';caption='';is_video=False
 mediaid_to_shortcode=staticmethod(lambda value:'BA')
 _context=SimpleNamespace(iphone_support=True,is_logged_in=True)
 @property
 def _iphone_struct(self):raise ConnectionException('alternate unavailable')
 @property
 def url(self):
  assert not self._context.iphone_support
  return 'https://one.cdninstagram.com/verified-graphql.jpg'
post=Post();result=adapter.publication_manifest(post,20)
assert result['items'][0]['url'].endswith('/verified-graphql.jpg')
assert post._context.iphone_support
print('verified fallback preserved')
`;
  const result = spawnSync('python3', ['-B', '-c', program, path.resolve('scripts/instagram-media.py')], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout.trim(), 'verified fallback preserved');
});

test('the photo extension extracts only a native single image and keeps large publication IDs as strings', () => {
  const program = `
import runpy,sys,types
class Core:
 def __init_subclass__(cls, plugin_name=None): pass
 def _extract_product(self, product, *args, **kwargs): return 'upstream'
 def playlist_result(self, entries, playlist_id, playlist_title, **fields): return {**fields,'id':playlist_id,'entries':entries}
class Error(Exception):
 def __init__(self,message,**kwargs): super().__init__(message)
instagram=types.ModuleType('yt_dlp.extractor.instagram');instagram.InstagramIE=Core
def shortcode(pk):
 assert str(pk)=='9007199254740993'
 return 'gAAAAAAAB'
instagram._pk_to_id=shortcode
utils=types.ModuleType('yt_dlp.utils');utils.ExtractorError=Error
sys.modules['yt_dlp.extractor.instagram']=instagram;sys.modules['yt_dlp.utils']=utils
plugin=runpy.run_path(sys.argv[1])['_InstagramPhotoIE']()
photo={'pk':'9007199254740993','id':'opaque-field','code':'gAAAAAAAB','media_type':1,
 'image_versions2':{'candidates':[{'url':'https://one.cdninstagram.com/photo.jpg'},{'url':'https://two.cdninstagram.com/smaller.jpg'}]},
 'user':{'username':'source'}}
assert plugin._extract_product(photo)['instagram_single_photo']=={'publication_id':photo['pk'],'url':photo['image_versions2']['candidates'][0]['url']}
below=photo.copy();below.pop('code')
assert plugin._extract_product(below)['id']==photo['code']
for updates in [{'code':'other'},{'pk':None},{'image_versions2':{}},{'carousel_media':[{}]},{'carousel_media_count':2}]:
 try:plugin._extract_product({**photo,**updates});raise AssertionError('invalid photo accepted')
 except Error:pass
for typ in [2,8]:assert plugin._extract_product({**photo,'media_type':typ})=='upstream'
print('ok')
`;
  const plugin = path.resolve('src/yt-dlp-plugins/instagram-photo/yt_dlp_plugins/extractor/instagram_photo.py');
  const result = spawnSync('python3', ['-B', '-c', program, plugin], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'ok');
});

test('Polaris native carousel fields bind each normalized asset to its child ID and reject substitutions', () => {
  const result = spawnSync('python3', ['-B', path.resolve('test/instagram-polaris-fixture.py')], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /6 Polaris fixtures passed/);
});
