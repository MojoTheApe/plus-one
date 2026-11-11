// One pointer owner for steering; other fingers remain free for taps/actions.
// Only completed short taps count. Starting a drag never emits a split.
export class FloatingControls {
  constructor(canvas, joystick, stick, { move, release, split, enabled }) {
    Object.assign(this, { canvas, joystick, stick, move, release, split, enabled,
      pointers: new Map(), steering: null, lastTap: null });
    joystick.hidden = true;
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'lostpointercapture']) {
      canvas.addEventListener(type, e => this.pointer(e));
    }
    canvas.addEventListener('dblclick', e => e.preventDefault());
  }
  pointer(e) {
    const now = e.timeStamp;
    if (e.type === 'pointerdown') {
      if (!this.enabled() || (e.button !== undefined && e.button !== 0)) return;
      e.preventDefault();
      if (this.pointers.has(e.pointerId)) { this.reset(); return; }
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, at: now, dragged: false, mouse: e.pointerType === 'mouse' });
      this.canvas.setPointerCapture(e.pointerId);
      return;
    }
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    e.preventDefault();
    const x = e.clientX - p.x, y = e.clientY - p.y, length = Math.hypot(x, y);
    if (e.type === 'pointermove') {
      if (!this.enabled()) { this.reset(); return; }
      if (length > 10 && !p.dragged) { p.dragged = true; this.lastTap = null; }
      if (p.dragged && !p.mouse && this.steering === null) {
        this.steering = e.pointerId; this.lastTap = null;
        this.joystick.hidden = false;
      }
      if (this.steering === e.pointerId) {
        const limit = this.position() * .32;
        const strength = Math.min(1, Math.max(0, (length - 14) / (limit - 14)));
        this.move({ x: length ? x / length * strength : 0, y: length ? y / length * strength : 0 });
        this.stick.style.transform = `translate(${length ? x / length * Math.min(limit, length) : 0}px,${length ? y / length * Math.min(limit, length) : 0}px)`;
      }
      return;
    }
    this.pointers.delete(e.pointerId);
    if (this.steering === e.pointerId) {
      this.steering = null; this.joystick.hidden = true; this.stick.style.transform = '';
      this.release(e.type !== 'pointerup');
    }
    if (e.type !== 'pointerup') { this.lastTap = null; return; }
    if (!this.enabled() || p.dragged || length > 10 || now - p.at > 240) { this.lastTap = null; return; }
    const last = this.lastTap;
    if (last && p.at >= last.at && now - last.at <= 330 && Math.hypot(e.clientX - last.x, e.clientY - last.y) <= 44) {
      this.lastTap = null; this.split(e.clientX, e.clientY);
    } else this.lastTap = { at: now, x: e.clientX, y: e.clientY };
  }
  position() {
    const p = this.pointers.get(this.steering);
    if (!p) return;
    const rect = this.canvas.getBoundingClientRect(), width = this.joystick.offsetWidth, height = this.joystick.offsetHeight;
    const left = (p.x - rect.left - width / 2) + 'px', top = (p.y - rect.top - height / 2) + 'px';
    if (this.joystick.style.left !== left) this.joystick.style.left = left;
    if (this.joystick.style.top !== top) this.joystick.style.top = top;
    return width;
  }
  reset() {
    const hadSteering = this.steering !== null;
    const captured = [...this.pointers.keys()];
    this.pointers.clear(); this.steering = null; this.lastTap = null;
    for (const id of captured) if (this.canvas.hasPointerCapture?.(id)) this.canvas.releasePointerCapture(id);
    this.joystick.hidden = true; this.stick.style.transform = '';
    if (hadSteering) this.release(true);
  }
}

// WKWebView's native recognizers can ignore canvas-only PointerEvent handling.
// Cancel native touch/gesture defaults without stopping our pointer handlers.
export class GameZoomGuard {
  constructor(doc) {
    this.doc = doc; this.active = false; this.blocked = new Set(); this.lastTouch = null;
    this.viewport = doc.querySelector('meta[name="viewport"]');
    this.originalViewport = this.viewport?.getAttribute('content');
    const options = { capture: true, passive: false };
    for (const type of ['touchstart', 'touchmove', 'touchend', 'touchcancel']) doc.addEventListener(type, e => this.touch(e), options);
    for (const type of ['gesturestart', 'gesturechange', 'gestureend', 'dblclick']) {
      doc.addEventListener(type, e => { if (this.active && e.cancelable) e.preventDefault(); }, options);
    }
  }
  setActive(active) {
    if (this.active === active) return;
    this.active = active; this.blocked.clear(); this.lastTouch = null;
    this.doc.documentElement.dataset.playing = String(active);
    if (this.viewport) this.viewport.setAttribute('content', active
      ? 'width=device-width, initial-scale=1, minimum-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover'
      : this.originalViewport);
  }
  touch(e) {
    if (!this.active) return;
    const changed = Array.from(e.changedTouches || []), interactive = e.target?.closest?.('button,a,input,textarea,select,summary');
    const field = !interactive || interactive.id === 'boost-game';
    let block = field || e.touches.length > 1;
    if (e.type === 'touchstart') {
      const t = changed[0], last = this.lastTouch;
      if (t) {
        const target = interactive?.id || interactive || null;
        block ||= !!last && last.target === target && e.timeStamp - last.at < 350 && Math.hypot(t.clientX - last.x, t.clientY - last.y) < 44;
        this.lastTouch = { at: e.timeStamp, x: t.clientX, y: t.clientY, target };
      }
      if (block) for (const t of changed) this.blocked.add(t.identifier);
    }
    if (e.type === 'touchend' || e.type === 'touchcancel') {
      block ||= changed.some(t => this.blocked.has(t.identifier));
      for (const t of changed) this.blocked.delete(t.identifier);
      if (e.type === 'touchcancel') this.lastTouch = null;
    }
    if (block && e.cancelable) e.preventDefault();
  }
}
