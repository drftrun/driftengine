import { describe, expect, it } from 'vitest';

import type { Block } from './blocks.ts';
import type { Cell } from './grid.ts';
import { buildLots } from './lots.ts';
import { area, bounds, rect } from './plane.ts';
import type { CityTables, District } from './tables.ts';

const DISTRICT: District = {
  kind: 'A',
  index: 0,
  suffix: 'A',
  short: 'A',
  label: null,
  seed: [0, 0],
  share: 1,
  spacing: 0,
  accent: [0, 0, 0, 0],
  lotWidth: 20,
  lotDepth: 25,
};

const VALUES: Record<string, number> = {
  lotStep: 0.25,
  alleyMinBlock: 36,
  courtyardMin: 12,
  alleyWidth: 4,
};

const tables = {
  value: (name: string) => VALUES[name] ?? 0,
  district: () => DISTRICT,
  alleys: [],
} as unknown as CityTables;

function block(id: number, w: number, d: number): Block {
  const outline = rect(0, 0, w, d);
  return {
    id,
    district: 'A',
    cell: {} as Cell,
    outline,
    bounds: bounds(outline),
    rect: true,
    kind: 'building',
    ground: null,
  };
}

describe('lots', () => {
  it('A BLOCK IS CUT INTO LOTS THAT TILE IT WITH ITS ALLEY OR COURT, EACH ON A STREET', () => {
    /* 60 across: two lots' depth and a court would need 62, so an alley and two 28 m strips. */
    const { lots, plans } = buildLots(
      [block(0, 100, 60), block(1, 100, 70), block(2, 100, 30)],
      tables,
    );
    expect(plans.map((p) => p.form)).toEqual(['alley', 'ring', 'single']);
    const of = (b: number) => lots.filter((l) => l.block === b);
    expect(of(0)).toHaveLength(10);
    expect(of(0).every((l) => l.width === 20 && l.depth === 28)).toBe(true);
    /* The ring: five a long side, and one on each 20 m end between them. */
    expect(of(1)).toHaveLength(12);
    expect(of(2)).toHaveLength(5);

    for (const [b, w, d] of [
      [0, 100, 60],
      [1, 100, 70],
    ] as const) {
      const plan = plans[b];
      const filled =
        of(b).reduce((sum, l) => sum + Math.abs(area(l.outline)), 0) +
        (plan?.alley ? Math.abs(area(plan.alley)) : 0) +
        (plan?.court ? Math.abs(area(plan.court)) : 0);
      expect(filled).toBeCloseTo(w * d, 6);
    }
    /* Every lot's front edge lies on the block's boundary, on the side it faces. */
    const outer = [
      [0, 0, 100, 60],
      [0, 0, 100, 70],
      [0, 0, 100, 30],
    ] as const;
    for (const lot of lots) {
      const [x0, z0, x1, z1] = outer[lot.block] ?? [0, 0, 0, 0];
      const front =
        lot.facing[0] > 0
          ? lot.bounds.x1 === x1
          : lot.facing[0] < 0
            ? lot.bounds.x0 === x0
            : lot.facing[1] > 0
              ? lot.bounds.z1 === z1
              : lot.bounds.z0 === z0;
      expect(front).toBe(true);
    }
  });

  it('merges a ring’s end into its court when it cannot hold six tenths of a lot', () => {
    const wide = { ...DISTRICT, lotWidth: 30 };
    const wider = { ...tables, district: () => wide } as unknown as CityTables;
    /* 64 across is a ring (two 25 m lots and a 12 m court need 62); its ends are 14 m, under 18. */
    const { lots, plans } = buildLots([block(0, 100, 64)], wider);
    expect(plans[0]?.form).toBe('ring');
    expect(lots).toHaveLength(6);
    expect(lots.every((l) => l.facing[0] === 0)).toBe(true);
    const court = plans[0]?.court ?? [];
    expect(Math.abs(area(court))).toBeCloseTo(100 * 14, 6);
  });

  it('snaps every lot edge along the street to the lot step', () => {
    const { lots } = buildLots([block(0, 101, 60)], tables);
    const strip = lots.filter((l) => l.facing[1] < 0).map((l) => l.width);
    expect(strip).toEqual([20.25, 20.25, 20, 20.25, 20.25]);
  });
});
