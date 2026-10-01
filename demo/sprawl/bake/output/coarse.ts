/**
 * Each region's coarse level: its buildings as boxes wearing their own facades, and whatever else
 * in it is as large as the level's error, kept whole.
 *
 * **A building's walls are a stack of boxes, one a run of height** — read in `WALL_BAND`s — **each
 * wearing the surface covering most of it, and a slab on top wears the one covering most of its
 * roof**, so a facade's windows still light by the scene's share at any
 * distance and a building's seed still picks which. The city is lit at night more than it is by
 * day, and a box in a mean flat colour would put the skyline out. **Each is shaded to the mean of
 * everything its building wears there** — surface colour times picture mean, linear, by area — so
 * a switch of level does not read as a building brightening or darkening (phase 5, decision 8); a
 * shade more than four times from the surface's own is held at four, since a near-black picture
 * would otherwise ask for a colour past anything the facade was drawn to carry. **The facade keeps
 * its own density** — how often its picture repeats a metre along a wall and up it, measured on the
 * copy that shows the most of it — since a box's sides are not the parts the picture was tiled to.
 * **Each box is as wide as its run's walls reach**, so a tower that steps back is boxed as narrow
 * as it stands and a glow wrapped round an inset band stays outside it. **A lot that is not a
 * rectangle stands as its outline**, extruded.
 *
 * What it gives up: a building's trim and ornament, and a facade's second material where it shares
 * its bands with a first, which the box's shade stands in for; a roof's plant and parapets, up to
 * the level's error.
 */
import type { DrftAssembly } from '@driftengine/drft';

import { placement } from '../mesh/instantiate.ts';
import type { Kit, Shape } from '../mesh/kit.ts';
import type { Surface } from '../mesh/materials.ts';
import { rates } from '../mesh/measure.ts';
import { Builder, classKey, classOf, surfaceRecord, windowShift } from '../mesh/region.ts';
import { WALL_BAND } from '../mesh/region.ts';
import type { BakedBuilding, BakedRegion, MaterialClass, Worn } from '../mesh/region.ts';
import { expandAssembly } from '@driftengine/drft';
import type { MeshData } from '@driftengine/drft';
import type { Value } from '../script/values.ts';
import type { TexturePlan } from '../textures/plan.ts';
import type { Solid } from './lights.ts';
import { occluderBox } from './occluders.ts';

type Rgb = readonly [number, number, number];

/** How thick a box's roof slab is: centred on its top, it stands clear of the walls' own top. */
const ROOF_SLAB = 0.1;
/** The furthest a shade may take a surface from its own colour, either way. */
const SHADE_RANGE = 4;

export interface CoarseInput {
  readonly kit: Kit;
  readonly plan: TexturePlan;
  readonly regions: readonly Pick<BakedRegion, 'id' | 'coarse'>[];
  readonly buildings: readonly BakedBuilding[];
}

/** Every region's coarse level and occluders, by region id. */
export interface CoarseCity {
  /** Its assemblies, one a material class. */
  readonly levels: Map<number, { cls: MaterialClass; assembly: DrftAssembly }[]>;
  /** Its buildings' occluder boxes, six floats each (`occluders.ts`). */
  readonly occluders: Map<number, number[]>;
  /** Every building's boxes across the city, which occlude its light (`lights.ts`). */
  readonly solids: Solid[];
}

/**
 * Every region's coarse level, and an occluder for each run of its buildings' walls. `picture` is
 * the linear mean of a surface's albedo picture, white where it has none.
 */
