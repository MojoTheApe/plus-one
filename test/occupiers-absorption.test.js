import test from 'node:test';
import assert from 'node:assert/strict';
import { AbsorptionCell, AbsorptionPlayer, ABSORPTION_RULES, cellVelocity, radiusFromMass, separateOpponents } from '../src/occupiers/absorption-core.js';
import { AbsorptionMatch, absorptionConfig } from '../src/occupiers/absorption.js';
import { OccupiersRoom, COLORS } from '../src/occupiers/room.js';
const seeded = () => { let n = 77; return () => ((n = (Math.imul(n, 1664525) + 1013904223) >>> 0) / 2 ** 32); };
const members = n => Array.from({ length: n }, (_, i) => ({ id: 'p' + i, name: 'Гравець ' + i, color: COLORS[i], character: 'fox' }));
const match = (n = 2, config = {}) => new AbsorptionMatch(members(n), { now: 0, random: seeded(), config: { foodCount: 0, ...config } });
const place = (p, mass, x = 1000, y = 1000) => { p.cells = [new AbsorptionCell(p.nextId(), [x, y], mass, ABSORPTION_RULES.speed)]; p.centre(); p.target = { x: 0, y: 0 }; p.protectedUntil = 0; };

test('large cells keep a dynamic speed floor and boost spends mass behind the current aim', () => {
  const velocity = mass => cellVelocity(new AbsorptionCell(1, [0, 0], mass, 240), [0, 0], { x: 1, y: 0 }, ABSORPTION_RULES)[0];
  assert.ok(velocity(100) > 140 && velocity(100) < 150); assert.ok(velocity(4000) >= 91);
  assert.ok(velocity(100) < velocity(10));
  const g = match(), p = g.active()[0]; place(p, 100, 1200, 1200);
  g.input(p.id, { x: 1, y: 0 }); assert.equal(g.boost(p.id, true, 0), true); g.advance(150);
  assert.ok(p.score > 98.98 && p.score < 99); assert.equal(g.ejected.size, 1);
  const pellet = [...g.ejected.values()][0];
  assert.ok(pellet.x < 1200); assert.ok(pellet.vx < 0); assert.equal(Math.abs(pellet.vy), 0);
  assert.ok(p.cells[0].velocity[0] > velocity(100) * 1.4);
  assert.ok(p.score + pellet.mass < 100, 'pickup cannot create mass');
  g.boost(p.id, false, 150); const mass = p.score; g.advance(500);
  assert.ok(mass - p.score < .05, 'only ordinary passive decay after release'); assert.equal(g.ejected.size, 1); assert.equal(p.boosting, false);
});
test('boost cannot be obtained free by spamming holds, and disconnect/expiry/respawn stop it', () => {
  const g = match(), p = g.active()[0]; place(p, 10, 1200, 1200); g.input(p.id, { x: 1, y: 0 });
  for (let t = 0; t < 300; t += 20) { g.boost(p.id, true, t); g.advance(t + 20); }
  assert.equal(p.score, 10); assert.equal(p.boosting, false); assert.equal(p.cells[0].thrust, 0); assert.equal(g.ejected.size, 0);
  place(p, 100, 1200, 1200); g.input(p.id, { x: 0, y: -1 }); g.boost(p.id, true, 300); g.advance(550);
  assert.ok(p.boosting); g.advance(900); assert.equal(p.boosting, false);
  g.boost(p.id, true, 900); g.advance(1000); g.disconnect(p.id, 1000); assert.equal(p.boosting, false);
  g.eliminate(p, 'absorbed', 1000); g.join(members(1)[0], 1000); assert.equal(p.boostUntil, 0); assert.equal(p.paidBoostUntil, 0);
});
test('directional split overrides joystick aim without changing steering; invalid aim is rejected', () => {
  const g = match(), p = g.active()[0]; place(p, 100, 1200, 1200); g.input(p.id, { x: 1, y: 0 });
  for (const aim of [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: NaN, y: 1 }, { x: '0', y: 1 }]) assert.equal(g.split(p.id, 0, aim), false);
  assert.equal(g.split(p.id, 0, { x: 0, y: -1 }), true);
  assert.deepEqual(p.cells[1].boostDirection, [0, -1]); assert.deepEqual(p.target, { x: 1, y: 0 }); assert.equal(p.score, 100);
  g.advance(100); assert.ok(p.cells[1].y < p.cells[0].y);
});
test('ejected food is bounded, expires, and an opponent can collect each pellet only once', () => {
  const g = match(), [p, other] = g.active(); place(p, 100, 1200, 1200); place(other, 10, 800, 1200);
  g.input(p.id, { x: 1, y: 0 }); g.eject(p, 0);
  const f = [...g.ejected.values()][0];
  other.cells[0].x = f.x; other.cells[0].y = f.y;
  const before = other.score; g.step(0, 20); assert.equal(g.ejected.size, 0); assert.equal(other.score, before + f.mass);
  g.eject(p, 20); g.step(0, 11000); assert.equal(g.ejected.size, 0);
  for (let i = 0; i < g.config.maxEjected; i++) g.ejected.set(i, { mass: 1 });
  const mass = p.score; assert.equal(g.eject(p, 12000), false); assert.equal(p.score, mass);
});
test('a pellet blocked by the round arena publishes no outward velocity', () => {
  const g = match(), p = g.active()[0]; place(p, 100, 1200, 1200); g.eject(p, 0);
  const f = [...g.ejected.values()][0]; f.x = f.radius; f.y = 1200; f.vx = -360; f.vy = 0;
  g.step(.1, 100);
  assert.ok(f.x >= f.radius - .000001); assert.ok(Math.abs(f.vx) < .000001);
});
function room(count = 2, practice = false) {
  const room = new OccupiersRoom('fixture', { clock: () => 0, random: seeded(), practice });
  const people = members(count).map((m, i) => room.attach({ id: i, holder: m.name }, { close() {} }, 0));
  return { room, people };
}
function start(room, people, now = 0) { for (const p of people) room.command(p, { action: 'ready', ready: true }, now); assert.equal(room.command(people[0], { action: 'start' }, now).ok, true); }

