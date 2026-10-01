import { describe, expect, it } from 'vitest';

import { SURFACE, SURFACE_FLOATS, expandAssembly } from '@driftengine/drft';
import type { DrftAssembly, MeshData } from '@driftengine/drft';

import { Kit } from '../mesh/kit.ts';
import type { CopyOf, Shape } from '../mesh/kit.ts';
import type { Surface, TextureRef } from '../mesh/materials.ts';
import type { BakedBuilding, Worn } from '../mesh/region.ts';
import { surfaceRecord } from '../mesh/region.ts';
import type { Value } from '../script/values.ts';
import { planTextures } from '../textures/plan.ts';
import { coarseLevels } from './coarse.ts';

const tex = (file: string): TextureRef => ({ file, width: 256, height: 256 });
function surface(fields: Partial<Surface> = {}): Surface {
  return {
    color: [1, 1, 1],
    alpha: 1,
    emissive: 0,
    emissiveColor: null,
    windowSeed: 0,
    roughness: 0.8,
    metallic: 0,
    textures: { albedo: null, emissive: null, mr: null },
    rooms: null,
    tiling: null,
    transform: { sx: 1, sy: 1, ox: 0, oy: 0 },
    clamp: false,
    blend: 'opaque',
    effect: undefined,
    ...fields,
  };
}
const num = (v: number): Value => ({ k: 'num', type: 'f32', v });
const box = (w: number, h: number, d: number, x: number, y: number, z: number): Shape => {
  const matrix = new Float64Array(16);
  matrix[0] = matrix[5] = matrix[10] = matrix[15] = 1;
  matrix.set([x, y, z], 12);
  return {
    kind: 'Box',
    spec: {
      k: 'struct',
      fields: new Map([
        ['x', num(w)],
        ['y', num(h)],
        ['z', num(d)],
      ]),
      items: [],
    },
    matrix,
    smooth: null,
    csg: null,
  };
};
const worn = (s: Surface, area: number, largest: CopyOf, bands: number[] = []): Worn => ({
  surface: s,
  area,
  largest,
  largestArea: area,
  bands,
});
const round = (xs: ArrayLike<number>): number[] =>
  Array.from(xs, (x) => Math.round(x * 1000) / 1000 + 0);

/* A facade in a picture whose mean is 0.4, tiled every 2 m along and 3 m up; a red trim; a green
   base; a cap. */
const facade = surface({
  color: [0.5, 0.5, 0.5],
  textures: { albedo: tex('facade.svg'), emissive: null, mr: null },
  tiling: { mx: 2, my: 3, cylinder: false, fit: false },
});
const trim = surface({ color: [0.9, 0.3, 0.3] });
const base = surface({ color: [0.3, 0.6, 0.2] });
const cap = surface({ color: [0.2, 0.2, 0.2] });
const picture = (s: Surface): readonly [number, number, number] =>
  s.textures.albedo === null ? [1, 1, 1] : [0.4, 0.4, 0.4];

/** The copy of an assembly wearing a surface of this red, and its surface. */
function wearing(levels: { assembly: DrftAssembly }[], red: number) {
  for (const { assembly } of levels) {
    for (let c = 0; c < assembly.pieces.length; c++) {
      const s = assembly.surfaceOf[c] as number;
      const colour = assembly.surfaces.subarray(s * SURFACE_FLOATS, s * SURFACE_FLOATS + 3);
      if (Math.abs((colour[0] as number) - red) < 1e-3) {
        return {
          colour,
          matrix: assembly.transforms.subarray(c * 12, c * 12 + 12),
          uv: assembly.uv.subarray(c * 8, c * 8 + 8),
          piece: assembly.pieces[c] as number,
        };
      }
    }
  }
  return null;
}

