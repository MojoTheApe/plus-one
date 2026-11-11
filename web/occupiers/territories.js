import { drawToy, drawPlayerLabel, shade } from './art.js';
// Territories presentation and controls only. No client geometry, scores or
// positions are accepted by the authoritative server.
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
const damp = (value, velocity, target, dt, rate) => {
  const offset = value-target, step = (velocity+rate*offset)*dt, decay = Math.exp(-rate*dt);
  return [target+(offset+step)*decay, (velocity-rate*step)*decay];
};

export function extrapolate(point, angle, target, speed, turnSpeed, seconds) {
  const points = [], stepCount = Math.ceil(seconds * 120), dt = stepCount ? seconds / stepCount : 0;
  point = [...point];
  for (let i = 0; i < stepCount; i++) {
    const delta = Math.atan2(Math.sin(target - angle), Math.cos(target - angle));
    angle += Math.max(-turnSpeed * dt, Math.min(turnSpeed * dt, delta));
    point = [point[0] + Math.cos(angle) * speed * dt, point[1] + Math.sin(angle) * speed * dt]; points.push(point);
  }
  return { point, angle, points };
}

export function arenaBoundary(game) {
  const a = game.arena;
  if (!a || a.shape !== 'circle') return [[0, 0], [game.width, 0], [game.width, game.height], [0, game.height]];
  return Array.from({ length: a.segments }, (_, i) => [a.center[0] + Math.cos(i / a.segments * Math.PI * 2) * a.radius,
    a.center[1] + Math.sin(i / a.segments * Math.PI * 2) * a.radius]);
}

