import { afterEach, expect, test, vi } from 'vitest';

import {
  BAY,
  CITY_COLS,
  CITY_ROWS,
  CITY_TRIANGLES,
  LOT_X,
  LOT_Z,
  MATERIAL,
  SKIN,
  STOREY,
  TEXTURED,
  cityBlock,
  cityBlocks,
  cityBuildings,
} from './manhattan';

import type { Building, Mass } from './manhattan';
import type { RawMesh } from '../gpuDrivenRig';

/**
 * **What this file is for: a Manhattan that is the same Manhattan every time it is built.**
 *
 * The demo is published, so `shots.mjs` holds it to zero pixels and a reported defect is one
 * anybody can reproduce — both only if all of it comes from one seed. And it is modelled on a real
 * city's rules, so the rules are what is tested: the street wall, the 1916 setback, the towers of
 * several kinds and heights that occlusion culling needs.
 */

const SEED = 20260918;

afterEach(() => {
  vi.restoreAllMocks();
});

function trianglesOf(meshes: readonly RawMesh[]): number {
  return meshes.reduce((sum, mesh) => sum + mesh.indices.length / 3, 0);
}

function everyBuilding(): { bx: number; bz: number; building: Building }[] {
  const all: { bx: number; bz: number; building: Building }[] = [];
  for (const [bx, bz] of cityBlocks()) {
    for (const building of cityBuildings(bx, bz, SEED)) all.push({ bx, bz, building });
  }
  return all;
}

test('A BLOCK IS BUILT FROM ITS SEED AND ITS PLACE, and from nothing else', () => {
  const positions = (meshes: readonly RawMesh[]) => meshes.map((mesh) => [...mesh.positions]);
  const one = cityBlock(1, -3, SEED);
  expect(one.length).toBeGreaterThan(0);
  expect(positions(cityBlock(1, -3, SEED))).toEqual(positions(one));
  expect(cityBlock(1, -3, SEED).map((mesh) => [...mesh.indices])).toEqual(
    one.map((mesh) => [...mesh.indices]),
  );
  expect(positions(cityBlock(1, -3, SEED + 1))).not.toEqual(positions(one));
  expect(positions(cityBlock(1, -2, SEED))).not.toEqual(positions(one));
});

test('IT READS NO CLOCK AND NO RANDOM NUMBER, which is what makes the first test mean anything', () => {
  /*
   * Two calls a millisecond apart agree whether or not a clock was read, so the test above cannot
   * tell a seeded generator from one seeded by the time that happened to be called twice in one
   * tick. This one can.
   */
  for (const [object, name] of [
    [Math, 'random'],
    [Date, 'now'],
    [performance, 'now'],
  ] as const) {
    vi.spyOn(object as unknown as Record<string, () => number>, name).mockImplementation(() => {
      throw new Error(name);
    });
  }
  expect(() => cityBlock(0, 0, SEED)).not.toThrow();
});

test('EVERY KIND OF BUILDING STANDS SOMEWHERE, IN MANY HEIGHTS', () => {
  const kinds = new Map<string, number>();
  const heights = new Set<number>();
  let tallest = 0;
  let lowest = Infinity;
  for (const { building } of everyBuilding()) {
    kinds.set(building.kind, (kinds.get(building.kind) ?? 0) + 1);
    heights.add(Math.round(building.height));
    tallest = Math.max(tallest, building.height);
    lowest = Math.min(lowest, building.height);
  }
  for (const kind of ['walkup', 'prewar', 'setback', 'glass', 'supertall']) {
    expect(kinds.get(kind), kind).toBeGreaterThan(0);
  }
  /* Most of a city is low; its skyline is a few hundred of its thousands of buildings. */
  expect((kinds.get('walkup') ?? 0) + (kinds.get('prewar') ?? 0)).toBeGreaterThan(
    10 * ((kinds.get('setback') ?? 0) + (kinds.get('glass') ?? 0) + (kinds.get('supertall') ?? 0)),
  );
  expect(heights.size).toBeGreaterThanOrEqual(60);
  expect(tallest / lowest).toBeGreaterThanOrEqual(20);
});

test('THE PUBLISHED GRID IS PAST A MILLION TRIANGLES, and this is how many', () => {
  let triangles = 0;
  for (const [bx, bz] of cityBlocks()) triangles += trianglesOf(cityBlock(bx, bz, SEED));
  expect(triangles).toBe(CITY_TRIANGLES);
  expect(triangles).toBeGreaterThan(1_000_000);
  expect(cityBlocks()).toHaveLength(CITY_COLS * CITY_ROWS);
});

