/**
 * The placed city cut into square regions, each one assembly a material class — painted copies of
 * the kit — and the furniture that repeats unchanged placed as copies of one mesh.
 *
 * **A material class is what one draw can bind**: a blend mode, a texture array, and for a blended
 * surface its opacity, to a tenth. A region is then a handful of assemblies, and a draw each.
 * **An additive surface's opacity goes into its colour** — adding a colour at a quarter strength is
 * adding a quarter of it — so additive surfaces share a class whatever their opacity. A blended one
 * cannot, because blending needs the opacity where the colour is mixed, and a vertex has no lane
 * for it in an assembly.
 *
 * **What repeats unchanged is instanced, not copied part by part.** A street lamp is twenty parts
 * placed six thousand times with the same props; as copies it would be a hundred and twenty
 * thousand, as instances it is one mesh a material class and a matrix a lamp. Which sources repeat
 * is the caller's to say.
 *
 * **A facade's lit windows differ building by building** through the copy: its vertices carry the
 * building's light (`materials.ts`) and its coordinates are shifted by whole repeats from the
 * building's seed, which moves which windows the hash lights without moving the picture.
 */
import {
  ATTR_CHANNEL,
  ATTR_EMISSIVE_COLOR,
  ATTR_LAYERS,
  ATTR_ROUGHNESS,
  ATTR_SPECULAR,
  ATTR_TANGENT,
  ATTR_UVS,
  COPY_MATRIX_FLOATS,
  COPY_UV_FLOATS,
  SURFACE,
  SURFACE_FLOATS,
  assemblyBounds,
  expandAssembly,
} from '@driftengine/drft';
import type { DrftAssembly, MeshData } from '@driftengine/drft';

import type { ScriptRead } from '../script/reader.ts';
import type { Value } from '../script/values.ts';
import type { Marker, Part } from './flatten.ts';
import type { Instance } from './instances.ts';
import { instantiateAll, placement } from './instantiate.ts';
import { Kit } from './kit.ts';
import { instanceLights } from './lights.ts';
import type { CityLight } from './lights.ts';
import type { CopyOf } from './kit.ts';
import { PieceMeasures } from './measure.ts';
import { simpler } from './simpler.ts';
import { Elevation } from './visible.ts';
import { surfaceOf } from './materials.ts';
import type { Surface } from './materials.ts';
import { volumeOf } from './volumes.ts';
import type { CityVolume } from './volumes.ts';
import { planTextures } from '../textures/plan.ts';
import { SPECIES, growTree, leafPicture } from './trees.ts';
import type { TreeSpec } from './trees.ts';
import type { TexturePlan } from '../textures/plan.ts';

export const ASSEMBLY_BITS =
  ATTR_UVS | ATTR_TANGENT | ATTR_LAYERS | ATTR_EMISSIVE_COLOR | ATTR_ROUGHNESS | ATTR_SPECULAR;

export interface MaterialClass {
  readonly blend: Surface['blend'];
  /** The texture plan's class: which array. */
  readonly texture: number;
  /** A blended class's opacity, to a tenth; 1 otherwise. */
  readonly alpha: number;
  /** Whether its copies carry their pieces' sway: a tree's wood and leaves. */
  readonly sway: boolean;
}

export interface BakedRegion {
  readonly id: number;
  readonly bounds: Float32Array;
  readonly assemblies: { readonly cls: MaterialClass; readonly assembly: DrftAssembly }[];
  /** Copies of a prototype: its index in `prototypes`, and sixteen floats a copy. */
  readonly groups: { readonly prototype: number; readonly transforms: Float32Array }[];
  /** What its coarse level keeps whole. */
  readonly coarse: CoarseCopy[];
}

