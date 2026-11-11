import test from 'node:test';
import { controlsFixture } from '../test-support/floating-controls.mjs';
import assert from 'node:assert/strict';
import { AbsorptionView } from '../test-support/absorption-view.mjs';
import { AbsorptionMatch } from '../src/occupiers/absorption.js';
import { AbsorptionCell } from '../src/occupiers/absorption-core.js';
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

test('actual bubble paint shortens long names without squeezed letters and reduced motion keeps circular bodies', () => {
  const name = 'Long Telegram Player Name', game = new AbsorptionMatch([{ id: 'self', name, color: '#ffbb00' }], { now: 0, practice: true, config: { foodCount: 0 } });
  const labels = [], bodies = []; let path = [];
  const ctx = new Proxy({ beginPath() { path = []; }, moveTo(x, y) { path.push([x, y]); }, lineTo(x, y) { path.push([x, y]); },
    fill() { if (this.fillStyle === '#ffbb00' && path.length === 41) bodies.push([...path]); },
    measureText(text) { return { width: Array.from(text).length * 7 }; },
    fillText(text, x, y, maxWidth) { labels.push({ text, x, y, maxWidth, font: this.font }); },
    drawImage() { assert.fail('Absorption must not paint toy avatars'); } }, { get: (o, k) => k in o ? o[k] : () => {} });
  const v = Object.assign(Object.create(AbsorptionView.prototype), { players: new Map(), food: new Map(), id: 'self', ctx, width: 390, height: 754, dpr: 1, lastPaint: 1000, reducedMotion: true, stick: { style: {} } });
  v.update(game.snapshot(), 'self', 1000); v.paint(1000);
  assert.equal(labels.length, 1); assert.ok(labels[0].text.endsWith('…')); assert.ok(labels[0].text.length * 7 <= labels[0].maxWidth);
  assert.ok(parseInt(labels[0].font.split(' ')[1]) >= 11);
  const radii = bodies[0].map(([x, y]) => Math.hypot(x - labels[0].x, y - labels[0].y));
  assert.ok(Math.max(...radii) - Math.min(...radii) < .00001);
  const p = game.participant('self'); p.cells[0].setMass(640);
  for (let i = 0; i < 4; i++) p.split(0, game.config);
  labels.length = 0; v.update(game.snapshot(), 'self', 1100);
  for (let i = 0; i <= 120; i++) { labels.length = 0; v.paint(1100 + i * 1000 / 60); }
  assert.equal(labels.length, 16); assert.ok(labels.every(l => l.text.length * 7 <= l.maxWidth));
});
const view = id => Object.assign(Object.create(AbsorptionView.prototype), { players: new Map(), food: new Map(), id,
  stick: { style: {} }, game: null, camera: null, inputTimer: null, target: null, anchor: null });

