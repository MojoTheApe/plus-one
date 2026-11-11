import { randomUUID } from 'node:crypto';
import { hasCharacter } from './characters.js';
import { EPS, distance, area, contains, circle, difference, capture,
  boundaryCuts, interpolate, appendTrail, pointSegmentDistance, segmentDistance,
  segmentIntersection } from './geometry.js';

export const TERRITORY_DEFAULTS = Object.freeze({
  width: 2400, height: 2400, maxPlayers: 12, durationMs: 300_000,
  spawnRadius: 62, spawnGap: 24, spawnDistance: 200, protectionMs: 3000,
  reconnectMs: 10_000, speed: 155, turnSpeed: 5.2, headRadius: 6, trailRadius: 3, tickRate: 30,
});

export function territoryConfig(options = {}) {
  const config = { ...TERRITORY_DEFAULTS, ...options };
  for (const [key, value] of Object.entries(config)) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new Error('Invalid game setting: ' + key);
  }
  if (!Number.isInteger(config.maxPlayers) || config.maxPlayers < 2 || config.maxPlayers > 12
    || config.width < config.spawnRadius * 6 || config.height < config.spawnRadius * 6
    || config.tickRate < 10 || config.tickRate > 60) throw new Error('Invalid territory limits');
  return config;
}

const normalize = angle => Math.atan2(Math.sin(angle), Math.cos(angle));
const nearSegment = (a, b, c, d, radius) => Math.min(a[0], b[0]) - radius <= Math.max(c[0], d[0])
  && Math.max(a[0], b[0]) + radius >= Math.min(c[0], d[0])
  && Math.min(a[1], b[1]) - radius <= Math.max(c[1], d[1])
  && Math.max(a[1], b[1]) + radius >= Math.min(c[1], d[1]);

// Everything specific to Territories lives here, including late-entry eligibility,
// elimination, reconnect consequences, the clock, final ranking and victory.
// The Telegram room/lobby does not impose these rules on a future game mode.
export class TerritoriesMatch {
  static minimumPlayers = 1;
  static respawns = false;
  constructor(members, { now = Date.now(), config = {}, random = Math.random, onEvent = () => {}, practice = false } = {}) {
    this.config = territoryConfig(config);
    this.practice = practice === true;
    this.capacity = this.practice ? 1 : this.config.maxPlayers;
    if (members.length < (this.practice ? 1 : TerritoriesMatch.minimumPlayers) || members.length > this.capacity) throw new Error('players_required');
    this.id = randomUUID();
    this.mode = 'territories';
    this.players = new Map();
    this.random = random;
    this.onEvent = onEvent;
    this.arena = { shape: 'circle', center: [this.config.width / 2, this.config.height / 2], radius: Math.min(this.config.width, this.config.height) / 2, segments: 256 };
    this.world = circle(this.arena.center, this.arena.radius, this.arena.segments);
    this.arenaArea = area(this.world);
    this.startedAt = this.simulatedAt = now;
    this.endsAt = now + this.config.durationMs;
    this.finished = false;
    this.results = null;
    for (const member of members) if (!this.spawn(member, now)) throw new Error('no_spawn');
  }

  active() { return [...this.players.values()].filter(player => player.alive); }
  participant(id) { return this.players.get(id); }

  safeSpawn() {
    const c = this.config, margin = c.spawnRadius + c.spawnGap;
    const safe = point => {
      if (distance(point, this.arena.center) + margin > this.arena.radius * Math.cos(Math.PI / this.arena.segments)) return false;
      for (const player of this.active()) {
        if (distance(point, player.point) < c.spawnDistance + c.spawnRadius + c.headRadius
          || contains(point, player.land)) return false;
        for (const polygon of player.land) for (const ring of polygon) {
          for (let i = 0; i < ring.length - 1; i++) {
            if (pointSegmentDistance(point, ring[i], ring[i + 1]) <= margin) return false;
          }
        }
        for (let i = 0; i < player.trail.length - 1; i++) {
          if (pointSegmentDistance(point, player.trail[i], player.trail[i + 1]) <= margin + c.trailRadius) return false;
        }
      }
      return true;
    };
    for (let i = 0; i < 256; i++) {
      const p = [margin + this.random() * (c.width - margin * 2), margin + this.random() * (c.height - margin * 2)];
      if (safe(p)) return p;
    }
    // A deterministic second search is conservative: never fall back to overlap.
    let checked = 0;
    for (let x = margin; x <= c.width - margin; x += c.spawnRadius) {
      for (let y = margin; y <= c.height - margin; y += c.spawnRadius) {
        if (++checked > 4096) return null;
        if (safe([x, y])) return [x, y];
      }
    }
    return null;
  }

  spawn(member, now) {
    if (this.players.has(member.id) || this.active().length >= this.capacity) return null;
    const point = this.safeSpawn();
    if (!point) return null;
    const angle = Math.atan2(this.config.height / 2 - point[1], this.config.width / 2 - point[0]);
    const land = circle(point, this.config.spawnRadius);
    const player = { id: member.id, name: member.name, color: member.color, character: hasCharacter(member.character) ? member.character : 'car', point, angle, targetAngle: angle,
      alive: true, land, score: area(land), landRevision: 1, trail: [], trailId: 0,
      protectedUntil: now + this.config.protectionMs, disconnectedAt: null, deathAt: null, deathReason: null };
    this.players.set(member.id, player);
    this.competitive ||= this.players.size > 1;
    return player;
  }

