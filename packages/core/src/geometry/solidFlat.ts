/**
 * The straight-sided solids: box, rounded box, quad, triangular prism, a polygon extruded, and a
 * profile swept along a path.
 *
 * Conventions, shared with `solidRound.ts`: centred on the origin unless stated, full extents rather
 * than half, parametric texture coordinates (0..1 across each face), counter-clockwise outward
 * faces. A polygon handed in may be wound either way — it is oriented here — and may be concave, so
 * caps are ear-clipped rather than fanned.
 */
import { mergeSolids, transformSolid } from './solid.ts';
import type { Solid } from './solid.ts';
import { SolidWriter } from './solidWriter.ts';
import type { Vec3 } from '../math/color.ts';

/**
 * The six faces of an axis-aligned box as (normal, u axis, v axis), with u × v = normal so the
 * corners (−,−) (+,−) (+,+) (−,+) run counter-clockwise seen from outside. The u and v axes also
 * orient each face's texture: v is up on the four sides.
 */
const FACES: readonly (readonly [Vec3, Vec3, Vec3])[] = [
  [
    [1, 0, 0],
    [0, 0, -1],
    [0, 1, 0],
  ],
  [
    [-1, 0, 0],
    [0, 0, 1],
    [0, 1, 0],
  ],
  [
    [0, 1, 0],
    [1, 0, 0],
    [0, 0, -1],
  ],
  [
    [0, -1, 0],
    [1, 0, 0],
    [0, 0, 1],
  ],
  [
    [0, 0, 1],
    [1, 0, 0],
    [0, 1, 0],
  ],
  [
    [0, 0, -1],
    [-1, 0, 0],
    [0, 1, 0],
  ],
];

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const abs3 = (a: Vec3): Vec3 => [Math.abs(a[0]), Math.abs(a[1]), Math.abs(a[2])];

/** A box of full extents `x, y, z`, faceted: four vertices a face, texture 0..1 across each. */
export function solidBox(x: number, y: number, z: number): Solid {
  const half: Vec3 = [x / 2, y / 2, z / 2];
  const out = new SolidWriter();
  for (const [n, u, v] of FACES) {
    const hn = dot(abs3(n), half);
    const hu = dot(abs3(u), half);
    const hv = dot(abs3(v), half);
    const base = out.vertexCount;
    for (const [su, sv] of CORNERS) {
      out.vertex(
        n[0] * hn + u[0] * hu * su + v[0] * hv * sv,
        n[1] * hn + u[1] * hu * su + v[1] * hv * sv,
        n[2] * hn + u[2] * hu * su + v[2] * hv * sv,
        n[0],
        n[1],
        n[2],
        (su + 1) / 2,
        (sv + 1) / 2,
      );
    }
    out.quad(base, base + 1, base + 2, base + 3);
  }
  return out.finish();
}

const CORNERS: readonly (readonly [number, number])[] = [
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, 1],
];

/** A single-sided plane of `x` by `y` in XY, facing +Z. The one open solid. */
export function solidQuad(x: number, y: number): Solid {
  const out = new SolidWriter();
  for (const [su, sv] of CORNERS) {
    out.vertex((su * x) / 2, (sv * y) / 2, 0, 0, 0, 1, (su + 1) / 2, (sv + 1) / 2);
  }
  out.quad(0, 1, 2, 3);
  return out.finish();
}

/**
 * A box of full extents with every edge rounded to `radius`, `segments` steps per rounded band.
 *
 * Built as a Minkowski sum: each face is a grid whose points are pushed out from the inner box —
 * the box shrunk by the radius — along the direction from their clamped inner point. Grid lines
 * fall on the inner box's edges exactly, so the flat middle of each face is one quad and adjacent
 * faces meet on identical seams.
 */
