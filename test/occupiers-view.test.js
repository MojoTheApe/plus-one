import test from 'node:test';
import { controlsFixture } from '../test-support/floating-controls.mjs';
import assert from 'node:assert/strict';
import { drawToy, shade } from '../web/occupiers/art.js';
import { TerritoryView, extrapolate, arenaBoundary } from '../web/occupiers/territories.js';
const near = (a,b,e=1e-6) => assert.ok(Math.hypot(a[0]-b[0],a[1]-b[1])<e, `${a} != ${b}`);
function player(trail, from, point, newTrail=false) { return {id:'self',alive:true,trail,point,from,angle:0,fromAngle:0,received:1000}; }
const view = () => Object.assign(Object.create(TerritoryView.prototype), { id:'self',game:{speed:155,turnSpeed:7},inputAngle:null,players:new Map() });

test('a new trail is clipped at its displayed head without returning to its attachment', () => {
  const trail=[[330,300],[340,300],[348,306],[352,320]],p=player(trail,[300,300],trail.at(-1),true),v=view();
  assert.equal(v.trailFrame(p,[300,300],[]).tail,null);
  const head=[346,304],frame=v.trailFrame(p,head,[]);
  assert.equal(frame.tail.endIndex,1);
  const visible=[...trail.slice(0,frame.tail.endIndex+1),...frame.extension,head];
  assert.deepEqual(visible,[[330,300],[340,300],head]);
  near(p.point,[352,320]);
});

test('off-polyline correction starts at the displayed point and searches only a recent suffix', () => {
  const p=player([[0,0],[100,0]],[80,10],[100,0]),v=view();near(v.frameState(p,1000).point,[80,10]);
  const next=v.frameState(p,1000.001);assert.ok(Math.hypot(next.point[0]-80,next.point[1]-10)<.01);
  const spiral=[[80,0],[100,0],[100,100],[0,100],[0,2],[100,2]];
  const frame=v.trailFrame(player(spiral,[80,1],[100,2]),[80,1],[]);
  assert.equal(frame.tail.endIndex,4,'nearby old parallel segment is excluded');
});

test('packet jitter is bounded by the explicit receipt-age horizon and never mutates server state', () => {
  for(const id of ['self','other']) {
    const v=view(),p=player([[0,0],[100,0]],[84.5,0],[100,0]);p.id=id;
    const cap=id==='self'?150:180;
    let previous=v.frameState(p,1000).point;
    for(let age=1;age<=cap;age++){const next=v.frameState(p,1000+age).point;assert.ok(next.every(Number.isFinite));assert.ok(Math.hypot(next[0]-previous[0],next[1]-previous[1])<=.232501);previous=next;}
    near(v.frameState(p,1300).point,previous);near(v.frameState(p,2000).point,previous);
    near(p.point,[100,0]);
  }
});

test('short-arc heading and turn-limited extrapolation cross the angle wrap safely', () => {
  const v=view(),p=player([], [0,0],[1,0]);p.fromAngle=Math.PI-.05;p.angle=-Math.PI+.05;
  let previous=p.fromAngle;
  for(let t=1000;t<=1150;t++){const angle=v.frameState(p,t).angle;assert.ok(Math.abs(angle-previous)<.01);assert.ok(angle>=Math.PI-.050001&&angle<=Math.PI+.050001);previous=angle;}
  assert.ok(previous>Math.PI,'the short forward arc crossed the wrap');
  const predicted=extrapolate([0,0],Math.PI-.05,-Math.PI+.05,155,7,.1);
  assert.ok(predicted.point[0]<-15);assert.ok(Math.abs(predicted.point[1])<1);
  const turning=extrapolate([0,0],0,Math.PI,155,7,.1);assert.ok(turning.angle<=.700001);
});

test('the final fast gesture is sent, and cancellation cannot resurrect old input', async () => {
  const sent=[],v=Object.assign(view(),{enabled:true,lastInputAt:-Infinity,inputTimer:null,pendingInput:null,onInput:a=>sent.push(a)});
  v.input(0);v.input(1);v.input(2);
  await new Promise(resolve=>setTimeout(resolve,65));assert.deepEqual(sent,[0,2]);
  v.input(3);v.input(4);v.clearInput();const length=sent.length;
  await new Promise(resolve=>setTimeout(resolve,65));assert.equal(sent.length,length);assert.equal(v.inputAngle,null);
});

test('visible trail clipping never visits the authoritative future tip before its character', () => {
  const p=player([[0,0],[100,0]],[84.5,0],[100,0]),v=view();
  for(const age of [0,10,30,50]) {
    const frame=v.frameState(p,1000+age),end=frame.tail.endIndex;
    const visible=[...p.trail.slice(0,end+1),frame.point];
    assert.ok(visible.every(point=>point[0]<=frame.point[0]));
    near(visible.at(-1),frame.point);
  }
});

