import test from 'node:test';
import assert from 'node:assert/strict';
import { capture, rectangle, area, intersection, contains, circle, difference, distance } from '../src/occupiers/geometry.js';
import { TerritoriesMatch, territoryConfig } from '../src/occupiers/territories.js';
import { OccupiersRoom, COLORS } from '../src/occupiers/room.js';

const rect = (x, y, w, h = w) => [[[[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]]]];
const seeded = () => { let n = 12345; return () => ((n = (n * 1664525 + 1013904223) >>> 0) / 2 ** 32); };
const members = count => Array.from({ length: count }, (_, i) => ({ id: 'p' + i, name: 'Player ' + i, color: COLORS[i] }));
const match = (count = 2, config = {}) => new TerritoriesMatch(members(count), { now: 0, random: seeded(), config });
function place(p, point, land = rect(50, 50, 100)) {
  Object.assign(p, { point, land, score: area(land), angle: 0, targetAngle: 0, protectedUntil: 0, trail: [] });
}
const socket = () => ({ close() {} });
function lobby(count = 2, config = {}) {
  let now = 0;
  const room = new OccupiersRoom('fixture', { clock: () => now, random: seeded(), config });
  const people = Array.from({ length: count }, (_, i) => room.attach({ id: i + 1, holder: 'Player ' + i }, socket(), now));
  return { room, people, time: value => { now = value; } };
}
function start(room, people) {
  for (const m of people) assert.equal(room.command(m, { action: 'ready', ready: true }, 0).ok, true);
  assert.equal(room.command(people[0], { action: 'start' }, 0).ok, true);
}

test('capture preserves old land and awards the same exact area in both directions', () => {
  const land = rect(100, 100, 100), world = rectangle(500, 500);
  const trail = [[200, 125], [300, 125], [300, 175], [200, 175]];
  for (const path of [trail, [...trail].reverse()]) {
    const result = capture(land, path, world);
    assert.equal(area(result), 15000);
    assert.equal(area(difference(land, result)), 0);
  }
});

test('concave captures, holes, disconnected islands and protected land remain exact', () => {
  const outer = rect(100, 100, 300);
  const hole = rect(200, 200, 100);
  const donut = difference(outer, hole);
  assert.equal(contains([250, 250], donut), false);
  const filled = capture(donut, [[200, 225], [250, 225], [250, 275], [200, 275]], rectangle(600, 600));
  assert.equal(area(filled), 82500);
  assert.equal(contains([225, 250], filled), true);
  assert.equal(contains([275, 250], filled), false);
  const islands = [...rect(10, 10, 40), ...rect(200, 10, 40)];
  assert.deepEqual(capture(islands, [[50, 20], [150, 20], [200, 20]], rectangle(500, 500)), islands);
  const base = rect(100, 100, 100), trail = [[200, 125], [300, 125], [300, 175], [200, 175]];
  const protectedLand = rect(240, 140, 20);
  const grown = capture(base, trail, rectangle(500, 500), [protectedLand]);
  assert.equal(area(intersection(grown, protectedLand)), 0);
  assert.equal(area(grown), 14600);
});

test('concave corner expansion and randomized rectangular excursions never lose or double-own old land', () => {
  const concave = [[[[100, 100], [300, 100], [300, 200], [200, 200], [200, 300], [100, 300], [100, 100]]]];
  const trail = [[250, 200], [250, 250], [200, 250]];
  for (const path of [trail, [...trail].reverse()]) assert.equal(area(capture(concave, path, rectangle(500, 500))), 32500);
  const random = seeded();
  for (let i = 0; i < 100; i++) {
    const start = 110 + Math.floor(random() * 50), height = 5 + Math.floor(random() * 25), width = 5 + Math.floor(random() * 80);
    const path = [[200, start], [200 + width, start], [200 + width, start + height], [200, start + height]];
    for (const ring of [path, [...path].reverse()]) {
      const result = capture(rect(100, 100, 100), ring, rectangle(500, 500));
      assert.equal(area(result), 10000 + width * height);
      assert.equal(area(difference(rect(100, 100, 100), result)), 0);
    }
  }
});