export interface BakedCity {
  readonly kit: Kit;
  readonly plan: TexturePlan;
  readonly regions: BakedRegion[];
  readonly prototypes: { readonly cls: MaterialClass; readonly mesh: MeshData }[];
  /** Templates, prefabs and bases the instances named and the scripts do not declare, by name. */
  readonly missing: ReadonlyMap<string, number>;
  /** Every building and landmark, as the coarse levels need it. */
  readonly buildings: BakedBuilding[];
  /** Every fixed light the instances carry, placed. */
  readonly lights: CityLight[];
  /** Every volume of light standing in the air, placed: parts the geometry leaves out. */
  readonly volumes: CityVolume[];
  /** What each kind of instance costs the finest levels: copies, and the triangles they expand to. */
  readonly cost: ReadonlyMap<string, { copies: number; triangles: number }>;
}

/**
 * A building as its region's coarse level draws it: its box — the footprint and height its props
 * give, or its lot's outline where that is not a rectangle — and what its opaque, unlit parts show
 * from outside (`visible.ts`): on its walls, band by band, and on its roof. The rest of those parts
 * is what the box leaves out.
 */
export interface BakedBuilding {
  readonly region: number;
  readonly box: {
    readonly x: number;
    readonly z: number;
    readonly yaw: number;
    readonly w: number;
    readonly d: number;
    readonly h: number;
    /** The ground storey's height: what an occluder leaves out so it never hides its street. */
    readonly ground: number;
  };
  /** The outline in the building's own x, z, where its lot is not a rectangle. */
  readonly footprint: readonly number[] | null;
  readonly walls: Map<string, Worn>;
  readonly roofs: Map<string, Worn>;
  /**
   * How far its walls reach in each `WALL_BAND`, in its own frame: the least and most x, then z,
   * four slots a band — so a tower that steps back is boxed as narrow as it stands.
   */
  readonly reach: number[];
  /** How high its walls rise, whatever its props say. */
  readonly top: number;
}

/** A surface a building shows: how much of it, and the copy with the most of it to measure. */
export interface Worn {
  readonly surface: Surface;
  area: number;
  largest: CopyOf;
  largestArea: number;
  /** A wall's showing area by height, `WALL_BAND` metres a slot from the ground; empty on a roof. */
  readonly bands: number[];
}

/**
 * The height a building's walls are read in: a coarse level stacks its box from runs of this, each
 * wearing what covers most of it, so a lit shopfront or a storey of accent survives the fold.
 */
export const WALL_BAND = 2;

/** A copy a region's coarse level keeps: as broad as the level's error, simplified as it allows. */
export interface CoarseCopy {
  readonly cls: MaterialClass;
  readonly copy: CopyOf;
  readonly record: readonly number[];
  readonly shift: readonly [number, number];
}

/**
 * The coarse level's geometric error: the most it leaves out. A part narrower than this — its box's
 * middle side, since a long thin rail shows its width, not its length — is dropped unless it covers
 * the ground, and a building's ornament folds into its box, which a parapet, a cornice or a roof's
 * plant rises past by about this much.
 */
export const COARSE_ERROR = 4;

export interface RegionOptions {
  /** The side of a region in metres. 100 unless given. */
  readonly size?: number;
  /** The sources whose instances repeat unchanged and are instanced. */
  readonly instanced?: ReadonlySet<string>;
}

export const classKey = (c: MaterialClass): string =>
  `${c.blend}|${c.texture}|${c.alpha}${c.sway ? '|sway' : ''}`;

export function classOf(surface: Surface, plan: TexturePlan): MaterialClass {
  return {
    blend: surface.blend,
    texture: plan.layerOf(surface).cls,
    alpha: surface.blend === 'blend' ? Math.round(surface.alpha * 10) / 10 : 1,
    sway: false,
  };
}

/** The twelve surface floats a copy wears. */
export function surfaceRecord(surface: Surface, plan: TexturePlan): number[] {
  const r = new Array<number>(SURFACE_FLOATS).fill(0);
  const fold = surface.blend === 'additive' ? surface.alpha : 1;
  r[SURFACE.color] = surface.color[0] * fold;
  r[SURFACE.color + 1] = surface.color[1] * fold;
  r[SURFACE.color + 2] = surface.color[2] * fold;
  r[SURFACE.emissive] = surface.emissive * fold;
  r[SURFACE.specular] = surface.metallic;
  const e = surface.emissiveColor;
  r[SURFACE.emissiveColor] = e === null ? -1 : e[0];
  r[SURFACE.emissiveColor + 1] = e === null ? -1 : e[1];
  r[SURFACE.emissiveColor + 2] = e === null ? -1 : e[2];
  r[SURFACE.roughness] = surface.roughness;
  r[SURFACE.layer] = plan.layerOf(surface).layer;
  return r;
}

