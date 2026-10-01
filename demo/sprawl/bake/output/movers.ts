/**
 * The things that move through the city, baked from the reference's own templates: its vehicles,
 * its people and its drones, each a few meshes the runtime draws as instanced parts.
 *
 * **A vehicle is a white paint mesh, an underglow mesh and a fixed mesh.** The parts its
 * `VehiclePart` slots name body — body, cab, hood, roof, trunk, nose, shoulder — are white, so an
 * instance's tint is its paint; the glow slots are white too, tinted by its glow; everything else
 * keeps its own colours, the lamps emissive, which the frame's night gates. **A person is its body
 * split by `NpcSlot`** — skin, cloth, second cloth, hair, accent — white for a palette's tint, and
 * **each `Limb` pivot a mesh of its own in the pivot's frame**, which the stride turns about it: the
 * reference's rigid limbs. **A drone is its parts, fixed**, but for a light carrying `Blink`, which is a
 * mesh of its own tinted `blink` — the runtime switches it on each drone's own beat at the rate and
 * duty the kind carries — and glows in its own colour, so the tint reaches its light. Baked into the
 * frame, every drone's strobe burned at eight all night, and from the air the city was under a field
 * of white stars.
 *
 * Movers are drawn untextured, in the colours their parts carry: none of the reference's movers
 * wears a picture a walker would read at their size.
 */
import { expandAssembly } from '@driftengine/drft';
import type { MeshData } from '@driftengine/drft';

import type { MoverKindData, Tint } from '../../data/life.ts';
import type { Instance } from '../mesh/instances.ts';
import { instantiateAll } from '../mesh/instantiate.ts';
import { localMatrix, multiply } from '../mesh/flatten.ts';
import type { Matrix, Part } from '../mesh/flatten.ts';
import { Kit } from '../mesh/kit.ts';
import { linear, surfaceOf } from '../mesh/materials.ts';
import type { Surface } from '../mesh/materials.ts';
import { Builder, surfaceRecord, windowShift } from '../mesh/region.ts';
import type { ScriptRead } from '../script/reader.ts';
import type { Value } from '../script/values.ts';
import { effective } from '../script/world.ts';
import type { ScriptEntity } from '../script/world.ts';
import type { TexturePlan } from '../textures/plan.ts';

export interface MoverMesh {
  readonly mesh: MeshData;
  readonly tint: Tint;
  /** The limb it hangs from, by index, or −1 for the body. */
  readonly limb: number;
}

export interface Limb {
  /** Where the limb turns about, in the body's frame. */
  readonly pivot: readonly [number, number, number];
  readonly phase: number;
  /** How far it swings each way, radians. */
  readonly swing: number;
  readonly lift: number;
}

export interface MoverKind {
  readonly name: string;
  readonly role: MoverKindData['role'];
  readonly meshes: MoverMesh[];
  readonly limbs: Limb[];
  /** Its blinking lights' beat: hertz, and the share lit. */
  readonly blink?: readonly [number, number];
}

const PAINT = new Set(['PartBody', 'Cab', 'Hood', 'Roof', 'Trunk', 'Nose', 'Shoulder']);
const GLOW = new Set(['GlowL', 'GlowR']);
const SLOTS: readonly Tint[] = ['skin', 'cloth', 'cloth2', 'hair', 'accent'];
/** Movers wear no pictures, so every surface stands on the blank layer. */
const BLANK_PLAN = { classes: [], layerOf: () => ({ cls: 0, layer: 0 }) } as unknown as TexturePlan;

const field = (v: Value | undefined, key: string): Value | undefined =>
  v?.k === 'struct' ? v.fields?.get(key) : undefined;
const num = (v: Value | undefined, key: string, fallback: number): number => {
  const f = field(v, key);
  return f?.k === 'num' ? f.v : fallback;
};
const symbol = (v: Value | undefined, key: string): string => {
  const f = field(v, key);
  return f?.k === 'symbol' ? f.name : f?.k === 'entity' ? (f.entity?.name ?? '') : '';
};

/** How a mover is baked beyond its template: its own name, the props it takes, and its paint. */
export interface MoverOptions {
  readonly as?: string;
  readonly props?: ReadonlyMap<string, Value>;
  /**
   * A colour handed to the template as its paint, 0–255: whatever wears it is the paint an instance
   * tints — how a template that takes its colour as a prop says which parts are painted.
   */
  readonly sentinel?: readonly [number, number, number];
}

