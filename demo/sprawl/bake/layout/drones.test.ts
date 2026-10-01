import { mulberry32 } from '@driftengine/core';
import { describe, expect, it } from 'vitest';

import { depotParts, siteDepots, sitePads } from './drones.ts';
import type { DepotKind } from './drones.ts';
import type { Placed, SidewalkRun } from './furniture.ts';
import type { Lot } from './lots.ts';
import type { Vec2 } from './plane.ts';
import type { Road } from './roads.ts';

/** A square lot `side` across, centred at (x, 0), facing `facing`. */
function lot(x: number, side: number, facing: Vec2 = [0, 1]): Lot {
  const h = side / 2;
  return {
    id: x,
    block: 0,
    district: 'D',
    outline: [],
    bounds: { x0: x - h, z0: -h, x1: x + h, z1: h },
    facing,
    width: side,
    depth: side,
    corner: false,
    polygon: false,
  };
}

const round = (x: number): number => Math.round(x * 1000) / 1000 + 0;

describe("the drones' places", () => {
  it('DEPOTS STAND AS FAR APART AS THE LOTS ALLOW, AND NEVER ON A LOT THEIR YARD DOES NOT FIT', () => {
    /* The lot at 900 is farthest out and 20 m across: a 22 m yard does not fit it. */
    const lots = [lot(-50, 30), lot(30, 30, [1, 0]), lot(400, 25), lot(900, 20)];
    const depots = siteDepots(lots, 5, 11);
    /* 400 first, the farthest out; then −50, 450 from it against 30's 370; then 30, alone. */
    expect(depots.map((d) => d.position[0])).toEqual([400, -50, 30]);
    /* Kept 400 m apart, only two of the three fit: 400 and −50 are 450 apart, 30 is 80 from −50. */
    expect(siteDepots(lots, 5, 11, 400).map((d) => d.position[0])).toEqual([400, -50]);
    /* A lot facing +x turns the yard's +z to it: a quarter turn. */
    expect(depots.map((d) => round(d.yaw))).toEqual([0, 0, round(Math.PI / 2)]);
  });

  it('A DEPOT’S BEACON AND FLOODLIGHTS STAND WHERE ITS KIND SAYS, TURNED WITH ITS YARD', () => {
    const kind: DepotKind = {
      yard: 'Yard',
      beacon: 'Beacon',
      lamp: 'Bulb',
      half: 11,
      lampX: 5.7,
      lampY: 9.13,
      beaconX: 5,
      beaconY: 14.6,
      light: 13,
    };
    const parts = depotParts(
      { position: [100, 200], yaw: Math.PI / 2, lot: lot(100, 30) },
      kind,
      0.5,
    );
    /* A quarter turn takes local (x, z) to (z, −x): (5, 5) to (5, −5), (5.7, 5.7) to (5.7, −5.7). */
    /* Each on the 0.5 m of ground it is given. */
    expect(parts.map((p) => [p.template, ...p.position.map(round), round(p.y)])).toEqual([
      ['Yard', 100, 200, 0.5],
      ['Beacon', 105, 195, 15.1],
      ['Bulb', 105.7, 194.3, 9.63],
      ['Bulb', 94.3, 205.7, 9.63],
    ]);
    expect(parts.map((p) => [p.light?.intensity ?? 0, round(p.light?.y ?? 0)])).toEqual([
      [0, 0],
      [0, 0],
      [13, 9.63],
      [13, 9.63],
    ]);
  });

  it('PADS STAND MID-PAVEMENT, FACING THE ROAD, APART FROM EACH OTHER AND CLEAR OF THE FURNITURE', () => {
    const road = { id: 0, vertical: false, at: 0, from: 0, to: 300 } as unknown as Road;
    const run = (side: 1 | -1): SidewalkRun => ({
      road,
      side,
      from: 0,
      to: 300,
      kerb: 6,
      edge: 10,
    });
    /* Poles every 4 m along the first half of the +z pavement leave no room there within 3 m. */
    const poles: Placed[] = [];
    for (let x = 0; x <= 150; x += 4) {
      poles.push({ template: 'Pole', position: [x, 8], y: 0, yaw: 0, props: new Map() });
    }
    const pads = sitePads([run(1), run(-1)], poles, 'Pad', 0.34, 60, 12, 3, mulberry32(7));
    /* Between the kerb at 6 and the building line at 10, on either side. */
    expect(new Set(pads.map((p) => Math.abs(p.position[1])))).toEqual(new Set([8]));
    expect(new Set(pads.map((p) => p.position[1]))).toEqual(new Set([8, -8]));
    /* The side at +z faces −z, the road: a half turn; the other faces +z. */
    for (const p of pads) expect(round(p.yaw)).toBe(p.position[1] > 0 ? round(Math.PI) : 0);
    for (const p of pads) {
      for (const q of poles) {
        expect(Math.hypot(p.position[0] - q.position[0], p.position[1] - 8)).toBeGreaterThanOrEqual(
          3,
        );
      }
      for (const q of pads) {
        if (q !== p)
          expect(
            Math.hypot(p.position[0] - q.position[0], p.position[1] - q.position[1]),
          ).toBeGreaterThanOrEqual(12);
      }
    }
    /*
     * The sides are 16 m apart, beyond the 12 m spacing, so each run parks on its own: at most 26
     * pads on the open 300 m and 13 on the 147 m past the poles, and random parking jams at 0.748
     * of the gaps (Rényi's constant), about 19 and 9. One that gives up early falls short of 22.
     */
    expect(pads.length).toBeGreaterThanOrEqual(22);
    expect(pads.length).toBeLessThanOrEqual(39);
  });
});