export function coarseLevels(city: CoarseInput, picture: (surface: Surface) => Rgb): CoarseCity {
  const byRegion = new Map<number, BakedBuilding[]>();
  for (const b of city.buildings) {
    const list = byRegion.get(b.region) ?? [];
    list.push(b);
    byRegion.set(b.region, list);
  }
  const out = new Map<number, { cls: MaterialClass; assembly: DrftAssembly }[]>();
  const occluders = new Map<number, number[]>();
  const solids: Solid[] = [];
  for (const region of city.regions) {
    const boxes: number[] = [];
    const builders = new Map<string, { cls: MaterialClass; b: Builder }>();
    const add = (
      cls: MaterialClass,
      copy: Parameters<Builder['add']>[0],
      record: readonly number[],
      shift: readonly [number, number],
    ): void => {
      const entry = builders.get(classKey(cls)) ?? { cls, b: new Builder() };
      entry.b.add(copy, record, shift);
      builders.set(classKey(cls), entry);
    };
    for (const c of region.coarse) add(c.cls, c.copy, c.record, c.shift);
    for (const building of byRegion.get(region.id) ?? []) {
      for (const part of shellOf(city, building, picture, boxes, solids)) {
        add(classOf(part.surface, city.plan), part.copy, part.record, windowShift(part.surface));
      }
    }
    out.set(
      region.id,
      [...builders.values()]
        .sort((x, y) => classKey(x.cls).localeCompare(classKey(y.cls)))
        .map(({ cls, b }) => ({ cls, assembly: b.finish() })),
    );
    occluders.set(region.id, boxes);
  }
  return { levels: out, occluders, solids };
}

type Placed = { surface: Surface; copy: Parameters<Builder['add']>[0]; record: number[] };
/** A surface and how much of it a mean counts. */
type Weighed = { readonly surface: Surface; readonly weight: number };

/** A building's walls, a box a run of bands, and its roof, each wearing its shaded surface. */
function shellOf(
  city: CoarseInput,
  building: BakedBuilding,
  picture: (surface: Surface) => Rgb,
  occluders: number[],
  solids: Solid[],
): Placed[] {
  const out: Placed[] = [];
  const { yaw, ground } = building.box;
  /* The walls as high as they rise, not as high as the props say: a roof garden, a lower wing. */
  const h = building.top;
  const runs = wallRuns(building.walls, h);
  for (const run of runs) {
    const surface = shaded(run.most.surface, run.weights, picture);
    const extent = reachOf(building, run.from, run.to);
    const height = run.top - run.bottom;
    /* An outline occludes light as its bounds, and nothing as an occluder, which must be inside. */
    const solid = building.footprint === null ? extent : boundsOf(building.footprint);
    const [sx, sz] = worldOf(building, solid);
    solids.push({ x: sx, z: sz, yaw, w: solid.w, d: solid.d, bottom: run.bottom, top: run.top });
    if (building.footprint === null) {
      const box = occluderBox(
        sx,
        sz,
        yaw,
        extent.w,
        extent.d,
        Math.max(run.bottom, ground),
        run.top,
      );
      if (box !== null) occluders.push(...box);
    }
    const placed = partOf(city, building, run.most, surface, extent, run.bottom, height, false);
    if (placed !== null) out.push(placed);
  }
  const top = dominant(building.roofs);
  if (top !== null) {
    const weights = [...building.roofs.values()].map((w) => ({
      surface: w.surface,
      weight: w.area,
    }));
    const surface = shaded(top.surface, weights, picture);
    /* The roof covers the top run, as far as it reaches. */
    const last = runs[runs.length - 1];
    const extent = reachOf(building, last?.from ?? 0, last?.to ?? 0);
    const placed = partOf(city, building, top, surface, extent, h - ROOF_SLAB / 2, ROOF_SLAB, true);
    if (placed !== null) out.push(placed);
  }
  return out;
}

/**
 * A building's walls as runs of bands, bottom up, each worn by what covers most of its bands and
 * weighing everything that covers them. A band nothing covers — hidden, or open — carries the run
 * below it on, or the walls' commonest surface where it is the first.
 */
