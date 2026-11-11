import clipping from 'polygon-clipping';

export const EPS = 1e-7;
export const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const cross = (a, b) => a[0] * b[1] - a[1] * b[0];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
export const interpolate = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

export function ringArea(ring) {
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i++) sum += cross(ring[i], ring[i + 1]);
  return Math.abs(sum) / 2;
}

export function area(land) {
  return land.reduce((sum, polygon) => sum + ringArea(polygon[0])
    - polygon.slice(1).reduce((holes, ring) => holes + ringArea(ring), 0), 0);
}

export function pointSegmentDistance(p, a, b) {
  const lengthSquared = (b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2;
  if (lengthSquared < EPS * EPS) return distance(p, a);
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * (b[0] - a[0])
    + (p[1] - a[1]) * (b[1] - a[1])) / lengthSquared));
  return distance(p, interpolate(a, b, t));
}

export function segmentIntersection(a, b, c, d) {
  const r = sub(b, a), s = sub(d, c), delta = sub(c, a), denominator = cross(r, s);
  if (Math.abs(denominator) < EPS) return null;
  const t = cross(delta, s) / denominator, u = cross(delta, r) / denominator;
  return t >= -EPS && t <= 1 + EPS && u >= -EPS && u <= 1 + EPS
    ? { point: interpolate(a, b, Math.max(0, Math.min(1, t))), t, u } : null;
}

export function segmentDistance(a, b, c, d) {
  if (segmentIntersection(a, b, c, d)) return 0;
  return Math.min(pointSegmentDistance(a, c, d), pointSegmentDistance(b, c, d),
    pointSegmentDistance(c, a, b), pointSegmentDistance(d, a, b));
}

function inRing(p, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a[1] > p[1]) !== (b[1] > p[1])
      && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

export function locateBoundary(p, land, tolerance = 0.0001) {
  let nearest = null, best = tolerance;
  land.forEach((polygon, polygonIndex) => polygon.forEach((ring, ringIndex) => {
    for (let edge = 0; edge < ring.length - 1; edge++) {
      const d = pointSegmentDistance(p, ring[edge], ring[edge + 1]);
      if (d <= best) { best = d; nearest = { polygonIndex, ringIndex, edge }; }
    }
  }));
  return nearest;
}

export function contains(p, land) {
  // Boundaries belong to the territory. This closes a returning trail exactly
  // at the edge rather than waiting for a numerical step into the interior.
  if (locateBoundary(p, land, EPS)) return true;
  return land.some(polygon => inRing(p, polygon[0]) && !polygon.slice(1).some(ring => inRing(p, ring)));
}

export function boundaryCuts(a, b, land) {
  const hits = [0, 1];
  for (const polygon of land) for (const ring of polygon) {
    for (let i = 0; i < ring.length - 1; i++) {
      const hit = segmentIntersection(a, b, ring[i], ring[i + 1]);
      if (hit && hit.t > EPS && hit.t < 1 - EPS) hits.push(hit.t);
    }
  }
  return hits.sort((x, y) => x - y).filter((value, i, values) => !i || value - values[i - 1] > EPS);
}

export function circle(center, radius, segments = 32) {
  const ring = Array.from({ length: segments }, (_, i) => {
    const a = i * Math.PI * 2 / segments;
    return [center[0] + Math.cos(a) * radius, center[1] + Math.sin(a) * radius];
  });
  ring.push([...ring[0]]);
  return [[ring]];
}

export const rectangle = (width, height) => [[[[0, 0], [width, 0], [width, height], [0, height], [0, 0]]]];
export const union = (...lands) => clipping.union(...lands);
export const intersection = (...lands) => clipping.intersection(...lands);
export const difference = (land, ...others) => others.length ? clipping.difference(land, ...others) : land;

function boundaryArc(ring, from, to, startPoint, endPoint) {
  const count = ring.length - 1;
  if (from === to) {
    const a = ring[from], b = ring[from + 1];
    const length = distance(a, b);
    // A same-edge arc can be either the short edge section or a complete lap.
    // Compare positions along its direction, not the trail's winding.
    const startT = length ? distance(a, startPoint) / length : 0;
    const endT = length ? distance(a, endPoint) / length : 0;
    if (startT <= endT) return [];
  }
  const points = [];
  let edge = (from + 1) % count;
  for (let steps = 0; steps < count; steps++) {
    points.push(ring[edge]);
    if (edge === to) break;
    edge = (edge + 1) % count;
  }
  return points;
}

export function capture(land, trail, world, protectedLand = []) {
  if (trail.length < 3) return land;
  const exit = trail[0], entry = trail.at(-1);
  const a = locateBoundary(exit, land), b = locateBoundary(entry, land);
  // Connecting disconnected islands does not enclose a face. Nor does a trail
  // whose original attachment has already been taken by an opponent.
  if (!a || !b || a.polygonIndex !== b.polygonIndex || a.ringIndex !== b.ringIndex) return land;
  const ring = land[a.polygonIndex][a.ringIndex];
  const forward = boundaryArc(ring, b.edge, a.edge, entry, exit);
  const backward = boundaryArc(ring, a.edge, b.edge, exit, entry).reverse();
  const candidates = [forward, backward].map(arc => {
    const loop = [...trail, ...arc, exit];
    if (ringArea(loop) < EPS) return land;
    let candidate = intersection(union(land, [[loop]]), world);
    if (protectedLand.length) candidate = union(land, difference(candidate, ...protectedLand));
    return candidate;
  });
  // Union ALWAYS retains the old land. The smaller added face avoids accidentally
  // filling the large side of an excursion into a hole in one's own territory.
  return candidates.sort((x, y) => area(x) - area(y))[0];
}

export function appendTrail(trail, point) {
  if (trail.length && distance(trail.at(-1), point) < EPS) return;
  if (trail.length >= 2) {
    const a = trail.at(-2), b = trail.at(-1);
    if (pointSegmentDistance(b, a, point) < 0.015
      && (b[0] - a[0]) * (point[0] - b[0]) + (b[1] - a[1]) * (point[1] - b[1]) >= 0) trail.pop();
  }
  trail.push([...point]);
}