test('absorption validates bounded settings and keeps its own speed/protection/rate', () => {
  for (const config of [{ width: 2 }, { splitLimit: 17 }, { mergeMs: 1 }, { speed: NaN }, { foodCount: 1201 }, { tickRate: 30 }]) assert.throws(() => absorptionConfig(config));
  const { room: r, people } = room(); r.command(people[0], { action: 'mode', mode: 'absorption' }, 0); start(r, people);
  assert.equal(r.match.config.speed, 240); assert.equal(r.match.config.protectionMs, 2000); assert.equal(r.match.config.tickRate, 60);
});
test('mass growth derives radius, lowers movement speed and claims each food only once', () => {
  const game = match(), [a, b] = game.active(); place(a, 10); place(b, 10);
  game.food.set(1, { id: 1, x: 1000, y: 1000, hue: 0 }); game.step(0, 10);
  assert.equal(a.score + b.score, 21); assert.equal(game.food.size, 0);
  assert.equal(a.cells[0].radius, radiusFromMass(11));
  const velocity = mass => cellVelocity(new AbsorptionCell(1, [0, 0], mass, 240), [0, 0], { x: 1, y: 0 }, ABSORPTION_RULES)[0];
  assert.ok(velocity(100) < velocity(10)); assert.equal(velocity(10), 240);
});
test('equal mass and protection prevent drain; larger contact transfers mass without instant death', () => {
  for (const [ma, mb, shield, drains] of [[10, 10, 0, false], [30, 10, 0, true], [30, 10, 20, false], [10, 30, 20, false]]) {
    const game = match(), [a, b] = game.active(); place(a, ma); place(b, mb); b.protectedUntil = shield;
    game.step(1 / 60, 10); assert.equal(b.alive, true); assert.equal(b.score < mb, drains);
    assert.ok(Math.abs(a.score + b.score - ma - mb) < 1e-8);
    if (drains) { assert.ok(a.score > ma); assert.equal(b.cells[0].absorbedBy, a.cells[0].id); }
  }
});
test('several simultaneous eaters cannot claim the same cell or award mass twice', () => {
  const game = match(3), [a, b, c] = game.active(); place(a, 30); place(b, 30); place(c, 10);
  game.step(1 / 60, 1); assert.equal(game.active().length, 3);
  assert.ok(c.score > 0 && c.score < 10); assert.ok(Math.abs(a.score + b.score + c.score - 70) < 1e-8);
  assert.ok(Math.abs(a.score - 30 - (10 - c.score)) < 1e-8); assert.equal(b.score, 30);
});
test('sustained contact drains across snapshots, exhausts one body and only then eliminates its owner', () => {
  const game = match(), [a, b] = game.active(); place(a, 30); place(b, 10);
  for (let i = 1; i <= 30; i++) game.step(1 / 60, i * 1000 / 60);
  assert.ok(b.alive && b.score > 0 && b.score < 10); assert.ok(a.score > 30);
  assert.ok(game.snapshot().players.find(p => p.id === b.id).alive);
  for (let i = 31; i <= 80; i++) game.step(1 / 60, i * 1000 / 60);
  assert.equal(b.alive, false); assert.equal(b.cells.length, 0); assert.equal(b.deathReason, 'absorbed'); assert.ok(Math.abs(a.score - 40) < 1e-8);
});
test('a controlled smaller player can escape contact and keep the remaining mass', () => {
  const game = match(), [a, b] = game.active(); place(a, 30); place(b, 10);
  game.input(b.id, { x: 1, y: 0 }); game.advance(500);
  assert.ok(b.alive && b.score < 10 && b.score > 0); assert.equal(b.cells[0].absorbedBy, null);
  const left = b.score; game.advance(1000); assert.equal(b.score, left); assert.ok(Math.abs(a.score + b.score - 40) < 1e-8);
});
test('undersized parts do not regenerate from decay, and split clears old contact quotas', () => {
  const game = match(), p = game.active()[0]; place(p, 80);
  p.cells.push(new AbsorptionCell(p.nextId(), [1500, 1000], 2, game.config.speed)); p.mergeAt = 999999; p.centre();
  p.move(1 / 60, 1, game.config, game.arena); assert.equal(p.cells[1].mass, 2);
  p.cells[0].absorption = { by: 999, mass: 80 }; p.cells[0].absorbedBy = 999;
  p.split(2, game.config); assert.equal(p.cells[0].absorption, null); assert.equal(p.cells[0].absorbedBy, null);
});
test('simultaneous chains conserve all transfers alongside ordinary passive decay', () => {
  const game = match(3), [a, b, c] = game.active(); place(a, 100, 1000); place(b, 30, 1080); place(c, 10, 1110);
  game.step(1 / 60, 1);
  assert.equal(b.cells[0].absorbedBy, a.cells[0].id); assert.equal(c.cells[0].absorbedBy, b.cells[0].id);
  assert.ok(Math.abs(a.score + b.score + c.score - (140 - 100 * .001 / 60)) < 1e-8);
});
test('split freezes source cells, conserves mass and cannot create a seventeenth part', () => {
  let n = 0; const p = new AbsorptionPlayer(members(1)[0], () => ++n); p.init([1000, 1000], 0, ABSORPTION_RULES); place(p, 640);
  const before = p.score;
  for (const expected of [2, 4, 8, 16]) { assert.equal(p.split(0, ABSORPTION_RULES), true); assert.equal(p.cells.length, expected); assert.equal(p.score, before); }
  assert.equal(p.split(1, ABSORPTION_RULES), false); assert.equal(p.cells.length, 16); assert.equal(new Set(p.cells.map(c => c.id)).size, 16);
  p.cells.pop(); p.cells[0].setMass(80); assert.equal(p.split(2, ABSORPTION_RULES), true); assert.equal(p.cells.length, 16);
});
test('merge waits at least fifteen seconds and requires contact; split boost decays', () => {
  const game = match(), p = game.active()[0]; place(p, 40); p.split(0, game.config);
  const reset = () => { for (const c of p.cells) { c.x = 1000; c.y = 1000; } p.centre(); };
  reset(); p.move(0, 14999, game.config, game.arena); assert.equal(p.cells.length, 2);
  p.cells[0].x = 700; p.cells[1].x = 1300; p.move(0, 15000, game.config, game.arena); assert.equal(p.cells.length, 2);
  reset(); p.move(0, 15001, game.config, game.arena); assert.equal(p.cells.length, 1); assert.equal(p.score, 40);
  p.split(16000, game.config); p.target = { x: 1, y: 0 };
  for (let i = 0; i < 60; i++) p.move(1 / 60, 16000 + i * 1000 / 60, game.config, game.arena);
  assert.ok(p.cells.every(c => c.speed === game.config.speed));
});
test('circle clamp is finite for all parts, including after separation and giant mass', () => {
  const game = match(), p = game.active()[0]; place(p, 200, 2380, 1200); p.split(0, game.config); p.target = { x: 1, y: 0 };
  for (let i = 0; i < 600; i++) p.move(1 / 60, i * 1000 / 60, game.config, game.arena);
  for (const c of p.cells) { assert.ok(Number.isFinite(c.x + c.y)); assert.ok(Math.hypot(c.x - 1200, c.y - 1200) + c.radius <= 1200.1); }
});
test('invalid input and pre-join split cannot mutate mass or crash; only finite normalized direction is copied', () => {
  const game = match(), p = game.active()[0], mass = p.score;
  for (const value of [null, {}, [], '1', { x: NaN, y: 0 }, { x: Infinity, y: 0 }, { x: 2, y: 0 }, { x: '1', y: 0 }]) assert.equal(game.input(p.id, value), false);
  assert.equal(game.split('unjoined', 0), false); assert.equal(game.input(p.id, { x: .6, y: .8, mass: 999, xPosition: 0 }), true);
  assert.deepEqual(p.target, { x: .6, y: .8 }); assert.equal(p.score, mass);
});
test('safe spawn tests actual cell radii with bounded fallback even under hostile repeated random points', () => {
  const game = match(12); assert.equal(game.active().length, 12);
  for (const a of game.active()) for (const b of game.active()) if (a !== b) assert.ok(Math.hypot(a.point[0] - b.point[0], a.point[1] - b.point[1]) >= a.cells[0].radius + b.cells[0].radius + 79);
  game.random = () => .5; const p = game.active()[0]; game.eliminate(p, 'absorbed', 1);
  assert.equal(game.join(members(12)[0], 2).ok, true); assert.equal(p.score, 10);
  for (const other of game.active().filter(x => x !== p)) assert.ok(Math.hypot(p.point[0] - other.point[0], p.point[1] - other.point[1]) > p.cells[0].radius + other.cells[0].radius);
});
test('deadline survives a lone or empty arena, permits unlimited respawn and ranks only final summed mass', () => {
  const game = match(2, { durationMs: 1000 }), [a, b] = game.active(); place(a, 40); a.split(0, game.config);
  for (let i = 0; i < 3; i++) { game.eliminate(b, 'absorbed', i + 1); assert.equal(game.join(members(2)[1], i + 2).ok, true); assert.equal(b.score, 10); }
  game.eliminate(b, 'absorbed', 10); game.advance(500); assert.equal(game.finished, false);
  game.advance(1000); assert.deepEqual(game.results.winners, [a.id]); assert.equal(game.results.rows[0].mass, 40); assert.equal(game.results.rows[1].mass, 0);
  assert.equal(game.join(members(2)[1], 1000).reason, 'match_ended');
  const empty = match(2, { durationMs: 1000 }); for (const p of empty.active()) empty.eliminate(p, 'absorbed', 1);
  empty.advance(1000); assert.deepEqual(empty.results.winners, []);
  const tie = match(2, { durationMs: 1000 }); tie.advance(1000); assert.equal(tie.results.winners.length, 2); assert.deepEqual(tie.results.rows.map(r => r.rank), [1, 1]);
});
test('reconnect keeps live mass, life and protection; expired connection can return small without resetting the round', () => {
  const game = match(), p = game.active()[0]; p.cells[0].setMass(40); game.disconnect(p.id, 10); game.connect(p.id);
  assert.equal(p.life, 1); assert.equal(p.score, 40); assert.equal(p.protectedUntil, 2000);
  game.disconnect(p.id, 10); game.advance(10011); assert.equal(p.alive, false); assert.equal(p.deathReason, 'disconnected');
  assert.equal(game.join(members(2)[0], 10012).ok, true); assert.equal(p.score, 10); assert.equal(p.life, 2); assert.equal(game.endsAt, 300000);
});
test('food deltas are bounded, reset on full snapshot and contain only additions/removals', () => {
  const game = match(2, { foodCount: 600 }), baseline = new Map();
  assert.equal(game.snapshot(true, baseline).food.added.length, 600);
  const first = game.snapshot(false, baseline).food; assert.equal(first.reset, true); assert.equal(first.added.length, 600);
  assert.equal(game.snapshot(false, baseline).food.added.length, 0);
  const id = game.food.keys().next().value; game.food.delete(id); game.balanceFood();
  const next = game.snapshot(false, baseline).food; assert.deepEqual(next.removed, [id]); assert.equal(next.added.length, 1);
});
test('only host can switch in lobby; mode switch resets readiness/results and rematches alternate without leaked state', () => {
  const { room: r, people } = room(); const [host, guest] = people;
  assert.equal(r.command(guest, { action: 'mode', mode: 'absorption' }, 0).reason, 'host_only');
  assert.equal(r.command(host, { action: 'mode', mode: 'other' }, 0).reason, 'mode_unknown');
  let now = 0, old;
  for (const mode of ['absorption', 'territories', 'absorption', 'territories']) {
    people.forEach(p => r.command(p, { action: 'ready', ready: true }, now));
    assert.equal(r.command(host, { action: 'mode', mode }, now).ok, true); assert.ok(people.every(p => !p.ready)); assert.equal(r.lastResults, null); assert.equal(r.baseline.size, 0);
    start(r, people, now); assert.equal(r.mode, mode); assert.notEqual(r.match, old); assert.equal(r.match.players.size, 2);
    assert.equal(r.command(host, { action: 'mode', mode: mode === 'absorption' ? 'territories' : 'absorption' }, now).reason, 'match_running');
    old = r.match; old.finish(now + 1); r.tick(now + 1); r.command(host, { action: 'lobby' }, now + 1); assert.equal(r.match, null); now += 100;
  }
});
test('absorption late admission reserves unique colours at twelve and respawn reassesses a reused colour', () => {
  const { room: r, people } = room(); r.command(people[0], { action: 'mode', mode: 'absorption' }, 0); start(r, people);
  const late = Array.from({ length: 11 }, (_, i) => r.attach({ id: i + 10, holder: 'Пізній ' + i }, { close() {} }, 1));
  assert.equal(late.map(m => r.command(m, { action: 'join' }, 1)).filter(x => x.ok).length, 10);
  const p = r.player(people[0].id), color = p.color; r.match.eliminate(p, 'absorbed', 2);
  r.command(late.at(-1), { action: 'color', color }, 2); assert.equal(r.command(late.at(-1), { action: 'join' }, 2).ok, true);
  assert.equal(r.command(people[0], { action: 'join' }, 3).reason, 'full');
  r.match.eliminate(r.player(late[0].id), 'absorbed', 4); assert.equal(r.command(people[0], { action: 'join' }, 4).ok, true);
  assert.equal(new Set(r.match.active().map(p => p.color)).size, 12); assert.notEqual(p.color, color);
});
test('private absorption starts alone and respawns, while territories keeps its no-return rule', () => {
  const { room: r, people } = room(1, true); r.command(people[0], { action: 'mode', mode: 'absorption' }, 0); start(r, people);
  const p = r.player(people[0].id); r.match.eliminate(p, 'absorbed', 1); assert.equal(r.command(people[0], { action: 'join' }, 2).ok, true); assert.equal(r.phase, 'running');
  const { room: t, people: tp } = room(3); start(t, tp); t.match.eliminate(t.player(tp[0].id), 'trail_cut', 1); assert.equal(t.command(tp[0], { action: 'join' }, 2).reason, 'eliminated');
});