function wallRuns(
  walls: ReadonlyMap<string, Worn>,
  h: number,
): { most: Worn; from: number; to: number; bottom: number; top: number; weights: Weighed[] }[] {
  const overall = dominant(walls);
  if (overall === null) return [];
  const bands = Math.max(1, Math.ceil(h / WALL_BAND - 1e-6));
  const runs: { most: Worn; from: number; to: number }[] = [];
  for (let b = 0; b < bands; b++) {
    let most: Worn | null = null;
    let best = 0;
    for (const w of walls.values()) {
      const area = w.bands[b] ?? 0;
      if (area > best) {
        best = area;
        most = w;
      }
    }
    const last = runs[runs.length - 1];
    const chosen = most ?? last?.most ?? overall;
    if (last !== undefined && last.most === chosen) last.to = b + 1;
    else runs.push({ most: chosen, from: b, to: b + 1 });
  }
  return runs.map(({ most, from, to }) => {
    const weights: Weighed[] = [];
    for (const w of walls.values()) {
      let weight = 0;
      for (let b = from; b < to; b++) weight += w.bands[b] ?? 0;
      if (weight > 0) weights.push({ surface: w.surface, weight });
    }
    return {
      most,
      from,
      to,
      bottom: from * WALL_BAND,
      top: Math.min(to * WALL_BAND, h),
      weights: weights.length > 0 ? weights : [{ surface: most.surface, weight: 1 }],
    };
  });
}

/** A box in a building's frame: its centre along the building's x and z, and its two sides. */
type Extent = { readonly x: number; readonly z: number; readonly w: number; readonly d: number };

/** An extent's centre out of its building's frame: its x is (cos, −sin) in the world, z (sin, cos). */
function worldOf(building: BakedBuilding, extent: Extent): [number, number] {
  const [c, s] = [Math.cos(building.box.yaw), Math.sin(building.box.yaw)];
  return [
    building.box.x + c * extent.x + s * extent.z,
    building.box.z - s * extent.x + c * extent.z,
  ];
}

/**
 * How far a building's walls reach over bands `from` to `to`, as a box in its frame: the whole
 * footprint where nothing measured them.
 */
function reachOf(building: BakedBuilding, from: number, to: number): Extent {
  let [x0, x1, z0, z1] = [Infinity, -Infinity, Infinity, -Infinity];
  const r = building.reach;
  for (let b = from; b < to && b * 4 < r.length; b++) {
    x0 = Math.min(x0, r[b * 4] as number);
    x1 = Math.max(x1, r[b * 4 + 1] as number);
    z0 = Math.min(z0, r[b * 4 + 2] as number);
    z1 = Math.max(z1, r[b * 4 + 3] as number);
  }
  if (!(x1 > x0 && z1 > z0)) return { x: 0, z: 0, w: building.box.w, d: building.box.d };
  return { x: (x0 + x1) / 2, z: (z0 + z1) / 2, w: x1 - x0, d: z1 - z0 };
}

/**
 * One piece of a building's shell: a box as far as `extent` reaches, or its outline, from `bottom`
 * up `height`, wearing `surface` at the density `most`'s largest copy wears it — along and up a
 * wall, across a roof.
 */
function partOf(
  city: CoarseInput,
  building: BakedBuilding,
  most: Worn,
  surface: Surface,
  extent: Extent,
  bottom: number,
  height: number,
  roof: boolean,
): Placed | null {
  const { yaw } = building.box;
  const { w, d } = extent;
  const [x, z] = worldOf(building, extent);
  const outline = building.footprint;
  const shape =
    outline === null
      ? boxShape(x, z, yaw, w, d, bottom, height)
      : extruded(building.box.x, building.box.z, yaw, outline, bottom, height);
  const copy = city.kit.copyOf(shape, surface);
  if (copy === null) return null;
  const { ru, rv } = rates(expanded(city, most), roof ? 'up' : 'side');
  if (ru > 0 && rv > 0) {
    /* How far the shape's own coordinates run along each piece axis: a box's faces run 0..1
       across its sides; an outline's walls once round it, and its top across its bounds. */
    let along: [number, number, number];
    let up: [number, number, number];
    if (outline === null) {
      along = [w, height, d];
      up = [w, height, d];
    } else if (roof) {
      const [sx, sz] = spans(outline);
      along = [sx, height, sz];
      up = [sx, height, sz];
    } else {
      const round = perimeter(outline);
      along = [round, round, round];
      up = [height, height, height];
    }
    for (let a = 0; a < 3; a++) {
      copy.uv[a] = ru * along[a];
      copy.uv[3 + a] = rv * up[a];
    }
  }
  return { surface, copy, record: surfaceRecord(surface, city.plan) };
}