export function solidRoundedBox(
  x: number,
  y: number,
  z: number,
  radius: number,
  segments: number,
): Solid {
  const half: Vec3 = [x / 2, y / 2, z / 2];
  const r = Math.max(0, Math.min(radius, half[0], half[1], half[2]));
  if (r === 0) return solidBox(x, y, z);
  const inner: Vec3 = [half[0] - r, half[1] - r, half[2] - r];
  const steps = Math.max(1, Math.floor(segments));
  const out = new SolidWriter();
  for (const [n, u, v] of FACES) {
    const hn = dot(abs3(n), half);
    const us = bandCoordinates(dot(abs3(u), half), dot(abs3(u), inner), steps);
    const vs = bandCoordinates(dot(abs3(v), half), dot(abs3(v), inner), steps);
    const base = out.vertexCount;
    for (const b of vs) {
      for (const a of us) {
        const p: Vec3 = [
          n[0] * hn + u[0] * a + v[0] * b,
          n[1] * hn + u[1] * a + v[1] * b,
          n[2] * hn + u[2] * a + v[2] * b,
        ];
        const q: Vec3 = [clamp(p[0], inner[0]), clamp(p[1], inner[1]), clamp(p[2], inner[2])];
        let dx = p[0] - q[0];
        let dy = p[1] - q[1];
        let dz = p[2] - q[2];
        const len = Math.hypot(dx, dy, dz);
        if (len < 1e-12) {
          [dx, dy, dz] = n;
        } else {
          dx /= len;
          dy /= len;
          dz /= len;
        }
        const uHalf = us[us.length - 1] ?? 1;
        const vHalf = vs[vs.length - 1] ?? 1;
        out.vertex(
          q[0] + dx * r,
          q[1] + dy * r,
          q[2] + dz * r,
          dx,
          dy,
          dz,
          (a / uHalf + 1) / 2,
          (b / vHalf + 1) / 2,
        );
      }
    }
    const row = us.length;
    for (let j = 0; j < vs.length - 1; j++) {
      for (let i = 0; i < row - 1; i++) {
        const a = base + j * row + i;
        out.quad(a, a + 1, a + 1 + row, a + row);
      }
    }
  }
  return out.finish();
}

const clamp = (value: number, limit: number): number => Math.max(-limit, Math.min(limit, value));

/** Coordinates across one face axis: `steps` into each rounded band, one step across the flat. */
function bandCoordinates(outer: number, inner: number, steps: number): number[] {
  const coords: number[] = [];
  for (let s = 0; s <= steps; s++) coords.push(-outer + ((outer - inner) * s) / steps);
  if (inner > 0)
    for (let s = 0; s <= steps; s++) coords.push(inner + ((outer - inner) * s) / steps);
  else for (let s = 1; s <= steps; s++) coords.push(inner + ((outer - inner) * s) / steps);
  return coords;
}

/**
 * A triangular prism: the section in XY — base `x` wide at −y/2, apex at +y/2 — extruded `z` along
 * Z, centred. `right` puts the apex over the base's left end, a right angle there.
 */
export function solidPrism(x: number, y: number, z: number, right = false): Solid {
  const apex = right ? -x / 2 : 0;
  return extrudeCanonical([-x / 2, -y / 2, x / 2, -y / 2, apex, y / 2], -z / 2, z / 2);
}

/**
 * A polygon in XZ (`x, z` pairs, either winding, convex or not) extruded along +Y from 0 to
 * `height`, or centred on the origin when `centre` is set.
 */
export function solidExtrude(profile: ArrayLike<number>, height: number, centre = false): Solid {
  const w0 = centre ? -height / 2 : 0;
  /* Built with the polygon in (s, t) and depth along w, then mapped s→x, t→z, w→y: a swap of two
     axes, whose negative determinant `transformSolid` answers by reversing the winding. */
  const canonical = extrudeCanonical(Array.from(profile), w0, w0 + height);
  return transformSolid(canonical, [1, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 1]);
}

/**
 * A profile (`x, y` pairs in the plane across the path) swept along a polyline path (`x, y, z`
 * triples). At each point the frame is right = up × tangent, up' = tangent × right, so profile x
 * runs right and profile y runs up; `up` defaults to +Y. Sides are faceted; `capEnds` closes both
 * ends. Texture u runs around the profile and v along the path, both 0..1.
 *
 * Corners are not mitred: a sharp turn pinches the section. A path that turns sharply wants more
 * points.
 */