test('closing a trail subtracts stolen land, preserves disjoint ownership and eliminates a fully captured player', () => {
  const game = match(3); const [a, b, c] = [...game.players.values()];
  place(a, [899, 875], rect(800, 800, 100));
  place(b, [970, 850], rect(940, 840, 20));
  place(c, [1000, 1000], rect(950, 950, 100));
  a.trail = [[900, 825], [1000, 825], [1000, 875]];
  game.closeTrail(a, [900, 875], 100);
  assert.equal(a.score, 15000);
  assert.equal(b.alive, false); assert.equal(b.deathReason, 'no_land');
  assert.equal(area(intersection(a.land, b.land)), 0); assert.equal(area(intersection(a.land, c.land)), 0);
  assert.deepEqual(a.trail, []);
});

test('spawn checks whole edges, heads and trails, and never substitutes an overlapping fallback', () => {
  const game = match(); const [a, b] = [...game.players.values()];
  place(a, [500, 500], rectangle(2400, 2400));
  game.eliminate(b, 'fixture', 0);
  assert.equal(game.safeSpawn(), null);
  a.land = rect(10, 10, 100); a.point = [100, 100]; a.trail = [[300, 300], [2100, 300]];
  const p = game.spawn({ id: 'new', name: 'New', color: COLORS[2] }, 10);
  assert.ok(p); assert.equal(area(intersection(p.land, a.land)), 0);
  assert.ok(distance(p.point, a.point) >= game.config.spawnDistance + game.config.spawnRadius);
});

test('unprotected head contacts kill both; either protected head makes direct contact harmless', () => {
  for (const protectedUntil of [0, 2000]) {
    const game = match(); const [a, b] = [...game.players.values()];
    place(a, [500, 500], rect(400, 400, 200)); place(b, [510, 500], rect(510, 490, 50));
    b.protectedUntil = protectedUntil;
    game.step(.001, 100);
    assert.equal(a.alive, !!protectedUntil); assert.equal(b.alive, !!protectedUntil);
  }
});

test('cutting a trail kills its owner, including when attacker is inside own land; protection prevents kills', () => {
  for (const protectedUntil of [0, 2000]) {
    const game = match(3); const [a, b, c] = [...game.players.values()];
    place(a, [500, 500], rect(400, 400, 200)); place(b, [900, 900]); place(c, [1600, 1600]);
    a.protectedUntil = protectedUntil; b.trail = [[505, 450], [505, 550]];
    game.step(.04, 100);
    assert.equal(b.alive, !!protectedUntil); assert.equal(a.alive, true);
  }
});

test('long straight simplified trails do not cause self-collision at their moving end', () => {
  const game = match(); const [a, b] = [...game.players.values()];
  place(a, [800, 500]); place(b, [1500, 1500]);
  a.trail = [[150, 500], [800, 500]];
  for (let i = 0; i < 10; i++) game.step(1 / 30, 100 + i * 34);
  assert.equal(a.alive, true); assert.equal(a.trail.length, 2);
});

test('self-crossing and leaving the arena eliminate, and dead land/trails are released', () => {
  const game = match(3); const [a, b, c] = [...game.players.values()];
  place(a, [500, 500]); place(b, [2399, 700]); place(c, [1700, 1700]);
  a.trail = [[505, 450], [505, 550], [900, 550], [900, 500], [500, 500]];
  game.step(.04, 100);
  assert.equal(a.deathReason, 'self_trail'); assert.equal(b.deathReason, 'boundary');
  assert.deepEqual(a.land, []); assert.deepEqual(a.trail, []);
});

test('protection lasts at most three seconds and ends on the first exit', () => {
  const game = match(); const p = [...game.players.values()][0], spawn = [...p.point];
  assert.equal(p.protectedUntil, 3000);
  game.step(.01, 100); assert.equal(p.protectedUntil, 3000);
  p.point = [spawn[0] + 61, spawn[1]]; p.angle = p.targetAngle = 0;
  game.step(.04, 200); assert.equal(p.protectedUntil, 0); assert.ok(p.trail.length > 0);
});

test('input accepts only finite bounded directions and cannot set speed, area or protection', () => {
  const game = match(), p = [...game.players.values()][0];
  for (const input of [NaN, Infinity, -Infinity, null, '0', {}, 1000]) assert.equal(game.input(p.id, input), false);
  assert.equal(game.input(p.id, Math.PI), true);
  assert.equal(p.score, area(p.land)); assert.equal(p.protectedUntil, 3000);
});

