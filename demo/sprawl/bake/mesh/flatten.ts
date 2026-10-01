/**
 * An instantiated entity tree flattened into what the meshing needs: each primitive with its world
 * matrix and resolved material, each CSG group as one part holding its operands, and the markers —
 * lights, obstacle rectangles, sign mounts — the later stages read.
 *
 * **Transforms compose as the scripts assume**: `M = M_parent · T · Rx · Ry · Rz · S`, scale
 * inherited by children — the digest's reading, from a lamp's bezel that only fits its scaled
 * parent. The Euler order is the spec's default, to be settled by photographing the two landmarks
 * whose rotations disagree about it.
 *
 * **A prefab's children belong to every entity based on it**: an entity's children are its bases'
 * (depth first, in base order) and then its own. **A material is resolved through the base chain**
 * per component, so a named initialiser on an instance and a family prefab three levels up both
 * count, and material components never pass from parent to child: a child has its own.
 *
 * An entity tagged `flecs.core.Disabled` is skipped with its subtree, and a primitive under a zero
 * scale — the invisible carrier of a glow sprite — is not geometry.
 */
import type { Value } from '../script/values.ts';
import { effective, hasTag } from '../script/world.ts';
import type { ScriptEntity } from '../script/world.ts';

export type Matrix = Float64Array;

/** The components a surface's look is made of. */
const MATERIAL = [
  'Rgba',
  'PbrMaterial',
  'Emissive',
  'PbrTextures',
  'TextureTiling',
  'TextureTransform',
  'TextureWrap',
  'SurfaceWear',
  'MaterialAnim',
  'InteriorMap',
  'WindowLights',
  'NightLight',
  'VolumeGlow',
];
const TAGS = ['Additive', 'AlphaBlend', 'DryMaterial'];

/** Components that are geometry. `Tree` is generated, the spline family swept. */
export const PRIMITIVES = new Set([
  'Box',
  'Cylinder',
  'Cone',
  'Frustum',
  'Tube',
  'Sphere',
  'HemiSphere',
  'IcoSphere',
  'Capsule',
  'RoundedBox',
  'Quad',
  'TrianglePrism',
  'RightTrianglePrism',
  'Lathe',
  'Extrude',
  'Torus',
  'Tree',
  'Sweep',
  'SplineMesh',
]);

/** Components the later stages read off the world, with where they stand. */
const MARKERS = new Set([
  'PointLight',
  'SpotLight',
  'LightLod',
  'LightGlow',
  'NavLight',
  'BlockRect',
  'ObstacleTop',
  'SignMount',
  'RoofDeck',
  'Glazing',
  'NpcSlot',
  'UseSlot',
  'ParticleEmitter',
  'RainEmitter',
  'SignalHead',
]);

export interface MaterialSet {
  readonly components: ReadonlyMap<string, Value>;
  readonly tags: ReadonlySet<string>;
}

export interface Part {
  readonly kind: string;
  readonly spec: Value;
  readonly matrix: Matrix;
  readonly material: MaterialSet;
  /** Crease angle in degrees, where the entity asks for smoothed normals. */
  readonly smooth: number | null;
  /** For a CSG group: its operation and operands, their matrices relative to the group. */
  readonly csg: {
    readonly op: string;
    readonly operands: readonly { part: Part; op: string }[];
  } | null;
  readonly entity: ScriptEntity;
}

export interface Marker {
  readonly component: string;
  readonly value: Value;
  readonly matrix: Matrix;
  readonly entity: ScriptEntity;
}

