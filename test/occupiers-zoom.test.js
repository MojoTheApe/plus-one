import test from 'node:test';
import assert from 'node:assert/strict';
import { GameZoomGuard } from '../web/occupiers/controls.js';

function fixture() {
  const events = {}, original = 'width=device-width,initial-scale=1,viewport-fit=cover'; let content = original, writes = 0;
  const doc = { documentElement: { dataset: {} }, querySelector: () => ({ getAttribute: () => content, setAttribute(k, v) { content = v; writes++; } }),
    addEventListener(type, fn, options) { events[type] = { fn, options }; } };
  const guard = new GameZoomGuard(doc);
  const touch = (type, at, { button = null, count = 1, id = 1, x = 100 } = {}) => {
    const e = { type, timeStamp: at, target: { closest: () => button && { id: button } }, touches: Array(count).fill({}),
      changedTouches: [{ identifier: id, clientX: x, clientY: 100 }], cancelable: true, defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; }, stopPropagation() { assert.fail('pointer routing must stay intact'); } };
    events[type].fn(e); return e.defaultPrevented;
  };
  return { guard, doc, events, touch, original, content: () => content, writes: () => writes };
}
test('active game locks root/viewport once, and lobby restores zoom and clickable controls', () => {
  const f = fixture(); assert.equal(f.touch('touchstart', 0), false);
  f.guard.setActive(true); assert.match(f.content(), /maximum-scale=1/); assert.equal(f.doc.documentElement.dataset.playing, 'true');
  const writes = f.writes(); f.guard.setActive(true); assert.equal(f.writes(), writes);
  assert.equal(f.touch('touchstart', 10), true); assert.equal(f.touch('touchend', 30, { count: 0 }), true);
  f.guard.setActive(false); assert.equal(f.content(), f.original); assert.equal(f.touch('touchstart', 40), false);
});
test('legacy non-passive touch handlers consume double/triple taps across field, boost and root gaps', () => {
  const f = fixture(); f.guard.setActive(true);
  for (const button of [null, 'boost-game']) for (let n = 0; n < 3; n++) {
    assert.equal(f.touch('touchstart', 20 + n * 70, { button }), true);
    assert.equal(f.touch('touchend', 40 + n * 70, { button, count: 0 }), true);
  }
  for (const e of Object.values(f.events)) { assert.equal(e.options.passive, false); assert.equal(e.options.capture, true); }
});
test('first observation button click survives, repeated taps and multi-touch native zoom are cancelled', () => {
  const f = fixture(); f.guard.setActive(true);
  assert.equal(f.touch('touchstart', 100, { button: 'open-join' }), false);
  assert.equal(f.touch('touchend', 120, { button: 'open-join', count: 0 }), false);
  assert.equal(f.touch('touchstart', 180, { button: 'open-join' }), true);
  assert.equal(f.touch('touchend', 200, { button: 'open-join', count: 0 }), true);
  assert.equal(f.touch('touchstart', 220, { id: 2, count: 2, button: 'open-join', x: 200 }), true);
  assert.equal(f.touch('touchmove', 240, { id: 2, count: 2, button: 'open-join', x: 250 }), true);
  for (const type of ['gesturestart','gesturechange','gestureend','dblclick']) {
    let prevented = false; f.events[type].fn({ cancelable: true, preventDefault() { prevented = true; } }); assert.equal(prevented, true);
  }
});
test('a newly shown observation action is clickable after a nearby gameplay tap', () => {
  const f = fixture(); f.guard.setActive(true);
  assert.equal(f.touch('touchstart', 10), true); assert.equal(f.touch('touchend', 30, { count: 0 }), true);
  assert.equal(f.touch('touchstart', 100, { button: 'open-join' }), false);
  assert.equal(f.touch('touchend', 120, { button: 'open-join', count: 0 }), false);
});
