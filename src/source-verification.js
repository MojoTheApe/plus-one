import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import {BlockList, isIP} from 'node:net';

const blocked = new BlockList();
for (const [network, prefix] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]]) blocked.addSubnet(network,prefix,'ipv4');
const globalV6 = new BlockList();globalV6.addSubnet('2000::',3,'ipv6');
for(const [network,prefix] of [['2001::',23],['2001:db8::',32],['2002::',16],['3ffe::',16],['3fff::',20]])blocked.addSubnet(network,prefix,'ipv6');

export function publicAddress(address) {
  const family=isIP(address);
  return family===4 ? !blocked.check(address,'ipv4') : family===6 && globalV6.check(address,'ipv6') && !blocked.check(address,'ipv6');
}

// Checks availability and the actual destination, not semantic truth. Every
// redirect is revalidated, and HTTPS keeps the source hostname for Host/TLS SNI.
export async function verifySourcePages(urls, deps = {}) {
  const deadline=Date.now()+(deps.budgetMs || 6000);
  const unique=[...new Set(urls)];
  const checked=await Promise.all(unique.slice(0,6).map(async original=>{
    let value=original, method='HEAD';
    for(let redirects=0;redirects<=3;redirects++) {
      let url;
      try {url=new URL(value);} catch {return {url:original,ok:false,reason:'invalid'};}
      if(!['http:','https:'].includes(url.protocol) || url.username || url.password || (url.port && !['80','443'].includes(url.port))) return {url:original,ok:false,reason:'unsafe'};
      const remaining=Math.min(3000,deadline-Date.now());
      if(remaining<=0)return {url:original,ok:false,reason:'timeout'};
      const result=await checkPage(url,method,remaining,deps);
      if(result.location && [301,302,303,307,308].includes(result.status)) {
        try{value=new URL(result.location,url).href;}catch{return {url:original,ok:false,reason:'invalid-redirect'};}
        continue;
      }
      if(method==='HEAD' && [403,405,501].includes(result.status)) {method='GET';redirects--;continue;}
      if(result.status>=200 && result.status<300)return {url:original,ok:true,finalUrl:url.href,host:url.hostname};
      return {url:original,ok:false,reason:result.reason || ([401,403,429].includes(result.status)?'access-restricted':result.status===404||result.status===410?'not-found':'http-error'),status:result.status};
    }
    return {url:original,ok:false,reason:'redirect-limit'};
  }));
  return [...checked,...unique.slice(6).map(url=>({url,ok:false,reason:'source-limit'}))];
}

function checkPage(url, method, timeoutMs, deps) {
  return new Promise(resolve=>{
    let done=false,request;
    const finish=value=>{if(done)return;done=true;clearTimeout(timer);resolve(value);request?.destroy();};
    const timer=setTimeout(()=>finish({reason:'timeout'}),timeoutMs);
    const host=url.hostname.replace(/^\[|\]$/g,'');
    (deps.lookup || dns.lookup)(host,{all:true},(error,addresses)=>{
      if(done)return;
      if(error)return finish({reason:'dns-failed'});
      const address=addresses.find(item=>item.family===4 && publicAddress(item.address)) || addresses.find(item=>publicAddress(item.address));
      if(!address)return finish({reason:'unsafe'});
      const send=deps.request || (url.protocol==='https:'?https.request:http.request);
      try {
        request=send(url,{method,headers:{'user-agent':'Plus-One-Source-Check/1.0',...(method==='GET'?{range:'bytes=0-1023'}:{})},
          lookup:(_hostname,options,callback)=>options?.all ? callback(null,[address]) : callback(null,address.address,address.family),
        },response=>finish({status:response.statusCode,location:response.headers.location}));
        request.on('error',()=>finish({reason:'network-failed'}));request.end();
      } catch {finish({reason:'network-failed'});}
    });
  });
}