test('lobby requires all participants ready, host authorization, unique colours and resets readiness on colour change', () => {
  const { room, people: [a, b] } = lobby();
  assert.equal(room.command(a, { action: 'start' }, 0).reason, 'not_ready');
  assert.equal(room.command(b, { action: 'start' }, 0).reason, 'host_only');
  assert.equal(room.command(a, { action: 'color', color: b.color }, 0).reason, 'color_taken');
  room.command(a, { action: 'ready', ready: true }, 0);
  room.command(a, { action: 'color', color: COLORS[3] }, 0); assert.equal(a.ready, false);
  start(room, [a, b]); assert.equal(room.phase, 'running');
});

test('observer does not block start; organizer role passes to next connected member', () => {
  const { room, people: [a, b, c] } = lobby(3);
  room.command(c, { action: 'spectate' }, 0); start(room, [a, b]);
  assert.equal(room.match.players.size, 2);
  room.detach(a, a.socket, 10); assert.equal(room.hostId, b.id);
});

test('late fifth player gets a unique safe start without restarting match clock; eliminated cannot re-enter', () => {
  const { room, people } = lobby(4); start(room, people);
  const endsAt = room.match.endsAt;
  const late = room.attach({ id: 5, holder: 'Late' }, socket(), 100);
  late.color = people[0].color; assert.equal(room.command(late, { action: 'join' }, 100).ok, true);
  assert.notEqual(late.color, people[0].color); assert.equal(room.match.active().length, 5);
  const p = room.player(late.id); assert.equal(p.protectedUntil, 3100);
  for (const other of room.match.active().filter(x => x !== p)) assert.equal(area(intersection(p.land, other.land)), 0);
  assert.equal(room.match.endsAt, endsAt);
  room.match.eliminate(p, 'trail_cut', 200);
  room.command(late, { action: 'spectate' }, 201);
  assert.equal(room.command(late, { action: 'join' }, 202).reason, 'eliminated');
  room.detach(late, late.socket, 203);
  const reopened = room.attach({ id: 5, holder: 'Late' }, socket(), 204);
  assert.equal(reopened.id, late.id); assert.equal(room.command(reopened, { action: 'join' }, 205).reason, 'eliminated');
});

test('simultaneous admission commands reserve colours/places atomically at twelve, and spectator can retry a freed slot', () => {
  const { room, people } = lobby(2); start(room, people);
  const late = Array.from({ length: 11 }, (_, i) => room.attach({ id: i + 10, holder: 'Late ' + i }, socket(), 100));
  const results = late.map(m => room.command(m, { action: 'join' }, 100));
  assert.equal(results.filter(r => r.ok).length, 10); assert.equal(results.at(-1).reason, 'full');
  assert.equal(new Set(room.match.active().map(p => p.color)).size, 12);
  room.match.eliminate(room.player(late[0].id), 'fixture', 101);
  assert.equal(room.command(late.at(-1), { action: 'join' }, 102).ok, true);
});

test('reconnection returns to the existing character without land/protection reset; second socket takes control only once', () => {
  const { room, people: [a, b] } = lobby(); start(room, [a, b]);
  const before = room.player(a.id), originalLand = JSON.stringify(before.land);
  room.detach(a, a.socket, 100);
  const other = socket(); room.attach({ id: 1, holder: 'Renamed' }, other, 200);
  assert.equal(room.player(a.id), before); assert.equal(before.protectedUntil, 3000);
  assert.equal(JSON.stringify(before.land), originalLand); assert.equal(before.disconnectedAt, null);
  const newer = socket(); room.attach({ id: 1, holder: 'Renamed' }, newer, 201);
  room.detach(a, other, 202); assert.equal(a.socket, newer); assert.equal(before.disconnectedAt, null);
});

test('ten-second disconnect expires even if user reconnects before the next scheduled server tick', () => {
  const { room, people } = lobby(3); start(room, people);
  const p = room.player(people[0].id); room.detach(people[0], people[0].socket, 0);
  // Keep position away from other collisions during the bounded catch-up.
  p.point = [800, 800]; p.land = rect(700, 700, 200);
  room.attach({ id: 1, holder: 'Back' }, socket(), 10_100);
  assert.equal(p.alive, false); assert.equal(p.deathReason, 'disconnected');
});

