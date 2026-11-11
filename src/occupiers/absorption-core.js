/*
 * Absorption physics adapted from owenashurst/agar.io-clone
 * cb8c12173cd6ae07abbc300a8838de0ab1d358ad, src/server/map/player.js.
 * Copyright (c) 2015 Huy Tran. Modifications: Occupiers contributors.
 *
 * The MIT License (MIT)
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

export const ABSORPTION_RULES = Object.freeze({
  initialMass: 10, speed: 240, slowBase: 4.5, splitLimit: 16, mergeMs: 15_000,
  protectionMs: 2000, foodMass: 1, foodCount: 600, foodRadius: 4, massBudget: 4000,
  reconnectMs: 10_000, tickRate: 60, massSpeedExponent: .22, minSpeedRatio: .38,
  boostMultiplier: 1.7, ejectIntervalMs: 200, ejectLifetimeMs: 10_000, maxEjected: 600, absorptionMs: 1200,
});

export const radiusFromMass = mass => 4 + Math.sqrt(mass) * 6;

export function massRanking(players) {
  let anchor = null, rank = 0;
  return [...players].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).map((player, i) => {
    // Anchor each tie group to its leader, avoiding a chain of near-equalities
    // that could otherwise give rank1 to a player outside the winning group.
    if (anchor === null || anchor - player.score >= .0001) { anchor = player.score; rank = i + 1; }
    return { player, rank };
  });
}

// Growth slowdown, split impulse and near-target braking, expressed
// in seconds rather than assuming one particular simulation/render frame rate.
export function arenaPoint(point, radius, arena) {
  const dx = point[0] - arena.center[0], dy = point[1] - arena.center[1], distance = Math.hypot(dx, dy);
  const limit = Math.max(0, arena.radius - radius);
  return distance > limit ? [arena.center[0] + dx / distance * limit, arena.center[1] + dy / distance * limit] : [...point];
}

export function arenaVelocity(point, radius, velocity, arena) {
  const dx = point[0] - arena.center[0], dy = point[1] - arena.center[1], distance = Math.hypot(dx, dy);
  const limit = Math.max(0, arena.radius - radius);
  if (!limit) return [0, 0];
  if (distance < limit - .00001 || !distance) return [...velocity];
  const nx = dx / distance, ny = dy / distance, outward = Math.max(0, velocity[0] * nx + velocity[1] * ny);
  return [velocity[0] - outward * nx, velocity[1] - outward * ny];
}

export function cellVelocity(cell, centre, target, rules, arena = null) {
  const constrain = velocity => arena ? arenaVelocity([cell.x, cell.y], cell.radius, velocity, arena) : velocity;
  if (cell.speed > rules.speed && cell.boostDirection) return constrain(cell.boostDirection.map(v => v * cell.speed));
  const range = Math.max(250, 50 + cell.radius);
  const dx = centre[0] - cell.x + target.x * range;
  const dy = centre[1] - cell.y + target.y * range;
  const distance = Math.hypot(dx, dy);
  if (!distance) return [0, 0];
  const ratio = Math.max(rules.minSpeedRatio, Math.min(1, (rules.initialMass / cell.mass) ** rules.massSpeedExponent));
  const thrust = 1 + (rules.boostMultiplier - 1) * (cell.thrust || 0);
  const speed = cell.speed * ratio * thrust * Math.min(1, distance / (50 + cell.radius));
  return constrain([dx / distance * speed, dy / distance * speed]);
}

export function moveCell(cell, centre, target, dt, rules, arena) {
  cell.thrust = (cell.thrust || 0) + ((cell.boosting ? 1 : 0) - (cell.thrust || 0)) * (1 - Math.exp(-dt * 12));
  const velocity = cellVelocity(cell, centre, target, rules, arena);
  cell.x += velocity[0] * dt; cell.y += velocity[1] * dt;
  cell.speed = Math.max(rules.speed, cell.speed - rules.speed * 4.8 * dt);
  if (cell.speed === rules.speed) cell.boostDirection = null;
  [cell.x, cell.y] = arenaPoint([cell.x, cell.y], cell.radius, arena);
}

export class AbsorptionCell {
  constructor(id, point, mass, speed) {
    this.id = id; this.x = point[0]; this.y = point[1]; this.speed = speed;
    this.absorption = null; this.absorbedBy = null;
    this.setMass(mass); this.velocity = [0, 0];
  }
  setMass(mass) { this.mass = mass; this.radius = radiusFromMass(mass); }
  addMass(mass) { this.setMass(this.mass + mass); }
}

export function separateCells(cells) {
  for (let i = 0; i < cells.length; i++) for (let j = i + 1; j < cells.length; j++) {
    const a = cells[i], b = cells[j], dx = b.x - a.x, dy = b.y - a.y;
    const distance = Math.hypot(dx, dy), sum = a.radius + b.radius;
    if (distance >= sum) continue;
    const ux = distance ? dx / distance : 1, uy = distance ? dy / distance : 0, push = (sum - distance) / 2;
    a.x -= ux * push; a.y -= uy * push; b.x += ux * push; b.y += uy * push;
  }
}

// Concrete Absorption body constraints, shared by the authoritative simulation
// and display prediction. Own pieces keep their separate merge/separation rules.
export function separateOpponents(entries, arena) {
  const travel = (c, nx, ny) => {
    const x = c.x - arena.center[0], y = c.y - arena.center[1], limit = Math.max(0, arena.radius - c.radius);
    const dot = x * nx + y * ny;
    return Math.max(0, -dot + Math.sqrt(Math.max(0, dot * dot + limit * limit - x * x - y * y)));
  };
  for (let pass = 0; pass < 64; pass++) {
    let deepest = 0;
    const ordered = [...entries].sort((a, b) => a.cell.x - a.cell.radius - b.cell.x + b.cell.radius);
    for (let i = 0; i < ordered.length; i++) for (let j = i + 1; j < ordered.length; j++) {
      const a = ordered[i], b = ordered[j];
      if (b.cell.x - b.cell.radius >= a.cell.x + a.cell.radius) break;
      if (a.owner === b.owner) continue;
      const x = b.cell.x - a.cell.x, y = b.cell.y - a.cell.y, sum = a.cell.radius + b.cell.radius;
      if (Math.abs(x) >= sum || Math.abs(y) >= sum) continue;
      const distance = Math.hypot(x, y), overlap = sum - distance;
      if (overlap <= .00001) continue;
      deepest = Math.max(deepest, overlap);
      let nx = distance ? x / distance : 1, ny = distance ? y / distance : 0;
      let ca = travel(a.cell, -nx, -ny), cb = travel(b.cell, nx, ny);
      if (!distance && ca + cb < overlap) {
        const rx = a.cell.x - arena.center[0], ry = a.cell.y - arena.center[1], radial = Math.hypot(rx, ry);
        nx = radial ? rx / radial : 1; ny = radial ? ry / radial : 0;
        ca = travel(a.cell, -nx, -ny); cb = travel(b.cell, nx, ny);
      }
      let da = Math.min(ca, overlap * b.cell.mass / (a.cell.mass + b.cell.mass));
      let db = Math.min(cb, overlap - da);
      da = Math.min(ca, overlap - db); // A wall transfers the remaining correction to the other body.
      a.cell.x -= nx * da; a.cell.y -= ny * da; b.cell.x += nx * db; b.cell.y += ny * db;
    }
    if (deepest <= .00001) break;
  }
}

export function touching(a, b) {
  const sum = a.radius + b.radius + .0001, x = a.x - b.x, y = a.y - b.y;
  return Math.abs(x) <= sum && Math.abs(y) <= sum && x * x + y * y <= sum * sum;
}

// Remove only closing relative velocity. Tangential travel and escape remain
// available, including a smaller body being pushed against the circular wall.
export function contactVelocities(entries, arena) {
  // Positions and masses do not change during this solve. Build only actual
  // neighbours once instead of testing every pair on all four velocity passes.
  const ordered = [...entries].sort((a, b) => a.cell.x - a.cell.radius - b.cell.x + b.cell.radius), pairs = [], walls = [];
  for (let i = 0; i < ordered.length; i++) {
    const a = ordered[i], cell = a.cell;
    const wx = cell.x - arena.center[0], wy = cell.y - arena.center[1], limit = Math.max(0, arena.radius - cell.radius);
    if (wx * wx + wy * wy >= (Math.max(0, limit - .00001)) ** 2) walls.push(cell);
    for (let j = i + 1; j < ordered.length; j++) {
      const b = ordered[j];
      if (b.cell.x - b.cell.radius > cell.x + cell.radius + .0001) break;
      if (a.owner === b.owner || !touching(cell, b.cell)) continue;
      const dx = b.cell.x - cell.x, dy = b.cell.y - cell.y, d = Math.hypot(dx, dy);
      pairs.push({ a: cell, b: b.cell, nx: d ? dx / d : 1, ny: d ? dy / d : 0,
        wa: b.cell.mass / (cell.mass + b.cell.mass) });
    }
  }
  for (let pass = 0; pass < (pairs.length ? 4 : 1); pass++) {
    for (const { a, b, nx, ny, wa } of pairs) {
      const closing = (a.velocity[0] - b.velocity[0]) * nx + (a.velocity[1] - b.velocity[1]) * ny;
      if (closing <= 0) continue;
      a.velocity[0] -= closing * wa * nx; a.velocity[1] -= closing * wa * ny;
      b.velocity[0] += closing * (1 - wa) * nx; b.velocity[1] += closing * (1 - wa) * ny;
    }
    for (const cell of walls) cell.velocity = arenaVelocity([cell.x, cell.y], cell.radius, cell.velocity, arena);
  }
}

export class AbsorptionPlayer {
  constructor(member, nextId) {
    Object.assign(this, { id: member.id, name: member.name, color: member.color,
      character: member.character || 'car', cells: [], life: 0, nextId,
      alive: false, point: [0, 0], disconnectedAt: null });
  }
  get score() { return this.cells.reduce((sum, cell) => sum + cell.mass, 0); }
  init(point, now, rules) {
    this.cells = [new AbsorptionCell(this.nextId(), point, rules.initialMass, rules.speed)];
    this.point = [...point]; this.target = { x: 0, y: 0 }; this.life++;
    this.lastAim = { x: 1, y: 0 };
    this.alive = true; this.deathReason = null; this.deathAt = null;
    this.disconnectedAt = null; this.protectedUntil = now + rules.protectionMs;
    this.mergeAt = 0; this.boosting = false; this.boostUntil = 0; this.nextEjectAt = 0; this.paidBoostUntil = 0;
  }
  centre() {
    const mass = this.score;
    if (mass) this.point = [0, 1].map(k => this.cells.reduce((sum, c) => sum + (k ? c.y : c.x) * c.mass, 0) / mass);
    return this.point;
  }
  constrain(rules, arena) {
    for (const c of this.cells) [c.x, c.y] = arenaPoint([c.x, c.y], c.radius, arena);
    this.centre();
    // Publish the allowed velocity at the final constrained position, including
    // growth/merge/separation, rather than an impulse that the wall blocked.
    for (const c of this.cells) c.velocity = cellVelocity(c, this.point, this.target, rules, arena);
  }
  split(now, rules, aim = this.lastAim) {
    let created = 0;
    // Freeze the original list. Newly created parts cannot split again during
    // the same command, and no command can exceed the actual remaining capacity.
    for (const cell of [...this.cells].sort((a, b) => b.mass - a.mass)) {
      if (this.cells.length >= rules.splitLimit) break;
      if (cell.mass < rules.initialMass * 2) continue;
      const mass = cell.mass / 2;
      cell.setMass(mass);
      cell.absorption = null; cell.absorbedBy = null;
      const child = new AbsorptionCell(this.nextId(), [cell.x, cell.y], mass, rules.speed * 3.2);
      child.boostDirection = [aim.x, aim.y];
      this.cells.push(child);
      created++;
    }
    if (created) { this.mergeAt = now + rules.mergeMs; }
    return created > 0;
  }
  move(dt, now, rules, arena) {
    for (const cell of this.cells) {
      cell.boosting = this.boosting;
      moveCell(cell, this.point, this.target, dt, rules, arena);
    }
    if (now < this.mergeAt) separateCells(this.cells);
    else for (let i = 0; i < this.cells.length; i++) for (let j = i + 1; j < this.cells.length; j++) {
      const a = this.cells[i], b = this.cells[j];
      if (!a || !b) continue;
      const dx = b.x - a.x, dy = b.y - a.y, distance = Math.hypot(dx, dy), sum = a.radius + b.radius;
      if (distance > sum) continue;
      const mass = a.mass + b.mass;
      a.x = (a.x * a.mass + b.x * b.mass) / mass;
      a.y = (a.y * a.mass + b.y * b.mass) / mass;
      a.addMass(b.mass); this.cells[j] = null;
    }
    this.cells = this.cells.filter(Boolean);
    for (const cell of this.cells) {
      // A partly consumed cell may be smaller than the spawn mass. Decay must
      // never restore mass that an opponent already removed.
      if (this.score > 50) cell.setMass(Math.max(Math.min(cell.mass, rules.initialMass), cell.mass * (1 - .001 * dt)));
    }
    this.constrain(rules, arena);
    this.protectedUntil = this.protectedUntil > now ? this.protectedUntil : 0;
  }
}
