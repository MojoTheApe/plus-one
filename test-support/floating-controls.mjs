import { FloatingControls } from '../web/occupiers/controls.js';
export function controlsFixture(callbacks = {}) {
  const handlers = {}, moved = [], released = [], split = [];
  const surface = { getContext: () => ({}), setPointerCapture() {},
    getBoundingClientRect: () => ({ left: 10, top: 20 }),
    addEventListener(type, fn) { handlers[type] = fn; } };
  const joystick = { offsetWidth: 164, offsetHeight: 164, style: {} }, stick = { style: {} };
  const controls = new FloatingControls(surface, joystick, stick, {
    enabled: () => true, move: v => moved.push(v), release: v => released.push(v), split: (x, y) => split.push([x, y]), ...callbacks,
  });
  let clock = 0;
  const send = (type, x, y, id = 1, ms = 20) => handlers[type]({ type, clientX: x, clientY: y, pointerId: id,
    pointerType: 'touch', button: 0, timeStamp: clock += ms, preventDefault() {} });
  return { controls, surface, joystick, stick, handlers, send, moved, released, split };
}