test('twelve-player five-minute round stays bounded with continuous inputs, splitting, late respawns and clean results', () => {
  const game = match(12, { foodCount: 600 }); const people = members(12);
  let peakCells = 12, peakStep = 0;
  for (let tick = 1; tick <= 18000; tick++) {
    const now = tick * 1000 / 60;
    if (tick % 6 === 0) for (const p of game.active()) { const a = tick / 200 + Number(p.id.slice(1)); game.input(p.id, { x: Math.cos(a), y: Math.sin(a) }); }
    if (tick % 180 === 0) for (const p of game.active()) game.split(p.id, game.simulatedAt);
    if (tick % 60 === 0) for (const member of people) if (!game.participant(member.id)?.alive) game.join(member, game.simulatedAt);
    const before = performance.now(); game.advance(now); peakStep = Math.max(peakStep, performance.now() - before);
    peakCells = Math.max(peakCells, game.active().reduce((n, p) => n + p.cells.length, 0));
    assert.ok(game.food.size <= 600); assert.ok(game.active().every(p => p.cells.length <= 16 && Number.isFinite(p.score)));
  }
  assert.equal(game.finished, true); assert.equal(game.results.rows.length, 12); assert.ok(game.results.winners.length);
  assert.ok(peakCells <= 192); assert.ok(peakStep < 250, 'a simulation step must not consume the entire catch-up budget');
});

