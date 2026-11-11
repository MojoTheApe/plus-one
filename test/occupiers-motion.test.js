import test from 'node:test';
import assert from 'node:assert/strict';
import { TerritoriesMatch } from '../src/occupiers/territories.js';
import { TerritoryView } from '../web/occupiers/territories.js';

const distance = (a,b) => Math.hypot(a[0]-b[0],a[1]-b[1]);
const delta = (a,b) => Math.atan2(Math.sin(a-b),Math.cos(a-b));
const turn = t => Math.atan2(Math.sin((t-500)*.0015),Math.cos((t-500)*.0015));
function run({mode='straight', jitter=false, own=true, fps=60, cadence=100}={}) {
  const match = new TerritoriesMatch([{id:'actor',name:'Гравець',color:'#ffbb00',character:'crab'}],
    {now:0,random:()=>.5,practice:true});
  const view = Object.assign(Object.create(TerritoryView.prototype),
    {game:null,id:own?'actor':'observer',players:new Map(),stick:{style:{}},inputAngle:null,inputAnchor:null});
  const events=[],baseline=new Map();
  for(let t=0;t<=4000;t++) {
    if(mode==='hard'&&t===500) match.input('actor',Math.PI);
    if(mode==='gentle'&&t>=520&&t%40===0) match.input('actor',turn(t));
    match.advance(t);
    if(t%cadence===0) events.push({at:t+(jitter&&Math.round(t/cadence)%2?40:0),kind:0,
      game:structuredClone(match.snapshot(t===0,baseline))});
    if(own&&mode==='hard'&&t===500) events.push({at:t,kind:1,angle:Math.PI});
    if(own&&mode==='gentle'&&t>=520&&t%40===0) events.push({at:t,kind:1,angle:turn(t)});
  }
  for(let i=0;i<=Math.floor(4000*fps/1000);i++) events.push({at:i*1000/fps,kind:2});
  events.sort((a,b)=>a.at-b.at||a.kind-b.kind);
  let previous;const frames=[],captures=[];
  for(const e of events) {
    const now=1000+e.at;
    if(e.kind===0) {
      const old=view.players.get('actor'),before=old?view.frameState(old,now):null;
      view.update(e.game,view.id,now);
      if(before) assert.ok(distance(before.point,view.frameState(view.players.get('actor'),now).point)<1e-6,
        'ordinary packets cannot teleport the displayed head');
      captures.push({at:e.at,score:e.game.players[0].score,alive:e.game.players[0].alive,trail:e.game.players[0].trail.id});
    } else if(e.kind===1) view.setAim(e.angle,now);
    else {
      const f=view.frameState(view.players.get('actor'),now);
      if(previous) frames.push({at:e.at,speed:distance(f.point,previous.point)/(e.at-previous.at)*1000,
        dx:f.point[0]-previous.point[0],yaw:delta(f.angle,previous.angle)/(e.at-previous.at)*1000,...f});
      previous={at:e.at,...f};
    }
  }
  return {frames,view,captures};
}

test('actual30Hz engine data keeps travel speed even with10Hz packet jitter and timer quantisation', () => {
  for(const own of [true,false]) for(const cadence of [99,100]) for(const jitter of [true,false]) {
    const {frames}=run({own,cadence,jitter});
    for(const f of frames.filter(f=>f.at>=1000&&f.at<=3500)) assert.ok(Math.abs(f.speed-155)<.02,
      `steady movement: own=${own},cadence=${cadence},jitter=${jitter},speed=${f.speed}`);
  }
});

test('smoothly steered own and remote turns have no held-angle frames at60Hz or120Hz', () => {
  for(const own of [true,false]) for(const jitter of [true,false]) {
    const runs=[60,120].map(fps=>run({own,jitter,fps,mode:'gentle'}));
    for(const r of runs) for(const f of r.frames.filter(f=>f.at>=1000&&f.at<=3500)) {
      assert.ok(f.yaw>.5&&f.yaw<2.5,`continuous angular motion, actual${f.yaw}`);
      assert.ok(f.speed>130&&f.speed<180,`continuous travel, actual${f.speed}`);
    }
    assert.ok(distance(runs[0].frames.at(-1).point,runs[1].frames.at(-1).point)<.15,'refresh rate does not change trajectory');
    assert.ok(Math.abs(delta(runs[0].frames.at(-1).angle,runs[1].frames.at(-1).angle))<.01);
  }
});

test('actual capture and second exit never send the own head backwards to a new trail attachment', () => {
  const r=run({mode:'hard'});
  assert.ok(r.captures.find(p=>p.at===1400).score>r.captures[0].score,'the engine really captured land');
  assert.ok(r.captures.every(p=>p.alive),'the actor remains alive');
  for(const f of r.frames.filter(f=>f.at>=1600&&f.at<=1900)) {
    assert.ok(f.dx<0,'forward travel after the turn cannot backtrack at the next attachment');
    assert.ok(f.speed>150&&f.speed<175,'no new-trail speed burst');
  }
});

test('outage recovery preserves receipt budgets, bounded history, cosmetics and authoritative death', () => {
  const {view}=run({mode:'gentle'}),p=view.players.get('actor');
  const frozen=view.frameState(p,6000);assert.deepEqual(view.frameState(p,9000),frozen);
  assert.ok(p.history.length<=8);
  const game=structuredClone(view.game);game.simulatedAt=5000;game.players[0].point=[1500,1500];
  view.update(game,'actor',9000);const reset=view.frameState(view.me(),9000);
  assert.deepEqual(reset.point,[1500,1500]);assert.equal(view.inputAngle,null);assert.equal(view.me().character,'crab');
  game.simulatedAt=5033;game.players[0].alive=false;game.players[0].point=[1502,1500];
  view.update(game,'actor',9033);assert.deepEqual(view.frameState(view.me(),9500).point,[1502,1500]);
  assert.equal(view.frameState(view.me(),9500).tail,null);
  view.update(null,'actor',9500);assert.equal(view.players.size,0);assert.equal(view.simulationOffset,null);
});
