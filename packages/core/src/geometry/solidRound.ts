/**
 * The round solids: cylinder, cone, frustum, tube, sphere, hemisphere, icosphere, capsule, torus
 * and lathe — all but the icosphere one revolve of a profile around +Y.
 *
 * A profile is `(r, y)` points. Revolving it, the vertex at angle θ sits at (r·cos θ, y, r·sin θ),
 * and a quad is wound so that the profile's direction crossed with the direction of increasing θ
 * points outward: a profile climbing on its outer side, or running outward along a bottom cap,
 * faces out. Where the profile touches the axis a quad collapses to a triangle and only the
 * triangle is written, so no edge is counted twice.
 *
 * `smooth` shares vertices around the axis with normals that vary around it; the default,
 * faceted, gives every quad its own four vertices and its own normal. Texture u runs around (0..1,
 * the seam duplicated) and v along the profile (0..1 by length).
 */
import type { Solid } from './solid.ts';
import { SolidWriter } from './solidWriter.ts';

/** A profile point with the in-plane normal it wants when smooth: (nr, ny) across the profile. */
interface ProfilePoint {
  readonly r: number;
  readonly y: number;
  readonly nr: number;
  readonly ny: number;
}

/**
 * Revolve one or more strips — runs of profile points whose normals are continuous — around +Y.
 * A strip's normals are used when smooth; faceted quads take the normal their corners imply.
 */
function revolve(
  strips: readonly (readonly ProfilePoint[])[],
  segments: number,
  smooth: boolean,
): Solid {
  const n = Math.max(3, Math.floor(segments));
  const out = new SolidWriter();
  let total = 0;
  for (const strip of strips) {
    for (let i = 0; i + 1 < strip.length; i++) total += span(strip[i], strip[i + 1]);
  }
  let walked = 0;
  for (const strip of strips) {
    const v: number[] = [];
    for (let i = 0; i < strip.length; i++) {
      if (i > 0) walked += span(strip[i - 1], strip[i]);
      v.push(total > 0 ? walked / total : 0);
    }
    if (smooth) revolveSmooth(out, strip, v, n);
    else revolveFaceted(out, strip, v, n);
  }
  return out.finish();
}

function span(a: ProfilePoint | undefined, b: ProfilePoint | undefined): number {
  return a && b ? Math.hypot(b.r - a.r, b.y - a.y) : 0;
}

function revolveSmooth(
  out: SolidWriter,
  strip: readonly ProfilePoint[],
  v: number[],
  n: number,
): void {
  const base = out.vertexCount;
  const row = n + 1;
  for (let i = 0; i < strip.length; i++) {
    const p = strip[i];
    if (!p) continue;
    for (let j = 0; j <= n; j++) {
      const t = (2 * Math.PI * (j % n)) / n;
      const c = Math.cos(t);
      const s = Math.sin(t);
      out.vertex(p.r * c, p.y, p.r * s, p.nr * c, p.ny, p.nr * s, j / n, v[i] ?? 0);
    }
  }
  for (let i = 0; i + 1 < strip.length; i++) {
    const r0 = strip[i]?.r ?? 0;
    const r1 = strip[i + 1]?.r ?? 0;
    for (let j = 0; j < n; j++) {
      const a = base + i * row + j;
      const b = a + row;
      const c = b + 1;
      const d = a + 1;
      emit(out, a, b, c, d, r0, r1);
    }
  }
}