  join(member, now) {
    this.advance(now);
    if (this.finished) return { ok: false, reason: 'match_ended' };
    const previous = this.players.get(member.id);
    if (previous) return { ok: previous.alive, reason: previous.alive ? 'already_playing' : 'eliminated' };
    if (this.active().length >= this.capacity) return { ok: false, reason: 'full' };
    if (!this.spawn(member, now)) return { ok: false, reason: 'no_spawn' };
    this.onEvent({ type: 'joined', id: member.id, name: member.name });
    return { ok: true };
  }

  input(id, angle) {
    if (typeof angle !== 'number' || !Number.isFinite(angle) || Math.abs(angle) > Math.PI) return false;
    const player = this.players.get(id);
    if (!player?.alive || this.finished) return false;
    player.targetAngle = angle;
    return true;
  }

  connect(id) { const p = this.players.get(id); if (p?.alive) p.disconnectedAt = null; }
  disconnect(id, now) { const p = this.players.get(id); if (p?.alive && p.disconnectedAt === null) p.disconnectedAt = now; }

  eliminate(player, reason, now) {
    if (!player.alive) return;
    player.alive = false;
    player.deathAt = now;
    player.deathReason = reason;
    player.eliminationScore = player.score;
    player.land = [];
    player.landRevision++;
    player.trail = [];
    player.trailId++;
    player.protectedUntil = 0;
    this.onEvent({ type: 'eliminated', id: player.id, reason });
  }

  step(dt, now) {
    const c = this.config, players = this.active(), deaths = new Map();
    const mark = (player, reason) => { if (!deaths.has(player.id)) deaths.set(player.id, reason); };
    const previous = new Map();
    for (const p of players) {
      previous.set(p.id, p.point);
      const turn = Math.max(-c.turnSpeed * dt, Math.min(c.turnSpeed * dt, normalize(p.targetAngle - p.angle)));
      p.angle = normalize(p.angle + turn);
      p.point = [p.point[0] + Math.cos(p.angle) * c.speed * dt, p.point[1] + Math.sin(p.angle) * c.speed * dt];
      if (now >= p.protectedUntil) p.protectedUntil = 0;
      if (p.protectedUntil) {
        const cuts = boundaryCuts(previous.get(p.id), p.point, p.land);
        if (cuts.slice(1).some((t, i) => !contains(interpolate(previous.get(p.id), p.point, (cuts[i] + t) / 2), p.land))) {
          p.protectedUntil = 0;
        }
      }
      if (!contains(p.point, this.world)) mark(p, 'boundary');
      if (p.disconnectedAt !== null && now - p.disconnectedAt >= c.reconnectMs) mark(p, 'disconnected');
    }
    // Resolve ALL contacts from the same pre-capture trails. A player can cut a
    // trail in the tick in which they also die; iteration order changes no winner.
    for (let i = 0; i < players.length; i++) for (let j = i + 1; j < players.length; j++) {
      const a = players[i], b = players[j];
      if (a.protectedUntil || b.protectedUntil) continue;
      const from = [previous.get(a.id)[0] - previous.get(b.id)[0], previous.get(a.id)[1] - previous.get(b.id)[1]];
      const to = [a.point[0] - b.point[0], a.point[1] - b.point[1]];
      if (pointSegmentDistance([0, 0], from, to) <= c.headRadius * 2) { mark(a, 'head'); mark(b, 'head'); }
    }
    for (const attacker of players) {
      if (attacker.protectedUntil) continue;
      const from = previous.get(attacker.id), to = attacker.point;
      for (const victim of players) {
        if (victim.protectedUntil || victim.trail.length < 2) continue;
        let tailDistance = 0;
        for (let i = victim.trail.length - 2; i >= 0; i--) {
          const a = victim.trail[i];
          let b = victim.trail[i + 1];
          const length = distance(a, b), previousTail = tailDistance;
          tailDistance += length;
          const own = victim.id === attacker.id;
          const ignore = c.headRadius * 2 + c.trailRadius * 2 + c.speed * dt;
          if (own && tailDistance <= ignore) continue;
          if (own && previousTail < ignore) b = interpolate(a, b, (tailDistance - ignore) / length);
          if (!nearSegment(from, to, a, b, c.headRadius + c.trailRadius)) continue;
          if (own) {
            // Contact with the attachment point while re-entering one's land is
            // closure, not a crossing of an open trail in the arena.
            const hit = segmentIntersection(from, to, a, b);
            if (i === 0 && contains(to, victim.land)
              && pointSegmentDistance(victim.trail[0], from, to) < c.headRadius) continue;
            if (hit || segmentDistance(from, to, a, b) < EPS) mark(victim, 'self_trail');
          } else if (segmentDistance(from, to, a, b) <= c.headRadius + c.trailRadius) mark(victim, 'trail_cut');
        }
      }
    }
    for (const [id, reason] of deaths) this.eliminate(this.players.get(id), reason, now);
    for (const player of this.active()) {
      if (player.alive) this.traceMovement(player, previous.get(player.id), player.point, now);
    }
  }