/** An assembly under construction: surfaces deduplicated, copies appended. */
export class Builder {
  constructor(private readonly attributes: number = ASSEMBLY_BITS) {}
  private readonly surfaces: number[] = [];
  private readonly surfaceIndex = new Map<string, number>();
  private readonly pieces: number[] = [];
  private readonly surfaceOf: number[] = [];
  private readonly transforms: number[] = [];
  private readonly uv: number[] = [];

  add(copy: CopyOf, record: readonly number[], shift: readonly [number, number]): void {
    const key = record.join(',');
    let s = this.surfaceIndex.get(key);
    if (s === undefined) {
      s = this.surfaces.length / SURFACE_FLOATS;
      this.surfaces.push(...record);
      this.surfaceIndex.set(key, s);
    }
    this.pieces.push(copy.piece);
    this.surfaceOf.push(s);
    for (let i = 0; i < COPY_MATRIX_FLOATS; i++) this.transforms.push(copy.matrix[i] as number);
    for (let i = 0; i < COPY_UV_FLOATS; i++) {
      this.uv.push((copy.uv[i] as number) + (i === 6 ? shift[0] : i === 7 ? shift[1] : 0));
    }
  }

  finish(): DrftAssembly {
    return {
      attributes: this.attributes,
      surfaces: new Float32Array(this.surfaces),
      pieces: new Uint32Array(this.pieces),
      surfaceOf: new Uint32Array(this.surfaceOf),
      transforms: new Float32Array(this.transforms),
      uv: new Float32Array(this.uv),
    };
  }
}

/** A grown tree's coordinates are the engine's already: stretched by nothing, offset by nothing. */
const TREE_UV = new Float32Array([1, 1, 1, 1, 1, 1, 0, 0]);

/** A species' leaves, as a surface the texture plan can place: its picture, cut out. */
function leafSurface(species: string): Surface {
  return {
    ...BARK,
    textures: { albedo: leafPicture(species), emissive: null, mr: null },
    blend: 'cutout',
  };
}

/** What a tree's surfaces start from: white, rough, opaque, untextured. */
const BARK: Surface = {
  color: [1, 1, 1],
  alpha: 1,
  emissive: 0,
  emissiveColor: null,
  windowSeed: 0,
  roughness: 0.9,
  metallic: 0,
  textures: { albedo: null, emissive: null, mr: null },
  rooms: null,
  tiling: null,
  transform: { sx: 1, sy: 1, ox: 0, oy: 0 },
  clamp: false,
  blend: 'opaque',
  effect: undefined,
};

/** What a tree grows from, and the height it is scaled to: a hedge is grown at its size and is not. */
function treeOf(part: Part): { spec: TreeSpec; scale: number } {
  const f = (k: string): Value | undefined =>
    part.spec.k === 'struct' ? part.spec.fields?.get(k) : undefined;
  const n = (k: string, fallback: number): number => {
    const v = f(k);
    return v?.k === 'num' ? v.v : fallback;
  };
  const s = f('species');
  const species = s?.k === 'symbol' ? s.name : s?.k === 'entity' ? (s.entity?.name ?? '') : '';
  const known = SPECIES[species] === undefined ? 'TreePlane' : species;
  const tenth = (x: number): number => Math.round(x * 10) / 10;
  const hedge = known === 'TreeHedge';
  return {
    spec: {
      species: known,
      variant: Math.abs(Math.round(n('seed', 0))) % 4,
      bare: n('bare', 0) > 0.4 ? 0.8 : 0,
      size: hedge ? [tenth(n('width', 1)), tenth(n('height', 1)), tenth(n('depth', 1))] : null,
      leafSize: hedge ? tenth(n('leaf_size', 0.8)) : 1,
    },
    scale: hedge ? 1 : n('height', 1),
  };
}

