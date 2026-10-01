/**
 * The road surface as the reference's host lays it, from its own slab templates: along each segment
 * a carriageway, a median where the class has one, and a kerb and a sidewalk either side; where
 * roads cross, a square of junction surface with paving at its corners, a crosswalk across every
 * approach and a stop bar before it on the lanes that arrive.
 *
 * **The host is compiled and unpublished, so the arrangement is reconstructed** from what its
 * templates and tables say: slabs run `len` along local +x and `width` along +z and are yawed into
 * place; the carriageway's picture spans its width once and repeats every `tile` metres along it,
 * which keeps its texels square; sidewalks and junction paving tile every `walk_tile` metres. A
 * slab is centred on the ground, so a carriageway's top is half its thickness up, and paint sits on
 * it. **What would make it wrong** is a capture where a crosswalk is not a band across the whole
 * carriageway, or a stop bar spans both directions.
 *
 * **A missing arm is paved over**: where a road ends at another, the far side's sidewalk and kerb
 * run on across the mouth it would have had.
 */
import type { Value } from '../script/values.ts';
import type { ScriptWorld } from '../script/world.ts';
import type { CityLayout } from '../layout/layout.ts';
import type { Road } from '../layout/roads.ts';
import { rows } from '../layout/rows.ts';
import type { RoadClass } from '../layout/tables.ts';
import type { Instance } from './instances.ts';

/** The crosswalk band's width along the road: `CrossSlab`'s own default. */
const CROSSING = 3.2;
/** A carriageway slab's thickness, `RoadSlab`'s default: its top is half this above the ground. */
const ROAD_THICK = 0.62;

interface Style {
  readonly barLen: number;
  readonly barInset: number;
  readonly kerbW: number;
  readonly walkTile: number;
  readonly surface: string;
  readonly walk: string;
  readonly kerb: string;
  readonly paint: string;
}

const nameOf = (v: Value | undefined, fallback: string): string =>
  v?.k === 'entity' ? (v.entity?.name ?? fallback) : fallback;

function junctionStyle(world: ScriptWorld): Style {
  const row = rows(world, 'JunctionStyle')[0];
  return {
    barLen: row?.n('bar_len', 0.5) ?? 0.5,
    barInset: row?.n('bar_inset', 1.1) ?? 1.1,
    kerbW: row?.n('kerb_w', 0.34) ?? 0.34,
    walkTile: row?.n('walk_tile', 2) ?? 2,
    surface: nameOf(row?.v('surface'), 'JunctionSurface'),
    walk: nameOf(row?.v('walk'), 'JunctionWalk'),
    kerb: nameOf(row?.v('kerb'), 'JunctionKerb'),
    paint: nameOf(row?.v('paint'), 'JunctionPaint'),
  };
}

const carriage = (c: RoadClass): number => 2 * c.lanes * c.laneWidth + c.median;
const f32 = (v: number): Value => ({ k: 'num', type: 'f32', v: Math.fround(v) });

/** One slab: a template, its size and tiling, a material, a place along or across a road. */
export function slab(
  name: string,
  base: string,
  size: { len: number; width: number; tu: number; tv: number },
  x: number,
  z: number,
  alongZ: boolean,
  y = 0,
): Instance {
  const props = new Map<string, Value>([
    ['len', f32(size.len)],
    ['width', f32(size.width)],
    ['tu', f32(size.tu)],
    ['tv', f32(size.tv)],
  ]);
  /* T · Ry: a quarter turn back takes local +x to world +z. */
  return {
    name,
    props,
    position: [x, z],
    y,
    yaw: alongZ ? -Math.PI / 2 : 0,
    source: 'road',
    bases: [base],
  };
}

interface Arm {
  readonly cls: RoadClass;
}

