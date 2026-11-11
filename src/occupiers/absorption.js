import { randomUUID } from 'node:crypto';
import { hasCharacter } from './characters.js';
import { ABSORPTION_RULES, AbsorptionPlayer, radiusFromMass, separateOpponents, touching, contactVelocities, massRanking, arenaPoint, arenaVelocity } from './absorption-core.js';

export function absorptionConfig(options = {}) {
  const config = { width: 2400, height: 2400, maxPlayers: 12, durationMs: 300_000, ...ABSORPTION_RULES, ...options };
  for (const [key, value] of Object.entries(config)) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0
      || (!['foodCount', 'protectionMs'].includes(key) && value === 0)) throw new Error('Invalid absorption setting: ' + key);
  }
  if (config.width < 400 || config.height < 400 || !Number.isInteger(config.maxPlayers)
    || config.maxPlayers < 2 || config.maxPlayers > 12 || config.splitLimit !== 16
    || config.mergeMs < 15_000 || config.slowBase <= 1 || config.tickRate !== 60
    || !Number.isInteger(config.foodCount) || config.foodCount > 1200
    || config.absorptionMs < 500 || config.absorptionMs > 5000
    || config.massBudget < config.maxPlayers * config.initialMass) throw new Error('Invalid absorption limits');
  return Object.freeze(config);
}