export function solidSweep(
  profile: ArrayLike<number>,
  path: ArrayLike<number>,
  capEnds: boolean,
  up: Vec3 = [0, 1, 0],
): Solid {
  const poly = counterClockwise(Array.from(profile));
  const k = poly.length / 2;
  const n = Math.floor(path.length / 3);
  const rings: number[][] = [];
  const along: number[] = [0];
  for (let i = 0; i < n; i++) {
    const prev = Math.max(0, i - 1);
    const next = Math.min(n - 1, i + 1);
    let tx = (path[next * 3] ?? 0) - (path[prev * 3] ?? 0);
    let ty = (path[next * 3 + 1] ?? 0) - (path[prev * 3 + 1] ?? 0);
    let tz = (path[next * 3 + 2] ?? 0) - (path[prev * 3 + 2] ?? 0);
    const tl = Math.hypot(tx, ty, tz) || 1;
    tx /= tl;
    ty /= tl;
    tz /= tl;
    let rx = up[1] * tz - up[2] * ty;
    let ry = up[2] * tx - up[0] * tz;
    let rz = up[0] * ty - up[1] * tx;
    const rl = Math.hypot(rx, ry, rz) || 1;
    rx /= rl;
    ry /= rl;
    rz /= rl;
    const ux = ty * rz - tz * ry;
    const uy = tz * rx - tx * rz;
    const uz = tx * ry - ty * rx;
    const ring: number[] = [];
    for (let p = 0; p < k; p++) {
      const px = poly[p * 2] ?? 0;
      const py = poly[p * 2 + 1] ?? 0;
      ring.push(
        (path[i * 3] ?? 0) + rx * px + ux * py,
        (path[i * 3 + 1] ?? 0) + ry * px + uy * py,
        (path[i * 3 + 2] ?? 0) + rz * px + uz * py,
      );
    }
    rings.push(ring);
    if (i > 0) {
      along.push(
        (along[i - 1] ?? 0) +
          Math.hypot(
            (path[i * 3] ?? 0) - (path[(i - 1) * 3] ?? 0),
            (path[i * 3 + 1] ?? 0) - (path[(i - 1) * 3 + 1] ?? 0),
            (path[i * 3 + 2] ?? 0) - (path[(i - 1) * 3 + 2] ?? 0),
          ),
      );
    }
  }
  const total = along[n - 1] || 1;
  const perimeter = perimeterFractions(poly);
  const out = new SolidWriter();
  for (let i = 0; i < n - 1; i++) {
    const a = rings[i] ?? [];
    const b = rings[i + 1] ?? [];
    for (let p = 0; p < k; p++) {
      const q = (p + 1) % k;
      writeQuad(
        out,
        [a[p * 3] ?? 0, a[p * 3 + 1] ?? 0, a[p * 3 + 2] ?? 0],
        [a[q * 3] ?? 0, a[q * 3 + 1] ?? 0, a[q * 3 + 2] ?? 0],
        [b[q * 3] ?? 0, b[q * 3 + 1] ?? 0, b[q * 3 + 2] ?? 0],
        [b[p * 3] ?? 0, b[p * 3 + 1] ?? 0, b[p * 3 + 2] ?? 0],
        perimeter[p] ?? 0,
        perimeter[p + 1] ?? 1,
        (along[i] ?? 0) / total,
        (along[i + 1] ?? 0) / total,
      );
    }
  }
  if (!capEnds || n < 2) return out.finish();
  const sides = out.finish();
  const caps = [
    capFromRing(rings[0] ?? [], poly, true),
    capFromRing(rings[n - 1] ?? [], poly, false),
  ];
  return mergeSolids([sides, ...caps]);
}

/** One faceted quad with its own four vertices and the normal its corners imply. */
function writeQuad(
  out: SolidWriter,
  a: Vec3,
  b: Vec3,
  c: Vec3,
  d: Vec3,
  u0: number,
  u1: number,
  v0: number,
  v1: number,
): void {
  const ux = b[0] - a[0];
  const uy = b[1] - a[1];
  const uz = b[2] - a[2];
  const vx = d[0] - a[0];
  const vy = d[1] - a[1];
  const vz = d[2] - a[2];
  let nx = uy * vz - uz * vy;
  let ny = uz * vx - ux * vz;
  let nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz) || 1;
  nx /= len;
  ny /= len;
  nz /= len;
  const base = out.vertexCount;
  out.vertex(a[0], a[1], a[2], nx, ny, nz, u0, v0);
  out.vertex(b[0], b[1], b[2], nx, ny, nz, u1, v0);
  out.vertex(c[0], c[1], c[2], nx, ny, nz, u1, v1);
  out.vertex(d[0], d[1], d[2], nx, ny, nz, u0, v1);
  out.quad(base, base + 1, base + 2, base + 3);
}