/** A template instantiated at the origin, split into meshes by what tints each part. */
export function bakeMover(
  read: ScriptRead,
  name: string,
  role: MoverKind['role'],
  options: MoverOptions = {},
): MoverKind | null {
  const at: Instance = {
    name,
    props: options.props ?? new Map(),
    position: [0, 0],
    y: 0,
    yaw: 0,
    source: role,
  };
  const sentinel = options.sentinel?.map((c) => linear(c));
  const made = instantiateAll(read, [at]);
  if (made.parts.length === 0) return null;
  const kit = new Kit();
  const limbs: Limb[] = [];
  const pivots = new Map<ScriptEntity, { index: number; inverse: Matrix }>();
  const groups = new Map<string, { tint: Tint; limb: number; b: Builder }>();
  let blink: [number, number] | undefined;
  for (const part of made.parts) {
    const surface = surfaceOf(part.material);
    const blinks = nearest(part.entity, 'Blink');
    const limb = role === 'person' ? limbOf(part.entity, pivots, limbs) : null;
    if (blinks !== undefined) blink ??= [num(blinks, 'rate', 1), num(blinks, 'duty', 0.5)];
    const tint =
      blinks !== undefined
        ? 'blink'
        : sentinel !== undefined &&
            surface.color.every((c, k) => Math.abs(c - (sentinel[k] as number)) < 1e-4)
          ? 'paint'
          : tintOf(part.entity, role);
    const placed: Part =
      limb === null ? part : { ...part, matrix: multiply(limb.inverse, part.matrix) };
    const copy = kit.copyOf(placed, surface);
    if (copy === null) continue;
    const key = `${limb?.index ?? -1}|${tint ?? ''}`;
    const group = groups.get(key) ?? { tint, limb: limb?.index ?? -1, b: new Builder() };
    /* A paint or a slot is white for its tint; a blinking light keeps its colour and glows in it. */
    const worn: Surface =
      tint === null
        ? surface
        : tint === 'blink'
          ? { ...surface, emissiveColor: null }
          : { ...surface, color: [1, 1, 1] };
    group.b.add(copy, surfaceRecord(worn, BLANK_PLAN), windowShift(worn));
    groups.set(key, group);
  }
  const meshes = [...groups.values()].map(({ tint, limb, b }) => ({
    mesh: expandAssembly(b.finish(), (o) => kit.pieces[o] as MeshData),
    tint,
    limb,
  }));
  return {
    name: options.as ?? name,
    role,
    meshes,
    limbs,
    ...(blink === undefined ? {} : { blink }),
  };
}

/** What tints a part: its vehicle slot, or its person slot, or nothing. */
function tintOf(entity: ScriptEntity, role: MoverKind['role']): Tint {
  if (role === 'vehicle') {
    const slot = symbol(nearest(entity, 'VehiclePart'), 'slot');
    return PAINT.has(slot) ? 'paint' : GLOW.has(slot) ? 'glow' : null;
  }
  if (role === 'person') {
    const slot = nearest(entity, 'NpcSlot');
    return slot === undefined ? null : (SLOTS[num(slot, 'slot', -1)] ?? null);
  }
  return null;
}

/** A component on an entity or the nearest ancestor that carries it. */
function nearest(entity: ScriptEntity | null, component: string): Value | undefined {
  for (let e = entity; e !== null; e = e.parent) {
    const v = effective(e, component);
    if (v !== undefined) return v;
  }
  return undefined;
}

/** The limb a part hangs from — its nearest ancestor with a `Limb` — registered once. */
function limbOf(
  entity: ScriptEntity,
  pivots: Map<ScriptEntity, { index: number; inverse: Matrix }>,
  limbs: Limb[],
): { index: number; inverse: Matrix } | null {
  let pivot: ScriptEntity | null = entity;
  while (pivot !== null && effective(pivot, 'Limb') === undefined) pivot = pivot.parent;
  if (pivot === null) return null;
  const known = pivots.get(pivot);
  if (known !== undefined) return known;
  const world = worldOf(pivot);
  const value = effective(pivot, 'Limb');
  limbs.push({
    pivot: [world[12] as number, world[13] as number, world[14] as number],
    phase: num(value, 'phase', 0),
    swing: num(value, 'swing', 0),
    lift: num(value, 'lift', 0),
  });
  const entry = { index: limbs.length - 1, inverse: invertRigid(world) };
  pivots.set(pivot, entry);
  return entry;
}

/** An entity's matrix in its instance's frame: its own and every ancestor's, from the top down. */
function worldOf(entity: ScriptEntity): Matrix {
  const chain: ScriptEntity[] = [];
  for (let e: ScriptEntity | null = entity; e !== null && e.parent !== null; e = e.parent) {
    chain.push(e);
  }
  let m = localMatrix(chain[chain.length - 1] as ScriptEntity);
  for (let i = chain.length - 2; i >= 0; i--)
    m = multiply(m, localMatrix(chain[i] as ScriptEntity));
  return m;
}

/** The inverse of a rotation and a translation: the rotation's transpose, the translation undone. */
function invertRigid(m: Matrix): Matrix {
  const out = new Float64Array(16);
  for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) out[c * 4 + r] = m[r * 4 + c] as number;
  for (let r = 0; r < 3; r++) {
    out[12 + r] = -(
      (out[r] as number) * (m[12] as number) +
      (out[4 + r] as number) * (m[13] as number) +
      (out[8 + r] as number) * (m[14] as number)
    );
  }
  out[15] = 1;
  return out;
}