test('split launches toward the last aim even after releasing the stick, then boost expires', () => {
  const game = match(), p = game.active()[0]; place(p, 40); game.input(p.id, { x: 0, y: -1 }); game.input(p.id, { x: 0, y: 0 });
  assert.equal(game.split(p.id, 0), true); const child = p.cells[1]; assert.deepEqual(child.boostDirection, [0, -1]);
  game.advance(100); assert.ok(child.y < p.cells[0].y - 50);
  for (let t = 110; t <= 1000; t += 10) game.advance(t);
  assert.equal(child.speed, game.config.speed); assert.equal(child.boostDirection, null);
});

test('near-equal mass chains cannot produce rank1 outside the actual winning group', () => {
  const game = match(3), [a, b, c] = game.active();
  place(a, 100.00015, 700, 1000); place(b, 100.00008, 1200, 1000); place(c, 100, 1700, 1000);
  game.finish(1); assert.deepEqual(game.results.winners, [a.id, b.id]); assert.deepEqual(game.results.rows.map(r => r.rank), [1, 1, 3]);
});

test('growth at a circular wall clamps the new radius and publishes only allowed velocity in the same tick', () => {
  const game = match(), [a, b] = game.active();
  place(a, 10, 2400 - radiusFromMass(10), 1200); place(b, 10, 500, 1200);
  game.input(a.id, { x: 1, y: 0 }); a.cells[0].speed = 768; a.cells[0].boostDirection = [1, 0];
  for (let i = 1; i <= 100; i++) game.food.set(i, { id: i, x: a.point[0] - 1, y: 1200, hue: 0 });
  game.step(0, 1); const p = game.snapshot().players.find(p => p.id === a.id), c = p.cells[0];
  assert.equal(p.score, 110); assert.ok(Math.hypot(c.point[0] - 1200, c.point[1] - 1200) + c.radius <= 1200 + 1e-6);
  assert.ok(Math.hypot(...c.velocity) < 1e-6, 'blocked boost must not appear as outward snapshot motion');
});