function revolveFaceted(
  out: SolidWriter,
  strip: readonly ProfilePoint[],
  v: number[],
  n: number,
): void {
  for (let i = 0; i + 1 < strip.length; i++) {
    const p = strip[i];
    const q = strip[i + 1];
    if (!p || !q) continue;
    for (let j = 0; j < n; j++) {
      const t0 = (2 * Math.PI * j) / n;
      const t1 = (2 * Math.PI * ((j + 1) % n)) / n;
      const c0 = Math.cos(t0);
      const s0 = Math.sin(t0);
      const c1 = Math.cos(t1);
      const s1 = Math.sin(t1);
      const ax = p.r * c0;
      const az = p.r * s0;
      const bx = q.r * c0;
      const bz = q.r * s0;
      const cx = q.r * c1;
      const cz = q.r * s1;
      const dx = p.r * c1;
      const dz = p.r * s1;
      /* The normal from the diagonals, (c − a) × (d − b): right for a quad and for the triangle a
         quad collapses to at the axis, where the edge-based cross product is zero. */
      const ex = cx - ax;
      const ey = q.y - p.y;
      const ez = cz - az;
      const fx = dx - bx;
      const fy = p.y - q.y;
      const fz = dz - bz;
      let nx = ey * fz - ez * fy;
      let ny = ez * fx - ex * fz;
      let nz = ex * fy - ey * fx;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len;
      ny /= len;
      nz /= len;
      const u0 = j / n;
      const u1 = (j + 1) / n;
      const a = out.vertex(ax, p.y, az, nx, ny, nz, u0, v[i] ?? 0);
      const b = out.vertex(bx, q.y, bz, nx, ny, nz, u0, v[i + 1] ?? 0);
      const c = out.vertex(cx, q.y, cz, nx, ny, nz, u1, v[i + 1] ?? 0);
      const d = out.vertex(dx, p.y, dz, nx, ny, nz, u1, v[i] ?? 0);
      emit(out, a, b, c, d, p.r, q.r);
    }
  }
}

/** Quad `a b c d`, or the one triangle left of it where either end of the profile step is on the axis. */
function emit(
  out: SolidWriter,
  a: number,
  b: number,
  c: number,
  d: number,
  r0: number,
  r1: number,
): void {
  if (r0 <= 1e-12 && r1 <= 1e-12) return;
  if (r0 <= 1e-12) out.triangle(a, b, c);
  else if (r1 <= 1e-12) out.triangle(a, b, d);
  else out.quad(a, b, c, d);
}

/** Points along a polyline profile, each segment its own strip so every corner creases. */
function creasedStrips(points: readonly (readonly [number, number])[]): ProfilePoint[][] {
  const strips: ProfilePoint[][] = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const [r0, y0] = points[i] ?? [0, 0];
    const [r1, y1] = points[i + 1] ?? [0, 0];
    const len = Math.hypot(r1 - r0, y1 - y0) || 1;
    const nr = (y1 - y0) / len;
    const ny = -(r1 - r0) / len;
    strips.push([
      { r: r0, y: y0, nr, ny },
      { r: r1, y: y1, nr, ny },
    ]);
  }
  return strips;
}

/** An arc of the circle centred (cr, cy), radius `radius`, from angle `a0` to `a1` in `steps`. */
function arc(
  cr: number,
  cy: number,
  radius: number,
  a0: number,
  a1: number,
  steps: number,
): ProfilePoint[] {
  const points: ProfilePoint[] = [];
  for (let s = 0; s <= steps; s++) {
    const a = a0 + ((a1 - a0) * s) / steps;
    const c = Math.cos(a);
    const sn = Math.sin(a);
    points.push({ r: Math.max(0, cr + radius * c), y: cy + radius * sn, nr: c, ny: sn });
  }
  return points;
}

/** A cylinder of `radius` and `length` along Y, centred, capped. */
export function solidCylinder(
  radius: number,
  length: number,
  segments: number,
  smooth = false,
): Solid {
  return solidFrustum(radius, radius, length, segments, smooth);
}

/** A cone: base `radius` at −length/2, apex at +length/2. */
export function solidCone(radius: number, length: number, segments: number, smooth = false): Solid {
  return solidFrustum(radius, 0, length, segments, smooth);
}