test('deadline and final-player wins are decided before late entry; rematch fully resets game state', () => {
  const { room, people } = lobby(2, { durationMs: 1000 }); start(room, people);
  const old = room.match, p = [...old.players.values()];
  p[0].score = p[1].score = 100;
  room.tick(1000); assert.equal(room.phase, 'results'); assert.equal(room.lastResults.winners.length, 2);
  const late = room.attach({ id: 9, holder: 'After end' }, socket(), 1000);
  assert.equal(room.command(late, { action: 'join' }, 1000).ok, true); assert.equal(room.phase, 'lobby');
  assert.equal(room.match, null); assert.ok(people.every(m => !m.ready));
  for (const m of room.connected().filter(m => m.role === 'player')) room.command(m, { action: 'ready', ready: true }, 1001);
  assert.equal(room.command(people[0], { action: 'start' }, 1001).ok, true);
  assert.notEqual(room.match.id, old.id); assert.ok([...room.match.players.values()].every(x => x.alive && x.trail.length === 0));
});

test('final ranking puts survivors first, then later eliminations, retaining every late participant', () => {
  const game = match(4); const p = [...game.players.values()];
  game.eliminate(p[0], 'fixture', 100); game.eliminate(p[1], 'fixture', 200);
  p[2].score = 400; p[3].score = 300; game.finish(300);
  assert.deepEqual(game.results.rows.map(r => r.id), [p[2].id, p[3].id, p[1].id, p[0].id]);
  assert.deepEqual(game.results.winners, [p[2].id]);
});

test('mode-specific settings reject unsafe values and preserve twelve as active rather than lifetime limit', () => {
  for (const options of [{ maxPlayers: 13 }, { durationMs: -1 }, { speed: Infinity }, { tickRate: 0 }]) assert.throws(() => territoryConfig(options));
  assert.equal(territoryConfig().durationMs, 300000);
});

test('private Territories practice supports one participant until death or timeout and stays private', () => {

  for (const end of ['death', 'timeout']) {
    const game = new TerritoriesMatch(members(1), { now: 0, practice: true, random: seeded(), config: { durationMs: 1000 } });
    game.advance(100); assert.equal(game.finished, false);
    assert.equal(game.join(members(2)[1], 100).ok, false);
    if (end === 'death') game.eliminate(game.active()[0], 'boundary', 150);
    game.advance(end === 'death' ? 200 : 1000);
    assert.equal(game.finished, true); assert.equal(game.results.rows.length, 1);
    assert.equal(game.results.winners.length, end === 'death' ? 0 : 1);
  }
});

test('three complete five-minute twelve-player simulated matches finish with all results and clean rematches', () => {
  const { room, people } = lobby(12);
  for (let round = 0; round < 3; round++) {
    const startAt = round * 301000;
    for (const member of people) assert.equal(room.command(member, { action: 'ready', ready: true }, startAt).ok, true);
    assert.equal(room.command(people[0], { action: 'start' }, startAt).ok, true);
    for (let frame = 1; frame <= 9000; frame++) {
      for (const p of room.match.active()) room.match.input(p.id, Math.atan2(Math.sin(p.angle + .2), Math.cos(p.angle + .2)));
      room.tick(startAt + frame * 1000 / 30 + .0001);
    }
    assert.equal(room.phase, 'results'); assert.equal(room.lastResults.rows.length, 12);
    assert.ok(room.lastResults.rows.every(r => r.status !== 'eliminated'));
    const colors = people.map(p => p.color);
    room.command(people[0], { action: 'lobby' }, startAt + 300001);
    assert.equal(room.match, null); assert.ok(people.every(m => !m.ready));
    assert.deepEqual(people.map(p => p.color), colors);
  }
});


test('circular world keeps complete random and fallback spawns inside its edge', () => {
  for(const random of [seeded(),()=>0]) {
    const game=new TerritoriesMatch(members(12),{now:0,random,config:{width:3000,height:1800}});
    assert.equal(game.world[0][0].length,257);assert.equal(game.active().length,12);
    for(const p of game.active()) {
      assert.ok(distance(p.point,game.arena.center)+game.config.spawnRadius+game.config.spawnGap<=900*Math.cos(Math.PI/256));
      assert.equal(area(difference(p.land,game.world)),0);
    }
  }
});

test('circular boundary eliminates in former square corners even during spawn protection', () => {
  for(const point of [[2401,1200],[1200,2401],[30,30],[2300,2300]]) {
    const game=match(3),p=game.active()[0];p.point=point;p.land=rect(point[0]-10,point[1]-10,20);p.protectedUntil=3000;
    game.step(.001,100);assert.equal(p.deathReason,'boundary');
  }
});