test('minimap bodies use the arena scale for every cell, including tiny and split pieces', () => {
  const arcs = [], ctx = new Proxy({ arc(x, y, r) { arcs.push([x, y, r]); } }, { get: (o, k) => k in o ? o[k] : () => {} });
  const v = Object.assign(view('self'), { minimap: { width: 180, height: 180, getContext: () => ctx },
    game: { arena: { center: [1200, 1200], radius: 1200 } }, width: 390, height: 754, scale: 1, camera: [1200, 1200] });
  const live = [{ id: 'self', color: '#ffbb00', cells: [{ visual: { point: [1200, 1200], radius: 12 } }] },
    { id: 'other', color: '#00cfe8', cells: [120, 60].map((radius, i) => ({ visual: { point: [1500 + i * 100, 1200], radius } })) }];
  v.paintMinimap(live);
  const scale = 174 / 2400;
  assert.deepEqual(arcs.slice(1).map(a => a[2]), [12 * scale, 120 * scale, 60 * scale]);
  live[0].cells[0].visual.radius = 6; arcs.length = 0; v.paintMinimap(live); assert.equal(arcs[1][2], 6 * scale);
});
test('a shrinking prey remains visible beside its solid eater using authoritative contact state', () => {
  const game = new AbsorptionMatch([{ id: 'self', name: 'Big', color: '#ffbb00' }, { id: 'prey', name: 'Small', color: '#00cfe8' }], { now: 0, config: { foodCount: 0 } });
  for (const p of game.active()) { p.cells[0].x = p.cells[0].y = 1200; p.cells[0].setMass(p.id === 'self' ? 30 : 10); p.protectedUntil = 0; p.centre(); }
  game.step(1 / 60, 16); const colors = []; let vertices = 0;
  const ctx = new Proxy({ beginPath() { vertices = 0; }, moveTo() { vertices++; }, lineTo() { vertices++; },
    fill() { if (vertices >= 41) colors.push(this.fillStyle); }, measureText: () => ({ width: 8 }) }, { get: (o, k) => k in o ? o[k] : () => {} });
  const v = Object.assign(view('self'), { ctx, width: 390, height: 754, dpr: 1, lastPaint: 1000 });
  v.update(game.snapshot(), 'self', 1000); v.paint(1000);
  assert.deepEqual(colors, ['#ffbb00', '#00cfe8']);
  assert.ok(v.players.get('prey').cells[0].mass > 0 && v.players.get('prey').cells[0].mass < 10);
});
function run({ own = true, fps = 60, turning = false, jitter = false, burst = false } = {}) {
  const game = new AbsorptionMatch([{ id: 'actor', name: 'Гравець', character: 'fox', color: '#ffbb00' }], { now: 0, practice: true, random: () => .5, config: { foodCount: 0 } });
  const p = game.participant('actor'); p.cells[0].x = p.cells[0].y = 1200; p.centre(); game.input(p.id, { x: 1, y: 0 });
  const v = view(own ? 'actor' : 'observer'), events = [], baseline = new Map();
  for (let t = 0; t <= 3000; t++) {
    if (turning && t % 40 === 0) { const target = { x: Math.cos(t / 900), y: Math.sin(t / 900) }; game.input(p.id, target); if (own) events.push({ at: t, kind: 1, target }); }
    game.advance(t);
    if (t % 100 === 0) events.push({ at: t + (burst ? (t % 400 === 100 ? 140 : t % 400 === 200 ? 41 : 0) : jitter && t % 200 ? 40 : 0), kind: 0, game: structuredClone(game.snapshot(t === 0, baseline)) });
  }
  for (let i = 0; i <= 3000 * fps / 1000; i++) events.push({ at: i * 1000 / fps, kind: 2 });
  events.sort((a, b) => a.at - b.at || a.kind - b.kind);
  const frames = []; let previous;
  for (const e of events) {
    const now = e.at + 1000;
    if (e.kind === 0) {
      const old = v.me() || v.players.get('actor'), cell = old?.cells[0], before = cell ? [...v.frameCell(old, cell, now).point] : null;
      v.update(e.game, v.id, now);
      if (before) assert.ok(distance(before, v.frameCell(v.players.get('actor'), v.players.get('actor').cells[0], now).point) < 1e-6, 'ordinary snapshots cannot teleport a displayed cell');
    } else if (e.kind === 1 && v.game) v.setAim(e.target, now);
    else if (e.kind === 2 && v.game) {
      const actor = v.players.get('actor'), point = [...v.frameCell(actor, actor.cells[0], now).point];
      if (previous) frames.push({ at: e.at, point, speed: distance(point, previous.point) / (e.at - previous.at) * 1000 });
      previous = { at: e.at, point };
    }
  }
  return { v, frames };
}
test('actual60Hz absorption data moves continuously through10Hz jitter at60/120Hz display', () => {
  for (const own of [true, false]) for (const jitter of [true, false]) for (const fps of [60, 120]) {
    const { frames } = run({ own, jitter, fps });
    for (const f of frames.filter(f => f.at >= 800 && f.at <= 2500)) assert.ok(f.speed > 220 && f.speed < 260, `continuous travel own=${own} fps=${fps} speed=${f.speed}`);
  }
});
test('steering stays continuous and trajectories agree across display refresh rates', () => {
  for (const own of [true, false]) {
    const runs = [60, 120].map(fps => run({ own, jitter: true, fps, turning: true }));
    for (const r of runs) for (const f of r.frames.filter(f => f.at >= 800 && f.at <= 2500)) assert.ok(f.speed > 180 && f.speed < 290, `turn speed=${f.speed}`);
    assert.ok(distance(runs[0].frames.at(-1).point, runs[1].frames.at(-1).point) < .3);
  }
});
test('packet gaps freeze prediction and life changes discard old cells, food and input', () => {
  const { v } = run(), p = v.me(), cell = p.cells[0];
  const a = structuredClone(v.frameCell(p, cell, 6000)); assert.deepEqual(v.frameCell(p, cell, 9000).point, a.point);
  assert.ok(cell.history.length <= 8);
  const game = structuredClone(v.game); game.simulatedAt = 9000; game.players[0].life++; game.players[0].cells[0].point = [900, 900]; game.players[0].point = [900, 900];
  v.update(game, 'actor', 10000); assert.ok(distance(v.frameCell(v.me(), v.me().cells[0], 10000).point, [900, 900]) < 1e-6); assert.equal(v.target, null);
  v.food.set(9, {}); v.update(null, 'actor'); assert.equal(v.players.size, 0); assert.equal(v.food.size, 0); assert.equal(v.camera, null);
});
test('own direction replacement starts at the current prediction and stop does not rewind', () => {
  const { v } = run(), p = v.me(), now = p.received + 30;
  const before = v.prediction(p, now).map(c => [c.x, c.y]); v.setAim({ x: 0, y: 1 }, now);
  assert.deepEqual(v.prediction(p, now).map(c => [c.x, c.y]), before);
  const beforeStop = v.prediction(p, now + 20).map(c => [c.x, c.y]); v.setAim({ x: 0, y: 0 }, now + 20);
  assert.deepEqual(v.prediction(p, now + 20).map(c => [c.x, c.y]), beforeStop);
});
test('shared floating control cancellation stops Absorption and inactive controls ignore touch', () => {
  const sent = [], v = Object.assign(view('self'), { enabled: true, lastInputAt: -Infinity, onInput: t => sent.push(t) });
  v.players.set('self', { alive: true });
  const f = controlsFixture({ enabled: () => v.enabled, move: t => v.input(t), release: () => { v.input({ x: 0, y: 0 }); v.flushInput(); } });
  f.send('pointerdown', 100, 400); f.send('pointermove', 160, 400);
  assert.ok(sent[0].x > 0); f.send('pointermove', 160, 440); f.send('pointercancel', 160, 440);
  assert.deepEqual(sent.at(-1), { x: 0, y: 0 }); assert.equal(v.pendingInput, null); assert.equal(v.inputTimer, null);
  v.enabled = false; const count = sent.length;
  f.send('pointerdown', 100, 400); f.send('pointermove', 160, 400); assert.equal(sent.length, count);
});