test('THE STREET WALL: A BLOCK IS BUILT END TO END, and nothing stands in a street', () => {
  /*
   * **Built to the lot line, shoulder to shoulder.** Along each frontage, the lots of the buildings
   * standing on it cover the block from one avenue to the other with no gap — a tower's lot runs
   * through the block and covers both — which is what makes a street a corridor.
   */
  for (const [bx, bz] of [
    [0, 0],
    [-3, -6],
    [2, 7],
  ] as const) {
    const buildings = cityBuildings(bx, bz, SEED);
    for (const [z0, z1] of [
      [0, LOT_Z / 2],
      [LOT_Z / 2, LOT_Z],
    ] as const) {
      const spans = buildings
        .filter((building) => building.lot.z0 <= z0 && building.lot.z1 >= z1)
        .map((building) => [building.lot.x0, building.lot.x1] as const)
        .sort((a, b) => a[0] - b[0]);
      let reached = 0;
      for (const [x0, x1] of spans) {
        expect(x0).toBeCloseTo(reached, 6);
        reached = x1;
      }
      expect(reached).toBeCloseTo(LOT_X, 6);
    }
    for (const building of buildings) {
      for (const mass of building.masses) {
        expect(mass.x0).toBeGreaterThanOrEqual(-1e-6);
        expect(mass.x1).toBeLessThanOrEqual(LOT_X + 1e-6);
        expect(mass.z0).toBeGreaterThanOrEqual(-1e-6);
        expect(mass.z1).toBeLessThanOrEqual(LOT_Z + 1e-6);
      }
    }
  }
});

test('THE 1916 RULE: ABOVE ITS SETBACKS A TOWER COVERS NO MORE THAN A QUARTER OF ITS LOT', () => {
  /*
   * **The Zoning Resolution's envelope, as the generator draws it.** A podium across the whole lot
   * to the street wall's height, tiers stepping in, and a tower on at most a quarter of the lot as
   * high as it likes — unless it has stepped in as far as a sixteen-metre tower allows first.
   */
  let towers = 0;
  let shafts = 0;
  for (const { building } of everyBuilding()) {
    if (building.kind !== 'setback') continue;
    towers += 1;
    const lot = (building.lot.x1 - building.lot.x0) * (building.lot.z1 - building.lot.z0);
    const podium = building.masses[0] as Mass;
    expect((podium.x1 - podium.x0) * (podium.z1 - podium.z0)).toBeCloseTo(lot, 6);
    /*
     * **The tower is whatever rises further than a tier does** — six storeys — and only it is held
     * to the quarter. A building that reaches its height while still stepping in never had a tower
     * at all, which the rule allows: most of the twenties' setback buildings are exactly that.
     */
    for (const mass of building.masses) {
      if (mass.material !== MATERIAL.deco) continue;
      if (mass.y1 - mass.y0 <= 6 * STOREY.setback + 1e-6) continue;
      const area = (mass.x1 - mass.x0) * (mass.z1 - mass.z0);
      const narrow = Math.min(mass.x1 - mass.x0, mass.z1 - mass.z0);
      expect(area <= 0.25 * lot + 1e-6 || narrow <= 16 + 1e-6).toBe(true);
      shafts += 1;
    }
    /* And every tier is inside the one below it. */
    for (let k = 1; k < building.masses.length; k += 1) {
      const below = building.masses[k - 1] as Mass;
      const above = building.masses[k] as Mass;
      expect(above.x0).toBeGreaterThanOrEqual(below.x0 - 1e-6);
      expect(above.x1).toBeLessThanOrEqual(below.x1 + 1e-6);
      expect(above.y0).toBeCloseTo(below.y1, 6);
    }
  }
  expect(towers).toBeGreaterThan(10);
  expect(shafts).toBeGreaterThan(5);
});

