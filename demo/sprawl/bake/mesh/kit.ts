/**
 * Parts as copies of a kit: each primitive a piece shared by every part of its shape, placed by a
 * matrix that also carries its size.
 *
 * **Sizes go in the matrix wherever the shape survives it.** Every box is one unit box, every quad
 * one unit quad, and a round primitive one piece per segment count and proportion — a frustum's
 * radii over the larger, a tube's wall over its radius — normalised to a unit diameter, so a copy's
 * matrix is the part's own times the size. Proportions are keyed to a thousandth and the piece built
 * from the keyed values, so every copy of a key is the same geometry; what that gives up is at most
 * half a thousandth of a diameter. A rounded box, a lathe and an extrusion are pieces of their own,
 * because scaling one would stretch its rounding.
 *
 * **A CSG result is a piece of its own, once per shape**, from `SolidCache`. Its coordinates are its
 * operands' — each face 0..1 at that operand's size — so a copy's stretch cannot tile it in metres.
 * Where its surface tiles, the piece's coordinates are laid out again in metres along each face's
 * dominant axis, u across and v up a wall, divided by the tile: a box projection, exact on the flat
 * faces a cut wall is made of and seamed where a round one turns through 45°.
 *
 * **A swept span is a piece of its own only where it bends.** The monorail and the elevated road
 * are profiles swept along Hermite spans in the world, thousands of them; a straight one is one
 * unit sweep a profile, stretched along the span and turned onto it by its copy, and only a curved
 * one is swept as it lies — where identical corners share it. A `Sweep` along a named spline is
 * swept as it lies.
 *
 * A piece carries positions, normals, its coordinates and tangents; its colour is the copy's.
 *
 * **v runs down a picture here, as it does everywhere in the engine**, where a solid lays it out
 * up a face. So a piece stores v negated and a copy adds one: the top of a face samples the top of
 * its image, and the repeats up a wall are counted from its foot. Left as the solid wrote it, every
 * sign in the city read upside down — photographed, and taken at first for a mirror.
 */
import {
  generateTangents,
  solidSweep,
  solidBox,
  solidCapsule,
  solidCone,
  solidCylinder,
  solidFrustum,
  solidHemisphere,
  solidIcosphere,
  solidPrism,
  solidQuad,
  solidSphere,
  solidTorus,
  solidTube,
  smoothSolidNormals,
} from '@driftengine/core';
import type { Solid } from '@driftengine/core';
import type { MeshData } from '@driftengine/drft';

import type { Value } from '../script/values.ts';
import { effective } from '../script/world.ts';
import type { Part } from './flatten.ts';
import type { Surface } from './materials.ts';
import { uvStretch } from './materials.ts';
import { SolidCache, primitiveSolid } from './primitives.ts';

type Vec3 = readonly [number, number, number];

interface Unit {
  readonly key: string;
  readonly solid: () => Solid | null;
  /** What the matrix scales the piece by along its axes. */
  readonly scale: Vec3;
  readonly shape: 'box' | 'round';
  /** The part's size in its own units, for tiling. */
  readonly extents: Vec3;
}

const q = (x: number): number => Math.round(x * 1000) / 1000;

const num = (spec: Value, key: string, fallback: number): number => {
  const f = spec.k === 'struct' ? spec.fields?.get(key) : undefined;
  return f?.k === 'num' ? f.v : fallback;
};

