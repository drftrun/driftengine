import { expect, test } from 'vitest';
import { createLightGrid, gatherLights } from './lightGrid.ts';
import {
  createPointLightBuffer,
  selectGridLights,
  selectPointLights,
} from './pointLightSelection.ts';
import type { PointLightBuffer, PointLightSource } from './pointLightSelection.ts';

/**
 * The frame's exact choice made through a grid is the full scan's choice, field for field — which
 * lights, in which slot, the cut the last ones fade against, how far the choice is complete and who
 * gets a shadow map. A lattice of lamps puts many at exactly equal distances from an eye on the
 * lattice, so ties are real here, and both lists break them by source index: a list that kept the
 * order it met lamps in would pick differently through a grid and nothing else would say.
 */
function lamps(): PointLightSource[] {
  const out: PointLightSource[] = [];
  for (let z = 0; z < 40; z++) {
    for (let x = 0; x < 40; x++) {
      out.push({
        x: x * 25,
        y: 6,
        z: z * 25,
        r: 1,
        g: 0.8,
        b: 0.5,
        radius: 20 + ((x * 7 + z * 3) % 4) * 5,
        flicker: 0,
        shadowNear: 0.1,
        sourceRadius: 0.1,
        /* Half the lamps summed by a field, so `complete` is decided by the left-out ones. */
        inLightField: (x + z) % 2 === 0,
      });
    }
  }
  return out;
}

function snapshot(buffer: PointLightBuffer): unknown[] {
  return Object.entries(buffer)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([key, value]) =>
      ArrayBuffer.isView(value) ? [key, Array.from(value as Float32Array)] : [key, value],
    );
}

test('THE GRID CHOOSES WHAT THE FULL SCAN CHOOSES, ties, cut, completeness and shadows included', () => {
  const sources = lamps();
  const eyes = [
    [500, 1.7, 500],
    [250, 1.7, 250],
    [0, 1.7, 0],
    [975, 40, 12.5],
    [-300, 5, 500],
    /* Equidistant from lamps 657, 658, 697 and 698, which 40 m cells meet as 657, 697, 658, 698:
       both lists must break the tie by index, not by the order the lamps arrived in. */
    [437.5, 1.7, 412.5],
  ];
  for (const cell of [3, 40, 500]) {
    const grid = createLightGrid(sources, cell);
    for (const [x, y, z] of eyes as [number, number, number][]) {
      for (const range of [60, 180]) {
        const scanned = createPointLightBuffer(64);
        const gridded = createPointLightBuffer(64);
        selectPointLights(sources, x, y, z, scanned, 0, range);
        selectGridLights(grid, x, y, z, gridded, 0, range);
        expect(snapshot(gridded), `cell ${cell}, eye ${x},${y},${z}, range ${range}`).toEqual(
          snapshot(scanned),
        );
      }
    }
  }
  /* And the grid looks at far fewer. At 60 m from the middle the reach is 60 + 35, the largest
     radius: cells 10 to 14 of 40 m on both axes, which hold the lamps at 400 to 575 — eight a side,
     64 of 1,600. */
  const grid = createLightGrid(sources, 40);
  expect(gatherLights(grid, 500, 1.7, 500, 60 + grid.maxRadius)).toBe(64);
});
