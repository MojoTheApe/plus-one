import { shade } from './art.js';
// This explicit public asset is the same pure physics module used by the server.
import { moveCell, cellVelocity, separateCells, massRanking, arenaPoint, arenaVelocity, separateOpponents, contactVelocities, touching } from './absorption-core.js';

const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const damp = (value, velocity, target, dt, rate) => {
  const offset = value - target, step = (velocity + rate * offset) * dt, decay = Math.exp(-rate * dt);
  return [target + (offset + step) * decay, (velocity - rate * step) * decay];
};
const centre = cells => {
  const mass = cells.reduce((n, c) => n + c.mass, 0);
  return [0, 1].map(k => cells.reduce((n, c) => n + c.mass * (k ? c.y : c.x), 0) / mass);
};

// Visual prediction is bounded and never awards food, mass, merges or kills.
// Positions remain server-owned. All actors use the same bounded simulation clock;
// own input starts from the current predicted pose, not the previous packet.
export class AbsorptionView {
  constructor(canvas, joystick, stick, onInput, minimap = null) {
    Object.assign(this, { canvas, joystick, stick, onInput, minimap, players: new Map(), food: new Map(),
      game: null, id: null, enabled: false, frame: null, camera: null, scale: null,
      followId: null, dragging: null, pendingInput: null, inputTimer: null, target: null, anchor: null,
      boosting: false, reducedMotion: globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches || false, lastInputAt: -Infinity, lastSentTarget: null, resyncInput: false, lastPaint: performance.now() });
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.motionQuery = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)');
    this.motionQuery?.addEventListener?.('change', e => { this.reducedMotion = e.matches; });
    new ResizeObserver(() => this.resize()).observe(canvas);
    canvas.addEventListener('pointermove', event => {
      if (event.pointerType !== 'mouse' || !this.enabled || !this.me()?.alive) return;
      const rect = canvas.getBoundingClientRect(), origin = this.screenPoint(this.me().visual || this.me().point);
      const x = event.clientX - rect.left - origin[0], y = event.clientY - rect.top - origin[1];
      const length = Math.hypot(x, y), strength = Math.min(1, length / 100);
      this.input({ x: length > 5 ? x / length * strength : 0, y: length > 5 ? y / length * strength : 0 });
    });
    window.addEventListener('blur', () => this.releaseInput());
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.releaseInput(); });
  }
  me() { return this.players.get(this.id); }
  alive() { return [...this.players.values()].filter(p => p.alive).sort((a, b) => b.score - a.score); }
  rank(player) { return massRanking(this.alive()).find(row => row.player.id === player.id)?.rank; }
  horizon(own = true) { return Math.min(own ? 320 : 350, Math.max(own ? 150 : 180, (this.packetGap || 0) + 50)); }
  setAim(target, now = performance.now()) {
    if (this.target?.x === target.x && this.target?.y === target.y) return;
    const player = this.me();
    if (player?.alive && this.game) {
      const predicted = this.prediction(player, now);
      this.anchor = { at: Math.min(now, player.received + this.horizon()), received: player.received,
        cells: predicted.map(c => ({ ...c })) };
      player.predictions = new Map(); player.predictionAt = null;
    }
    this.target = { ...target };
  }
  input(target, now = performance.now()) {
    if (!this.enabled) return;
    this.setAim(target, now); this.pendingInput = { ...target };
    const remaining = 40 - (now - this.lastInputAt);
    if (remaining <= 0) this.flushInput(now);
    else if (this.inputTimer === null) this.inputTimer = setTimeout(() => this.flushInput(), remaining);
  }
  flushInput(now = performance.now()) {
    clearTimeout(this.inputTimer); this.inputTimer = null;
    if (!this.pendingInput || !this.enabled) return;
    this.lastInputAt = now; this.lastSentTarget = { ...this.pendingInput };
    this.onInput(this.pendingInput); this.pendingInput = null;
  }
  cancelPendingInput(now = performance.now()) {
    clearTimeout(this.inputTimer); this.inputTimer = null; this.pendingInput = null;
    this.setAim(this.lastSentTarget || this.me()?.target || { x: 0, y: 0 }, now);
    this.resyncInput = true;
  }
  clearInput() {
    this.cancelPendingInput(); this.target = null; this.anchor = null; this.dragging = null; this.lastInputAt = -Infinity;
    this.lastSentTarget = null; this.resyncInput = false; this.boosting = false;
    if (this.stick) this.stick.style.transform = '';
  }
  releaseInput() {
    const canSend = this.enabled && this.me()?.alive;
    if (canSend) { this.input({ x: 0, y: 0 }); this.flushInput(); }
    // Blurring while disconnected must not turn an unsent stop into a sticky
    // local command or erase the need for authoritative reconnect input.
    const sent = this.lastSentTarget, resync = this.resyncInput;
    this.clearInput(); this.lastSentTarget = sent; this.resyncInput = resync;
    this.target = canSend ? { x: 0, y: 0 } : null;
  }

  prediction(player, now) {
    const own = player.id === this.id;
    player.predictions ||= new Map();
    if (player.predictions.has(now)) return player.predictions.get(now);
    if (!own) {
      // The server already resolves each remote part's group motion and contact
      // velocity. Extrapolate that allowed velocity on the common clock rather
      // than re-simulating every peer's own-part separation at120Hz.
      const at = Math.min(now, player.received + this.horizon(false));
      const seconds = Math.min(.5, Math.max(0, at - player.simulatedAt - this.simulationOffset) / 1000);
      const cells = player.cells.map(c => {
        const speed = Math.hypot(...c.velocity); let travel = speed * seconds, velocity = [...c.velocity];
        if (speed && c.speed > this.game.physics.speed && c.boostDirection) {
          const decay = this.game.physics.speed * 4.8, boosted = Math.min(seconds, (c.speed - this.game.physics.speed) / decay);
          travel = speed / c.speed * (c.speed * boosted - decay * boosted * boosted / 2 + this.game.physics.speed * (seconds - boosted));
          velocity = velocity.map(v => v * Math.max(this.game.physics.speed, c.speed - decay * seconds) / c.speed);
        }
        const point = arenaPoint([c.point[0] + (speed ? c.velocity[0] / speed * travel : 0),
          c.point[1] + (speed ? c.velocity[1] / speed * travel : 0)], c.radius, this.game.arena);
        return { id: c.id, x: point[0], y: point[1], velocity: arenaVelocity(point, c.radius, velocity, this.game.arena) };
      });
      player.predictions.set(now, cells);
      if (player.predictions.size > 8) player.predictions.delete(player.predictions.keys().next().value);
      return cells;
    }
    const cap = player.received + this.horizon(own), at = Math.min(now, cap);
    let anchor = own && this.anchor?.received === player.received ? this.anchor : null;
    const previous = player.predictionAt;
    if (previous?.received === player.received && previous.at <= at && (!anchor || previous.at >= anchor.at)) anchor = previous;
    const target = own ? this.target || player.target : player.target;
    const since = anchor?.at ?? player.simulatedAt + this.simulationOffset;
    const seconds = Math.min(.5, Math.max(0, at - since) / 1000), steps = Math.ceil(seconds * 120), dt = steps ? seconds / steps : 0;
    const cells = anchor ? anchor.cells.map(c => ({ ...c })) : player.cells.map(c => ({ id: c.id, x: c.point[0], y: c.point[1], mass: c.mass, radius: c.radius, speed: c.speed, thrust: c.thrust, boostDirection: c.boostDirection }));
    for (let i = 0; i < steps; i++) {
      const point = centre(cells);
      for (const cell of cells) { cell.boosting = player.boosting; moveCell(cell, point, target, dt, this.game.physics, this.game.arena); }
      if (player.mergeAt > at - this.simulationOffset) separateCells(cells);
      for (const cell of cells) moveCell(cell, [cell.x, cell.y], { x: 0, y: 0 }, 0, this.game.physics, this.game.arena);
    }
    const point = centre(cells);
    for (const cell of cells) cell.velocity = cellVelocity(cell, point, target, this.game.physics, this.game.arena);
    player.predictionAt = { at, received: player.received, cells };
    player.predictions.set(now, cells);
    if (player.predictions.size > 8) player.predictions.delete(player.predictions.keys().next().value);
    return cells;
  }
  targetPose(player, cell, now) {
    const predicted = this.prediction(player, now).find(c => c.id === cell.id);
    return { point: [predicted.x, predicted.y], velocity: predicted.velocity };
  }
  frameCell(player, cell, now) {
    const cap = player.received + this.horizon(player.id === this.id);
    if (!cell.pose) {
      const target = this.targetPose(player, cell, now);
      cell.pose = { point: [...target.point], velocity: [...target.velocity], at: now, radius: cell.radius };
    }
    const pose = cell.pose, end = Math.min(now, cap), begin = Math.min(pose.at, cap);
    let cursor = Math.max(begin, end - 100);
    while (cursor < end - .00001) {
      const next = Math.min(end, cursor + 1000 / 120), dt = (next - cursor) / 1000, target = this.targetPose(player, cell, next);
      const previous = [...pose.point];
      for (let k = 0; k < 2; k++) {
        const v = target.velocity[k], result = damp(pose.point[k], pose.velocity[k] - v, target.point[k] - v * dt, dt, 25);
        pose.point[k] = result[0] + v * dt; pose.velocity[k] = result[1] + v;
      }
      const maxSpeed = Math.max(this.game.physics.speed, cell.speed) * this.game.physics.boostMultiplier * 1.5, travelled = distance(previous, pose.point);
      if (travelled > maxSpeed * dt) pose.point = pose.point.map((v, k) => previous[k] + (v - previous[k]) * maxSpeed * dt / travelled);
      pose.radius += (cell.radius - pose.radius) * (1 - Math.exp(-dt * 18)); cursor = next;
    }
    const radius = Math.max(pose.radius, cell.radius);
    pose.point = arenaPoint(pose.point, radius, this.game.arena);
    pose.velocity = arenaVelocity(pose.point, radius, pose.velocity, this.game.arena);
    pose.at = Math.max(pose.at, now); return pose;
  }
  update(game, id, now = performance.now()) {
    this.id = id;
    if (!game || this.game?.id !== game.id) {
      this.game = null; this.players.clear(); this.food.clear(); this.camera = null; this.scale = null;
      this.followId = null; this.simulationOffset = null; this.packetGap = 0; this.gameReceived = null; this.softContacts = new Map(); this.clearInput();
      if (!game) return;
    }
    if (this.gameReceived !== null && this.gameReceived !== undefined && game.simulatedAt > this.game.simulatedAt) {
      const gap = now - this.gameReceived;
      if (gap > 0 && gap <= 450) this.packetGap = Math.max(gap, (this.packetGap || 0) * .98);
    }
    this.simulationOffset = Math.min(this.simulationOffset ?? Infinity, now - game.simulatedAt); this.game = game; this.gameReceived = now;
    if (game.food.reset) this.food.clear();
    for (const food of game.food.added) this.food.set(food.id, food);
    for (const id of game.food.removed) this.food.delete(id);
    const present = new Set(game.players.map(p => p.id));
    for (const key of this.players.keys()) if (!present.has(key)) this.players.delete(key);
    for (const data of game.players) {
      let player = this.players.get(data.id), reset = !player || player.life !== data.life || now - player.received > 500;
      if (player && !reset) reset = data.cells.some(c => {
        const old = player.cells.find(old => old.id === c.id);
        return old?.pose && distance(old.pose.point, c.point) > Math.max(180, c.speed * .5);
      });
      if (!player || reset) player = { cells: [] };
      const duplicate = !reset && player.simulatedAt === game.simulatedAt && player.cells.length === data.cells.length && player.alive === data.alive;
      const old = new Map(player.cells.map(c => [c.id, c]));
      const cells = data.cells.map(data => {
        const cell = old.get(data.id) || { history: [], pose: null };
        if (!duplicate && (!cell.history.length || game.simulatedAt > cell.history.at(-1).at)) {
          cell.history.push({ at: game.simulatedAt, point: [...data.point], velocity: [...data.velocity] });
          if (cell.history.length > 8) cell.history.shift();
        }
        if (!cell.history.length) cell.history.push({ at: game.simulatedAt, point: [...data.point], velocity: [...data.velocity] });
        return Object.assign(cell, data);
      });
      Object.assign(player, data, { cells, simulatedAt: game.simulatedAt, received: duplicate ? player.received : now, predictions: new Map(), predictionAt: null });
      this.players.set(player.id, player);
      if (player.id === id && this.resyncInput) {
        this.target = { ...data.target }; this.lastSentTarget = { ...data.target };
        this.anchor = null; this.resyncInput = false; player.predictions = new Map();
      }
      if (player.id === id && !duplicate) this.anchor = null;
      if (player.id === id && (reset || !player.alive)) { this.clearInput(); if (reset) this.camera = null; }
    }
  }
  resize() {
    const rect = this.canvas.getBoundingClientRect(), dpr = Math.min(devicePixelRatio || 1, 2);
    if (!rect.width || !rect.height) return;
    Object.assign(this, { width: rect.width, height: rect.height, dpr });
    if (this.canvas.width !== Math.round(rect.width * dpr)) this.canvas.width = Math.round(rect.width * dpr);
    if (this.canvas.height !== Math.round(rect.height * dpr)) this.canvas.height = Math.round(rect.height * dpr);
  }
  start() {
    if (this.frame !== null) return; this.resize(); this.lastPaint = performance.now();
    const animate = now => { this.paint(now); this.frame = requestAnimationFrame(animate); };
    this.frame = requestAnimationFrame(animate);
  }
  stop() {
    this.releaseInput(); if (this.frame !== null) cancelAnimationFrame(this.frame); this.frame = null;
  }
  focalY() { return this.height < 600 && this.width < 480 ? .52 : .57; }
  screenPoint(point) {
    const camera = this.camera || point, scale = this.scale || 1.2;
    return [this.width / 2 + (point[0] - camera[0]) * scale, this.height * this.focalY() + (point[1] - camera[1]) * scale];
  }
  softBodies(live, dt) {
    this.softContacts ||= new Map();
    const entries = live.flatMap(p => p.cells.map(cell => ({ owner: p.id, cell, x: cell.visual.point[0], y: cell.visual.point[1],
      radius: cell.visual.radius, mass: cell.mass, base: [...cell.visual.point], planes: [], active: false })));
    const byId = new Map(entries.map(e => [e.cell.id, e])), active = [];
    for (const contact of this.softContacts.values()) contact.active = false;
    const ordered = [...entries].sort((a, b) => a.x - a.radius - b.x + b.radius);
    for (let i = 0; i < ordered.length; i++) for (let j = i + 1; j < ordered.length; j++) {
      const a = ordered[i], b = ordered[j];
      if (b.x - b.radius > a.x + a.radius + .5) break;
      if (a.owner === b.owner) continue;
      if (!touching(a, b)) {
        // Radius/pose smoothing can leave a subpixel gap after a shrink packet.
        // Close only that cosmetic gap for a genuinely touching server pair.
        if (!a.cell.point || !b.cell.point || Math.hypot(a.x - b.x, a.y - b.y) > a.radius + b.radius + .5
          || !touching({ x: a.cell.point[0], y: a.cell.point[1], radius: a.cell.radius },
            { x: b.cell.point[0], y: b.cell.point[1], radius: b.cell.radius })) continue;
      }
      const low = a.cell.id < b.cell.id ? a : b, high = low === a ? b : a, key = low.cell.id + ':' + high.cell.id;
      const contact = this.softContacts.get(key) || { a: low.cell.id, b: high.cell.id, weight: 0 };
      contact.weight += (1 - contact.weight) * (1 - Math.exp(-dt * 22)); contact.active = true;
      this.softContacts.set(key, contact); low.active = high.active = true;
      active.push({ a: low, b: high, contact });
    }
    // Small cosmetic compression only. Authoritative/predicted solid positions
    // and minimap geometry stay unchanged; the common clipping plane makes the
    // two coloured surfaces share one soft, flattened contact edge.
    for (let pass = 0; pass < 6; pass++) for (const { a, b, contact } of active) {
      const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy); if (!d) continue;
      const target = a.radius + b.radius - Math.min(a.radius, b.radius) * .12 * contact.weight;
      const shift = (d - target), wa = b.mass / (a.mass + b.mass);
      a.x += dx / d * shift * wa; a.y += dy / d * shift * wa;
      b.x -= dx / d * shift * (1 - wa); b.y -= dy / d * shift * (1 - wa);
    }
    for (const e of entries) {
      if (e.active) {
        [e.x, e.y] = arenaPoint([e.x, e.y], e.radius, this.game.arena);
        e.cell.body = { point: [e.x, e.y], offset: [e.x - e.base[0], e.y - e.base[1]], planes: e.planes };
      } else {
        const offset = (e.cell.body?.offset || [0, 0]).map(v => v * Math.exp(-dt * 18));
        e.cell.body = { point: arenaPoint([e.x + offset[0], e.y + offset[1]], e.radius, this.game.arena), offset, planes: e.planes };
      }
    }
    for (const [key, contact] of this.softContacts) {
      const a = byId.get(contact.a), b = byId.get(contact.b);
      if (!a || !b) { this.softContacts.delete(key); continue; }
      if (contact.active) {
        const dx = b.cell.body.point[0] - a.cell.body.point[0], dy = b.cell.body.point[1] - a.cell.body.point[1], d = Math.hypot(dx, dy);
        if (!d) continue;
        contact.nx = dx / d; contact.ny = dy / d;
        const plane = (d * d + a.radius * a.radius - b.radius * b.radius) / (2 * d);
        contact.depthA = Math.max(0, Math.min(a.radius * .35, a.radius - plane));
        contact.depthB = Math.max(0, Math.min(b.radius * .35, b.radius - d + plane));
      } else {
        const decay = Math.exp(-dt * 18); contact.weight *= decay; contact.depthA *= decay; contact.depthB *= decay;
        if (contact.weight < .001) { this.softContacts.delete(key); continue; }
      }
      a.planes.push({ nx: contact.nx, ny: contact.ny, depth: contact.depthA, influence: contact.active ? 1 : contact.weight });
      b.planes.push({ nx: -contact.nx, ny: -contact.ny, depth: contact.depthB, influence: contact.active ? 1 : contact.weight });
    }
  }
  bodyRadius(cell, angle, now) {
    const radius = cell.visual.radius, nx = Math.cos(angle), ny = Math.sin(angle), planes = cell.body?.planes || [];
    const speed = Math.hypot(...cell.visual.velocity), direction = Math.atan2(cell.visual.velocity[1], cell.visual.velocity[0]);
    let influence = 0;
    for (const p of planes) influence = Math.max(influence, Math.max(0, (nx * p.nx + ny * p.ny - .4) / .6) * p.influence);
    const wobble = this.reducedMotion ? 0 : Math.min(.025, speed / 16000);
    let result = radius * (1 - (1 - influence) * (wobble * (1 - Math.cos(2 * (angle - direction))) / 2
      + (this.reducedMotion ? 0 : .0045 * (1 - Math.sin(angle * 3 + now / 330 + cell.id)))));
    for (const p of planes) {
      const dot = nx * p.nx + ny * p.ny; if (dot <= 0 || !p.depth) continue;
      const limit = (radius - p.depth) / dot, k = Math.min(radius * .015, p.depth * .4);
      const blend = k ? Math.max(0, k - Math.abs(result - limit)) ** 2 / (4 * k) : 0;
      result = Math.min(result, limit) - blend;
    }
    return Math.max(radius * .5, result);
  }
  paint(now) {
    if (!this.game || !this.width || !this.height) return;
    const dt = Math.min(.1, Math.max(0, (now - this.lastPaint) / 1000)); this.lastPaint = now;
    const live = this.alive(), own = this.me();
    const cellsToFrame = live.flatMap(p => p.cells);
    const radius = Math.max(4, Math.min(...cellsToFrame.map(c => c.radius)));
    const speed = Math.max(this.game.physics.speed, ...cellsToFrame.map(c => c.speed)) * this.game.physics.boostMultiplier * 1.5;
    const steps = Math.max(1, Math.min(64, Math.ceil(dt * speed / (radius * .75))));
    // Resolve between bounded display moves too: a fast tiny predicted part
    // must not swap sides with a delayed opponent between two painted frames.
    for (let i = 1; i <= steps; i++) {
      const at = now - dt * 1000 + i * dt * 1000 / steps;
      for (const p of live) for (const cell of p.cells) cell.visual = this.frameCell(p, cell, at);
      const bodies = live.flatMap(p => p.cells.map(cell => ({ owner: p.id, cell: {
        x: cell.visual.point[0], y: cell.visual.point[1], radius: cell.visual.radius,
        mass: cell.mass, velocity: [...cell.visual.velocity], source: cell,
      } })));
      separateOpponents(bodies, this.game.arena); contactVelocities(bodies, this.game.arena);
      for (const { cell } of bodies) {
        cell.source.visual.point = [cell.x, cell.y]; cell.source.visual.velocity = cell.velocity;
      }
    }
    for (const p of live) p.visual = [0, 1].map(k => p.cells.reduce((n, c) => n + c.mass * c.visual.point[k], 0) / p.score);
    const followed = own?.alive ? own : this.players.get(this.followId)?.alive ? this.players.get(this.followId) : live[0];
    const target = followed?.visual || this.game.arena.center;
    if (!this.camera) this.camera = [...target];
    this.camera = this.camera.map((v, k) => v + (target[k] - v) * (1 - Math.exp(-dt * 12)));
    // Keep initial cells legible, then reveal more of the arena as mass/parts grow.
    const span = followed ? Math.max(...followed.cells.map(c => Math.hypot(c.visual.point[0] - target[0], c.visual.point[1] - target[1]) + c.radius)) : 40;
    const largest = followed ? Math.max(...followed.cells.map(c => c.radius)) : 40;
    const zoom = Math.min(1.25, this.width / Math.max(340, largest * 5, span * 2.8), this.height / Math.max(450, span * 4.2));
    this.scale ??= zoom; this.scale += (zoom - this.scale) * (1 - Math.exp(-dt * 4));
    const c = this.ctx, dpr = this.dpr, a = this.game.arena;
    c.setTransform(dpr, 0, 0, dpr, 0, 0); c.fillStyle = '#dbe4e8'; c.fillRect(0, 0, this.width, this.height);
    const origin = this.screenPoint(a.center); c.beginPath(); c.arc(...origin, a.radius * this.scale, 0, Math.PI * 2);
    c.fillStyle = '#f4feff'; c.fill(); c.strokeStyle = '#aabdc5'; c.lineWidth = 3; c.stroke(); c.save(); c.clip();
    const foodColors = ['#ffbb00', '#00cfe8', '#f71957', '#38e625', '#9b23ed', '#2165f5'];
    for (const food of this.food.values()) {
      const [x, y] = this.screenPoint([food.x, food.y]); if (x < -10 || y < -10 || x > this.width + 10 || y > this.height + 10) continue;
      c.beginPath(); c.arc(x, y, Math.max(2.8, this.game.physics.foodRadius * this.scale), 0, Math.PI * 2); c.fillStyle = foodColors[food.hue]; c.fill();
    }
    for (const f of this.game.ejected || []) {
      const age = Math.min(.15, Math.max(0, (now - this.gameReceived) / 1000)), travel = (1 - Math.exp(-age * 6)) / 6;
      const [x, y] = this.screenPoint(arenaPoint([f.point[0] + f.velocity[0] * travel, f.point[1] + f.velocity[1] * travel], f.radius, this.game.arena));
      c.beginPath(); c.arc(x, y, Math.max(3, f.radius * this.scale), 0, Math.PI * 2); c.fillStyle = f.color; c.fill();
      c.lineWidth = 1.5; c.strokeStyle = shade(f.color, .65); c.stroke();
    }
    this.softBodies(live, dt);
    const cells = live.flatMap(p => p.cells.map(cell => ({ p, cell }))).sort((a, b) => b.cell.mass - a.cell.mass);
    for (const { p, cell } of cells) {
      const [x, y] = this.screenPoint(cell.body.point), radius = cell.visual.radius * this.scale;
      if (x + radius < 0 || y + radius < 0 || x - radius > this.width || y - radius > this.height) continue;
      // Include each contact normal so even a small dent on a large body has
      // a point on the shared plane, independent of circle tessellation angle.
      const extras = cell.body.planes.map(p => (Math.atan2(p.ny, p.nx) + Math.PI * 2) % (Math.PI * 2)).sort((a, b) => a - b);
      let extra = 0;
      const vertex = angle => {
        const r = this.bodyRadius(cell, angle, now) * this.scale;
        c.lineTo(x + Math.cos(angle) * r, y + Math.sin(angle) * r);
      };
      c.beginPath();
      const initial = this.bodyRadius(cell, 0, now) * this.scale; c.moveTo(x + initial, y);
      for (let i = 1; i <= 40; i++) {
        const angle = i / 40 * Math.PI * 2;
        while (extra < extras.length && extras[extra] < angle) vertex(extras[extra++]);
        vertex(angle);
      }
      c.closePath(); c.fillStyle = p.color; c.fill(); c.lineWidth = Math.max(2, Math.min(4, radius * .06)); c.strokeStyle = shade(p.color, .65); c.stroke();
      const fontSize = Math.max(11, Math.min(28, Math.floor(radius * .43))), nameWidth = Math.floor(radius * 1.65);
      c.font = `900 ${fontSize}px Rubik, sans-serif`;
      const labelKey = `${p.name}:${fontSize}:${nameWidth}`;
      if (cell.label?.key !== labelKey) {
        const letters = Array.from(p.name); let name = letters.join('');
        while (letters.length && c.measureText(name).width > nameWidth) { letters.pop(); name = letters.join('') + '…'; }
        cell.label = { key: labelKey, text: name };
      }
      const name = cell.label.text;
      c.textAlign = 'center'; c.textBaseline = 'middle'; c.lineJoin = 'round';
      c.lineWidth = 3; c.strokeStyle = '#20252d'; c.strokeText(name, x, y, radius * 1.65);
      c.fillStyle = '#fff'; c.fillText(name, x, y, radius * 1.65);
      if (p.protectedUntil > this.serverTime()) { c.beginPath(); c.arc(x, y, radius + 5, 0, Math.PI * 2); c.setLineDash([4, 5]); c.lineWidth = 2; c.strokeStyle = '#20252d'; c.stroke(); c.setLineDash([]); }
    }
    c.restore();
    this.paintMinimap(live);
  }
  paintMinimap(live) {
    if (!this.minimap) return;
    const size = 180, a = this.game.arena, scale = 174 / (a.radius * 2), m = this.minimap;
    if (m.width !== size) m.width = m.height = size;
    const c = m.getContext('2d'); c.clearRect(0, 0, size, size); c.beginPath(); c.arc(90, 90, 87, 0, Math.PI * 2); c.fillStyle = '#fff'; c.fill(); c.strokeStyle = '#aabdc5'; c.lineWidth = 2; c.stroke(); c.save(); c.clip();
    const point = p => [90 + (p[0] - a.center[0]) * scale, 90 + (p[1] - a.center[1]) * scale];
    for (const p of live) for (const cell of p.cells) {
      c.beginPath(); c.arc(...point(cell.visual.point), cell.visual.radius * scale, 0, Math.PI * 2);
      c.fillStyle = p.color; c.fill(); c.strokeStyle = '#26353c'; c.lineWidth = p.id === this.id ? .9 : .5; c.stroke();
    }
    const [x, y] = point([this.camera[0] - this.width / this.scale / 2, this.camera[1] - this.height * this.focalY() / this.scale]);
    c.strokeStyle = '#26353c'; c.lineWidth = 1.5; c.strokeRect(x, y, this.width / this.scale * scale, this.height / this.scale * scale); c.restore();
  }
  serverTime() { return Date.now() + (this.clockOffset || 0); }
}