test('captures clip at the same circular world and final score uses its actual area', () => {
  const game=match(),p=game.active()[0];
  const land=rect(1160,2280,80,80),trail=[[1240,2300],[1300,2420],[1100,2420],[1160,2320]];
  const clipped=capture(land,trail,game.world);assert.equal(area(difference(clipped,game.world)),0);assert.ok(area(clipped)>area(land));
  p.land=game.world;p.score=game.arenaArea;game.finish(100);
  assert.equal(game.results.rows.find(row=>row.id===p.id).percent,100);
  assert.deepEqual(game.snapshot().arena,game.arena);assert.equal(game.snapshot().arenaArea,area(game.world));
});

test('gentler steering stays turn-limited and can make a full turn inside the starting territory', () => {
  const game=match(),p=game.active()[0],start=[...p.point];
  for(let i=0;i<90;i++) {game.input(p.id,Math.atan2(Math.sin(p.angle+1),Math.cos(p.angle+1)));const before=p.angle;game.step(1/30,i*1000/30);assert.ok(Math.abs(Math.atan2(Math.sin(p.angle-before),Math.cos(p.angle-before)))<=5.2/30+1e-8);assert.ok(contains(p.point,p.land));}
  assert.ok(p.alive);assert.ok(distance(start,p.point)<62);
});

test('character selection is shared, cosmetic, repeatable and preserved through reconnect and rematch', () => {
  const {room,people:[a,b]}=lobby();
  for(const invalid of ['unknown','__proto__',null,{},1])assert.equal(room.command(a,{action:'character',character:invalid},0).reason,'character_unknown');
  room.command(a,{action:'ready',ready:true},0);
  assert.equal(room.command(a,{action:'character',character:'fox'},0).ok,true);assert.equal(a.ready,false);
  assert.equal(room.command(b,{action:'character',character:'fox'},0).ok,true,'duplicate characters allowed');
  assert.equal(room.snapshot().characters.length,8);
  assert.equal(room.snapshot().members.find(m=>m.id===a.id).character,'fox');
  start(room,[a,b]);const original=room.player(a.id);
  assert.equal(original.character,'fox');assert.equal(room.command(a,{action:'character',character:'robot'},1).reason,'character_locked');assert.equal(original.character,'fox');
  room.detach(a,a.socket,2);const back=room.attach({id:1,holder:'Back'},socket(),3);assert.equal(back,a);assert.equal(back.character,'fox');assert.equal(room.player(a.id),original);
  room.match.finish(4);room.tick(4);assert.equal(room.lastResults.rows.find(p=>p.id===a.id).character,'fox');room.command(a,{action:'lobby'},4);
  assert.equal(a.character,'fox');assert.equal(b.character,'fox');assert.equal(room.hostId,b.id);start(room,[b,a]);assert.equal(room.player(a.id).character,'fox');
});

test('all character choices retain identical movement, collision dimensions and initial land', () => {
  const kinds=['car','cow','crab','duck','fox','penguin','dino','robot'];let expected;
  for(const kind of kinds){const game=new TerritoriesMatch(members(2).map(m=>({...m,character:kind})),{now:0,random:seeded()});
    const p=game.active()[0];game.input(p.id,1);game.advance(200);
    const state={point:p.point,angle:p.angle,land:p.land,score:p.score,headRadius:game.config.headRadius,speed:game.config.speed};
    if(expected)assert.deepEqual(state,expected);else expected=state;
    assert.equal(game.snapshot().players.find(v=>v.id===p.id).character,kind);
  }
});

test('a group Territories match can start alone, admits an opponent and then uses competitive ending', () => {
  const game = new TerritoriesMatch(members(1), { now: 0, random: seeded() });
  game.advance(100); assert.equal(game.finished, false); assert.equal(game.active().length, 1);
  assert.equal(game.join(members(2)[1], 100).ok, true); assert.equal(game.competitive, true);
  game.eliminate(game.active()[1], 'fixture', 110); game.advance(150);
  assert.equal(game.finished, true); assert.deepEqual(game.results.winners, [members(1)[0].id]);
  assert.throws(() => new TerritoriesMatch([], { now: 0 }), /players_required/);
});