/** A cap over one ring of a sweep: the profile's triangulation, reversed at the start. */
function capFromRing(ring: number[], poly: number[], start: boolean): Solid {
  const k = poly.length / 2;
  const tris = triangulate(poly);
  const out = new SolidWriter();
  const p0: Vec3 = [ring[0] ?? 0, ring[1] ?? 0, ring[2] ?? 0];
  let nx = 0;
  let ny = 0;
  let nz = 0;
  for (let t = 0; t < tris.length; t += 3) {
    const [a, b, c] = [tris[t] ?? 0, tris[t + 1] ?? 0, tris[t + 2] ?? 0];
    const ux = (ring[b * 3] ?? 0) - (ring[a * 3] ?? 0);
    const uy = (ring[b * 3 + 1] ?? 0) - (ring[a * 3 + 1] ?? 0);
    const uz = (ring[b * 3 + 2] ?? 0) - (ring[a * 3 + 2] ?? 0);
    const vx = (ring[c * 3] ?? 0) - (ring[a * 3] ?? 0);
    const vy = (ring[c * 3 + 1] ?? 0) - (ring[a * 3 + 1] ?? 0);
    const vz = (ring[c * 3 + 2] ?? 0) - (ring[a * 3 + 2] ?? 0);
    nx += uy * vz - uz * vy;
    ny += uz * vx - ux * vz;
    nz += ux * vy - uy * vx;
  }
  const len = Math.hypot(nx, ny, nz) || 1;
  const s = start ? -1 : 1;
  const [bx, by] = bounds(poly);
  for (let p = 0; p < k; p++) {
    out.vertex(
      ring[p * 3] ?? p0[0],
      ring[p * 3 + 1] ?? p0[1],
      ring[p * 3 + 2] ?? p0[2],
      (s * nx) / len,
      (s * ny) / len,
      (s * nz) / len,
      ((poly[p * 2] ?? 0) - bx[0]) / (bx[1] - bx[0] || 1),
      ((poly[p * 2 + 1] ?? 0) - by[0]) / (by[1] - by[0] || 1),
    );
  }
  for (let t = 0; t < tris.length; t += 3) {
    if (start) out.triangle(tris[t] ?? 0, tris[t + 2] ?? 0, tris[t + 1] ?? 0);
    else out.triangle(tris[t] ?? 0, tris[t + 1] ?? 0, tris[t + 2] ?? 0);
  }
  return out.finish();
}

/**
 * A polygon in (s, t) extruded along w from `w0` to `w1`, in a frame where s × t = w: caps
 * ear-clipped, sides faceted, texture u around the perimeter and v along w. The frame is XYZ
 * itself, so a caller wanting another axis maps it with `transformSolid`.
 */
function extrudeCanonical(profile: number[], w0: number, w1: number): Solid {
  const poly = counterClockwise(profile);
  const k = poly.length / 2;
  const tris = triangulate(poly);
  const [bs, bt] = bounds(poly);
  const perimeter = perimeterFractions(poly);
  const out = new SolidWriter();
  for (const [w, sign] of [
    [w1, 1],
    [w0, -1],
  ] as const) {
    const base = out.vertexCount;
    for (let p = 0; p < k; p++) {
      const s = poly[p * 2] ?? 0;
      const t = poly[p * 2 + 1] ?? 0;
      out.vertex(
        s,
        t,
        w,
        0,
        0,
        sign,
        (s - bs[0]) / (bs[1] - bs[0] || 1),
        (t - bt[0]) / (bt[1] - bt[0] || 1),
      );
    }
    for (let i = 0; i < tris.length; i += 3) {
      const a = base + (tris[i] ?? 0);
      const b = base + (tris[i + 1] ?? 0);
      const c = base + (tris[i + 2] ?? 0);
      if (sign > 0) out.triangle(a, b, c);
      else out.triangle(a, c, b);
    }
  }
  for (let p = 0; p < k; p++) {
    const q = (p + 1) % k;
    const a: Vec3 = [poly[p * 2] ?? 0, poly[p * 2 + 1] ?? 0, w0];
    const b: Vec3 = [poly[q * 2] ?? 0, poly[q * 2 + 1] ?? 0, w0];
    writeQuad(
      out,
      a,
      b,
      [b[0], b[1], w1],
      [a[0], a[1], w1],
      perimeter[p] ?? 0,
      perimeter[p + 1] ?? 1,
      0,
      1,
    );
  }
  return out.finish();
}