test('a moderately off-path correction keeps the existing trail visible throughout', () => {
  const v=view(),p=player([[0,0],[100,0]],[80,20],[100,0]);
  near(v.frameState(p,1000).point,[80,20]);
  for(const age of [0,25,50,51])assert.ok(v.frameState(p,1000+age).tail);
  const recent=v.trailFrame(player([[0,0],[1000,0]],[100,0],[1000,0]),[100,0],[]);
  assert.equal(recent.tail,null,'an unmatched old segment is not shown ahead of the head');
});

test('duplicate event broadcasts preserve the motion epoch rather than pulling the head backward', () => {
  const v=Object.assign(view(),{players:new Map(),clearInput(){},camera:null});
  const data={id:'self',name:'Self',color:'#ffbb00',point:[100,0],angle:0,alive:true,score:1,land:[],trail:{id:'t',from:0,points:[[0,0],[100,0]]}};
  const game={id:'match',speed:155,turnSpeed:7,simulatedAt:0,players:[data]};
  v.game=null;v.update(game,'self',1000);
  const before=v.position(v.me(),1100);near(before,[115.5,0]);
  v.update(game,'self',1100);near(v.position(v.me(),1125),[119.375,0]);assert.equal(v.me().received,1000);
});

test('shared floating pointer cancellation discards a pending Territories direction', async () => {
  const sent = [], v = Object.assign(view(), { enabled: true, lastInputAt: -Infinity, onInput: a => sent.push(a) });
  const f = controlsFixture({ move: target => v.input(Math.atan2(target.y / .82, target.x)), release: cancelled => cancelled ? v.cancelPendingInput() : v.flushInput() });
  f.send('pointerdown', 100, 300); f.send('pointermove', 160, 300); f.send('pointermove', 160, 360); f.send('pointercancel', 160, 360);
  await new Promise(resolve => setTimeout(resolve, 65)); assert.deepEqual(sent, [0]); assert.equal(v.pendingInput, null);
});

test('actual paint ends the stroke at the same frame point used by its toy and camera', t => {
  const previousPath=globalThis.Path2D,previousOffscreen=globalThis.OffscreenCanvas;
  class Path { constructor(){this.points=[];}moveTo(...p){this.points.push(p);}lineTo(...p){this.points.push(p);}closePath(){} }
  const strokes=[];
  const ctx=new Proxy({stroke(path){if(path instanceof Path&&this.lineWidth===6)strokes.push(path.points);}},
    {get:(o,k)=>k in o?o[k]:()=>{},set:(o,k,v)=>(o[k]=v,true)});
  globalThis.Path2D=Path;globalThis.OffscreenCanvas=class{getContext(){return ctx;}};
  t.after(()=>{if(previousPath)globalThis.Path2D=previousPath;else delete globalThis.Path2D;if(previousOffscreen)globalThis.OffscreenCanvas=previousOffscreen;else delete globalThis.OffscreenCanvas;});
  const v=Object.assign(view(),{players:new Map(),ctx,width:390,height:754,dpr:1,lastPaint:1000,camera:null,followId:null});
  const p=Object.assign(player([[0,0],[100,0]],[84.5,0],[100,0]),{name:'Self',color:'#ffbb00',score:1,land:[],protectedUntil:0});
  v.game={...v.game,width:2400,height:2400,headRadius:6,trailRadius:3};v.players.set('self',p);v.paint(1000);
  assert.ok(strokes.length);near(strokes.at(-1).at(-1),p.visual.point);assert.ok(strokes.flat().every(p=>p[0]<=84.5));near(v.camera,p.visual.point);
});


test('new aim and cancellation anchor the current pose without extending the receipt cap', t => {
  for (const age of [90,150,250]) {
    const v=Object.assign(view(),{enabled:true,lastInputAt:-Infinity,inputTimer:null,pendingInput:null,lastSentAngle:0,onInput(){}});
    const p=player([[0,0],[100,0]],[100,0],[100,0]);v.players.set('self',p);v.inputAngle=0;
    const now=1000+age,before=v.frameState(p,now);v.input(Math.PI,now);const after=v.frameState(p,now);
    near(before.point,after.point);assert.equal(before.angle,after.angle);
    const later=v.frameState(p,now+10);assert.ok(Math.hypot(later.point[0]-after.point[0],later.point[1]-after.point[1])<=1.550001);
    v.lastSentAngle=0;const cancelledAt=now+10,prior=v.frameState(p,cancelledAt);v.cancelPendingInput(cancelledAt);near(v.frameState(p,cancelledAt).point,prior.point);
    near(v.frameState(p,1300).point,v.frameState(p,2000).point);
    v.clearInput();assert.equal(v.inputAnchor,null);
  }
});