test('SOME TOWERS ARE GLASS, AND A GLASS TOWER HAS A LIT CORE BEHIND ITS SKIN', () => {
  const all = everyBuilding();
  const glass = all.filter(({ building }) => building.glass);
  expect(glass.length).toBeGreaterThan(10);
  expect(glass.length).toBeLessThan(all.length / 10);
  /* The core stands a skin's width inside the glass, on the office facade. */
  const { bx, bz, building } = glass[0] as (typeof glass)[number];
  const meshes = cityBlock(bx, bz, SEED);
  const core = meshes.find((mesh) => mesh.material === MATERIAL.office) as RawMesh;
  const skin = meshes.find((mesh) => mesh.material === MATERIAL.glass) as RawMesh;
  const shaft = building.masses[0] as Mass;
  const within = (mesh: RawMesh, x0: number, x1: number, z0: number, z1: number) => {
    let count = 0;
    for (let v = 0; v < mesh.positions.length / 3; v += 1) {
      const x = mesh.positions[v * 3] as number;
      const z = mesh.positions[v * 3 + 2] as number;
      if (x >= x0 - 1e-4 && x <= x1 + 1e-4 && z >= z0 - 1e-4 && z <= z1 + 1e-4) count += 1;
    }
    return count;
  };
  expect(within(skin, shaft.x0, shaft.x1, shaft.z0, shaft.z1)).toBeGreaterThan(0);
  expect(
    within(core, shaft.x0 + SKIN, shaft.x1 - SKIN, shaft.z0 + SKIN, shaft.z1 - SKIN),
  ).toBeGreaterThan(0);
});

test('EVERY TRIANGLE FACES THE WAY ITS NORMAL SAYS, and every normal is a unit', () => {
  /*
   * **`(P1 - P0) x (P2 - P0)` along the stored normal** is the engine's winding, and the second
   * pipeline culls back faces in the raster and whole clusters by their cones. A building wound
   * inside out still reads as a building — the far wall's inside survives the cull — so this is
   * asserted rather than looked at. The water tanks' prisms and cones are in it.
   */
  let checked = 0;
  for (const [bx, bz] of [
    [0, -6],
    [-2, 3],
    [2, 8],
  ] as const) {
    for (const mesh of cityBlock(bx, bz, SEED)) {
      const p = mesh.positions;
      const n = mesh.normals;
      let bad = 0;
      for (let t = 0; t < mesh.indices.length; t += 3) {
        const a = mesh.indices[t] as number;
        const b = mesh.indices[t + 1] as number;
        const c = mesh.indices[t + 2] as number;
        const e1 = [0, 1, 2].map((k) => (p[b * 3 + k] as number) - (p[a * 3 + k] as number));
        const e2 = [0, 1, 2].map((k) => (p[c * 3 + k] as number) - (p[a * 3 + k] as number));
        const cross = [
          (e1[1] as number) * (e2[2] as number) - (e1[2] as number) * (e2[1] as number),
          (e1[2] as number) * (e2[0] as number) - (e1[0] as number) * (e2[2] as number),
          (e1[0] as number) * (e2[1] as number) - (e1[1] as number) * (e2[0] as number),
        ];
        const along =
          (cross[0] as number) * (n[a * 3] as number) +
          (cross[1] as number) * (n[a * 3 + 1] as number) +
          (cross[2] as number) * (n[a * 3 + 2] as number);
        const unit = Math.hypot(n[a * 3] as number, n[a * 3 + 1] as number, n[a * 3 + 2] as number);
        if (!(along > 0) || Math.abs(unit - 1) > 1e-5) bad += 1;
        checked += 1;
      }
      expect(bad, `material ${mesh.material}`).toBe(0);
    }
  }
  expect(checked).toBeGreaterThan(10_000);
});