/** A frustum with explicit radii at its bottom (−length/2) and top (+length/2), capped. */
export function solidFrustum(
  radiusBottom: number,
  radiusTop: number,
  length: number,
  segments: number,
  smooth = false,
): Solid {
  const h = length / 2;
  return revolve(
    creasedStrips([
      [0, -h],
      [radiusBottom, -h],
      [radiusTop, h],
      [0, h],
    ]),
    segments,
    smooth,
  );
}

/** A hollow cylinder: outer `radius`, wall `thickness`, `length` along Y, centred. Four segments make a square frame. */
export function solidTube(
  radius: number,
  thickness: number,
  length: number,
  segments: number,
  smooth = false,
): Solid {
  const h = length / 2;
  const inner = Math.max(0, radius - thickness);
  return revolve(
    creasedStrips([
      [inner, -h],
      [radius, -h],
      [radius, h],
      [inner, h],
      [inner, -h],
    ]),
    segments,
    smooth,
  );
}

/** A sphere of `radius`: `segments` around, half as many from pole to pole. */
export function solidSphere(radius: number, segments: number, smooth = false): Solid {
  const rings = Math.max(2, Math.floor(segments / 2));
  return revolve([arc(0, 0, radius, -Math.PI / 2, Math.PI / 2, rings)], segments, smooth);
}

/** A dome toward +Y on a flat base at the origin. */
export function solidHemisphere(radius: number, segments: number, smooth = false): Solid {
  const rings = Math.max(1, Math.floor(segments / 4));
  const base: ProfilePoint[] = [
    { r: 0, y: 0, nr: 0, ny: -1 },
    { r: radius, y: 0, nr: 0, ny: -1 },
  ];
  return revolve([base, arc(0, 0, radius, 0, Math.PI / 2, rings)], segments, smooth);
}

/** A capsule: a cylinder of `length` (excluding the caps) with hemispherical ends, along Y. */
export function solidCapsule(
  radius: number,
  length: number,
  segments: number,
  smooth = false,
): Solid {
  const rings = Math.max(1, Math.floor(segments / 4));
  const h = length / 2;
  return revolve(
    [
      arc(0, -h, radius, -Math.PI / 2, 0, rings),
      [
        { r: radius, y: -h, nr: 1, ny: 0 },
        { r: radius, y: h, nr: 1, ny: 0 },
      ],
      arc(0, h, radius, 0, Math.PI / 2, rings),
    ],
    segments,
    smooth,
  );
}

/** A torus around +Y: ring radius `major`, tube radius `minor`, `segments` around and `sides` across. */
export function solidTorus(
  major: number,
  minor: number,
  segments: number,
  sides: number,
  smooth = false,
): Solid {
  return revolve(
    [arc(major, 0, minor, 0, 2 * Math.PI, Math.max(3, Math.floor(sides)))],
    segments,
    smooth,
  );
}

/**
 * A profile (`r, y` pairs, bottom to top) revolved around +Y. An end off the axis is closed with a
 * flat cap, so any profile makes a solid. Every profile corner creases, faceted or smooth.
 */
export function solidLathe(profile: ArrayLike<number>, segments: number, smooth = false): Solid {
  const points: [number, number][] = [];
  for (let i = 0; i + 1 < profile.length; i += 2)
    points.push([profile[i] ?? 0, profile[i + 1] ?? 0]);
  const first = points[0];
  const last = points[points.length - 1];
  if (first && first[0] > 1e-12) points.unshift([0, first[1]]);
  if (last && last[0] > 1e-12) points.push([0, last[1]]);
  return revolve(creasedStrips(points), segments, smooth);
}

/**
 * An icosahedron subdivided `level` times onto a sphere of `radius`. Faceted by default — every
 * triangle its own vertices and face normal — or smooth, sharing vertices with radial normals.
 */