/** The unit piece a primitive part is a copy of, or null for one this kit does not make. */
function unitOf(part: Shape): Unit | null {
  const s = part.spec;
  const n = (key: string, fallback: number): number => num(s, key, fallback);
  const seg = Math.max(3, Math.round(n('segments', 12)));
  const sm = n('smooth', 0) !== 0;
  const tail = `${seg}|${sm}|${part.smooth}`;
  switch (part.kind) {
    case 'Box': {
      const e: Vec3 = [n('x', 1), n('y', 1), n('z', 1)];
      return {
        key: `Box|${part.smooth}`,
        solid: () => solidBox(1, 1, 1),
        scale: e,
        shape: 'box',
        extents: e,
      };
    }
    case 'Quad': {
      const e: Vec3 = [n('x', 1), n('y', 1), 1];
      return {
        key: `Quad|${part.smooth}`,
        solid: () => solidQuad(1, 1),
        scale: e,
        shape: 'box',
        extents: e,
      };
    }
    case 'TrianglePrism':
    case 'RightTrianglePrism': {
      const e: Vec3 = [n('x', 1), n('y', 1), n('z', 1)];
      const right = part.kind === 'RightTrianglePrism';
      return {
        key: `${part.kind}|${part.smooth}`,
        solid: () => solidPrism(1, 1, 1, right),
        scale: e,
        shape: 'box',
        extents: e,
      };
    }
    case 'Cylinder':
    case 'Cone': {
      const length = n('length', 1);
      const make = part.kind === 'Cylinder' ? solidCylinder : solidCone;
      return {
        key: `${part.kind}|${tail}`,
        solid: () => make(0.5, 1, seg, sm),
        scale: [1, length, 1],
        shape: 'round',
        extents: [1, length, 1],
      };
    }
    case 'Frustum': {
      const rb = n('radius_bottom', 0.5);
      const rt = n('radius_top', 0.5);
      const d = 2 * Math.max(rb, rt);
      if (!(d > 0)) return null;
      const [b, t] = [q(rb / d), q(rt / d)];
      const length = n('length', 1);
      return {
        key: `Frustum|${b}|${t}|${tail}`,
        solid: () => solidFrustum(b, t, 1, seg, sm),
        scale: [d, length, d],
        shape: 'round',
        extents: [d, length, d],
      };
    }
    case 'Sphere':
    case 'HemiSphere':
    case 'IcoSphere': {
      const d = 2 * n('radius', 0.5);
      const solid =
        part.kind === 'Sphere'
          ? () => solidSphere(0.5, seg, sm)
          : part.kind === 'HemiSphere'
            ? () => solidHemisphere(0.5, seg, sm)
            : () => solidIcosphere(0.5, Math.max(0, Math.round(n('segments', 1))), sm);
      return {
        key: `${part.kind}|${tail}`,
        solid,
        scale: [d, d, d],
        shape: 'round',
        extents: [d, d, d],
      };
    }
    case 'Capsule': {
      const r = n('radius', 0.5);
      const length = n('length', 1);
      const ratio = q(length / (2 * r));
      return {
        key: `Capsule|${ratio}|${tail}`,
        solid: () => solidCapsule(0.5, ratio, seg, sm),
        scale: [2 * r, 2 * r, 2 * r],
        shape: 'round',
        extents: [2 * r, length, 2 * r],
      };
    }
    case 'Tube': {
      const r = n('radius', 0.5);
      const wall = q(n('thickness', 0.1) / (2 * r));
      const length = n('length', 1);
      return {
        key: `Tube|${wall}|${tail}`,
        solid: () => solidTube(0.5, wall, 1, seg, sm),
        scale: [2 * r, length, 2 * r],
        shape: 'round',
        extents: [2 * r, length, 2 * r],
      };
    }
    case 'Torus': {
      const r = n('radius', 0.5);
      const tube = q(n('tube', 0.1) / (2 * r));
      const rings = Math.max(3, Math.round(n('rings', 6)));
      const across = 2 * r + 2 * n('tube', 0.1);
      return {
        key: `Torus|${tube}|${rings}|${tail}`,
        solid: () => solidTorus(0.5, tube, seg, rings, sm),
        scale: [2 * r, 2 * r, 2 * r],
        shape: 'round',
        extents: [across, 2 * n('tube', 0.1), across],
      };
    }
    case 'RoundedBox':
    case 'Lathe':
    case 'Extrude': {
      const solid = primitiveSolid(part.kind, part.spec);
      if (solid === null) return null;
      return {
        key: `${part.kind}|${JSON.stringify(specKey(s))}|${part.smooth}`,
        solid: () => solid,
        scale: [1, 1, 1],
        shape: part.kind === 'Lathe' ? 'round' : 'box',
        extents: extentsOf(solid),
      };
    }
    default:
      return null;
  }
}

function specKey(spec: Value): unknown {
  if (spec.k === 'num') return Math.round(spec.v * 1e4);
  if (spec.k === 'struct')
    return spec.fields
      ? [...spec.fields].map(([k, v]) => [k, specKey(v)])
      : spec.items.map(specKey);
  if (spec.k === 'vector') return spec.items.map(specKey);
  if (spec.k === 'symbol') return spec.name;
  return spec.k;
}

function extentsOf(solid: Solid): Vec3 {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < solid.positions.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      const v = solid.positions[i + a] as number;
      if (v < (lo[a] as number)) lo[a] = v;
      if (v > (hi[a] as number)) hi[a] = v;
    }
  }
  return [
    (hi[0] as number) - (lo[0] as number),
    (hi[1] as number) - (lo[1] as number),
    (hi[2] as number) - (lo[2] as number),
  ];
}

/**
 * Coordinates laid out again in metres over the tile, along each face's dominant axis: across and
 * up a wall — u turning with the face so neither side reads mirrored — and x and z on a top.
 */