test('two mode observers sharing one canvas cannot clear each other at unchanged size', async () => {
  const { TerritoryView } = await import('../web/occupiers/territories.js');
  const previous = globalThis.devicePixelRatio; globalThis.devicePixelRatio = 3;
  let writes = 0, width = 300, height = 150, rect = { width: 320, height: 568 };
  const canvas = { getBoundingClientRect: () => rect,
    get width() { return width; }, set width(v) { width = v; writes++; },
    get height() { return height; }, set height(v) { height = v; writes++; } };
  const views = [TerritoryView, AbsorptionView].map(View => Object.assign(Object.create(View.prototype), { canvas }));
  try {
    for (const v of views) v.resize(); assert.equal(writes, 2); assert.equal(width, 640); assert.equal(height, 1136);
    for (const v of views) v.resize(); assert.equal(writes, 2, 'callbacks after first paint must preserve that frame');
    rect = { width: 844, height: 390 }; for (const v of views) v.resize(); assert.equal(writes, 4); assert.equal(width, 1688); assert.equal(height, 780);
  } finally { globalThis.devicePixelRatio = previous; }
});

test('actual wall stops stay inside the arena for own/remote cells at60/120Hz through packet jitter', () => {
  for (const direction of [{ x: 1, y: 0 }, { x: .6, y: .8 }]) for (const own of [true, false]) for (const fps of [60, 120]) for (const jitter of [0, 40]) {
    const game = new AbsorptionMatch([{ id: 'actor', name: 'Гравець', color: '#ffbb00' }], { practice: true, now: 0, random: () => 0, config: { foodCount: 0 } });
    const v = view(own ? 'actor' : 'observer'), events = [];
    game.input('actor', direction);
    for (let t = 0; t <= 7000; t++) { game.advance(t); if (t % 100 === 0) events.push({ at: t + (t % 200 ? jitter : 0), game: structuredClone(game.snapshot()) }); }
    for (let i = 0; i <= 7000 * fps / 1000; i++) events.push({ at: i * 1000 / fps });
    events.sort((a, b) => a.at - b.at || Number(!!b.game) - Number(!!a.game));
    for (const event of events) {
      const now = 1000 + event.at;
      if (event.game) v.update(event.game, v.id, now);
      else if (v.game) {
        const p = v.players.get('actor'), cell = p.cells[0], pose = v.frameCell(p, cell, now);
        assert.ok(Math.hypot(pose.point[0] - 1200, pose.point[1] - 1200) + Math.max(cell.radius, pose.radius) <= 1200 + 1e-6, 'the whole displayed body must remain inside the circular field');
      }
    }
    const raw = game.participant('actor').cells[0]; assert.ok(Math.hypot(...raw.velocity) < 1e-5);
    assert.ok(distance(v.players.get('actor').cells[0].pose.point, [raw.x, raw.y]) < .1, 'wall stop converges without persistent outward feed-forward');
  }
});