export function identity(): Matrix {
  const m = new Float64Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

/** `a · b`, column-major. */
export function multiply(a: Matrix, b: Matrix): Matrix {
  const out = new Float64Array(16);
  for (let c = 0; c < 4; c += 1) {
    for (let r = 0; r < 4; r += 1) {
      let sum = 0;
      for (let k = 0; k < 4; k += 1) sum += (a[k * 4 + r] as number) * (b[c * 4 + k] as number);
      out[c * 4 + r] = sum;
    }
  }
  return out;
}

const num = (v: Value | undefined, key: string, fallback: number): number => {
  const f = v?.k === 'struct' ? v.fields?.get(key) : undefined;
  return f?.k === 'num' ? f.v : fallback;
};

/** `T · Rx · Ry · Rz · S` from an entity's transform components, own or inherited. */
export function localMatrix(entity: ScriptEntity): Matrix {
  /* Through the base chain: an instance takes its prefab's transform where it sets none. */
  const p = effective(entity, 'Position3');
  const r = effective(entity, 'Rotation3');
  const s = effective(entity, 'Scale3');
  const [ax, ay, az] = [num(r, 'x', 0), num(r, 'y', 0), num(r, 'z', 0)];
  const [cx, sx, cy, sy, cz, sz] = [
    Math.cos(ax),
    Math.sin(ax),
    Math.cos(ay),
    Math.sin(ay),
    Math.cos(az),
    Math.sin(az),
  ];
  /* Rx · Ry · Rz, row by row. */
  const rot = [
    [cy * cz, -cy * sz, sy],
    [sx * sy * cz + cx * sz, -sx * sy * sz + cx * cz, -sx * cy],
    [-cx * sy * cz + sx * sz, cx * sy * sz + sx * cz, cx * cy],
  ] as const;
  const scale = [num(s, 'x', 1), num(s, 'y', 1), num(s, 'z', 1)];
  const m = new Float64Array(16);
  for (let c = 0; c < 3; c += 1) {
    for (let row = 0; row < 3; row += 1)
      m[c * 4 + row] = (rot[row]?.[c] as number) * (scale[c] as number);
  }
  m[12] = num(p, 'x', 0);
  m[13] = num(p, 'y', 0);
  m[14] = num(p, 'z', 0);
  m[15] = 1;
  return m;
}

function materialOf(entity: ScriptEntity): MaterialSet {
  const components = new Map<string, Value>();
  for (const name of MATERIAL) {
    const v = effective(entity, name);
    if (v !== undefined) components.set(name, v);
  }
  return { components, tags: new Set(TAGS.filter((t) => hasTag(entity, t))) };
}

/** An entity's children as the scripts mean them: its bases' first, then its own. */
export function childrenOf(entity: ScriptEntity): ScriptEntity[] {
  const out: ScriptEntity[] = [];
  for (const base of entity.bases) out.push(...childrenOf(base));
  out.push(...entity.children);
  return out;
}

function primitiveOf(entity: ScriptEntity): [string, Value] | null {
  for (const name of PRIMITIVES) {
    const v = effective(entity, name);
    if (v !== undefined) return [name, v];
  }
  return null;
}

const zeroScale = (m: Matrix): boolean =>
  Math.hypot(m[0] as number, m[1] as number, m[2] as number) < 1e-9 ||
  Math.hypot(m[4] as number, m[5] as number, m[6] as number) < 1e-9 ||
  Math.hypot(m[8] as number, m[9] as number, m[10] as number) < 1e-9;

/** A point of a line: named `x, y, z`, or three positional numbers. */
function point(v: Value): [number, number, number] {
  if (v.k !== 'struct') return [0, 0, 0];
  if (v.fields) return [num(v, 'x', 0), num(v, 'y', 0), num(v, 'z', 0)];
  return [0, 1, 2].map((i) => {
    const x = v.items[i];
    return x?.k === 'num' ? x.v : 0;
  }) as [number, number, number];
}

/**
 * The frame a part along a line stands in, as the scripts' `AlongSpline` asks: where the line is
 * at distance `s` — measured in plan, as the layout measures its lines — offset right and up, and
 * turned with it where `align` says so. **Right is up × tangent**, the reference's own, which its
 * sweeps take too and which keeps (right, up, heading) a turn rather than a mirror. The frame is
 * the world's, not the parent's: a line is placed in the world, and so is what stands along it.
 */
function alongSpline(v: Value): Matrix | null {
  const field = (k: string): Value | undefined => (v.k === 'struct' ? v.fields?.get(k) : undefined);
  const line = field('spline');
  if (line?.k !== 'entity' || line.entity === null) return null;
  const points = effective(line.entity, 'Spline');
  const list = points?.k === 'struct' ? points.fields?.get('points') : undefined;
  if (list?.k !== 'vector' || list.items.length < 2) return null;
  const p = list.items.map(point);
  const s = num(v, 's', 0);
  let at = 0;
  let i = 0;
  for (; i < p.length - 2; i++) {
    const [a, b] = [p[i] as number[], p[i + 1] as number[]];
    const len = Math.hypot(
      (b[0] as number) - (a[0] as number),
      (b[2] as number) - (a[2] as number),
    );
    if (at + len >= s) break;
    at += len;
  }
  const [a, b] = [p[i] as number[], p[i + 1] as number[]];
  const len =
    Math.hypot((b[0] as number) - (a[0] as number), (b[2] as number) - (a[2] as number)) || 1;
  const t = Math.min(Math.max((s - at) / len, 0), 1);
  const d = [0, 1, 2].map((k) => (b[k] as number) - (a[k] as number));
  const dl = Math.hypot(d[0] as number, d[1] as number, d[2] as number) || 1;
  const tan = d.map((x) => x / dl);
  /* right = up × tangent, up' = tangent × right. */
  let r = [tan[2] as number, 0, -(tan[0] as number)];
  const rl = Math.hypot(r[0] as number, r[2] as number) || 1;
  r = r.map((x) => x / rl);
  const u = [
    (tan[1] as number) * (r[2] as number) - (tan[2] as number) * (r[1] as number),
    (tan[2] as number) * (r[0] as number) - (tan[0] as number) * (r[2] as number),
    (tan[0] as number) * (r[1] as number) - (tan[1] as number) * (r[0] as number),
  ];
  const right = num(v, 'offset_right', 0);
  const up = num(v, 'offset_up', 0);
  const align = field('align');
  const turned = !(align?.k === 'num' && align.v === 0);
  const m = identity();
  if (turned) {
    m.set([r[0] as number, r[1] as number, r[2] as number], 0);
    m.set([u[0] as number, u[1] as number, u[2] as number], 4);
    m.set([tan[0] as number, tan[1] as number, tan[2] as number], 8);
  }
  for (let k = 0; k < 3; k++) {
    m[12 + k] =
      (a[k] as number) + (d[k] as number) * t + (r[k] as number) * right + (u[k] as number) * up;
  }
  return m;
}

export interface Flattened {
  readonly parts: Part[];
  readonly markers: Marker[];
}

/** Every part and marker under `root`, whose own transform is placed at `world`. */
export function flatten(
  root: ScriptEntity,
  world: Matrix,
  out: Flattened = { parts: [], markers: [] },
): Flattened {
  if (hasTag(root, 'flecs.core.Disabled')) return out;
  const along = effective(root, 'AlongSpline');
  const matrix =
    (along === undefined ? null : alongSpline(along)) ?? multiply(world, localMatrix(root));
  for (const name of MARKERS) {
    const v = effective(root, name);
    if (v !== undefined) out.markers.push({ component: name, value: v, matrix, entity: root });
  }
  const smoothing = effective(root, 'SmoothNormals');
  const smooth = smoothing ? num(smoothing, 'angle', 30) : null;
  const csg = effective(root, 'Csg');
  if (csg !== undefined) {
    const op = (csg.k === 'struct' ? symbolName(csg.fields?.get('op')) : '') || 'CsgUnion';
    const operands: { part: Part; op: string }[] = [];
    for (const child of childrenOf(root)) {
      const operator = effective(child, 'CsgOperator');
      const childOp =
        (operator?.k === 'struct' ? symbolName(operator.fields?.get('op')) : '') || op;
      for (const part of flatten(child, identity()).parts) operands.push({ part, op: childOp });
    }
    out.parts.push({
      kind: 'Csg',
      spec: csg,
      matrix,
      material: materialOf(root),
      smooth,
      csg: { op, operands },
      entity: root,
    });
    return out;
  }
  const primitive = primitiveOf(root);
  if (primitive !== null && !zeroScale(matrix)) {
    out.parts.push({
      kind: primitive[0],
      spec: primitive[1],
      matrix,
      material: materialOf(root),
      smooth,
      csg: null,
      entity: root,
    });
  }
  for (const child of childrenOf(root)) flatten(child, matrix, out);
  return out;
}

function symbolName(v: Value | undefined): string {
  if (v?.k === 'symbol') return v.name;
  if (v?.k === 'entity') return v.entity?.name ?? '';
  return '';
}