export function boxProjected(solid: Solid, mx: number, my: number): Solid {
  const uvs = new Float32Array(solid.uvs.length);
  const p = solid.positions;
  const n = solid.normals;
  for (let v = 0; v < p.length / 3; v++) {
    const [x, y, z] = [p[v * 3] as number, p[v * 3 + 1] as number, p[v * 3 + 2] as number];
    const [nx, ny, nz] = [n[v * 3] as number, n[v * 3 + 1] as number, n[v * 3 + 2] as number];
    const [ax, ay, az] = [Math.abs(nx), Math.abs(ny), Math.abs(nz)];
    let u: number;
    let w: number;
    if (ay >= ax && ay >= az) {
      u = x;
      w = ny >= 0 ? -z : z;
    } else if (ax >= az) {
      u = nx >= 0 ? -z : z;
      w = y;
    } else {
      u = nz >= 0 ? x : -x;
      w = y;
    }
    uvs[v * 2] = u / mx;
    uvs[v * 2 + 1] = w / my;
  }
  return { ...solid, uvs };
}

function meshOf(solid: Solid): MeshData {
  const count = solid.positions.length / 3;
  const uvs = new Float32Array(solid.uvs);
  for (let i = 1; i < uvs.length; i += 2) uvs[i] = -(uvs[i] as number);
  return {
    positions: solid.positions,
    normals: solid.normals,
    colors: new Float32Array(count * 3),
    emissive: new Float32Array(count),
    uvs,
    tangents: generateTangents(solid.positions, solid.normals, uvs, solid.indices),
    indices: solid.indices,
  };
}

type V3 = [number, number, number];

function vec(v: Value | undefined, fallback: V3 = [0, 0, 0]): V3 {
  if (v?.k !== 'struct') return fallback;
  if (v.fields)
    return [num(v, 'x', fallback[0]), num(v, 'y', fallback[1]), num(v, 'z', fallback[2])];
  return [0, 1, 2].map((i) => {
    const x = v.items[i];
    return x?.k === 'num' ? x.v : (fallback[i] as number);
  }) as V3;
}

/** A profile or a polyline written as positional pairs or triples, flattened. */
function flatList(v: Value | undefined, width: number): number[] {
  if (v?.k !== 'vector') return [];
  const out: number[] = [];
  for (const item of v.items) {
    if (item.k !== 'struct') continue;
    const values = item.fields ? [...item.fields.values()] : item.items;
    for (let k = 0; k < width; k++) {
      const x = values[k];
      out.push(x?.k === 'num' ? x.v : 0);
    }
  }
  return out;
}

const cross3 = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const norm3 = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const field = (spec: Value, key: string): Value | undefined =>
  spec.k === 'struct' ? spec.fields?.get(key) : undefined;

/** A polyline's stretch from `s0` to `s1` along it in plan, a point every `step` metres. */
export function stretch(points: readonly number[], s0: number, s1: number, step: number): number[] {
  const n = points.length / 3;
  const along = [0];
  for (let k = 1; k < n; k++) {
    along.push(
      (along[k - 1] as number) +
        Math.hypot(
          (points[k * 3] as number) - (points[k * 3 - 3] as number),
          (points[k * 3 + 2] as number) - (points[k * 3 - 1] as number),
        ),
    );
  }
  const at = (s: number): number[] => {
    let k = 0;
    while (k < n - 2 && (along[k + 1] as number) < s) k++;
    const len = (along[k + 1] as number) - (along[k] as number) || 1;
    const t = (s - (along[k] as number)) / len;
    return [0, 1, 2].map(
      (a) =>
        (points[k * 3 + a] as number) +
        ((points[k * 3 + 3 + a] as number) - (points[k * 3 + a] as number)) * t,
    );
  };
  const out: number[] = [];
  const count = Math.max(1, Math.ceil((s1 - s0) / Math.max(0.1, step)));
  for (let i = 0; i <= count; i++) out.push(...at(s0 + ((s1 - s0) * i) / count));
  return out;
}

export interface CopyOf {
  /** The piece's ordinal in the kit. */
  readonly piece: number;
  /** `COPY_MATRIX_FLOATS`: three columns, then the translation. */
  readonly matrix: Float32Array;
  /** `COPY_UV_FLOATS`. */
  readonly uv: Float32Array;
}

/** What of a part its copy is made from: its kind, its spec, where it stands and how it is cut. */
export type Shape = Pick<Part, 'kind' | 'spec' | 'matrix' | 'smooth' | 'csg'>;

export class Kit {
  readonly pieces: MeshData[] = [];
  /** Parts no piece is made for, by kind. */
  readonly unmade = new Map<string, number>();
  private readonly ordinals = new Map<string, number>();