test('short reconnect, including disabled blur, discards unsent/lost directions and resumes confirmed input', () => {
  for (const lostSend of [false, true]) for (const blur of [false, true]) {
    const game = new AbsorptionMatch([{ id: 'actor', name: 'Гравець', color: '#ffbb00' }], { practice: true, now: 0, random: () => 0, config: { foodCount: 0 } });
    let connected = true;
    const sent = [], v = Object.assign(view('actor'), { pendingInput: null, lastInputAt: -Infinity, enabled: true,
      onInput(target) { sent.push({ ...target }); if (connected) game.input('actor', target); } });
    v.update(game.snapshot(), 'actor', 1000); v.enabled = true; v.input({ x: 1, y: 0 }, 1000);
    game.advance(10); v.input({ x: 0, y: 1 }, 1010); assert.deepEqual(v.pendingInput, { x: 0, y: 1 });
    connected = false;
    if (lostSend) v.flushInput(1011);
    v.enabled = false; v.cancelPendingInput(1012); assert.equal(v.pendingInput, null); assert.equal(v.inputTimer, null);
    if (blur) v.releaseInput();
    for (let t = 11; t <= 2000; t++) {
      game.advance(t); if (t === 100) { connected = true; v.enabled = true; }
      if (t % 100 === 0 && connected) v.update(game.snapshot(), 'actor', 1000 + t);
      if (t % 10 === 0) v.frameCell(v.me(), v.me().cells[0], 1000 + t);
    }
    assert.deepEqual(v.target, { x: 1, y: 0 }); assert.deepEqual(v.lastSentTarget, { x: 1, y: 0 });
    assert.deepEqual(v.prediction(v.me(), 3010)[0].velocity, [240, 0]);
    assert.ok(Math.abs(v.frameCell(v.me(), v.me().cells[0], 3010).point[1] - 1200) < .001);
    assert.equal(sent.length, lostSend ? 2 : 1);
    v.releaseInput(); assert.deepEqual(game.participant('actor').target, { x: 0, y: 0 });
    assert.deepEqual(v.target, { x: 0, y: 0 }); assert.equal(v.resyncInput, false);
    v.cancelPendingInput(3010);
  }
});