/** The surface covering the most, or null for none. */
function dominant(worn: ReadonlyMap<string, Worn>): Worn | null {
  let best: Worn | null = null;
  for (const w of worn.values()) if (best === null || w.area > best.area) best = w;
  return best;
}

/** `surface`, coloured so that under its picture it shows the weighted mean of `weights`. */
function shaded(
  surface: Surface,
  weights: readonly Weighed[],
  picture: (surface: Surface) => Rgb,
): Surface {
  const mean = [0, 0, 0];
  let total = 0;
  for (const { surface: s, weight } of weights) {
    const p = picture(s);
    for (let c = 0; c < 3; c++) mean[c] = (mean[c] as number) + weight * s.color[c] * p[c];
    total += weight;
  }
  const own = picture(surface);
  const color = [0, 1, 2].map((c) => {
    const base = surface.color[c];
    if ((own[c] as number) <= 1e-4 || base <= 1e-4 || total <= 0) return base;
    const want = (mean[c] as number) / total / (own[c] as number);
    return Math.min(Math.max(want, base / SHADE_RANGE), base * SHADE_RANGE);
  }) as [number, number, number];
  return { ...surface, color };
}

/** The copy that shows the most of a surface, expanded on its own. */
function expanded(city: CoarseInput, most: Worn): MeshData {
  const one = new Builder();
  one.add(most.largest, surfaceRecord(most.surface, city.plan), [0, 0]);
  return expandAssembly(one.finish(), (o) => city.kit.pieces[o] as MeshData);
}

const num = (v: number): Value => ({ k: 'num', type: 'f32', v });
const struct = (fields: [string, Value][]): Value => ({
  k: 'struct',
  fields: new Map(fields),
  items: [],
});

/** A box `w` × `height` × `d` standing on `bottom`, turned by `yaw` about (x, z). */
function boxShape(
  x: number,
  z: number,
  yaw: number,
  w: number,
  d: number,
  bottom: number,
  height: number,
): Shape {
  return {
    kind: 'Box',
    spec: struct([
      ['x', num(w)],
      ['y', num(height)],
      ['z', num(d)],
    ]),
    matrix: placement(x, bottom + height / 2, z, yaw),
    smooth: null,
    csg: null,
  };
}

/** An outline extruded from `bottom` up `height`, turned by `yaw` about (x, z). */
function extruded(
  x: number,
  z: number,
  yaw: number,
  outline: readonly number[],
  bottom: number,
  height: number,
): Shape {
  const matrix = placement(x, bottom, z, yaw);
  for (let r = 0; r < 3; r++) matrix[4 + r] = (matrix[4 + r] as number) * height;
  const points: Value[] = [];
  for (let i = 0; i + 1 < outline.length; i += 2) {
    points.push(
      struct([
        ['x', num(outline[i] as number)],
        ['y', num(outline[i + 1] as number)],
      ]),
    );
  }
  return {
    kind: 'Extrude',
    spec: struct([
      ['profile', { k: 'vector', items: points }],
      ['height', num(1)],
    ]),
    matrix,
    smooth: null,
    csg: null,
  };
}

function perimeter(outline: readonly number[]): number {
  let round = 0;
  const n = outline.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    round += Math.hypot(
      (outline[j * 2] as number) - (outline[i * 2] as number),
      (outline[j * 2 + 1] as number) - (outline[i * 2 + 1] as number),
    );
  }
  return round;
}

/** An outline's bounds as a box in its building's frame. */
function boundsOf(outline: readonly number[]): Extent {
  const xs = outline.filter((_, i) => i % 2 === 0);
  const zs = outline.filter((_, i) => i % 2 === 1);
  const [x0, x1, z0, z1] = [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)];
  return { x: (x0 + x1) / 2, z: (z0 + z1) / 2, w: x1 - x0, d: z1 - z0 };
}

/** How far an outline reaches along x and along z. */
function spans(outline: readonly number[]): [number, number] {
  const xs = outline.filter((_, i) => i % 2 === 0);
  const zs = outline.filter((_, i) => i % 2 === 1);
  return [Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs)];
}