test('solid opponents meet at their edges, drain at tangency and never pass through a protected/equal body', () => {
  for (const shield of [0, 100000]) for (const masses of [[30, 10], [10, 10]]) {
    const game = match(), [a, b] = game.active();
    place(a, masses[0], 1000, 1200); place(b, masses[1], 1000 + a.cells[0].radius + radiusFromMass(masses[1]), 1200);
    b.protectedUntil = shield; game.input(a.id, { x: 1, y: 0 }); game.input(b.id, { x: -1, y: 0 });
    for (let i = 1; i <= 30; i++) {
      game.step(1 / 60, i * 1000 / 60);
      const ca = a.cells[0], cb = b.cells[0];
      assert.ok(Math.hypot(ca.x - cb.x, ca.y - cb.y) >= ca.radius + cb.radius - .0001);
    }
    assert.equal(b.score < masses[1], !shield && masses[0] > masses[1] * 1.1);
  }
});
test('wall contact blocks even a split impulse, and opening a real gap immediately stops edge transfer', () => {
  const game = match(), [a, b] = game.active(); place(b, 10, 2400 - radiusFromMass(10), 1200);
  place(a, 30, b.cells[0].x - b.cells[0].radius - radiusFromMass(30), 1200);
  a.cells[0].speed = 768; a.cells[0].boostDirection = [1, 0]; a.target = { x: 1, y: 0 };
  for (let i = 1; i <= 20; i++) {
    game.step(1 / 60, i * 1000 / 60);
    const ca = a.cells[0], cb = b.cells[0];
    assert.ok(Math.hypot(ca.x - cb.x, ca.y - cb.y) >= ca.radius + cb.radius - .0001);
    for (const p of [a, b]) for (const c of p.cells) assert.ok(Math.hypot(c.x - 1200, c.y - 1200) + c.radius <= 1200 + .0001);
  }
  game.input(a.id, { x: -1, y: 0 }); game.input(b.id, { x: -1, y: 0 });
  a.cells[0].speed = game.config.speed; a.cells[0].boostDirection = null;
  b.cells[0].y -= 200; b.centre(); const mass = b.score;
  for (let i = 21; i <= 40; i++) game.step(1 / 60, i * 1000 / 60);
  assert.equal(b.score, mass); assert.equal(b.cells[0].absorbedBy, null);
});
test('a normal solo Absorption match stays open for late join and keeps its full deadline', () => {
  const game = new AbsorptionMatch(members(1), { now: 0, config: { foodCount: 0 } });
  game.advance(100); assert.equal(game.finished, false);
  assert.equal(game.join(members(2)[1], 100).ok, true); assert.equal(game.active().length, 2);
  assert.equal(game.endsAt, 300000); assert.throws(() => new AbsorptionMatch([], { now: 0 }), /players_required/);
});