  constructor(private readonly solids: SolidCache = new SolidCache()) {}

  private ordinal(key: string, make: () => Solid | null): number | null {
    const known = this.ordinals.get(key);
    if (known !== undefined) return known;
    const solid = make();
    if (solid === null || solid.indices.length === 0) return null;
    this.pieces.push(meshOf(solid));
    this.ordinals.set(key, this.pieces.length - 1);
    return this.pieces.length - 1;
  }

  /**
   * A piece made elsewhere — a grown tree — added once under `key`. It is used as it comes: its
   * coordinates already run down its picture, so a copy of it offsets nothing.
   */
  addPiece(key: string, make: () => MeshData): number {
    const known = this.ordinals.get(key);
    if (known !== undefined) return known;
    this.pieces.push(make());
    this.ordinals.set(key, this.pieces.length - 1);
    return this.pieces.length - 1;
  }

  /**
   * A span of a profile swept along a Hermite curve: one unit sweep a profile where it runs
   * straight, stretched and turned onto the span by its copy, and a piece of its own where it bends.
   */
  private splineCopy(part: Shape, surface: Surface): CopyOf | null {
    const spec = part.spec;
    const profileEntity = field(spec, 'profile');
    const profile =
      profileEntity?.k === 'entity' && profileEntity.entity !== null
        ? effective(profileEntity.entity, 'SplineProfile')
        : undefined;
    if (profile === undefined) return null;
    const pairs = flatList(field(profile, 'profile'), 2);
    if (pairs.length < 6) return null;
    const cap = num(profile, 'cap_ends', 0) !== 0 || field(profile, 'cap_ends')?.k === 'symbol';
    const slices = Math.max(1, Math.round(num(profile, 'slices', 8)));
    const uScale = num(profile, 'uv_scale', 1);
    const p0 = vec(field(spec, 'p0'));
    const p1 = vec(field(spec, 'p1'));
    const t0 = vec(field(spec, 't0'));
    const t1 = vec(field(spec, 't1'));
    const up = norm3(vec(field(spec, 'up0'), [0, 1, 0]));
    const chord: V3 = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
    const length = Math.hypot(chord[0], chord[1], chord[2]);
    if (!(length > 1e-4)) return null;
    const along = num(spec, 'length', length) / Math.max(1e-6, num(spec, 'v_scale', 1));
    const d = norm3(chord);
    const bent = (t: V3): boolean => {
      const c = cross3(norm3(t), d);
      return Math.hypot(c[0], c[1], c[2]) > 1e-3;
    };
    const profileKey = JSON.stringify([pairs.map((x) => Math.round(x * 1e4)), cap]);
    const matrix = new Float32Array(12);
    let piece: number | null;
    if (!bent(t0) && !bent(t1)) {
      piece = this.ordinal(`Sweep|${profileKey}|line`, () =>
        solidSweep(pairs, [0, 0, 0, 1, 0, 0], cap),
      );
      /* The unit sweep runs along +x with its profile's x along −z: +x onto the span, +y onto its
         up, +z onto its left — (along, up, −right), a turn and not a mirror. */
      const right = norm3(cross3(up, d));
      const u = cross3(d, right);
      matrix.set(
        [
          d[0] * length,
          d[1] * length,
          d[2] * length,
          u[0],
          u[1],
          u[2],
          -right[0],
          -right[1],
          -right[2],
        ],
        0,
      );
    } else {
      const path: number[] = [];
      for (let k = 0; k <= slices; k++) {
        const t = k / slices;
        const [h00, h10, h01, h11] = [
          2 * t ** 3 - 3 * t * t + 1,
          t ** 3 - 2 * t * t + t,
          -2 * t ** 3 + 3 * t * t,
          t ** 3 - t * t,
        ];
        for (let a = 0; a < 3; a++) {
          path.push(
            h10 * (t0[a] as number) +
              h01 * (chord[a] as number) +
              h11 * (t1[a] as number) +
              h00 * 0,
          );
        }
      }
      const key = JSON.stringify(
        [chord, t0, t1, up, slices].map((v) =>
          Array.isArray(v) ? v.map((x) => Math.round(x * 1000)) : v,
        ),
      );
      piece = this.ordinal(`Sweep|${profileKey}|${key}`, () => solidSweep(pairs, path, cap, up));
      matrix.set([1, 0, 0, 0, 1, 0, 0, 0, 1], 0);
    }
    if (piece === null) return null;
    matrix.set(p0, 9);
    const { sx, sy, ox, oy } = surface.transform;
    const u = uScale * sx;
    const v = along * sy;
    /* v runs down the picture here, as everywhere in the kit: one minus the offset. */
    return { piece, matrix, uv: new Float32Array([u, u, u, v, v, v, ox, 1 - oy]) };
  }