/** A number an instance's props give, or `fallback`. */
function propNumber(inst: Instance, key: string, fallback: number): number {
  const v = inst.props.get(key);
  return v?.k === 'num' ? v.v : fallback;
}

/**
 * Whether a coarse level keeps a copy: as broad as its error, or covering the ground — a pavement
 * narrower than the error still keeps its place, since under it there is nothing to see instead —
 * or, lit, as long as the error: a strip of light reads from much further than its width, and at
 * night it is most of what a distant building is.
 */
function coarseKeeps(measures: PieceMeasures, copy: CopyOf, lit: boolean): boolean {
  const [longest, middle] = measures.sides(copy);
  return (
    middle >= COARSE_ERROR ||
    (lit && longest >= COARSE_ERROR) ||
    measures.facing(copy).up >= COARSE_ERROR * COARSE_ERROR
  );
}

/** Whether a surface gives light of its own: glows, or is lit at night. */
const lit = (surface: Surface): boolean => surface.emissive > 0 || surface.blend === 'additive';

/**
 * A polygon lot's outline, as its props carry it: six corners, the last repeated to fill, so a
 * corner the same as the one before it — or, last, as the first — is dropped.
 */
function footprintOf(inst: Instance): number[] | null {
  if (!inst.props.has('px0')) return null;
  const out: number[] = [];
  for (let i = 0; i < 6; i++) {
    const [x, z] = [propNumber(inst, `px${i}`, 0), propNumber(inst, `pz${i}`, 0)];
    const n = out.length;
    const same = (ax: number, az: number): boolean => Math.hypot(x - ax, z - az) < 1e-3;
    if (n > 0 && same(out[n - 2] as number, out[n - 1] as number)) continue;
    if (i === 5 && n > 0 && same(out[0] as number, out[1] as number)) continue;
    out.push(x, z);
  }
  return out;
}

/** A surface a building's parts wear, as drawing them from outside met it. */
interface Shown {
  readonly id: number;
  readonly surface: Surface;
  /** The copy of it with the most wall, and the one with the most roof. */
  side: { copy: CopyOf; area: number } | null;
  up: { copy: CopyOf; area: number } | null;
}

/** What a building's walls and roof show, by surface, from what its views saw. */
function wornOf(
  seen: Elevation,
  shown: ReadonlyMap<string, Shown>,
): Pick<BakedBuilding, 'walls' | 'roofs' | 'reach' | 'top'> {
  const { bands, reach, top: height } = seen.walls(WALL_BAND);
  const top = seen.roof();
  const walls = new Map<string, Worn>();
  const roofs = new Map<string, Worn>();
  for (const [key, s] of shown) {
    const largest = s.side ?? s.up;
    if (largest === null) continue;
    const wall = bands.get(s.id);
    if (wall !== undefined) {
      const area = wall.reduce((a, b) => a + b, 0);
      walls.set(key, {
        surface: s.surface,
        area,
        largest: largest.copy,
        largestArea: largest.area,
        bands: wall,
      });
    }
    const roof = top.get(s.id);
    const over = s.up ?? s.side;
    if (roof !== undefined && over !== null) {
      roofs.set(key, {
        surface: s.surface,
        area: roof,
        largest: over.copy,
        largestArea: over.area,
        bands: [],
      });
    }
  }
  return { walls, roofs, reach, top: height };
}

/** Whole repeats a building's seed shifts its windows by: moves the lit ones, not the picture. */
export function windowShift(surface: Surface): [number, number] {
  if (surface.effect?.windows === undefined || surface.windowSeed === 0) return [0, 0];
  const seed = Math.abs(Math.round(surface.windowSeed));
  return [seed % 17, (seed * 7) % 13];
}

/** The id of the region `size` metres square that holds (x, z): a grid offset so every id is whole. */
export function regionIdAt(x: number, z: number, size: number): number {
  return (Math.floor(z / size) + 1000) * 2000 + Math.floor(x / size) + 1000;
}