test('bounded adaptive prediction removes recurring holds through 240ms packet bursts without a reconnect snap', () => {
  for (const own of [true, false]) for (const fps of [60, 120]) {
    const { v, frames } = run({ own, fps, burst: true });
    const steady = frames.filter(f => f.at >= 1000 && f.at <= 2500);
    assert.ok(steady.every(f => f.speed > 180 && f.speed < 280));
    assert.ok(v.horizon() <= 320 && v.horizon(false) <= 350);
    const p = v.players.get('actor'), c = p.cells[0];
    const stopped = [...v.frameCell(p, c, 6000).point]; assert.deepEqual(v.frameCell(p, c, 10000).point, stopped);
  }
});
test('paint keeps predicted and delayed enemy circles outside each other while edge mass shrinks', () => {
  const game = new AbsorptionMatch([{ id: 'self', name: 'Big', color: '#ffbb00' }, { id: 'other', name: 'Small', color: '#00cfe8' }], { now: 0, config: { foodCount: 0 } });
  const [a, b] = game.active();
  a.cells[0].setMass(30); a.cells[0].x = 1000; a.cells[0].y = 1200;
  b.cells[0].x = 1000 + a.cells[0].radius + b.cells[0].radius; b.cells[0].y = 1200;
  for (const p of [a, b]) { p.protectedUntil = 0; p.centre(); }
  game.input('self', { x: 1, y: 0 }); game.input('other', { x: -1, y: 0 });
  const ctx = new Proxy({ measureText: () => ({ width: 8 }) }, { get: (o, k) => k in o ? o[k] : () => {} });
  const v = Object.assign(view('self'), { ctx, width: 390, height: 754, dpr: 1, lastPaint: 1000 });
  let previous;
  for (let i = 0; i <= 45; i++) {
    const t = i * 1000 / 60; game.advance(t);
    if (i % 6 === 0) v.update(game.snapshot(), 'self', t + 1000);
    v.paint(t + 1000);
    const ca = v.me().cells[0].visual, cb = v.players.get('other').cells[0].visual;
    assert.ok(distance(ca.point, cb.point) >= ca.radius + cb.radius - .0001);
    if (previous) assert.ok(distance(ca.point, previous) < 8, 'display contact cannot introduce a corrective jump');
    previous = [...ca.point];
  }
});

test('fast tiny displayed opponents cannot swap sides between rendered contact frames', () => {
  for (const fps of [60, 120]) {
    const game = new AbsorptionMatch([{ id: 'self', name: 'A', color: '#ffbb00' }, { id: 'other', name: 'B', color: '#00cfe8' }], { now: 0, config: { foodCount: 0 } });
    for (const [p, largeX, tinyX, aim] of [[game.participant('self'), 1100, 1194, 1], [game.participant('other'), 1300, 1206, -1]]) {
      p.cells = [new AbsorptionCell(p.nextId(), [largeX, 1200], 100, 240), new AbsorptionCell(p.nextId(), [tinyX, 1200], .05, 240)];
      p.mergeAt = 99999; p.centre(); p.target = { x: aim, y: 0 }; p.protectedUntil = 0;
      p.boostUntil = p.paidBoostUntil = p.nextEjectAt = 1000; p.boosting = true;
      for (const c of p.cells) c.thrust = 1;
    }
    const ctx = new Proxy({ measureText: () => ({ width: 8 }) }, { get: (o, k) => k in o ? o[k] : () => {} });
    const v = Object.assign(view('self'), { ctx, width: 390, height: 754, dpr: 1, lastPaint: 1000 });
    for (let i = 0; i <= fps / 5; i++) {
      const t = i * 1000 / fps; game.advance(t);
      if (i % (fps / 10) === 0) v.update(game.snapshot(), 'self', t + 1000);
      v.paint(t + 1000);
      const a = v.me().cells[1].visual, b = v.players.get('other').cells[1].visual;
      assert.ok(a.point[0] < b.point[0], 'displayed small parts cannot pass through and swap sides');
      assert.ok(distance(a.point, b.point) >= a.radius + b.radius - .0001);
    }
  }
});