test('A WINDOW IS ONE UNIT OF FACADE UV, a bay wide and a storey high, in every style', () => {
  /*
   * Each style's image is a grid of windows that repeats, so a unit of UV has to be one window on
   * every building whatever its storey height: the ratio of a triangle's UV area to its area in
   * metres is one bay by one storey of its kind.
   */
  const storeys = new Set(Object.values(STOREY));
  let checked = 0;
  for (const mesh of cityBlock(0, -5, SEED)) {
    if (!TEXTURED.has(mesh.material)) continue;
    const uv = mesh.uvs as Float32Array;
    const p = mesh.positions;
    for (let t = 0; t < mesh.indices.length; t += 3) {
      const [a, b, c] = [mesh.indices[t], mesh.indices[t + 1], mesh.indices[t + 2]] as number[];
      const d = (i: number, j: number, k: number) =>
        (p[(i as number) * 3 + k] as number) - (p[(j as number) * 3 + k] as number);
      const e1 = [
        d(b as number, a as number, 0),
        d(b as number, a as number, 1),
        d(b as number, a as number, 2),
      ];
      const e2 = [
        d(c as number, a as number, 0),
        d(c as number, a as number, 1),
        d(c as number, a as number, 2),
      ];
      const area =
        Math.hypot(
          (e1[1] as number) * (e2[2] as number) - (e1[2] as number) * (e2[1] as number),
          (e1[2] as number) * (e2[0] as number) - (e1[0] as number) * (e2[2] as number),
          (e1[0] as number) * (e2[1] as number) - (e1[1] as number) * (e2[0] as number),
        ) / 2;
      const du1 = (uv[(b as number) * 2] as number) - (uv[(a as number) * 2] as number);
      const dv1 = (uv[(b as number) * 2 + 1] as number) - (uv[(a as number) * 2 + 1] as number);
      const du2 = (uv[(c as number) * 2] as number) - (uv[(a as number) * 2] as number);
      const dv2 = (uv[(c as number) * 2 + 1] as number) - (uv[(a as number) * 2 + 1] as number);
      const storey = area / (Math.abs(du1 * dv2 - du2 * dv1) / 2) / BAY;
      expect(
        [...storeys].some((height) => Math.abs(height - storey) < 1e-3),
        `${storey}`,
      ).toBe(true);
      checked += 1;
    }
  }
  expect(checked).toBeGreaterThan(1000);
});

test('NO WALL ANOTHER BUILDING STANDS AGAINST IS DRAWN, where it stands against it', () => {
  /*
   * **A party wall is cut where its neighbour ends.** A wall facing east or west on a boundary
   * between two buildings in a row is hidden up to the lower one's height, and drawing it would be
   * triangles the count claims and the frame never shows. So no facade triangle may lie on such a
   * boundary below the neighbour's roof.
   */
  let hiddenDrawn = 0;
  let boundaries = 0;
  for (const [bx, bz] of [
    [0, 5],
    [-1, 9],
    [2, -10],
  ] as const) {
    const buildings = cityBuildings(bx, bz, SEED);
    const meshes = cityBlock(bx, bz, SEED).filter((mesh) => TEXTURED.has(mesh.material));
    for (const building of buildings) {
      for (const mass of building.masses) {
        for (const other of buildings) {
          if (other === building) continue;
          for (const m of other.masses) {
            const sharesX = Math.abs(m.x0 - mass.x1) < 1e-6 || Math.abs(m.x1 - mass.x0) < 1e-6;
            const spans = m.z0 <= mass.z0 + 1e-6 && m.z1 >= mass.z1 - 1e-6;
            if (!sharesX || !spans) continue;
            boundaries += 1;
            const x = Math.abs(m.x0 - mass.x1) < 1e-6 ? mass.x1 : mass.x0;
            for (const mesh of meshes) {
              for (let t = 0; t < mesh.indices.length; t += 3) {
                let cx = 0;
                let cy = 0;
                let cz = 0;
                for (let k = 0; k < 3; k += 1) {
                  const v = mesh.indices[t + k] as number;
                  cx += (mesh.positions[v * 3] as number) / 3;
                  cy += (mesh.positions[v * 3 + 1] as number) / 3;
                  cz += (mesh.positions[v * 3 + 2] as number) / 3;
                }
                const onFace = Math.abs(cx - x) < 1e-4 && cz > mass.z0 && cz < mass.z1;
                if (onFace && cy > mass.y0 && cy < Math.min(m.y1, mass.y1)) hiddenDrawn += 1;
              }
            }
          }
        }
      }
    }
  }
  expect(boundaries).toBeGreaterThan(20);
  expect(hiddenDrawn).toBe(0);
});

test('A NEW YORK ROOF: WATER TANKS, CROWNS, SPIRES, AND NEON AT THE STREET', () => {
  const all = everyBuilding();
  const low = all.filter(
    ({ building }) => building.kind === 'walkup' || building.kind === 'prewar',
  );
  const tanks = low.filter(({ building }) => building.tank).length;
  expect(tanks / low.length).toBeGreaterThan(0.2);
  expect(tanks / low.length).toBeLessThan(0.7);
  expect(all.filter(({ building }) => building.lit).length).toBeGreaterThan(5);
  expect(all.filter(({ building }) => building.spire > 0).length).toBeGreaterThan(5);
  expect(low.filter(({ building }) => building.sign !== null).length / low.length).toBeGreaterThan(
    0.4,
  );
  /* The tall kinds carry no shop sign. */
  expect(
    all.filter(({ building }) => building.kind === 'setback' && building.sign !== null),
  ).toEqual([]);
});
