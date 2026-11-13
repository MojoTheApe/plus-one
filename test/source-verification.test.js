import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {publicAddress,verifySourcePages,sourceAvailability} from '../src/source-verification.js';

test('a denied or slow supplementary page does not discard retrieved research; dead and unsafe citations require correction', () => {
  const good = {url:'https://example.org/report',ok:true};
  for (const reason of ['access-restricted','timeout','dns-failed','source-limit']) {
    const result=sourceAvailability([good,{url:'https://other.example/report',ok:false,reason}]);
    assert.equal(result.usable,true);assert.equal(result.unavailable.length,1);
  }
  for (const reason of ['not-found','unsafe','invalid-redirect']) assert.equal(sourceAvailability([good,{ok:false,reason}]).usable,false);
  assert.equal(sourceAvailability([]).usable,false);
});

function fixture(routes) {
  const calls=[];
  return {calls,lookup:(host,_options,cb)=>cb(null,[{address:host==='private.example'?'127.0.0.1':'93.184.215.14',family:4}]),
    request:(url,options,cb)=>{
      const request=new EventEmitter();request.destroy=()=>{};
      request.end=()=>queueMicrotask(()=>{
        options.lookup(url.hostname,{},(error,address)=>{assert.equal(error,null);assert.equal(address,'93.184.215.14');});
        calls.push({url:url.href,method:options.method,headers:options.headers});
        const route=routes[`${options.method} ${url.href}`] || {status:200};
        cb({statusCode:route.status,headers:{location:route.location}});
      });return request;
    },
  };
}

test('source validation rejects private, mapped, special, multicast and loopback addresses',()=>{
  for(const ip of ['0.0.0.0','10.1.2.3','100.64.0.1','127.0.0.1','169.254.169.254','172.16.0.1','192.168.1.1','198.18.0.1','224.0.0.1','::1','::ffff:127.0.0.1','::ffff:7f00:1','fe80::1','fc00::1','2001:2::1','2002:7f00:1::1','2001:db8::1'])assert.equal(publicAddress(ip),false,ip);
  for(const ip of ['93.184.215.14','8.8.8.8','2606:4700:4700::1111','2001:4860:4860::8888'])assert.equal(publicAddress(ip),true,ip);
});

test('dead sources and access restrictions remain distinct; HEAD-incompatible pages use bounded GET',async()=>{
  const f=fixture({'HEAD https://example.org/dead':{status:404},'HEAD https://example.org/blocked':{status:403},'GET https://example.org/blocked':{status:403},'HEAD https://example.org/article':{status:405}});
  const result=await verifySourcePages(['https://example.org/dead','https://example.org/blocked','https://example.org/article'],f);
  assert.equal(result[0].reason,'not-found');assert.equal(result[1].reason,'access-restricted');assert.equal(result[2].ok,true);
  assert.ok(f.calls.some(call=>call.method==='GET'&&call.headers.range==='bytes=0-1023'));
});

test('every redirect revalidates DNS; credentials, internal redirects and nonstandard ports are never requested',async()=>{
  const f=fixture({'HEAD https://example.org/redirect':{status:302,location:'http://private.example/secret'}});
  const result=await verifySourcePages(['https://example.org/redirect','https://user:secret@example.org/','http://example.org:8080/'],f);
  assert.ok(result.every(source=>!source.ok));assert.equal(f.calls.length,1);
});

test('DNS and request waits share a short total budget',async()=>{
  const result=await verifySourcePages(['https://example.org/'],{budgetMs:20,lookup:()=>{}});
  assert.equal(result[0].reason,'timeout');
});