  closeTrail(player, point, now) {
    appendTrail(player.trail, point);
    const protectedLand = this.active().filter(p => p.id !== player.id && p.protectedUntil > now).map(p => p.land);
    try {
      const land = capture(player.land, player.trail, this.world, protectedLand);
      const gained = difference(land, player.land);
      // Calculate every subtraction before committing ANY geometry. Clipping
      // failure preserves all owners rather than partially awarding the region.
      const changes = this.active().filter(p => p.id !== player.id && !p.protectedUntil)
        .map(p => [p, difference(p.land, gained)]);
      player.land = land;
      player.score = area(land);
      player.landRevision++;
      for (const [victim, remaining] of changes) {
        victim.land = remaining;
        victim.score = area(remaining);
        victim.landRevision++;
        if (victim.score < EPS) this.eliminate(victim, 'no_land', now);
      }
    } catch {
      this.onEvent({ type: 'capture_failed', id: player.id });
    }
    player.trail = [];
    player.trailId++;
  }

  traceMovement(player, from, to, now) {
    const cuts = boundaryCuts(from, to, player.land);
    for (let i = 0; i < cuts.length - 1; i++) {
      const start = interpolate(from, to, cuts[i]), end = interpolate(from, to, cuts[i + 1]);
      const inside = contains(interpolate(start, end, 0.5), player.land);
      if (inside) {
        if (player.trail.length) this.closeTrail(player, start, now);
      } else {
        if (!player.trail.length) { player.trailId++; appendTrail(player.trail, start); }
        appendTrail(player.trail, end);
      }
    }
    if (player.trail.length && contains(to, player.land)) this.closeTrail(player, to, now);
  }

  advance(now) {
    if (this.finished) return;
    const end = Math.min(now, this.endsAt), stepMs = 1000 / this.config.tickRate;
    // Bounded catch-up avoids a CPU spiral after a stalled process. Match clock
    // and disconnect expiry still use elapsed server time, never client time.
    if (end - this.simulatedAt > 250) this.simulatedAt = end - 250;
    while (this.simulatedAt + stepMs <= end + EPS && !this.finished) {
      this.simulatedAt += stepMs;
      this.step(stepMs / 1000, this.simulatedAt);
      const living = this.active().length;
      if (!living || (this.competitive && living === 1)) this.finish(this.simulatedAt);
    }
    if (!this.finished && now >= this.endsAt) this.finish(this.endsAt);
  }

  finish(now) {
    if (this.finished) return;
    this.finished = true;
    this.finishedAt = now;
    const ranked = [...this.players.values()].sort((a, b) => Number(b.alive) - Number(a.alive)
      || (a.alive ? b.score - a.score : b.deathAt - a.deathAt) || a.id.localeCompare(b.id));
    const living = ranked.filter(p => p.alive);
    const best = living[0]?.score;
    const winners = living.filter(p => Math.abs(p.score - best) <= 0.0001).map(p => p.id);
    let lastRank = 0;
    this.results = { matchId: this.id, winners, endedAt: now, rows: ranked.map((p, i) => {
      if (!i || !p.alive || !ranked[i - 1].alive || Math.abs(p.score - ranked[i - 1].score) > 0.0001) lastRank = i + 1;
      return { id: p.id, name: p.name, color: p.color, character: p.character, rank: lastRank,
        percent: (p.alive ? p.score : p.eliminationScore) / this.arenaArea * 100,
        status: winners.includes(p.id) ? 'winner' : p.alive ? 'survived' : 'eliminated', reason: p.deathReason };
    }) };
  }

  snapshot(full = true, baseline = new Map()) {
    return { id: this.id, mode: this.mode, arena: this.arena, arenaArea: this.arenaArea, width: this.config.width, height: this.config.height,
      speed: this.config.speed, turnSpeed: this.config.turnSpeed, headRadius: this.config.headRadius, trailRadius: this.config.trailRadius,
      simulatedAt: this.simulatedAt, startedAt: this.startedAt, endsAt: this.endsAt, finished: this.finished, results: this.results,
      players: [...this.players.values()].map(p => {
        const last = full ? null : baseline.get(p.id);
        const from = !last || last.trailId !== p.trailId ? 0 : Math.max(0, Math.min(p.trail.length, last.length - 1));
        const data = { id: p.id, name: p.name, color: p.color, character: p.character, point: p.point, angle: p.angle, targetAngle: p.targetAngle, alive: p.alive,
          score: p.score, protectedUntil: p.protectedUntil, deathReason: p.deathReason,
          trail: { id: p.trailId, from, points: p.trail.slice(from) } };
        if (!last || last.landRevision !== p.landRevision) data.land = p.land;
        if (!full) baseline.set(p.id, { landRevision: p.landRevision, trailId: p.trailId, length: p.trail.length });
        return data;
      }) };
  }
}