export class TerritoryView {
  constructor(canvas, joystick, stick, onInput, minimap = null) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.minimap = minimap;
    this.miniDirty = true;
    this.joystick = joystick;
    this.stick = stick;
    this.onInput = onInput;
    this.players = new Map();
    this.game = null;
    this.id = null;
    this.camera = null;
    this.frame = null;
    this.followId = null;
    this.dragging = null;
    this.lastInputAt = -Infinity;
    this.pendingInput = null;
    this.inputTimer = null;
    this.inputAngle = null;
    this.inputAnchor = null;
    this.lastSentAngle = null;
    this.enabled = true;
    this.lastPaint = performance.now();
    new ResizeObserver(() => this.resize()).observe(canvas);
    canvas.addEventListener('pointermove', event => {
      if (event.pointerType !== 'mouse' || !this.me()?.alive) return;
      const rect = canvas.getBoundingClientRect();
      const origin = this.screenPoint(this.me().visual?.point || this.me().point);
      this.input(Math.atan2((event.clientY - rect.top - origin[1]) / .82, event.clientX - rect.left - origin[0]));
    });

  }

  setAim(angle, now = performance.now()) {
    if (angle === this.inputAngle) return;
    const player = this.players.get(this.id);
    if (player?.alive && this.game) {
      this.frameState(player, now);
      const target = this.targetPose(player, now);
      this.inputAnchor = { received: player.received, at: now,
        point: target.point, angle: target.angle, extension: target.extension };
    }
    this.inputAngle = angle;
  }

  input(angle, now = performance.now()) {
    if (!this.enabled) return;
    this.setAim(angle, now);
    this.pendingInput = angle;
    const remaining = 40 - (now - this.lastInputAt);
    if (remaining <= 0) this.flushInput(now);
    else if (this.inputTimer === null) this.inputTimer = setTimeout(() => this.flushInput(), remaining);
  }

  cancelPendingInput(now = performance.now()) {
    clearTimeout(this.inputTimer); this.inputTimer = null; this.pendingInput = null;
    this.setAim(this.lastSentAngle, now);
  }

  clearInput() {
    clearTimeout(this.inputTimer); this.inputTimer = null; this.pendingInput = null;
    this.inputAngle = null; this.inputAnchor = null; this.lastSentAngle = null;
    this.lastInputAt = -Infinity; this.dragging = null;
    if (this.stick) this.stick.style.transform = '';
  }

  flushInput(now = performance.now()) {
    clearTimeout(this.inputTimer); this.inputTimer = null;
    if (this.pendingInput === null || !this.enabled) return;
    this.lastInputAt = now;
    this.lastSentAngle = this.pendingInput; this.onInput(this.pendingInput); this.pendingInput = null;
  }


  me() { return this.players.get(this.id); }
  alive() { return [...this.players.values()].filter(p => p.alive).sort((a, b) => b.score - a.score); }
  percent(player) { return this.game ? player.score / (this.game.arenaArea || this.game.width * this.game.height) * 100 : 0; }

  targetPose(player, now) {
    const own = player.id === this.id;
    const at = Math.min(now, player.received + (own ? 150 : 180));
    const time = at - (this.simulationOffset ?? 0) - (own ? 0 : 100);
    const history = player.history || [{ at: player.received, point: player.point,
      angle: player.angle, targetAngle: player.targetAngle }];
    if (!own && time <= history[0].at) return { point: [...history[0].point],
      angle: history[0].angle, velocity: [0,0], extension: [] };
    const speed = this.game.speed;
    const velocity = angle => [Math.cos(angle) * speed, Math.sin(angle) * speed];
    for (let i = 1; i < history.length; i++) {
      const a = history[i - 1], b = history[i];
      if (time > b.at) continue;
      const seconds = (b.at - a.at) / 1000;
      const t = Math.max(0, Math.min(1, (time - a.at) / (b.at - a.at)));
      const va = velocity(a.angle), vb = velocity(b.angle);
      // Tangents preserve travel velocity through each authoritative snapshot.
      const point = [0, 1].map(k => (2*t**3-3*t**2+1)*a.point[k]
        + (t**3-2*t**2+t)*seconds*va[k] + (-2*t**3+3*t**2)*b.point[k]
        + (t**3-t**2)*seconds*vb[k]);
      const v = [0, 1].map(k => ((6*t**2-6*t)*a.point[k]
        + (3*t**2-4*t+1)*seconds*va[k] + (-6*t**2+6*t)*b.point[k]
        + (3*t**2-2*t)*seconds*vb[k]) / seconds);
      return { point, velocity: v, angle: a.angle
        + Math.atan2(Math.sin(b.angle-a.angle), Math.cos(b.angle-a.angle))*t, extension: [] };
    }
    const last = history.at(-1);
    const anchor = own && this.inputAnchor?.received === player.received ? this.inputAnchor : null;
    const since = anchor ? Math.min(at, anchor.at) : last.at + (this.simulationOffset ?? 0) + (own ? 0 : 100);
    // Include the snapshot age at receipt; otherwise30Hz quantisation plus
    // jitter would exhaust a fresh packet's prediction early. Work stays bounded.
    const seconds = Math.min(.5, Math.max(0, at - since) / 1000);
    const predicted = extrapolate(anchor?.point || last.point, anchor?.angle ?? last.angle,
      own ? this.inputAngle ?? last.targetAngle ?? last.angle : last.targetAngle ?? last.angle,
      speed, this.game.turnSpeed || 0, seconds);
    return { ...predicted, velocity: velocity(predicted.angle),
      extension: [...(anchor?.extension || [last.point]), ...predicted.points] };
  }

  trailFrame(player, point, extension) {
    if (player.trail.length < 2) return { tail: null, extension: [] };
    // Search only recent confirmed/predicted geometry, never an older parallel
    // part of the excursion. Clip at this frame's head, including new trails.
    const first = Math.max(0, player.trail.length - 20);
    const points = [...player.trail.slice(first), ...extension];
    let best, walked = 0;
    const limit = this.game.speed * .5;
    for (let i = points.length-1; i > 0 && walked <= limit; i--) {
      const a = points[i-1], b = points[i], dx = b[0]-a[0], dy = b[1]-a[1];
      const length = dx*dx + dy*dy;
      if (!length) continue;
      const low = Math.max(0, 1-(limit-walked)/Math.sqrt(length));
      const t = Math.max(low, Math.min(1, ((point[0]-a[0])*dx+(point[1]-a[1])*dy)/length));
      walked += Math.sqrt(length);
      const projected = mix(a,b,t), error = distance(point,projected);
      if (!best || error < best.error) best = { i, t, error };
    }
    if (!best || best.error > this.game.speed * .5) return { tail: null, extension: [] };
    if (!first && best.i === 1 && best.t === 0) {
      const a = points[0], b = points[1];
      if ((point[0]-a[0])*(b[0]-a[0]) + (point[1]-a[1])*(b[1]-a[1]) < 0) return { tail: null, extension: [] };
    }
    const end = first + best.i - 1;
    return { tail: { endIndex: Math.min(end, player.trail.length-2) },
      extension: end >= player.trail.length-1 ? points.slice(player.trail.length-1-first,best.i) : [] };
  }

  frameState(player, now = performance.now()) {
    if (!player.alive) return { point: [...player.point], angle: player.angle, tail: null, extension: [] };
    const cap = player.received + (player.id === this.id ? 150 : 180);
    const pose = player.pose ||= { point: [...player.from], angle: player.fromAngle,
      velocity: player.id === this.id
        ? [Math.cos(player.fromAngle)*this.game.speed, Math.sin(player.fromAngle)*this.game.speed] : [0,0],
      yawRate: 0, at: player.received };
    const end = Math.max(pose.at, Math.min(now, cap));
    const steps = Math.ceil(Math.max(0, end-pose.at) / (1000/120));
    const dt = steps ? (end-pose.at)/steps/1000 : 0;
    for (let i = 0; i < steps; i++) {
      const at = pose.at + (i+1)*dt*1000;
      const target = this.targetPose(player, at);
      const previous = [...pose.point];
      for (let k = 0; k < 2; k++) {
        const v = target.velocity[k];
        // Critically damp the correction, not the travel speed. A steady155
        // units/s trajectory therefore stays155 even when packets arrive late.
        const start = target.point[k] - v*dt;
        const result = damp(pose.point[k], pose.velocity[k]-v, start, dt, 24);
        pose.point[k] = result[0]+v*dt; pose.velocity[k] = result[1]+v;
      }
      const travelled = distance(previous, pose.point), maxSpeed = this.game.speed * 1.5;
      if (travelled > maxSpeed*dt) pose.point = mix(previous,pose.point,maxSpeed*dt/travelled);
      const velocity = Math.hypot(...pose.velocity);
      if (velocity > maxSpeed) pose.velocity = pose.velocity.map(v => v*maxSpeed/velocity);
      const desired = pose.angle + Math.atan2(Math.sin(target.angle-pose.angle), Math.cos(target.angle-pose.angle));
      const result = damp(pose.angle, pose.yawRate, desired, dt, 28);
      const limit = (this.game.turnSpeed || 0)*1.25;
      pose.angle += Math.max(-limit*dt, Math.min(limit*dt,result[0]-pose.angle));
      pose.yawRate = Math.max(-limit, Math.min(limit,result[1]));
    }
    // Keep the wall clock current during a gap so a fresh packet cannot integrate
    // the frozen interval all at once. Prediction still stops at its receipt cap.
    pose.at = Math.max(pose.at, now);
    const target = this.targetPose(player, Math.min(now,cap));
    return { point: [...pose.point], angle: pose.angle,
      ...this.trailFrame(player, pose.point, target.extension) };
  }

  position(player, now = performance.now()) { return this.frameState(player, now).point; }

  update(game, id, now = performance.now()) {
    this.id = id;
    if (!game) { this.simulationOffset = null; this.game = null; this.players.clear(); this.camera = null; this.clearInput(); this.miniDirty = true; return; }
    if (this.game?.id !== game.id) { this.simulationOffset = null; this.players.clear(); this.camera = null; this.followId = null; this.clearInput(); this.miniDirty = true; }
    if (this.game?.id !== game.id || !this.boundary) {
      this.boundary = arenaBoundary(game);
      this.worldPath = null;
      if (typeof Path2D === 'function') {
        this.worldPath = new Path2D(); this.boundary.forEach((p, i) => i ? this.worldPath.lineTo(...p) : this.worldPath.moveTo(...p)); this.worldPath.closePath();
      }
    }
    const simulatedAt = game.simulatedAt ?? now;
    this.simulationOffset = Math.min(this.simulationOffset ?? Infinity, now-simulatedAt);
    this.game = game;
    const present = new Set(game.players.map(p => p.id));
    for (const key of this.players.keys()) if (!present.has(key)) { this.players.delete(key); this.miniDirty = true; }
    for (const data of game.players) {
      let p = this.players.get(data.id);
      const duplicate = p && p.alive === data.alive && p.angle === data.angle
        && p.point[0] === data.point[0] && p.point[1] === data.point[1]
        && p.trailId === data.trail.id && (game.simulatedAt === undefined || p.simulatedAt === game.simulatedAt);
      const oldFrame = p?.alive ? this.frameState(p, now) : null;
      let from = oldFrame?.point || [...data.point];
      let fromAngle = oldFrame?.angle ?? data.angle;
      const gap = p ? now - p.received : 0;
      if (!duplicate && (gap > 500 || distance(from, data.point) > game.speed * .5)) { from = [...data.point]; fromAngle = data.angle; p.pose = null; if (data.id === id || data.id === this.followId) this.camera = null; if (data.id === id) this.clearInput(); }
      const newTrail = !p || data.trail.id !== p.trailId;
      if (!p) p = { land: [], trail: [], trailId: null, prefixEnd: 0 };
      if (p.alive !== data.alive || data.land) this.miniDirty = true;
      const trail = data.trail;
      if (trail.id !== p.trailId || trail.from === 0) p.trail = [];
      p.trail.splice(trail.from, p.trail.length - trail.from, ...trail.points);
      p.trailId = trail.id;
      if (typeof Path2D === 'function') {
        if (!p.trailPath || newTrail || trail.from <= p.prefixEnd) {
          p.trailPath = new Path2D(); p.prefixEnd = 0;
          if (p.trail.length) p.trailPath.moveTo(...p.trail[0]);
        }
        // Keep at least 20 recent segments out of the stable prefix: enough for
        // both interpolation and bounded visual correction at current limits.
        const end = Math.max(0, p.trail.length - 20);
        while (p.prefixEnd < end) p.trailPath.lineTo(...p.trail[++p.prefixEnd]);
        if (data.land) {
          p.landPath = new Path2D();
          for (const polygon of data.land) for (const ring of polygon) {
            ring.forEach((point, i) => i ? p.landPath.lineTo(...point) : p.landPath.moveTo(...point)); p.landPath.closePath();
          }
          const points = data.land.flat(2);
          p.landBounds = points.length ? [Math.min(...points.map(p => p[0])), Math.min(...points.map(p => p[1])), Math.max(...points.map(p => p[0])), Math.max(...points.map(p => p[1]))] : null;
        }
      }
      const oldLand = p.land;
      if (duplicate) { from = p.from; fromAngle = p.fromAngle; }
      if (!duplicate) {
        p.history ||= [];
        if (!p.history.length || simulatedAt > p.history.at(-1).at) {
          p.history.push({ at: simulatedAt, point: [...data.point], angle: data.angle, targetAngle: data.targetAngle });
          if (p.history.length > 8) p.history.shift();
        }
      }
      Object.assign(p, data, { trail: p.trail, land: data.land ?? oldLand, from, fromAngle, simulatedAt: game.simulatedAt, received: duplicate ? p.received : now });
      this.players.set(p.id, p);
      if (p.id === this.id && !duplicate) this.inputAnchor = null;
      if (p.id === this.id && !p.alive) this.clearInput();
    }
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = Math.min(devicePixelRatio || 1, 2);
    if (rect.width && rect.height) {
      // Both concrete views observe this canvas. An unchanged backing size must
      // not clear the other view's freshly painted frame after a mode switch.
      if (this.canvas.width !== Math.round(rect.width * dpr)) this.canvas.width = Math.round(rect.width * dpr);
      if (this.canvas.height !== Math.round(rect.height * dpr)) this.canvas.height = Math.round(rect.height * dpr);
      this.width = rect.width; this.height = rect.height; this.dpr = dpr;
    }
  }

  start() {
    if (this.frame !== null) return;
    this.resize();
    this.lastPaint = performance.now();
    const animate = now => { this.paint(now); this.frame = requestAnimationFrame(animate); };
    this.frame = requestAnimationFrame(animate);
  }

  stop() {
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
    this.clearInput();
  }

  outline(ctx, operation) {
    if (this.worldPath) { ctx[operation](this.worldPath); return; }
    ctx.beginPath(); (this.boundary || arenaBoundary(this.game)).forEach((p, i) => i ? ctx.lineTo(...p) : ctx.moveTo(...p)); ctx.closePath(); ctx[operation]();
  }

  focalY() { return this.height < 600 && this.width < 480 ? .52 : .59; }

  paint(now) {
    if (!this.game || !this.width || !this.height) return;
    const dt = Math.min(0.1, (now - this.lastPaint) / 1000);
    this.lastPaint = now;
    const live = this.alive(), me = this.me();
    for (const player of live) player.visual = this.frameState(player, now);
    const followed = me?.alive ? me : this.players.get(this.followId)?.alive
      ? this.players.get(this.followId) : live[0];
    const target = followed ? followed.visual.point : [this.game.width / 2, this.game.height / 2];
    if (!this.camera) this.camera = [...target];
    this.camera = this.camera.map((v, i) => v + (target[i] - v) * (1 - Math.exp(-dt * 16)));
    const scale = Math.min(this.height < 480 ? 2.4 : 2.8, this.width / 125);
    this.scale = scale;
    const ctx = this.ctx, dpr = this.dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#dbe4e8'; ctx.fillRect(0, 0, this.width, this.height);
    ctx.translate(this.width / 2, this.height * this.focalY());
    ctx.scale(scale, scale * .82); ctx.translate(-this.camera[0], -this.camera[1]);
    ctx.fillStyle = '#f4feff'; this.outline(ctx, 'fill');
    ctx.strokeStyle = '#e14549'; ctx.lineWidth = 3 / scale;
    this.outline(ctx, 'stroke');
    ctx.save(); this.outline(ctx, 'clip');
    const bounds = [this.camera[0] - this.width / scale / 2, this.camera[1] - this.height * this.focalY() / (scale * .82),
      this.camera[0] + this.width / scale / 2, this.camera[1] + this.height * (1 - this.focalY()) / (scale * .82)];
    for (const p of live) {
      const b = p.landBounds;
      if (!p.landPath || (b && (b[2] < bounds[0] || b[0] > bounds[2] || b[3] < bounds[1] || b[1] > bounds[3]))) continue;
      ctx.save(); ctx.translate(0, 5 / (scale * .82));
      ctx.fillStyle = shade(p.color, .57); ctx.fill(p.landPath, 'evenodd'); ctx.restore();
      ctx.fillStyle = p.color; ctx.fill(p.landPath, 'evenodd');
    }
    for (const p of live) {
      if (!p.visual.tail) continue;
      const end = p.visual.tail.endIndex;
      let path;
      ctx.strokeStyle = p.color; ctx.lineWidth = this.game.trailRadius * 2;
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      if (p.trailPath && end >= p.prefixEnd) {
        ctx.stroke(p.trailPath);
        path = new Path2D(); path.moveTo(...p.trail[p.prefixEnd]);
        for (let i = p.prefixEnd + 1; i <= end; i++) path.lineTo(...p.trail[i]);
      } else {
        path = new Path2D();
        for (let i = 0; i <= end; i++) i ? path.lineTo(...p.trail[i]) : path.moveTo(...p.trail[i]);
      }
      for (const point of p.visual.extension) path.lineTo(...point);
      path.lineTo(...p.visual.point);
      ctx.strokeStyle = p.color; ctx.lineWidth = this.game.trailRadius * 2;
      ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.stroke(path);
    }
    ctx.restore();
    // Toys and labels use screen pixels so they stay crisp under the tilted map.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    for (const p of live.toSorted ? live.toSorted((a,b) => a.visual.point[1]-b.visual.point[1]) : [...live].sort((a,b) => a.visual.point[1]-b.visual.point[1])) {
      const point = this.screenPoint(p.visual.point);
      if (point[0] < -100 || point[1] < -100 || point[0] > this.width + 100 || point[1] > this.height + 100) continue;
      const size = this.game.headRadius * 3.2 * scale;
      const top = drawToy(ctx, ...point, size, p.visual.angle, p.character || 'car', p.color);
      if (p.protectedUntil > this.serverTime()) {
        ctx.beginPath();ctx.ellipse(point[0],point[1],this.game.headRadius*scale+5,(this.game.headRadius*scale+5)*.82,0,0,Math.PI*2);
        ctx.strokeStyle=p.color;ctx.lineWidth=2;ctx.setLineDash([4,5]);ctx.stroke();ctx.setLineDash([]);
      }
      drawPlayerLabel(ctx, point[0], top - 24, p.id === this.id ? 'ТИ' : Array.from(p.name).slice(0,18).join('').toLocaleUpperCase('uk-UA'), p.color, 17);
    }
    this.paintMinimap(live);
  }

  screenPoint(point) {
    const scale = this.scale || 2.8, camera = this.camera || point;
    return [this.width / 2 + (point[0] - camera[0]) * scale,
      this.height * this.focalY() + (point[1] - camera[1]) * scale * .82];
  }

  paintMinimap(live) {
    if (!this.minimap) return;
    const size = 180, pad = 3, a = this.game.arena;
    const radius = a?.radius || Math.min(this.game.width, this.game.height) / 2;
    const center = a?.center || [this.game.width / 2, this.game.height / 2];
    const scale = (size - pad * 2) / (radius * 2), dx = size / 2 - center[0] * scale, dy = size / 2 - center[1] * scale;
    if (!this.miniTerrain) this.miniTerrain = document.createElement('canvas');
    if (this.miniDirty) {
      this.miniTerrain.width = this.miniTerrain.height = size;
      const c = this.miniTerrain.getContext('2d');
      c.translate(dx, dy); c.scale(scale, scale); c.save();
      c.fillStyle = '#fff'; this.outline(c, 'fill'); this.outline(c, 'clip');
      for (const p of live) if (p.landPath) { c.fillStyle = p.color; c.fill(p.landPath, 'evenodd'); }
      c.restore(); c.lineWidth = 2 / scale; c.strokeStyle = '#b4c4cb'; this.outline(c, 'stroke'); this.miniDirty = false;
    }
    if (this.minimap.width !== size) this.minimap.width = this.minimap.height = size;
    const c = this.minimap.getContext('2d'); c.clearRect(0, 0, size, size); c.drawImage(this.miniTerrain, 0, 0);
    c.save(); c.translate(dx, dy); c.scale(scale, scale); this.outline(c, 'clip');
    for (const p of live) { c.beginPath(); c.arc(...p.visual.point, (p.id === this.id ? 4 : 2.5) / scale, 0, Math.PI * 2); c.fillStyle = p.color; c.fill(); c.strokeStyle = '#26353c'; c.lineWidth = 1 / scale; c.stroke(); }
    const left = this.camera[0] - this.width / (this.scale * 2), top = this.camera[1] - this.height * this.focalY() / (this.scale * .82);
    const width = this.width / this.scale, height = this.height / (this.scale * .82);
    c.strokeStyle = '#fff'; c.lineWidth = 3 / scale; c.strokeRect(left, top, width, height);
    c.strokeStyle = '#26353c'; c.lineWidth = 1 / scale; c.strokeRect(left, top, width, height); c.restore();
  }

  serverTime() { return Date.now() + (this.clockOffset || 0); }
}