test('the approaching remote is visibly touching as soon as its authoritative mass starts draining', () => {
  const game = new AbsorptionMatch([{ id: 'self', name: 'A', color: '#ffbb00' }, { id: 'other', name: 'B', color: '#00cfe8' }], { now: 0, config: { foodCount: 0 } });
  const [a, b] = game.active(); a.cells[0].setMass(30); a.cells[0].x = a.cells[0].y = 1200; b.cells[0].x = 1450; b.cells[0].y = 1200;
  for (const p of [a, b]) { p.protectedUntil = 0; p.centre(); } game.input('other', { x: -1, y: 0 });
  const ctx = new Proxy({ measureText: () => ({ width: 8 }) }, { get: (o, k) => k in o ? o[k] : () => {} });
  const v = Object.assign(view('self'), { ctx, width: 430, height: 850, dpr: 1, lastPaint: 1000 });
  let observed = 0;
  for (let i = 0; i < 150; i++) {
    const t = i * 1000 / 60; game.advance(t); if (i % 6 === 0) v.update(game.snapshot(), 'self', t + 1000); v.paint(t + 1000);
    const ca = v.me().cells[0], cb = v.players.get('other').cells[0];
    if (cb?.absorbedBy) {
      observed++; assert.ok(distance(ca.visual.point, cb.visual.point) - ca.visual.radius - cb.visual.radius <= .5);
      const angle = Math.atan2(cb.body.point[1] - ca.body.point[1], cb.body.point[0] - ca.body.point[0]);
      const ra = v.bodyRadius(ca, angle, t + 1000), rb = v.bodyRadius(cb, angle + Math.PI, t + 1000);
      assert.ok(Math.abs(distance(ca.body.point, cb.body.point) - ra - rb) < .01, 'actual coloured outlines share contact edge');
    }
  }
  assert.ok(observed > 20);
});
test('soft contacts dent both sides, remain finite at wall/multiple neighbours and relax after escape', () => {
  const v = Object.assign(view('self'), { game: { arena: { center: [1200, 1200], radius: 1200 } }, reducedMotion: true });
  const radius = 40, cell = (id, x, y) => ({ id, mass: 36, radius, visual: { point: [x, y], radius, velocity: [0, 0] } });
  const live = [{ id: 'self', cells: [cell(1, 1200, 40)] }, { id: 'other', cells: [cell(2, 1200, 120)] }, { id: 'third', cells: [cell(3, 1280, 120)] }];
  for (let i = 0; i < 30; i++) v.softBodies(live, 1 / 60);
  const a = live[0].cells[0], b = live[1].cells[0];
  assert.ok(v.bodyRadius(a, Math.PI / 2, 1000) < radius - 1);
  assert.ok(v.bodyRadius(b, -Math.PI / 2, 1000) < radius - 1);
  for (const p of live) for (const c of p.cells) for (let i = 0; i < 40; i++) {
    const r = v.bodyRadius(c, i * Math.PI / 20, 1000); assert.ok(Number.isFinite(r) && r > 0 && r <= radius + .0001);
  }
  const before = v.bodyRadius(a, Math.PI / 2, 1000); live[1].cells[0].visual.point = [1400, 300];
  v.softBodies(live, 1 / 60); assert.ok(v.bodyRadius(a, Math.PI / 2, 1017) > before && v.bodyRadius(a, Math.PI / 2, 1017) < radius);
  for (let i = 0; i < 60; i++) v.softBodies(live, 1 / 60);
  assert.ok(Math.abs(v.bodyRadius(a, Math.PI / 2, 2000) - radius) < .001);
  v.update(null, 'self', 2000); assert.equal(v.softContacts.size, 0);
});