test('twelve players with sixteen parts each resolve enemy contacts without penetration or a simulation backlog', () => {
  let seed = 1;
  const game = new AbsorptionMatch(members(12), { now: 0, random: () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32) });
  for (const [i, p] of game.active().entries()) {
    p.cells[0].setMass(160); for (let j = 0; j < 4; j++) p.split(0, game.config);
    p.target = { x: Math.cos(i), y: Math.sin(i) };
  }
  assert.equal(game.active().flatMap(p => p.cells).length, 192);
  for (let tick = 1; tick <= 180; tick++) {
    game.advance(tick * 1000 / 60);
    const bodies = game.active().flatMap(p => p.cells.map(c => ({ owner: p.id, c })));
    for (let i = 0; i < bodies.length; i++) for (let j = i + 1; j < bodies.length; j++) {
      const a = bodies[i], b = bodies[j]; if (a.owner === b.owner) continue;
      assert.ok(Math.hypot(a.c.x - b.c.x, a.c.y - b.c.y) >= a.c.radius + b.c.radius - .0001);
    }
    assert.ok(Math.abs(game.simulatedAt - tick * 1000 / 60) < .001);
  }
});

test('tiny paid boosted enemy parts cannot swap sides during one tick even without final penetration', () => {
  const game = match(), [a, b] = game.active();
  for (const [p, largeX, tinyX, aim] of [[a, 1100, 1194, 1], [b, 1300, 1206, -1]]) {
    p.cells = [new AbsorptionCell(p.nextId(), [largeX, 1200], 100, 240), new AbsorptionCell(p.nextId(), [tinyX, 1200], .05, 240)];
    p.mergeAt = 99999; p.centre(); p.target = { x: aim, y: 0 }; p.protectedUntil = 0;
    p.boostUntil = 1000; p.paidBoostUntil = 1000; p.nextEjectAt = 1000;
    for (const c of p.cells) c.thrust = 1;
  }
  const ca = a.cells[1], cb = b.cells[1];
  game.step(1 / 60, 20); assert.ok(ca.x < cb.x, 'solid parts cannot pass through and swap sides');
  assert.ok(Math.hypot(ca.x - cb.x, ca.y - cb.y) >= ca.radius + cb.radius - .0001);
});
test('a coincident pair at either pole resolves inward instead of staying overlapped against the wall', () => {
  const arena = { center: [1200, 1200], radius: 1200 }, radius = radiusFromMass(10);
  for (const y of [radius, 2400 - radius]) {
    const entries = ['a', 'b'].map(owner => ({ owner, cell: { x: 1200, y, mass: 10, radius } }));
    separateOpponents(entries, arena); const [a, b] = entries.map(e => e.cell);
    assert.ok(Math.hypot(a.x - b.x, a.y - b.y) >= 2 * radius - .0001);
  }
});