  /**
   * A profile swept along a named spline's points, in the part's own frame: a piece as it lies.
   * Given `s0` and `s1`, only that stretch of the spline, resampled every `step` metres — measured in
   * plan, as the layout measures its lines — which is how a crossing covers one street of a route.
   */
  private sweepCopy(part: Shape, surface: Surface): CopyOf | null {
    const line = field(part.spec, 'spline');
    const spline =
      line?.k === 'entity' && line.entity !== null ? effective(line.entity, 'Spline') : undefined;
    let points = spline === undefined ? [] : flatList(field(spline, 'points'), 3);
    const pairs = flatList(field(part.spec, 'profile'), 2);
    const s0 = num(part.spec, 's0', 0);
    const s1 = num(part.spec, 's1', 0);
    if (s1 > s0 && points.length >= 6) points = stretch(points, s0, s1, num(part.spec, 'step', 2));
    if (points.length < 6 || pairs.length < 6) return null;
    const piece = this.ordinal(
      `SweepAlong|${JSON.stringify([pairs, points].map((l) => l.map((x) => Math.round(x * 1e4))))}|${part.smooth}`,
      () => solidSweep(pairs, points, true),
    );
    if (piece === null) return null;
    const m = part.matrix;
    const matrix = new Float32Array(12);
    for (let c = 0; c < 3; c++)
      for (let r = 0; r < 3; r++) matrix[c * 3 + r] = m[c * 4 + r] as number;
    matrix.set([m[12] as number, m[13] as number, m[14] as number], 9);
    let length = 0;
    for (let k = 3; k < points.length; k += 3) {
      length += Math.hypot(
        (points[k] as number) - (points[k - 3] as number),
        (points[k + 1] as number) - (points[k - 2] as number),
        (points[k + 2] as number) - (points[k - 1] as number),
      );
    }
    const { sx, sy, ox, oy } = surface.transform;
    const v = (length / Math.max(1e-6, num(part.spec, 'uv_scale', length || 1))) * sy;
    return { piece, matrix, uv: new Float32Array([sx, sx, sx, v, v, v, ox, 1 - oy]) };
  }

  /**
   * The copy a part is, its piece added to the kit if new; null for a part this kit cannot make.
   * Anything shaped like a part will do — a coarse level's box is one no script declared.
   */
  copyOf(part: Shape, surface: Surface): CopyOf | null {
    if (part.kind === 'SplineMesh' || part.kind === 'Sweep') {
      const copy =
        part.kind === 'SplineMesh' ? this.splineCopy(part, surface) : this.sweepCopy(part, surface);
      if (copy === null) this.unmade.set(part.kind, (this.unmade.get(part.kind) ?? 0) + 1);
      return copy;
    }
    let piece: number | null;
    let scale: Vec3 = [1, 1, 1];
    let uv: Float32Array;
    if (part.csg !== null) {
      const t = surface.tiling;
      const shapeKey = this.solids.keyOf(part);
      piece = this.ordinal(`Csg|${shapeKey}|${t === null ? '' : `${t.mx}|${t.my}`}`, () => {
        const solid = this.solids.solid(part);
        return solid === null || t === null ? solid : boxProjected(solid, t.mx, t.my);
      });
      const { sx, sy, ox, oy } = surface.transform;
      uv = new Float32Array([sx, sx, sx, sy, sy, sy, ox, oy]);
    } else {
      const unit = unitOf(part);
      if (unit === null) {
        this.unmade.set(part.kind, (this.unmade.get(part.kind) ?? 0) + 1);
        return null;
      }
      piece = this.ordinal(unit.key, () => {
        const solid = unit.solid();
        return solid === null || part.smooth === null
          ? solid
          : smoothSolidNormals(solid, part.smooth);
      });
      scale = unit.scale;
      uv = uvStretch(surface, unit.shape, unit.extents);
    }
    if (piece === null) return null;
    /* The piece's v is negated; one minus the offset puts the picture's top at the face's top. */
    uv[7] = 1 - (uv[7] as number);
    const m = part.matrix;
    const matrix = new Float32Array(12);
    for (let c = 0; c < 3; c++) {
      for (let r = 0; r < 3; r++)
        matrix[c * 3 + r] = (m[c * 4 + r] as number) * (scale[c] as number);
    }
    matrix[9] = m[12] as number;
    matrix[10] = m[13] as number;
    matrix[11] = m[14] as number;
    return { piece, matrix, uv };
  }
}