test('the actual own-toy renderer rotates continuously through the former sprite boundary', () => {
  function roof(angle) {
    let path=[],result;
    const ctx=new Proxy({beginPath(){path=[];},moveTo(...p){path.push(p);},lineTo(...p){path.push(p);},
      drawImage(){throw Error('Own toy must not use a quantised sprite');},
      fill(){if(this.fillStyle===shade('#342133',1.08))result=path;}},
      {get:(o,k)=>k in o?o[k]:()=>{},set:(o,k,v)=>(o[k]=v,true)});
    const v=Object.assign(view(),{ctx,width:390,height:754,dpr:1,lastPaint:1000,camera:null,followId:null});
    const p=Object.assign(player([], [100,100],[100,100]),{name:'Self',color:'#ffbb00',score:1,land:[],protectedUntil:0,angle,fromAngle:angle});
    v.game={...v.game,width:2400,height:2400,headRadius:6,trailRadius:3};v.players.set('self',p);v.paint(1000);
    assert.ok(result?.length===4);return result;
  }
  const a=roof(Math.PI/16-1e-8),b=roof(Math.PI/16+1e-8);a.forEach((p,i)=>near(p,b[i],1e-5));
});

test('every detailed model uses continuous yaw without allocating rotating image surfaces', () => {
  function faces(kind, angle) {
    let path = [], result = [];
    const ctx = new Proxy({ beginPath(){path=[];}, moveTo(...p){path.push(p);}, lineTo(...p){path.push(p);},
      fill(){if(path.length===4)result.push(path);}, drawImage(){throw Error('No quantised toy sprite');} },
      {get:(o,k)=>k in o?o[k]:()=>{},set:(o,k,v)=>(o[k]=v,true)});
    drawToy(ctx,0,0,56,angle,kind,'#ffbb00'); return result;
  }
  for(const kind of ['car','cow','crab','duck','fox','penguin','dino','robot']) {
    const a=faces(kind,Math.PI/16-1e-8),b=faces(kind,Math.PI/16+1e-8);
    assert.ok(a.length>0,'model is visible'); assert.equal(a.length,b.length);
    a.forEach((face,i)=>face.forEach((point,j)=>near(point,b[i][j],1e-4)));
  }
});

test('burst snapshots cannot speed presentation turns above their per-frame limit', () => {
  for(const id of ['self','other']) {
    const v=view();v.game=null;
    const packet=angle=>({id:'burst',width:2400,height:2400,speed:155,turnSpeed:5.2,simulatedAt:angle*1000,
      players:[{id,name:'Гравець',color:'#ffbb00',point:[1200,1200],angle,targetAngle:angle,alive:true,score:1,land:[],trail:{id:0,from:0,points:[]}}]});
    v.update(packet(0),'self',1000);let previous=v.frameState(v.players.get(id),1000).angle;
    for(let frame=1;frame<=40;frame++) {
      const now=1000+frame*10;if(frame%2===0)v.update(packet(frame*.26),'self',now);
      const current=v.frameState(v.players.get(id),now).angle;
      assert.ok(Math.abs(Math.atan2(Math.sin(current-previous),Math.cos(current-previous)))<=.065001);
      assert.equal(v.frameState(v.players.get(id),now).angle,current,'same clock is idempotent');previous=current;
    }
    assert.ok(Math.abs(previous)>.2,'presentation still turns');
  }
});

test('the same circular boundary descriptor drives rendering and percentage on a non-square canvas', () => {
  const v=view();v.game={width:3000,height:1800,arena:{shape:'circle',center:[1500,900],radius:900,segments:256},arenaArea:2544434.5};
  const points=arenaBoundary(v.game);assert.equal(points.length,256);near(points[0],[2400,900]);near(points[64],[1500,1800]);
  for(const p of points)assert.ok(Math.abs(Math.hypot(p[0]-1500,p[1]-900)-900)<1e-6);
  assert.equal(v.percent({score:v.game.arenaArea/2}),50);
});

test('floating joystick ignores finger wobble and sends the full steering direction', () => {
  const f = controlsFixture(); f.send('pointerdown', 100, 300); f.send('pointermove', 106, 304);
  assert.equal(f.moved.length, 0); f.send('pointermove', 160, 300); assert.deepEqual(f.moved, [{ x: 1, y: 0 }]);
});

test('the selected character has identical drawn geometry for its owner and other viewers', () => {
  function render(id,character) {
    let path=[],faces=[];
    const ctx=new Proxy({beginPath(){path=[];},moveTo(...p){path.push(p);},lineTo(...p){path.push(p);},fill(){if(path.length===4)faces.push(path);}},
      {get:(o,k)=>k in o?o[k]:()=>{},set:(o,k,v)=>(o[k]=v,true)});
    const v=Object.assign(view(),{ctx,width:390,height:754,dpr:1,lastPaint:1000,camera:null,followId:null});
    const p=Object.assign(player([],[1200,1200],[1200,1200]),{id,character,name:'Гравець',color:'#ffbb00',score:1,land:[],protectedUntil:0,angle:.4,fromAngle:.4});
    v.game={...v.game,width:2400,height:2400,headRadius:6,trailRadius:3};v.players.set(id,p);v.paint(1000);return faces;
  }
  const unique=new Set();
  for(const kind of ['car','cow','crab','duck','fox','penguin','dino','robot']){
    const owner=render('self',kind);assert.deepEqual(owner,render('other',kind));unique.add(JSON.stringify(owner));
  }
  assert.equal(unique.size,8,'each offered character draws its own distinct geometry');
});