// Only this mode owns mass, cells, food, respawn eligibility and deadline victory.
// The shared Telegram room does not impose Territories' elimination rules here.
export class AbsorptionMatch {
  static minimumPlayers = 1;
  static respawns = true;
  constructor(members, { now = Date.now(), config = {}, random = Math.random, onEvent = () => {}, practice = false } = {}) {
    this.config = absorptionConfig(config); this.mode = 'absorption'; this.id = randomUUID();
    this.practice = practice === true; this.capacity = this.practice ? 1 : this.config.maxPlayers;
    if (members.length < AbsorptionMatch.minimumPlayers || members.length > this.capacity) throw new Error('players_required');
    this.players = new Map(); this.food = new Map(); this.ejected = new Map(); this.nextCellId = 0; this.nextFoodId = 0; this.nextEjectedId = 0;
    this.random = random; this.onEvent = onEvent;
    this.arena = { shape: 'circle', center: [this.config.width / 2, this.config.height / 2], radius: Math.min(this.config.width, this.config.height) / 2, segments: 256 };
    this.startedAt = this.simulatedAt = this.lastBalance = now; this.endsAt = now + this.config.durationMs;
    this.finished = false; this.results = null;
    for (const member of members) if (!this.spawn(member, now)) throw new Error('no_spawn');
    this.balanceFood();
  }
  active() { return [...this.players.values()].filter(p => p.alive); }
  participant(id) { return this.players.get(id); }
  randomPoint(margin) {
    const a = this.arena, angle = this.random() * Math.PI * 2, radius = Math.sqrt(this.random()) * Math.max(0, a.radius - margin);
    return [a.center[0] + Math.cos(angle) * radius, a.center[1] + Math.sin(angle) * radius];
  }
  safeSpawn() {
    const radius = radiusFromMass(this.config.initialMass), a = this.arena;
    const cells = this.active().flatMap(p => p.cells);
    const clearance = point => {
      if (Math.hypot(point[0] - a.center[0], point[1] - a.center[1]) + radius + 12 > a.radius) return -1;
      return cells.length ? Math.min(...cells.map(c => Math.hypot(point[0] - c.x, point[1] - c.y) - c.radius - radius)) : Infinity;
    };
    let best = null, distance = 80;
    for (let i = 0; i < 64; i++) {
      const point = this.randomPoint(radius + 12), gap = clearance(point);
      if (gap >= distance) { best = point; distance = gap; }
      if (!cells.length) return point;
    }
    if (best) return best;
    // Bounded deterministic fallback never substitutes an overlapping spawn.
    for (let ring = 1; ring <= 8; ring++) for (let i = 0; i < 48; i++) {
      const angle = i * Math.PI * 2 / 48, r = (a.radius - radius - 12) * ring / 8;
      const point = [a.center[0] + Math.cos(angle) * r, a.center[1] + Math.sin(angle) * r];
      if (clearance(point) >= 80) return point;
    }
    return null;
  }
  spawn(member, now) {
    if (this.active().length >= this.capacity) return null;
    const point = this.safeSpawn(); if (!point) return null;
    let player = this.players.get(member.id);
    if (player?.alive) return player;
    if (!player) { player = new AbsorptionPlayer(member, () => ++this.nextCellId); this.players.set(member.id, player); }
    Object.assign(player, { name: member.name, color: member.color, character: hasCharacter(member.character) ? member.character : 'car' });
    player.init(point, now, this.config); return player;
  }
  join(member, now) {
    this.advance(now);
    if (this.finished) return { ok: false, reason: 'match_ended' };
    if (this.participant(member.id)?.alive) return { ok: true, reason: 'already_playing' };
    if (this.active().length >= this.capacity) return { ok: false, reason: 'full' };
    const returning = this.players.has(member.id);
    if (!this.spawn(member, now)) return { ok: false, reason: 'no_spawn' };
    this.onEvent({ type: returning ? 'respawned' : 'joined', id: member.id, name: member.name });
    return { ok: true };
  }
  input(id, target) {
    if (!target || typeof target !== 'object' || Array.isArray(target)
      || typeof target.x !== 'number' || typeof target.y !== 'number'
      || !Number.isFinite(target.x) || !Number.isFinite(target.y) || Math.hypot(target.x, target.y) > 1.000001) return false;
    const player = this.participant(id); if (!player?.alive || this.finished) return false;
    player.target = { x: target.x, y: target.y };
    const length = Math.hypot(target.x, target.y);
    if (length > .000001) player.lastAim = { x: target.x / length, y: target.y / length };
    return true;
  }
  split(id, now, aim = null) {
    this.advance(now);
    const player = this.participant(id);
    if (aim !== null && (!aim || typeof aim.x !== 'number' || typeof aim.y !== 'number'
      || !Number.isFinite(aim.x) || !Number.isFinite(aim.y) || Math.abs(Math.hypot(aim.x, aim.y) - 1) > .00001)) return false;
    return !!player?.alive && !this.finished && player.split(now, this.config, aim || player.lastAim);
  }
  boost(id, active, now) {
    if (typeof active !== 'boolean') return false;
    this.advance(now);
    const p = this.participant(id);
    if (!p?.alive || this.finished) return false;
    p.boostUntil = active ? now + 350 : 0;
    if (!active) p.boosting = false;
    return true;
  }
  eject(p, now) {
    const c = this.config, payer = [...p.cells].sort((a, b) => b.mass - a.mass)[0];
    const cost = Math.max(1, p.score * .004);
    if (!payer || payer.mass - cost < c.initialMass || this.ejected.size >= c.maxEjected) return false;
    const mass = cost * .8, radius = 4 + Math.sqrt(mass) * 3, aim = p.lastAim;
    const point = arenaPoint([payer.x - aim.x * (payer.radius + radius + 3), payer.y - aim.y * (payer.radius + radius + 3)], radius, this.arena);
    payer.setMass(payer.mass - cost);
    const id = ++this.nextEjectedId;
    this.ejected.set(id, { id, owner: p.id, life: p.life, mass, radius, color: p.color, x: point[0], y: point[1],
      vx: -aim.x * 360, vy: -aim.y * 360, bornAt: now, expiresAt: now + c.ejectLifetimeMs });
    return true;
  }
  connect(id) { const p = this.participant(id); if (p?.alive) p.disconnectedAt = null; }
  disconnect(id, now) { const p = this.participant(id); if (p?.alive && p.disconnectedAt === null) { p.disconnectedAt = now; p.boosting = false; p.boostUntil = 0; p.paidBoostUntil = 0; } }
  eliminate(player, reason, now) {
    if (!player.alive) return;
    player.alive = false; player.cells = []; player.protectedUntil = 0;
    player.boosting = false; player.boostUntil = 0; player.target = { x: 0, y: 0 }; player.deathAt = now; player.deathReason = reason;
    this.onEvent({ type: 'eliminated', id: player.id, reason });
  }
  balanceFood() {
    const c = this.config, mass = this.active().reduce((sum, p) => sum + p.score, 0) + [...this.ejected.values()].reduce((sum, f) => sum + f.mass, 0);
    const desired = Math.max(0, Math.min(c.foodCount, Math.floor((c.massBudget - mass) / c.foodMass)));
    while (this.food.size > desired) this.food.delete(this.food.keys().next().value);
    while (this.food.size < desired) {
      const id = ++this.nextFoodId, point = this.randomPoint(c.foodRadius + 8);
      this.food.set(id, { id, x: Math.round(point[0] * 10) / 10, y: Math.round(point[1] * 10) / 10, hue: Math.floor(this.random() * 6) });
    }
  }
  step(dt, now) {
    const players = this.active(), cells = players.flatMap(p => p.cells);
    const radius = Math.max(4, Math.min(...cells.map(c => c.radius)));
    const speed = Math.max(this.config.speed, ...players.flatMap(p => p.cells.map(c => c.speed
      * (1 + (this.config.boostMultiplier - 1) * Math.max(c.thrust || 0, p.boostUntil >= now && Math.hypot(p.target.x, p.target.y) >= .05 ? 1 : 0)))));
    // Small drained parts can cross completely in one60Hz tick when boosted.
    // Bound each move below the smallest radius, while keeping the public
    // simulation/snapshot clock at60Hz and limiting work after a process stall.
    const steps = Math.max(1, Math.min(64, Math.ceil(Math.max(0, dt) * speed / (radius * .75))));
    for (let i = 1; i <= steps; i++) this.substep(dt / steps, now - dt * 1000 + i * dt * 1000 / steps);
  }
  substep(dt, now) {
    const c = this.config;
    for (const p of this.active()) {
      if (p.disconnectedAt !== null && now - p.disconnectedAt >= c.reconnectMs) this.eliminate(p, 'disconnected', now);
      else {
        const requested = now < p.boostUntil && Math.hypot(p.target.x, p.target.y) >= .05;
        if (requested && now >= p.nextEjectAt) {
          p.paidBoostUntil = this.eject(p, now) ? now + c.ejectIntervalMs : 0;
          p.nextEjectAt = now + c.ejectIntervalMs;
        }
        p.boosting = requested && now < p.paidBoostUntil;
        p.move(dt, now, c, this.arena);
      }
    }
    for (const [id, f] of this.ejected) {
      if (now >= f.expiresAt) { this.ejected.delete(id); continue; }
      const decay = Math.exp(-dt * 6), travel = (1 - decay) / 6;
      f.x += f.vx * travel; f.y += f.vy * travel; f.vx *= decay; f.vy *= decay;
      [f.x, f.y] = arenaPoint([f.x, f.y], f.radius, this.arena);
      [f.vx, f.vy] = arenaVelocity([f.x, f.y], f.radius, [f.vx, f.vy], this.arena);
    }
    const cells = this.active().flatMap(player => player.cells.map(cell => ({ player, cell })))
      .sort((a, b) => b.cell.mass - a.cell.mass || a.cell.id - b.cell.id);
    // Food is claimed once. Larger bodies win simultaneous containment ties;
    // touching equal players never awards one of them the other's mass.
    for (const { player, cell } of cells) {
      const radius2 = cell.radius ** 2; let gained = 0;
      for (const [id, food] of this.food) if ((food.x - cell.x) ** 2 + (food.y - cell.y) ** 2 <= radius2) { gained += c.foodMass; this.food.delete(id); }
      for (const [id, f] of this.ejected) {
        if (player.id === f.owner && now - f.bornAt < 800) continue;
        if (Math.hypot(f.x - cell.x, f.y - cell.y) + f.radius <= cell.radius) { gained += f.mass; this.ejected.delete(id); }
      }
      if (gained) cell.addMass(gained);
    }
    for (const player of this.active()) player.constrain(c, this.arena);
    const bodies = cells.map(({ player, cell }) => ({ owner: player.id, cell }));
    separateOpponents(bodies, this.arena);
    const contacts = [];
    cells.sort((a, b) => b.cell.mass - a.cell.mass || a.cell.id - b.cell.id);
    const losses = new Map(), gains = new Map();
    // Select one eater per prey from this tick's unchanged masses. Resolve all
    // transfers together, including chains, so no mass is credited twice/lost.
    for (const prey of cells) {
      let eater = null;
      if (prey.player.protectedUntil <= now) for (const candidate of cells) {
        if (candidate.player === prey.player || candidate.player.protectedUntil > now) continue;
        if (candidate.cell.mass > prey.cell.mass * 1.1 && touching(candidate.cell, prey.cell)) {
          eater = candidate; break; // Stable largest eligible neighbour, independent of overlap depth.
        }
      }
      const cell = prey.cell;
      cell.absorbedBy = eater?.cell.id ?? null;
      if (!eater) { cell.absorption = null; continue; }
      if (cell.absorption?.by !== eater.cell.id) cell.absorption = { by: eater.cell.id, mass: cell.mass };
      cell.absorption.mass = Math.max(cell.absorption.mass, cell.mass);
      let amount = Math.min(cell.mass, cell.absorption.mass * Math.max(0, dt) * 1000 / c.absorptionMs);
      if (dt > 0 && cell.mass - amount <= .01) amount = cell.mass;
      contacts.push({ prey: cell, eater: eater.cell, sum: cell.radius + eater.cell.radius });
      losses.set(cell.id, amount);
      gains.set(eater.cell.id, (gains.get(eater.cell.id) || 0) + amount);
    }
    for (const p of this.active()) {
      for (const cell of p.cells) cell.setMass(Math.max(0, cell.mass - (losses.get(cell.id) || 0) + (gains.get(cell.id) || 0)));
      p.cells = p.cells.filter(cell => cell.mass > 0);
      if (!p.cells.length) this.eliminate(p, 'absorbed', now); else p.constrain(c, this.arena);
    }
    // Follow only the gap created by this tick's shrinking radii. Ordinary
    // movement away was already tested above, so this never attracts an escapee.
    for (const { prey, eater, sum } of contacts) {
      if (!prey.mass || !eater.mass) continue;
      const dx = eater.x - prey.x, dy = eater.y - prey.y, d = Math.hypot(dx, dy);
      const follow = Math.min(Math.max(0, sum - prey.radius - eater.radius), Math.max(0, d - prey.radius - eater.radius));
      if (d && follow) { prey.x += dx / d * follow; prey.y += dy / d * follow; }
    }
    const remaining = this.active().flatMap(p => p.cells.map(cell => ({ owner: p.id, cell })));
    separateOpponents(remaining, this.arena);
    for (const p of this.active()) p.constrain(c, this.arena);
    contactVelocities(remaining, this.arena);
    if (now - this.lastBalance >= 1000) { this.balanceFood(); this.lastBalance = now; }
  }
  advance(now) {
    if (this.finished) return;
    const end = Math.min(now, this.endsAt), stepMs = 1000 / this.config.tickRate;
    if (!this.active().length) this.simulatedAt = end;
    if (end - this.simulatedAt > 250) this.simulatedAt = end - 250;
    while (this.simulatedAt + stepMs <= end + .000001 && !this.finished) {
      this.simulatedAt += stepMs; this.step(stepMs / 1000, this.simulatedAt);
    }
    if (now >= this.endsAt) this.finish(this.endsAt);
  }
  finish(now) {
    if (this.finished) return;
    this.finished = true;
    const ranked = massRanking(this.players.values());
    const best = ranked[0]?.player.score || 0, winners = ranked.filter(r => r.player.alive && best > 0 && r.rank === 1).map(r => r.player.id);
    this.results = { matchId: this.id, mode: this.mode, endedAt: now, winners, rows: ranked.map(({ player: p, rank }) => {
      return { id: p.id, name: p.name, color: p.color, character: p.character, rank, mass: p.score,
        status: winners.includes(p.id) ? 'winner' : p.alive ? 'survived' : 'eliminated', reason: p.deathReason };
    }) };
  }
  snapshot(full = true, baseline = new Map()) {
    const previous = full ? null : baseline.get('food');
    const foods = { reset: !previous, added: [...this.food.values()].filter(f => !previous?.has(f.id)),
      removed: previous ? [...previous].filter(id => !this.food.has(id)) : [] };
    if (!full) baseline.set('food', new Set(this.food.keys()));
    const c = this.config;
    return { id: this.id, mode: this.mode, width: c.width, height: c.height, arena: this.arena,
      simulatedAt: this.simulatedAt, startedAt: this.startedAt, endsAt: this.endsAt, finished: this.finished, results: this.results,
      physics: { speed: c.speed, initialMass: c.initialMass, slowBase: c.slowBase, splitLimit: c.splitLimit, mergeMs: c.mergeMs, foodRadius: c.foodRadius,
        massSpeedExponent: c.massSpeedExponent, minSpeedRatio: c.minSpeedRatio, boostMultiplier: c.boostMultiplier, absorptionMs: c.absorptionMs }, food: foods,
      ejected: [...this.ejected.values()].map(f => ({ id: f.id, point: [f.x, f.y], velocity: [f.vx, f.vy], radius: f.radius, color: f.color })),
      players: [...this.players.values()].map(p => ({ id: p.id, name: p.name, color: p.color, character: p.character, alive: p.alive,
        life: p.life, boosting: p.boosting, point: [...p.point], score: p.score, target: { ...p.target }, mergeAt: p.mergeAt,
        protectedUntil: p.protectedUntil, deathReason: p.deathReason,
        cells: p.cells.map(cell => ({ id: cell.id, point: [cell.x, cell.y], mass: cell.mass, radius: cell.radius, speed: cell.speed,
          absorbedBy: cell.absorbedBy ?? null, thrust: cell.thrust || 0, boostDirection: cell.boostDirection ? [...cell.boostDirection] : null, velocity: [...cell.velocity] })) })) };
  }
}
