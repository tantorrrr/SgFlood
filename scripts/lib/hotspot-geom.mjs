import { distanceM, pointToPathM } from '../../public/js/geo.js';

const NEAR_MAX_M = 2000;
const CLOSE_PAIR_M = 30;
const CHAIN_SNAP_M = 60;
const SPAN_TOL_M = 15;
const RAD = Math.PI / 180;

export function normalizeName(name) {
  return name
    .toLowerCase()
    .replace(/đ/g, 'd')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/^duong\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function closestTo(points, near) {
  let best = null;
  for (const p of points) {
    const d = distanceM(p, near);
    if (d <= NEAR_MAX_M && (!best || d < best.d)) best = { p, d };
  }
  return best?.p ?? null;
}

function sharedNodes(waysA, waysB) {
  const coordOf = new Map();
  for (const w of waysA) w.nodes.forEach((id, i) => coordOf.set(id, w.coords[i]));
  return waysB.flatMap((w) => w.nodes.filter((id) => coordOf.has(id)).map((id) => coordOf.get(id)));
}

function closePairs(waysA, waysB) {
  const out = [];
  for (const a of waysA) {
    for (const b of waysB) {
      let best = { d: Infinity };
      for (const p of a.coords) for (const q of b.coords) {
        const d = distanceM(p, q);
        if (d < best.d) best = { d, p, q };
      }
      if (best.d < CLOSE_PAIR_M) out.push([(best.p[0] + best.q[0]) / 2, (best.p[1] + best.q[1]) / 2]);
    }
  }
  return out;
}

export function findIntersection(waysA, waysB, near) {
  return closestTo(sharedNodes(waysA, waysB), near) ?? closestTo(closePairs(waysA, waysB), near);
}

function heading(a, b) {
  const dx = (b[1] - a[1]) * Math.cos(a[0] * RAD);
  const dy = b[0] - a[0];
  const len = Math.hypot(dx, dy) || 1;
  return [dx / len, dy / len];
}

function oriented(way, startNode) {
  return way.nodes[0] === startNode ? way : { nodes: [...way.nodes].reverse(), coords: [...way.coords].reverse() };
}

function extendTail(chain, unused) {
  for (;;) {
    const tail = chain.nodes.at(-1);
    const dir = heading(chain.coords.at(-2), chain.coords.at(-1));
    let best = null;
    for (const w of unused) {
      if (w.nodes[0] !== tail && w.nodes.at(-1) !== tail) continue;
      const next = oriented(w, tail);
      const [hx, hy] = heading(next.coords[0], next.coords[1]);
      const score = dir[0] * hx + dir[1] * hy;
      if (!best || score > best.score) best = { w, next, score };
    }
    if (!best) return chain;
    unused.delete(best.w);
    chain = { nodes: [...chain.nodes, ...best.next.nodes.slice(1)], coords: [...chain.coords, ...best.next.coords.slice(1)] };
  }
}

const reversed = (c) => ({ nodes: [...c.nodes].reverse(), coords: [...c.coords].reverse() });

export function buildChains(ways) {
  const unused = new Set(ways.filter((w) => w.coords.length > 1));
  const chains = [];
  for (const first of unused) {
    unused.delete(first);
    chains.push(reversed(extendTail(reversed(extendTail(first, unused)), unused)));
  }
  return chains;
}

export function projectOnPath([lat, lng], coords) {
  const kx = Math.cos(lat * RAD);
  const xy = ([a, b]) => [(b - lng) * kx, a - lat];
  let best = { offset: Infinity, along: 0 };
  let acc = 0;
  for (let i = 1; i < coords.length; i++) {
    const [x0, y0] = xy(coords[i - 1]);
    const [x1, y1] = xy(coords[i]);
    const [dx, dy] = [x1 - x0, y1 - y0];
    const len2 = dx * dx + dy * dy;
    const f = len2 ? Math.max(0, Math.min(1, -(x0 * dx + y0 * dy) / len2)) : 0;
    const seg = distanceM(coords[i - 1], coords[i]);
    const foot = [coords[i - 1][0] + (coords[i][0] - coords[i - 1][0]) * f, coords[i - 1][1] + (coords[i][1] - coords[i - 1][1]) * f];
    const offset = distanceM([lat, lng], foot);
    if (offset < best.offset) best = { offset, along: acc + f * seg };
    acc += seg;
  }
  return best;
}

export function slicePath(coords, from, to) {
  const out = [];
  let acc = 0;
  for (let i = 1; i < coords.length; i++) {
    const [a, b] = [coords[i - 1], coords[i]];
    const d = distanceM(a, b);
    const at = (s) => {
      const f = d ? (s - acc) / d : 0;
      return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
    };
    if (acc + d >= from && acc <= to) {
      if (!out.length) out.push(at(Math.max(from, acc)));
      out.push(at(Math.min(to, acc + d)));
    }
    acc += d;
  }
  return out;
}

export function selectBetween(chains, from, to) {
  const spans = [];
  for (const c of chains) {
    const [pf, pt] = [projectOnPath(from, c.coords), projectOnPath(to, c.coords)];
    if (pf.offset > CHAIN_SNAP_M || pt.offset > CHAIN_SNAP_M || pf.along === pt.along) continue;
    spans.push(slicePath(c.coords, Math.min(pf.along, pt.along), Math.max(pf.along, pt.along)));
  }
  return spans;
}

function intersectionOf(a, b, waysOf, near) {
  if (!near) throw new Error(`missing "near" for ${a} × ${b}`);
  const p = findIntersection(waysOf(a), waysOf(b), near);
  if (!p) throw new Error(`no intersection ${a} × ${b} within ${NEAR_MAX_M} m of near`);
  return p;
}

function resolveEnd(end, g, waysOf) {
  return typeof end === 'string' ? intersectionOf(g.street, end, waysOf, g.near) : end.point;
}

const withinRadius = (center, radiusM) => (mid) => distanceM(mid, center) <= radiusM;

const RESOLVERS = {
  between(g, waysOf) {
    const spans = selectBetween(buildChains(waysOf(g.street)), resolveEnd(g.from, g, waysOf), resolveEnd(g.to, g, waysOf));
    if (!spans.length) throw new Error(`endpoints do not both snap onto ${g.street}`);
    return { streets: [g.street], contains: (mid) => spans.some((s) => pointToPathM(mid, s) <= SPAN_TOL_M) };
  },
  junction(g, waysOf) {
    const [a, b] = g.streets;
    const center = intersectionOf(a, b, waysOf, g.near);
    const crossName = normalizeName(b);
    // Optional crossRadiusM (press junctions): the cross street only near the intersection, the first street to radiusM.
    const radius = (name) => (g.crossRadiusM != null && name === crossName && crossName !== normalizeName(a) ? g.crossRadiusM : g.radiusM);
    return { streets: g.streets, contains: (mid, name) => distanceM(mid, center) <= radius(name) };
  },
  near(g) {
    return { streets: [g.street], contains: withinRadius(g.point, g.radiusM) };
  },
};

export function geometryStreets(g) {
  if (g.type === 'junction') return g.streets;
  if (g.type === 'between') return [g.street, ...[g.from, g.to].filter((e) => typeof e === 'string')];
  return [g.street];
}

export function resolveGeometry(g, waysOf) {
  const resolve = RESOLVERS[g.type];
  if (!resolve) throw new Error(`unknown geometry type "${g.type}"`);
  const missing = geometryStreets(g).filter((n) => !waysOf(n).length);
  if (missing.length) throw new Error(`no OSM ways named ${missing.join(', ')}`);
  const { streets, contains } = resolve(g, waysOf);
  return { names: new Set(streets.map(normalizeName)), contains };
}