export function bakeRegions(
  read: ScriptRead,
  instances: readonly Instance[],
  options: RegionOptions = {},
): BakedCity {
  const size = options.size ?? 100;
  const instanced = options.instanced ?? new Set<string>();
  /* First every part and its surface, since the texture plan needs them all before a layer is known. */
  const flat: { inst: Instance; parts: Part[]; surfaces: Surface[]; key: string | null }[] = [];
  const shared = new Map<string, Marker[]>();
  const missing = new Map<string, number>();
  const lights: CityLight[] = [];
  /* Light standing in the air leaves the geometry (`volumes.ts`); a repeating instance's, once. */
  const volumes: CityVolume[] = [];
  const sharedAir = new Map<string, Part[]>();
  const placeAir = (air: readonly Part[], place?: ReturnType<typeof placement>): void => {
    for (const p of air) {
      const v = volumeOf(p, place);
      if (v !== null) volumes.push(v);
    }
  };
  for (const inst of instances) {
    const repeats = instanced.has(inst.source);
    const key = repeats ? `${inst.name}|${JSON.stringify([...inst.props])}` : null;
    const known = key === null ? undefined : shared.get(key);
    if (known !== undefined) {
      const place = placement(inst.position[0], inst.y, inst.position[1], inst.yaw);
      flat.push({ inst, parts: [], surfaces: [], key });
      lights.push(...instanceLights(inst, known, place));
      placeAir(sharedAir.get(key ?? '') ?? [], place);
      continue;
    }
    /* A repeating instance is flattened where it stands at the origin, once. */
    const at = repeats ? { ...inst, position: [0, 0] as const, y: 0, yaw: 0 } : inst;
    const made = instantiateAll(read, [at]);
    for (const [name, n] of made.missing) missing.set(name, (missing.get(name) ?? 0) + n);
    const parts: Part[] = [];
    const air: Part[] = [];
    for (const p of made.parts) (volumeOf(p) === null ? parts : air).push(p);
    placeAir(
      air,
      key === null ? undefined : placement(inst.position[0], inst.y, inst.position[1], inst.yaw),
    );
    flat.push({ inst, parts, surfaces: parts.map((p) => surfaceOf(p.material)), key });
    if (key !== null) {
      shared.set(key, made.markers);
      sharedAir.set(key, air);
    }
    lights.push(
      ...(key === null
        ? instanceLights(inst, made.markers)
        : instanceLights(
            inst,
            made.markers,
            placement(inst.position[0], inst.y, inst.position[1], inst.yaw),
          )),
    );
  }
  const species = new Set<string>();
  for (const f of flat)
    for (const p of f.parts) if (p.kind === 'Tree') species.add(treeOf(p).spec.species);
  const plan = planTextures([...flat.flatMap((f) => f.surfaces), ...[...species].map(leafSurface)]);
  const kit = new Kit();

  const regions = new Map<
    number,
    {
      builders: Map<string, { cls: MaterialClass; b: Builder }>;
      groups: Map<number, number[]>;
      coarse: CoarseCopy[];
    }
  >();
  const regionAt = (x: number, z: number) => {
    const id = regionIdAt(x, z, size);
    let r = regions.get(id);
    if (r === undefined) {
      r = { builders: new Map(), groups: new Map(), coarse: [] };
      regions.set(id, r);
    }
    return r;
  };

  const prototypes: { cls: MaterialClass; mesh: MeshData }[] = [];
  const prototypesOf = new Map<string, number[]>();
  /** A tree placed: copies of its variant's wood and leaves, grown the first time it is met. */
  const grown = new Map<string, ReturnType<typeof growTree>>();
  const plant = (part: Part): void => {
    const { spec, scale } = treeOf(part);
    const key = `tree|${JSON.stringify(spec)}`;
    const leaf = leafSurface(spec.species);
    const at = plan.layerOf(leaf);
    let tree = grown.get(key);
    if (tree === undefined) {
      tree = growTree(spec, at.layer, at.layer);
      grown.set(key, tree);
    }
    const m = part.matrix;
    const matrix = new Float32Array(COPY_MATRIX_FLOATS);
    for (let c = 0; c < 3; c++)
      for (let row = 0; row < 3; row++) matrix[c * 3 + row] = (m[c * 4 + row] as number) * scale;
    matrix.set([m[12] as number, m[13] as number, m[14] as number], 9);
    const r = regionAt(m[12] as number, m[14] as number);
    /* Wood and leaves wear one picture — bark in its top-left quarter — so one array and layer,
       the wood opaque and the leaves cut out, each painted white under its picture. */
    const pieces: [MeshData | null, string, MaterialClass][] = [
      [tree.wood, 'wood', { blend: 'opaque', texture: at.cls, alpha: 1, sway: true }],
      [tree.leaves, 'leaves', { blend: 'cutout', texture: at.cls, alpha: 1, sway: true }],
    ];
    const record = surfaceRecord({ ...leaf, color: [1, 1, 1] }, plan);
    for (const [mesh, name, cls] of pieces) {
      if (mesh === null) continue;
      const piece = kit.addPiece(`${key}|${name}`, () => mesh);
      const entry = r.builders.get(classKey(cls)) ?? {
        cls,
        b: new Builder(ASSEMBLY_BITS | ATTR_CHANNEL),
      };
      entry.b.add({ piece, matrix, uv: TREE_UV }, record, [0, 0]);
      r.builders.set(classKey(cls), entry);
    }
  };

  const measures = new PieceMeasures(kit.pieces);
  const buildings: BakedBuilding[] = [];
  const cost = new Map<string, { copies: number; triangles: number }>();
  for (const f of flat) {
    if (f.key !== null) {
      let protos = prototypesOf.get(f.key);
      if (protos === undefined) {
        protos = [];
        const byClass = new Map<string, { cls: MaterialClass; b: Builder }>();
        f.parts.forEach((part, i) => {
          const surface = f.surfaces[i] as Surface;
          const copy = kit.copyOf(part, surface);
          if (copy === null) return;
          const cls = classOf(surface, plan);
          const entry = byClass.get(classKey(cls)) ?? { cls, b: new Builder() };
          entry.b.add(copy, surfaceRecord(surface, plan), windowShift(surface));
          byClass.set(classKey(cls), entry);
        });
        for (const { cls, b } of byClass.values()) {
          prototypes.push({
            cls,
            mesh: expandAssembly(b.finish(), (o) => kit.pieces[o] as MeshData),
          });
          protos.push(prototypes.length - 1);
        }
        prototypesOf.set(f.key, protos);
      }
      const r = regionAt(f.inst.position[0], f.inst.position[1]);
      const m = placement(f.inst.position[0], f.inst.y, f.inst.position[1], f.inst.yaw);
      for (const p of protos) {
        const list = r.groups.get(p) ?? [];
        for (let i = 0; i < 16; i++) list.push(m[i] as number);
        r.groups.set(p, list);
      }
      continue;
    }
    const src = f.inst.source;
    const box =
      src === 'building'
        ? {
            x: f.inst.position[0],
            z: f.inst.position[1],
            yaw: f.inst.yaw,
            w: propNumber(f.inst, 'w', 10),
            d: propNumber(f.inst, 'd', 10),
            h: propNumber(f.inst, 'h', 10),
            ground: propNumber(f.inst, 'gh', 4),
          }
        : null;
    /* A building's opaque, unlit parts are drawn from outside to see which of them show. */
    const seen = box === null ? null : new Elevation(box);
    const shown = new Map<string, Shown>();
    f.parts.forEach((part, i) => {
      if (part.kind === 'Tree') {
        plant(part);
        return;
      }
      const surface = f.surfaces[i] as Surface;
      const copy = kit.copyOf(part, surface);
      if (copy === null) return;
      const r = regionAt(copy.matrix[9] as number, copy.matrix[11] as number);
      const cls = classOf(surface, plan);
      const entry = r.builders.get(classKey(cls)) ?? { cls, b: new Builder() };
      const record = surfaceRecord(surface, plan);
      const shift = windowShift(surface);
      entry.b.add(copy, record, shift);
      r.builders.set(classKey(cls), entry);
      const spent = cost.get(src) ?? { copies: 0, triangles: 0 };
      spent.copies += 1;
      spent.triangles += (kit.pieces[copy.piece] as MeshData).indices.length / 3;
      cost.set(src, spent);
      if (seen !== null && surface.blend === 'opaque' && surface.emissive === 0) {
        const key = `${record.join(',')}|${shift.join(',')}`;
        const known = shown.get(key) ?? { id: shown.size, surface, side: null, up: null };
        shown.set(key, known);
        seen.add(copy, kit.pieces[copy.piece] as MeshData, known.id);
        const facing = measures.facing(copy);
        if (facing.side > (known.side?.area ?? 0)) known.side = { copy, area: facing.side };
        if (facing.up > (known.up?.area ?? 0)) known.up = { copy, area: facing.up };
      } else {
        for (const kept of simpler(kit, part, surface, copy)) {
          if (coarseKeeps(measures, kept, lit(surface)))
            r.coarse.push({ cls, copy: kept, record, shift });
        }
      }
    });
    if (box !== null && seen !== null) {
      const region = regionIdAt(box.x, box.z, size);
      buildings.push({ region, box, footprint: footprintOf(f.inst), ...wornOf(seen, shown) });
    }
  }

  const piece = (o: number): MeshData => kit.pieces[o] as MeshData;
  const out: BakedRegion[] = [];
  for (const id of [...regions.keys()].sort((a, b) => a - b)) {
    const r = regions.get(id);
    if (r === undefined) continue;
    const bounds = new Float32Array([
      Infinity,
      Infinity,
      Infinity,
      -Infinity,
      -Infinity,
      -Infinity,
    ]);
    const grow = (b: ArrayLike<number>): void => {
      for (let a = 0; a < 3; a++) {
        bounds[a] = Math.min(bounds[a] as number, b[a] as number);
        bounds[a + 3] = Math.max(bounds[a + 3] as number, b[a + 3] as number);
      }
    };
    const assemblies = [...r.builders.values()]
      .sort((x, y) => classKey(x.cls).localeCompare(classKey(y.cls)))
      .map(({ cls, b }) => {
        const assembly = b.finish();
        grow(assemblyBounds(assembly, piece));
        return { cls, assembly };
      });
    const groups = [...r.groups].map(([prototype, list]) => {
      const transforms = new Float32Array(list);
      grow(copiesBounds((prototypes[prototype] as { mesh: MeshData }).mesh, transforms));
      return { prototype, transforms };
    });
    out.push({ id, bounds, assemblies, groups, coarse: r.coarse });
  }
  return { kit, plan, regions: out, prototypes, missing, buildings, cost, lights, volumes };
}

/** Every copy's box of `mesh`, through sixteen-float matrices. */
function copiesBounds(mesh: MeshData, transforms: Float32Array): Float32Array {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  const p = mesh.positions;
  for (let i = 0; i < p.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      lo[a] = Math.min(lo[a] as number, p[i + a] as number);
      hi[a] = Math.max(hi[a] as number, p[i + a] as number);
    }
  }
  const out = new Float32Array([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]);
  for (let k = 0; k + 15 < transforms.length; k += 16) {
    for (let corner = 0; corner < 8; corner++) {
      const c = [
        corner & 1 ? hi[0] : lo[0],
        corner & 2 ? hi[1] : lo[1],
        corner & 4 ? hi[2] : lo[2],
      ] as number[];
      for (let a = 0; a < 3; a++) {
        const w =
          (transforms[k + a] as number) * (c[0] as number) +
          (transforms[k + 4 + a] as number) * (c[1] as number) +
          (transforms[k + 8 + a] as number) * (c[2] as number) +
          (transforms[k + 12 + a] as number);
        out[a] = Math.min(out[a] as number, w);
        out[a + 3] = Math.max(out[a + 3] as number, w);
      }
    }
  }
  return out;
}