export function solidIcosphere(radius: number, level: number, smooth = false): Solid {
  const t = (1 + Math.sqrt(5)) / 2;
  const verts: number[][] = [
    [-1, t, 0],
    [1, t, 0],
    [-1, -t, 0],
    [1, -t, 0],
    [0, -1, t],
    [0, 1, t],
    [0, -1, -t],
    [0, 1, -t],
    [t, 0, -1],
    [t, 0, 1],
    [-t, 0, -1],
    [-t, 0, 1],
  ].map(unit);
  let faces: number[][] = [
    [0, 11, 5],
    [0, 5, 1],
    [0, 1, 7],
    [0, 7, 10],
    [0, 10, 11],
    [1, 5, 9],
    [5, 11, 4],
    [11, 10, 2],
    [10, 7, 6],
    [7, 1, 8],
    [3, 9, 4],
    [3, 4, 2],
    [3, 2, 6],
    [3, 6, 8],
    [3, 8, 9],
    [4, 9, 5],
    [2, 4, 11],
    [6, 2, 10],
    [8, 6, 7],
    [9, 8, 1],
  ];
  for (let l = 0; l < Math.floor(level); l++) {
    const cache = new Map<string, number>();
    const mid = (a: number, b: number): number => {
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      const hit = cache.get(key);
      if (hit !== undefined) return hit;
      const va = verts[a] ?? [0, 0, 0];
      const vb = verts[b] ?? [0, 0, 0];
      verts.push(
        unit([
          (va[0] ?? 0) + (vb[0] ?? 0),
          (va[1] ?? 0) + (vb[1] ?? 0),
          (va[2] ?? 0) + (vb[2] ?? 0),
        ]),
      );
      cache.set(key, verts.length - 1);
      return verts.length - 1;
    };
    const next: number[][] = [];
    for (const [a = 0, b = 0, c = 0] of faces) {
      const ab = mid(a, b);
      const bc = mid(b, c);
      const ca = mid(c, a);
      next.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
    }
    faces = next;
  }
  const out = new SolidWriter();
  const uv = (p: number[]): [number, number] => [
    0.5 + Math.atan2(p[2] ?? 0, p[0] ?? 0) / (2 * Math.PI),
    0.5 + Math.asin(Math.max(-1, Math.min(1, p[1] ?? 0))) / Math.PI,
  ];
  if (smooth) {
    for (const p of verts) {
      const [u, v] = uv(p);
      out.vertex(
        (p[0] ?? 0) * radius,
        (p[1] ?? 0) * radius,
        (p[2] ?? 0) * radius,
        p[0] ?? 0,
        p[1] ?? 0,
        p[2] ?? 0,
        u,
        v,
      );
    }
    /* The table's faces run counter-clockwise seen from outside, as every face here does. */
    for (const [a = 0, b = 0, c = 0] of faces) out.triangle(a, b, c);
    return out.finish();
  }
  for (const [a = 0, b = 0, c = 0] of faces) {
    const pa = verts[a] ?? [0, 0, 0];
    const pb = verts[b] ?? [0, 0, 0];
    const pc = verts[c] ?? [0, 0, 0];
    const n = unit([
      ((pa[0] ?? 0) + (pb[0] ?? 0) + (pc[0] ?? 0)) / 3,
      ((pa[1] ?? 0) + (pb[1] ?? 0) + (pc[1] ?? 0)) / 3,
      ((pa[2] ?? 0) + (pb[2] ?? 0) + (pc[2] ?? 0)) / 3,
    ]);
    const base = out.vertexCount;
    for (const p of [pa, pb, pc]) {
      const [u, v] = uv(p);
      out.vertex(
        (p[0] ?? 0) * radius,
        (p[1] ?? 0) * radius,
        (p[2] ?? 0) * radius,
        n[0] ?? 0,
        n[1] ?? 0,
        n[2] ?? 0,
        u,
        v,
      );
    }
    out.triangle(base, base + 1, base + 2);
  }
  return out.finish();
}

function unit(p: number[]): number[] {
  const len = Math.hypot(p[0] ?? 0, p[1] ?? 0, p[2] ?? 0) || 1;
  return [(p[0] ?? 0) / len, (p[1] ?? 0) / len, (p[2] ?? 0) / len];
}
