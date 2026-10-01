import { describe, expect, it } from 'vitest';

import { solidBox } from '@driftengine/core';
import type { MeshData } from '@driftengine/drft';

import type { CopyOf } from './kit.ts';
import { Elevation } from './visible.ts';

const solid = solidBox(1, 1, 1);
const unitBox: MeshData = {
  positions: solid.positions,
  normals: solid.normals,
  colors: new Float32Array(solid.positions.length),
  emissive: new Float32Array(solid.positions.length / 3),
  indices: solid.indices,
};
/** A unit box stretched to w × h × d and stood at (x, y, z), turned by `yaw` as a building is. */
function box(w: number, h: number, d: number, x: number, y: number, z: number, yaw = 0): CopyOf {
  const [c, s] = [Math.cos(yaw), Math.sin(yaw)];
  return {
    piece: 0,
    matrix: new Float32Array([c * w, 0, -s * w, 0, h, 0, s * d, 0, c * d, x, y, z]),
    uv: new Float32Array(8),
  };
}
const round = (xs: readonly number[]): number[] => xs.map((x) => Math.round(x * 1000) / 1000 + 0);

describe('what a building shows', () => {
  it('WHAT STANDS OUTERMOST IS WHAT SHOWS: A PANEL HIDES THE FACADE BEHIND IT, A ROOF THE TOP UNDER IT', () => {
    const view = new Elevation({ x: 0, z: 0, yaw: 0, w: 10, d: 10, h: 10 });
    /* A facade 10 m cube, a panel 10.2 m round it from 4 m to 6, a roof slab on top, and an
       awning 4 m wide jutting 2 m out of its +x side from 2 m up to 2.5. */
    view.add(box(10, 10, 10, 0, 5, 0), unitBox, 1);
    view.add(box(10.2, 2, 10.2, 0, 5, 0), unitBox, 2);
    view.add(box(10, 0.2, 10, 0, 10.1, 0), unitBox, 3);
    view.add(box(2, 0.5, 4, 6, 2.25, 0), unitBox, 4);
    const { bands, reach, top } = view.walls(2);
    /* Its walls rise to 10 m: the slab's 0.2 m of side above them reaches no cell. */
    expect(top).toBe(10);
    /* Each 2 m band of the facade shows 2 m of its four 10 m sides: 80 m². In the panel's band the
       panel shows instead, sampled at half-metre cells: twenty across a side — its extra 0.1 m
       reaches no cell's centre — four up, four sides, a quarter of a square metre each. The slab's
       0.2 m of side reaches no cell either. The awning's front hides eight cells of the facade's
       second band, and shows those and four at each end past the facade's corner: 4 m². */
    expect(round(bands.get(1) ?? [])).toEqual([80, 78, 0, 80, 80]);
    expect(round(bands.get(4) ?? [])).toEqual([0, 4]);
    expect(round(bands.get(2) ?? [])).toEqual([0, 0, 80]);
    expect(bands.get(3)).toBeUndefined();
    /* Where it stands, band by band, is where most of each side shows: the panel's band at the
       panel, and the awning's band at the facade, whatever juts from it. */
    expect(round(reach.slice(0, 4))).toEqual([-5, 5, -5, 5]);
    expect(round(reach.slice(4, 8))).toEqual([-5, 5, -5, 5]);
    expect(round(reach.slice(8, 12))).toEqual([-5.1, 5.1, -5.1, 5.1]);
    /* From above, the slab covers the facade's top: 20 × 20 cells of a quarter square metre; and
       the awning shows past the facade, 4 × 8 cells. */
    expect([...view.roof()]).toEqual([
      [3, 100],
      [4, 8],
    ]);
  });

  it('A BUILDING IS SEEN IN ITS OWN FRAME, TURNED AND PLACED', () => {
    /* Turned a quarter at (100, 50): its x runs along the world's −z and its z along x. A box 4 m
       along its x, 2 along its z and 6 up reaches ±2 and ±1 in that frame, whatever the world's. */
    const yaw = Math.PI / 2;
    const view = new Elevation({ x: 100, z: 50, yaw, w: 4, d: 2, h: 6 });
    view.add(box(4, 6, 2, 100, 3, 50, yaw), unitBox, 7);
    const { bands, reach, top } = view.walls(2);
    expect(top).toBe(6);
    /* Round its 12 m of side, 2 m a band: 24 m² in each of three. */
    expect(round(bands.get(7) ?? [])).toEqual([24, 24, 24]);
    expect(round(reach)).toEqual([-2, 2, -1, 1, -2, 2, -1, 1, -2, 2, -1, 1]);
    expect([...view.roof()]).toEqual([[7, 8]]);
    /* Stood 1 m along the world's x — the building's z — and 1 m along its −z — the building's x
       — it reaches −1 to 3 along the one and 0 to 2 along the other. */
    const moved = new Elevation({ x: 100, z: 50, yaw, w: 4, d: 2, h: 6 });
    moved.add(box(4, 6, 2, 101, 3, 49, yaw), unitBox, 7);
    expect(round(moved.walls(2).reach.slice(0, 4))).toEqual([-1, 3, 0, 2]);
    /* A mirrored copy is the same box, wound back by the expansion: the same reach. */
    const mirrored = new Elevation({ x: 100, z: 50, yaw, w: 4, d: 2, h: 6 });
    mirrored.add(box(-4, 6, 2, 101, 3, 49, yaw), unitBox, 7);
    expect(round(mirrored.walls(2).reach.slice(0, 4))).toEqual([-1, 3, 0, 2]);
  });
});