export function roadInstances(layout: CityLayout, world: ScriptWorld): Instance[] {
  const style = junctionStyle(world);
  const net = layout.roads;
  const out: Instance[] = [];
  const key = (x: number, z: number): string => `${Math.round(x * 10)},${Math.round(z * 10)}`;
  /* What meets at each junction, arm by arm: +z, −z, +x, −x. */
  const arms = new Map<string, (Arm | null)[]>();
  const armsAt = (x: number, z: number): (Arm | null)[] => {
    const k = key(x, z);
    let a = arms.get(k);
    if (a === undefined) {
      a = [null, null, null, null];
      arms.set(k, a);
    }
    return a;
  };
  const isJunction = new Set(net.junctions.map((j) => key(j.x, j.z)));
  const ends = (r: Road): [[number, number], [number, number]] =>
    r.vertical
      ? [
          [r.at, r.from],
          [r.at, r.to],
        ]
      : [
          [r.from, r.at],
          [r.to, r.at],
        ];
  for (const r of net.roads) {
    const [a, b] = ends(r);
    /* The road leaves `a` towards +axis and `b` towards −axis. */
    armsAt(a[0], a[1])[r.vertical ? 0 : 2] = { cls: r.cls };
    armsAt(b[0], b[1])[r.vertical ? 1 : 3] = { cls: r.cls };
  }
  const widest = (list: readonly (Arm | null)[]): RoadClass | null =>
    list.reduce<RoadClass | null>(
      (w, arm) => (arm === null || (w !== null && carriage(w) >= carriage(arm.cls)) ? w : arm.cls),
      null,
    );

  for (const r of net.roads) {
    const c = r.cls;
    const cw = carriage(c);
    const [a, b] = ends(r);
    /* How far the crossing road takes at each end: its carriageway, and its sidewalk beyond. */
    const trim = (p: [number, number]): { road: number; walk: number; crossing: boolean } => {
      if (!isJunction.has(key(p[0], p[1]))) return { road: 0, walk: 0, crossing: false };
      const across = widest(armsAt(p[0], p[1]).filter((_, i) => (r.vertical ? i >= 2 : i < 2)));
      if (across === null) return { road: 0, walk: 0, crossing: false };
      return {
        road: carriage(across) / 2 + CROSSING,
        walk: carriage(across) / 2 + across.sidewalk,
        crossing: true,
      };
    };
    const ta = trim(a);
    const tb = trim(b);
    const place = (s: number, off: number): [number, number] =>
      r.vertical ? [r.at + off, s] : [s, r.at + off];
    const run = (
      s0: number,
      s1: number,
      off: number,
      name: string,
      base: string,
      width: number,
      tu: number,
      tv: number,
    ): void => {
      if (s1 - s0 <= 1e-3) return;
      const [x, z] = place((s0 + s1) / 2, off);
      out.push(slab(name, base, { len: s1 - s0, width, tu, tv }, x, z, r.vertical));
    };
    const surface = nameOf(c.row.v('surface'), 'RoadStreet');
    const r0 = r.from + ta.road;
    const r1 = r.to - tb.road;
    run(r0, r1, 0, 'RoadSlab', surface, cw, (r1 - r0) / c.tile, 1);
    if (c.median > 0) run(r0, r1, 0, 'MedianSlab', 'Kerb', c.median, 1, 1);
    const w0 = r.from + ta.walk;
    const w1 = r.to - tb.walk;
    const walkW = c.sidewalk - style.kerbW;
    for (const side of [-1, 1]) {
      run(w0, w1, side * (cw / 2 + style.kerbW / 2), 'KerbSlab', 'Kerb', style.kerbW, 1, 1);
      run(
        w0,
        w1,
        side * (cw / 2 + style.kerbW + walkW / 2),
        'WalkSlab',
        'Sidewalk',
        walkW,
        (w1 - w0) / style.walkTile,
        walkW / style.walkTile,
      );
    }
    /* A crosswalk and a stop bar on each approach to a junction. */
    for (const [end, t, dir] of [
      [a, ta, -1],
      [b, tb, 1],
    ] as const) {
      if (!t.crossing) continue;
      const s = r.vertical ? end[1] : end[0];
      const band = s - dir * (t.road - CROSSING / 2);
      const [cx, cz] = place(band, 0);
      out.push(
        slab(
          'CrossSlab',
          'Crosswalk',
          { len: cw, width: CROSSING, tu: cw / CROSSING, tv: 1 },
          cx,
          cz,
          !r.vertical,
        ),
      );
      /* Traffic keeps right: heading along the axis towards this end, the arriving lanes are on the
         −x side of a road running along z and the +z side of one running along x. */
      const lanes = c.lanes * c.laneWidth;
      const off = (r.vertical ? -dir : dir) * (c.median / 2 + lanes / 2);
      const bar = s - dir * (t.road + style.barInset + style.barLen / 2);
      const [bx, bz] = place(bar, off);
      /* The bar declares no tiling; instantiation leaves out what a template does not declare. */
      out.push(
        slab(
          'JunctionBar',
          style.paint,
          { len: style.barLen, width: lanes, tu: 1, tv: 1 },
          bx,
          bz,
          r.vertical,
          ROAD_THICK / 2 + 0.02,
        ),
      );
    }
  }

  /* Each junction: its square, its corners, and paving across any arm it lacks. */
  for (const j of net.junctions) {
    const a = armsAt(j.x, j.z);
    const alongZ = widest([a[0] ?? null, a[1] ?? null]);
    const alongX = widest([a[2] ?? null, a[3] ?? null]);
    if (alongZ === null || alongX === null) continue;
    /* A road along z spans x, and one along x spans z. */
    const sx = carriage(alongZ);
    const sz = carriage(alongX);
    out.push(
      slab('RoadSlab', style.surface, { len: sx, width: sz, tu: 1, tv: 1 }, j.x, j.z, false),
    );
    const wx = alongZ.sidewalk;
    const wz = alongX.sidewalk;
    for (const dx of [-1, 1]) {
      for (const dz of [-1, 1]) {
        out.push(
          slab(
            'WalkSlab',
            style.walk,
            { len: wx, width: wz, tu: wx / style.walkTile, tv: wz / style.walkTile },
            j.x + dx * (sx / 2 + wx / 2),
            j.z + dz * (sz / 2 + wz / 2),
            false,
          ),
        );
      }
    }
    /* A missing arm: the crossing road's sidewalk and kerb carry on across its mouth. */
    for (const [i, dx, dz] of [
      [0, 0, 1],
      [1, 0, -1],
      [2, 1, 0],
      [3, -1, 0],
    ] as const) {
      if (a[i] !== null) continue;
      const alongArm = i < 2;
      const mouth = alongArm ? sx : sz;
      const deep = alongArm ? wz : wx;
      const reach = (alongArm ? sz : sx) / 2;
      const cx = j.x + dx * (reach + style.kerbW + (deep - style.kerbW) / 2);
      const cz = j.z + dz * (reach + style.kerbW + (deep - style.kerbW) / 2);
      out.push(
        slab(
          'WalkSlab',
          style.walk,
          {
            len: mouth,
            width: deep - style.kerbW,
            tu: mouth / style.walkTile,
            tv: (deep - style.kerbW) / style.walkTile,
          },
          cx,
          cz,
          !alongArm,
        ),
      );
      out.push(
        slab(
          'KerbSlab',
          style.kerb,
          { len: mouth, width: style.kerbW, tu: 1, tv: 1 },
          j.x + dx * (reach + style.kerbW / 2),
          j.z + dz * (reach + style.kerbW / 2),
          !alongArm,
        ),
      );
    }
  }
  return out;
}

/**
 * A slab of paving under every block that brings no ground of its own, to the block's edges and at
 * the sidewalk's height. The reference's scripts pave parks, squares and yards and leave the rest
 * of a block to its buildings, whose lots do not reach one another; left so, the ground between
 * them was sky. What would make it wrong is a capture of the reference showing earth or grass
 * between the buildings of a block.
 */
export function pavingInstances(layout: CityLayout): Instance[] {
  const out: Instance[] = [];
  for (const block of layout.blocks) {
    if (block.ground !== null) continue;
    const { x0, z0, x1, z1 } = block.bounds;
    const [w, d] = [x1 - x0, z1 - z0];
    out.push(
      slab(
        'WalkSlab',
        'Paving',
        { len: w, width: d, tu: w / 2, tv: d / 2 },
        (x0 + x1) / 2,
        (z0 + z1) / 2,
        false,
      ),
    );
  }
  return out;
}