describe("a region's coarse level", () => {
  it("A BUILDING'S BOX IS A STACK OF RUNS, EACH WEARING WHAT COVERS MOST OF IT, SHADED TO THE MEAN OF ALL OF IT, AT ITS FACADE'S OWN DENSITY", () => {
    const kit = new Kit();
    /* And a sign the region keeps whole, as it is. */
    const sign = surface({ color: [0.7, 0.1, 0.9], emissive: 2 });
    const plan = planTextures([facade, trim, base, cap, sign]);
    /* The facade runs 26 m up from the base; the cap overhangs the roof by 0.2 m a side. */
    const front = kit.copyOf(box(10, 26, 8, 50, 17, 20), facade) as CopyOf;
    const plinth = kit.copyOf(box(10.2, 4, 8.2, 50, 2, 20), base) as CopyOf;
    const band = kit.copyOf(box(10.1, 0.5, 8.1, 50, 10, 20), trim) as CopyOf;
    const lid = kit.copyOf(box(10.4, 0.3, 8.4, 50, 30.15, 20), cap) as CopyOf;
    const building: BakedBuilding = {
      region: 7,
      box: { x: 50, z: 20, yaw: 0, w: 10, d: 8, h: 32, ground: 4 },
      top: 30,
      footprint: null,
      /* In 2 m bands: the base covers the first, nothing the second, and the facade 60 m² of every
         band from 4 m to the top at 30, with 12 of trim beside it in each. */
      walls: new Map([
        ['b', worn(base, 70, plinth, [70])],
        ['a', worn(facade, 780, front, [0, 0, ...Array<number>(13).fill(60)])],
        ['t', worn(trim, 156, band, [0, 0, ...Array<number>(13).fill(12)])],
      ]),
      /* Nothing measured below 4 m; above, the walls reach from −4 to 5 along x, −4 to 4 along z. */
      reach: [
        ...[0, 1].flatMap(() => [Infinity, -Infinity, Infinity, -Infinity]),
        ...Array.from({ length: 13 }, () => [-4, 5, -4, 4]).flat(),
      ],
      roofs: new Map([
        ['a', worn(facade, 80, front)],
        ['c', worn(cap, 87.36, lid)],
      ]),
    };
    const signCopy = kit.copyOf(box(6, 1, 0.2, 50, 20, 24.2), sign) as CopyOf;
    const levels = coarseLevels(
      {
        kit,
        plan,
        regions: [
          {
            id: 7,
            coarse: [
              {
                cls: { blend: 'opaque', texture: 0, alpha: 1, sway: false },
                copy: signCopy,
                record: surfaceRecord(sign, plan),
                shift: [0, 0],
              },
            ],
          },
        ],
        buildings: [building],
      },
      picture,
    );
    const all = levels.levels.get(7) ?? [];
    /* One occluder, for the facade's run: its box from the ground storey's 4 m up to 30. The base's
       run is all ground storey, so none. */
    expect(round(levels.occluders.get(7) ?? [])).toEqual([46, 4, 16, 55, 30, 24]);

    /* The base's run: its band and the empty one above it, 4 m of it alone in its own colour. */
    const foot = wearing(all, 0.3);
    expect(round(foot?.colour ?? [])).toEqual([0.3, 0.6, 0.2]);
    expect(round(foot?.matrix ?? [])).toEqual([10, 0, 0, 0, 4, 0, 0, 0, 8, 50, 2, 20]);
    /* The facade's run, 4 m to 30, 9 × 8 m and centred 0.5 m along x. Its mean shade, (780·0.2 + 156·0.9) / 936 red and
       (780·0.2 + 156·0.3) / 936 green, is 0.31667 and 0.21667; over the facade's picture of 0.4
       its colour is 0.79167 and 0.54167. */
    const walls = wearing(all, 0.792);
    expect(round(walls?.colour ?? [])).toEqual([0.792, 0.542, 0.542]);
    expect(round(walls?.matrix ?? [])).toEqual([9, 0, 0, 0, 26, 0, 0, 0, 8, 50.5, 17, 20]);
    /* The facade repeats every 2 m along and 3 m up: its box of 9 × 26 × 8 m stretches u by
       half a repeat a metre along each side, v by a third up each. */
    expect(round(walls?.uv.subarray(0, 6) ?? [])).toEqual([4.5, 13, 4, 3, 8.667, 2.667]);

    /* Roof: the cap covers most of the top — its 10.4 × 8.4 overhang against the facade's 10 × 8
       — and the mean of the two is the cap's own 0.2, untextured. A slab 0.1 thick centred on the
       top run's top, as far as it reaches; the cap once across its 87.36 m²: 1/√87.36 = 0.10699 a
       metre. */
    const roof = wearing(all, 0.2);
    expect(round(roof?.matrix ?? [])).toEqual([9, 0, 0, 0, 0.1, 0, 0, 0, 8, 50.5, 30, 20]);
    expect(round(roof?.uv.subarray(0, 6) ?? [])).toEqual([
      0.963, 0.011, 0.856, 0.963, 0.011, 0.856,
    ]);

    /* The sign, as the region kept it. */
    const kept = wearing(all, 0.7);
    expect(round(kept?.matrix ?? [])).toEqual(round(signCopy.matrix));
    expect(kept?.colour[SURFACE.color + 2]).toBeCloseTo(0.9, 5);
  });

  it("A RUN'S BOX STANDS WHERE ITS WALLS REACH, IN ITS BUILDING'S FRAME, TURNED", () => {
    const kit = new Kit();
    const plan = planTextures([facade]);
    const front = kit.copyOf(box(2, 4, 2, 0, 2, 0), facade) as CopyOf;
    /* Turned a quarter, the building's x runs along the world's −z and its z along x. Its walls
       reach 1 to 3 along its x and −0.5 to 1.5 along its z: a box 2 × 2 centred at (2, 0.5) in its
       frame, which is (0.5, −2) in the world. */
    const building: BakedBuilding = {
      region: 1,
      box: { x: 0, z: 0, yaw: Math.PI / 2, w: 10, d: 8, h: 4, ground: 4 },
      top: 4,
      footprint: null,
      walls: new Map([['a', worn(facade, 16, front, [8, 8])]]),
      roofs: new Map(),
      reach: [1, 3, -0.5, 1.5, 1, 3, -0.5, 1.5],
    };
    const levels = coarseLevels(
      { kit, plan, regions: [{ id: 1, coarse: [] }], buildings: [building] },
      picture,
    ).levels.get(1);
    const walls = wearing(levels ?? [], 0.5);
    expect(round(walls?.matrix ?? [])).toEqual([0, 0, -2, 0, 4, 0, 2, 0, 0, 0.5, 2, -2]);
  });

  it('A LOT THAT IS NOT A RECTANGLE STANDS AS ITS OUTLINE, ITS FACADE ONCE ROUND AT ITS OWN DENSITY', () => {
    const kit = new Kit();
    const plan = planTextures([facade]);
    const front = kit.copyOf(box(10, 26, 8, 0, 13, 0), facade) as CopyOf;
    const building: BakedBuilding = {
      region: 3,
      box: { x: 100, z: 0, yaw: 0, w: 12, d: 9, h: 24, ground: 4 },
      top: 21,
      footprint: [0, 0, 12, 0, 0, 9],
      walls: new Map([['a', worn(facade, 500, front, Array<number>(11).fill(50))]]),
      roofs: new Map(),
      reach: [],
    };
    const levels = coarseLevels(
      { kit, plan, regions: [{ id: 3, coarse: [] }], buildings: [building] },
      picture,
    ).levels.get(3);
    const walls = wearing(levels ?? [], 0.5);
    /* Eleven bands of 2 m, the last cut off at the top, 21 m. */
    expect(round(walls?.matrix ?? [])).toEqual([1, 0, 0, 0, 21, 0, 0, 0, 1, 100, 0, 0]);
    /* Round the 12-9-15 triangle is 36 m, at half a repeat a metre; up its 21 m at a third. */
    expect(round(walls?.uv.subarray(0, 6) ?? [])).toEqual([18, 18, 18, 7, 7, 7]);
    /* Its piece, placed, has the outline's corners at the ground and at the top. */
    const mesh = expandAssembly(
      (levels ?? [])[0]?.assembly as DrftAssembly,
      (o) => kit.pieces[o] as MeshData,
    );
    const corners = new Set<string>();
    for (let i = 0; i < mesh.positions.length; i += 3)
      corners.add(round(mesh.positions.subarray(i, i + 3)).join(','));
    for (const c of ['100,0,0', '112,0,0', '100,0,9', '100,21,0', '112,21,0', '100,21,9'])
      expect(corners.has(c)).toBe(true);
    expect(walls?.piece).toBeDefined();
  });
});
