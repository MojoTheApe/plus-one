import test from 'node:test';
import assert from 'node:assert/strict';
import { controlsFixture } from '../test-support/floating-controls.mjs';

test('floating steering starts at each gesture origin with a dead zone, then releases', () => {
  const f = controlsFixture();
  f.send('pointerdown', 100, 300); f.send('pointermove', 106, 304);
  assert.equal(f.moved.length, 0); assert.equal(f.joystick.hidden, true);
  f.send('pointermove', 160, 300);
  assert.equal(f.joystick.style.left, '8px'); assert.equal(f.joystick.style.top, '198px');
  assert.deepEqual(f.moved.at(-1), { x: 1, y: 0 });
  f.send('pointerup', 160, 300); assert.deepEqual(f.released, [false]); assert.equal(f.joystick.hidden, true);
  f.send('pointerdown', 260, 100); f.send('pointermove', 260, 155);
  assert.equal(f.joystick.style.left, '168px'); assert.deepEqual(f.moved.at(-1), { x: 0, y: 1 });
});
test('second finger can double-tap a direction while the steering pointer remains owned', () => {
  const f = controlsFixture(); f.send('pointerdown', 100, 500); f.send('pointermove', 160, 500);
  for (let i = 0; i < 2; i++) { f.send('pointerdown', 250 + i * 5, 200, 2); f.send('pointerup', 250 + i * 5, 200, 2); }
  assert.deepEqual(f.split, [[255, 200]]); assert.equal(f.controls.steering, 1); assert.equal(f.released.length, 0);
  f.send('pointermove', 100, 560); assert.deepEqual(f.moved.at(-1), { x: 0, y: 1 });
});
test('drags, holds, distant taps, cancellation, stale taps and reset never split', () => {
  for (const kind of ['drag', 'hold', 'distant', 'cancel', 'stale', 'reset']) {
    const f = controlsFixture(); f.send('pointerdown', 200, 200);
    if (kind === 'drag') f.send('pointermove', 230, 200);
    f.send(kind === 'cancel' ? 'pointercancel' : 'pointerup', 200, 200, 1, kind === 'hold' ? 300 : 20);
    if (kind === 'reset') f.controls.reset();
    f.send('pointerdown', kind === 'distant' ? 300 : 200, 200, 1, kind === 'stale' ? 400 : 20);
    f.send('pointerup', kind === 'distant' ? 300 : 200, 200);
    assert.equal(f.split.length, 0, kind);
  }
});
test('inactive controls ignore input and lost capture cancels once without a stale tap', () => {
  let active = true; const f = controlsFixture({ enabled: () => active });
  f.send('pointerdown', 100, 200); f.send('pointermove', 150, 200);
  f.send('lostpointercapture', 150, 200); f.send('pointerup', 150, 200);
  assert.deepEqual(f.released, [true]); active = false;
  f.send('pointerdown', 100, 200); f.send('pointermove', 150, 200);
  assert.equal(f.controls.steering, null); assert.equal(f.split.length, 0);
});
test('duplicate downs and an intervening invalid hold cannot complete an old tap pair', () => {
  const f = controlsFixture();
  f.send('pointerdown', 200, 200); f.send('pointerdown', 200, 200); f.send('pointerup', 200, 200);
  f.send('pointerdown', 200, 200); f.send('pointerup', 200, 200);
  assert.equal(f.split.length, 0);
  const h = controlsFixture();
  h.send('pointerdown', 200, 200); h.send('pointerup', 200, 200);
  h.send('pointerdown', 200, 200); h.send('pointerup', 200, 200, 1, 250);
  h.send('pointerdown', 200, 200); h.send('pointerup', 200, 200);
  assert.equal(h.split.length, 0);
});

test('a changing viewport origin repositions the owned joystick without releasing steering', () => {
  const f = controlsFixture(); f.send('pointerdown', 100, 400); f.send('pointermove', 160, 400);
  f.surface.getBoundingClientRect = () => ({ left: 20, top: 50 });
  f.controls.position(); assert.equal(f.joystick.style.left, '-2px'); assert.equal(f.joystick.style.top, '268px');
  assert.equal(f.controls.steering, 1); assert.equal(f.released.length, 0);
  f.send('pointermove', 150, 430); assert.ok(f.moved.at(-1).y > 0);
});