function signedArea(poly: number[]): number {
  let sum = 0;
  const k = poly.length / 2;
  for (let p = 0; p < k; p++) {
    const q = (p + 1) % k;
    sum +=
      (poly[p * 2] ?? 0) * (poly[q * 2 + 1] ?? 0) - (poly[q * 2] ?? 0) * (poly[p * 2 + 1] ?? 0);
  }
  return sum / 2;
}

/** The polygon wound counter-clockwise, reversed if it came the other way. */
function counterClockwise(poly: number[]): number[] {
  if (signedArea(poly) >= 0) return poly;
  const out: number[] = [];
  for (let p = poly.length / 2 - 1; p >= 0; p--) out.push(poly[p * 2] ?? 0, poly[p * 2 + 1] ?? 0);
  return out;
}

function bounds(poly: number[]): [[number, number], [number, number]] {
  let s0 = Infinity;
  let s1 = -Infinity;
  let t0 = Infinity;
  let t1 = -Infinity;
  for (let p = 0; p < poly.length; p += 2) {
    s0 = Math.min(s0, poly[p] ?? 0);
    s1 = Math.max(s1, poly[p] ?? 0);
    t0 = Math.min(t0, poly[p + 1] ?? 0);
    t1 = Math.max(t1, poly[p + 1] ?? 0);
  }
  return [
    [s0, s1],
    [t0, t1],
  ];
}

/** How far around the perimeter each corner sits, 0 at the first and 1 back at it. */
function perimeterFractions(poly: number[]): number[] {
  const k = poly.length / 2;
  const at: number[] = [0];
  for (let p = 0; p < k; p++) {
    const q = (p + 1) % k;
    const edge = Math.hypot(
      (poly[q * 2] ?? 0) - (poly[p * 2] ?? 0),
      (poly[q * 2 + 1] ?? 0) - (poly[p * 2 + 1] ?? 0),
    );
    at.push((at[p] ?? 0) + edge);
  }
  const total = at[k] || 1;
  return at.map((d) => d / total);
}

/**
 * Ear clipping over a counter-clockwise simple polygon: corner indices, three a triangle.
 * Quadratic, which is right for the dozens of corners a profile has.
 */
function triangulate(poly: number[]): number[] {
  const k = poly.length / 2;
  const remaining: number[] = [];
  for (let p = 0; p < k; p++) remaining.push(p);
  const tris: number[] = [];
  const x = (i: number): number => poly[i * 2] ?? 0;
  const y = (i: number): number => poly[i * 2 + 1] ?? 0;
  const cross = (a: number, b: number, c: number): number =>
    (x(b) - x(a)) * (y(c) - y(a)) - (y(b) - y(a)) * (x(c) - x(a));
  let guard = k * k + 8;
  while (remaining.length > 3 && guard-- > 0) {
    let clipped = false;
    for (let r = 0; r < remaining.length; r++) {
      const a = remaining[(r + remaining.length - 1) % remaining.length] ?? 0;
      const b = remaining[r] ?? 0;
      const c = remaining[(r + 1) % remaining.length] ?? 0;
      if (cross(a, b, c) <= 1e-12) continue;
      let inside = false;
      for (const o of remaining) {
        if (o === a || o === b || o === c) continue;
        if (cross(a, b, o) >= 0 && cross(b, c, o) >= 0 && cross(c, a, o) >= 0) {
          inside = true;
          break;
        }
      }
      if (inside) continue;
      tris.push(a, b, c);
      remaining.splice(r, 1);
      clipped = true;
      break;
    }
    if (!clipped) {
      /* Only collinear corners remain unclipped: drop the middle one, which spans no area. */
      remaining.splice(1, 1);
    }
  }
  if (remaining.length === 3) tris.push(remaining[0] ?? 0, remaining[1] ?? 0, remaining[2] ?? 0);
  return tris;
}