test('size gives a clear pursuit/escape advantage while paid boost and split remain useful', () => {
  const ordinary = mass => cellVelocity(new AbsorptionCell(1, [1200, 1200], mass, 240), [1200, 1200], { x: 1, y: 0 }, ABSORPTION_RULES)[0];
  const speeds = [10, 40, 100, 400, 1000, 4000].map(ordinary);
  assert.equal(speeds[0], 240);
  assert.ok(speeds[1] < 180 && speeds[1] > 170);
  assert.ok(speeds[2] < speeds[0] * .61 && speeds[2] > speeds[0] * .59);
  assert.ok(speeds[4] <= speeds[0] * .39 && speeds[5] >= speeds[0] * .38);
  for (let i = 1; i < speeds.length; i++) assert.ok(speeds[i] <= speeds[i - 1]);
  const game = match(), [small, large] = game.active(); place(small, 10, 1000, 1200); place(large, 100, 1300, 1200);
  game.input(small.id, { x: 1, y: 0 }); game.input(large.id, { x: 1, y: 0 });
  for (let t = 0; t <= 1000; t += 20) game.advance(t);
  assert.ok(large.cells[0].x - small.cells[0].x < 210, 'small can catch a larger unboosted opponent');
  const bigBoost = new AbsorptionCell(10, [1200, 1200], 1000, 240); bigBoost.thrust = 1;
  assert.ok(cellVelocity(bigBoost, [1200, 1200], { x: 1, y: 0 }, ABSORPTION_RULES)[0] < ordinary(10) * .66);
});
test('a visible-sized free gap never transfers mass, including a gap below the previous contact tolerance', () => {
  const game = match(), [a, b] = game.active(); place(a, 30, 1000, 1200); place(b, 10, 1000 + a.cells[0].radius + radiusFromMass(10) + .02, 1200);
  for (let i = 1; i <= 30; i++) game.step(1 / 60, i * 1000 / 60);
  assert.equal(a.score, 30); assert.equal(b.score, 10); assert.equal(b.cells[0].absorbedBy, null);
});
