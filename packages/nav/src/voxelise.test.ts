import { describe, expect, it } from 'vitest';
import {
  columnAt,
  spanCount,
  spanFloor,
  spanWalkable,
  voxeliseWalkable,
  type NavGeometry,
} from './voxelise.ts';

/** A quad on the y = `height` plane, spanning x and z from `-half` to `+half`. */
function plane(half: number, height: number, tilt = 0): NavGeometry {
  return {
    positions: new Float32Array([
      -half,
      height,
      -half,
      half,
      height + tilt * 2 * half,
      -half,
      half,
      height + tilt * 2 * half,
      half,
      -half,
      height,
      half,
    ]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  };
}

function merge(...parts: NavGeometry[]): NavGeometry {
  const positions: number[] = [];
  const indices: number[] = [];
  let base = 0;
  for (const part of parts) {
    positions.push(...part.positions);
    for (const index of part.indices) indices.push(index + base);
    base += part.positions.length / 3;
  }
  return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
}

const SETTINGS = {
  cellSize: 0.5,
  cellHeight: 0.2,
  maxSlope: 45,
  agentHeight: 2,
  agentRadius: 0.5,
};

describe('voxelising a flat plane', () => {
  it('produces exactly one walkable layer everywhere', () => {
    const field = voxeliseWalkable(plane(4, 0), SETTINGS);
    expect(field.width).toBeGreaterThan(0);

    let columns = 0;
    let walkable = 0;
    for (let z = 0; z < field.depth; z += 1) {
      for (let x = 0; x < field.width; x += 1) {
        const count = spanCount(field, x, z);
        if (count === 0) continue;
        columns += 1;
        expect(count, 'a flat plane is one span per column').toBe(1);
        if (spanWalkable(field, x, z, 0)) walkable += 1;
      }
    }
    expect(columns).toBeGreaterThan(50);
    expect(walkable, 'and the middle of it is walkable').toBeGreaterThan(20);
  });

  it('is deterministic, byte for byte', () => {
    const a = voxeliseWalkable(plane(4, 0), SETTINGS);
    const b = voxeliseWalkable(plane(4, 0), SETTINGS);
    expect([...a.spans]).toEqual([...b.spans]);
    expect([...a.columnStart]).toEqual([...b.columnStart]);
  });

  it('puts the floor at the height of the surface', () => {
    const field = voxeliseWalkable(plane(4, 3), SETTINGS);
    const middle = columnAt(field, 0, 0);
    expect(middle).toBeGreaterThanOrEqual(0);
    expect(spanFloor(field, middle, 0)).toBeCloseTo(3, 1);
  });
});

describe('slope', () => {
  it('is walkable under the maximum and not over it', () => {
    /* tilt 0.5 over the full width is about 26.6°, tilt 2 is about 63.4°. */
    const gentle = voxeliseWalkable(plane(4, 0, 0.5), SETTINGS);
    const steep = voxeliseWalkable(plane(4, 0, 2), SETTINGS);

    expect(anyWalkable(gentle), 'a ramp under the limit is walkable').toBe(true);
    expect(anyWalkable(steep), 'one over it is not').toBe(false);
  });

  function anyWalkable(field: ReturnType<typeof voxeliseWalkable>): boolean {
    for (let z = 0; z < field.depth; z += 1) {
      for (let x = 0; x < field.width; x += 1) {
        for (let at = 0; at < spanCount(field, x, z); at += 1) {
          if (spanWalkable(field, x, z, at)) return true;
        }
      }
    }
    return false;
  }
});

/**
 * **The whole reason a voxel field is used rather than a heightfield.** A bridge over a path is two
 * walkable surfaces at one horizontal position, and a heightfield can only hold one of them — so
 * an agent under the bridge is either standing on the bridge or standing in the void.
 */
describe('an overhang', () => {
  it('produces two layers at the same horizontal position', () => {
    const field = voxeliseWalkable(merge(plane(3, 0), plane(3, 4)), SETTINGS);
    const column = columnAt(field, 0, 0);
    expect(spanCount(field, 0, 0) >= 0).toBe(true);
    expect(column).toBeGreaterThanOrEqual(0);

    let twoLayer = 0;
    for (let z = 0; z < field.depth; z += 1) {
      for (let x = 0; x < field.width; x += 1) {
        if (spanCount(field, x, z) === 2) twoLayer += 1;
      }
    }
    expect(twoLayer, 'the overlap really is two spans deep').toBeGreaterThan(20);
  });

  /** A ceiling closer than the agent is tall takes the floor beneath it out of the mesh. */
  it('removes walkability under a ceiling lower than the agent', () => {
    const roomy = voxeliseWalkable(merge(plane(3, 0), plane(3, 4)), SETTINGS);
    const cramped = voxeliseWalkable(merge(plane(3, 0), plane(3, 1)), SETTINGS);

    expect(walkableAtGround(roomy), 'four metres of headroom is enough').toBeGreaterThan(10);
    expect(walkableAtGround(cramped), 'one metre is not').toBe(0);
  });

  function walkableAtGround(field: ReturnType<typeof voxeliseWalkable>): number {
    let count = 0;
    for (let z = 0; z < field.depth; z += 1) {
      for (let x = 0; x < field.width; x += 1) {
        if (spanCount(field, x, z) > 0 && spanWalkable(field, x, z, 0)) count += 1;
      }
    }
    return count;
  }
});

/**
 * **An agent has a width, and the mesh has to know it before the mesh is built.** Eroding at query
 * time means every query pays for it and every query can get it wrong; eroding here means the mesh
 * is the space that agent can occupy, which is what a navigation mesh is for.
 */
describe('the agent radius', () => {
  it('erodes walkability away from an edge', () => {
    const wide = voxeliseWalkable(plane(4, 0), SETTINGS);
    const eroded = voxeliseWalkable(plane(4, 0), { ...SETTINGS, agentRadius: 1.5 });

    expect(count(eroded)).toBeLessThan(count(wide));
    expect(count(eroded), 'but the middle survives').toBeGreaterThan(0);
  });

  it('leaves nothing walkable on a strip narrower than the agent', () => {
    const strip: NavGeometry = {
      positions: new Float32Array([-4, 0, -0.4, 4, 0, -0.4, 4, 0, 0.4, -4, 0, 0.4]),
      indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
    };
    expect(count(voxeliseWalkable(strip, { ...SETTINGS, agentRadius: 1.5 }))).toBe(0);
  });

  /**
   * **A symmetric world must erode symmetrically**, and that is what says the passes do not
   * cascade. Eroding in place lets a cell cleared early in a pass clear its neighbour later in the
   * same pass, so the mesh is eaten from whichever corner the scan starts at — more margin on two
   * sides than on the other two, from an implementation detail nobody would think to look at. The
   * area thresholds above all survive it; this does not.
   */
  it('erodes the same amount from every side', () => {
    const field = voxeliseWalkable(plane(4, 0), { ...SETTINGS, agentRadius: 1.5 });

    /*
     * Against the columns that have geometry rather than against the grid, because the grid is a
     * cell wider than the plane on its high side — the last column's centre falls outside it. That
     * padding is not an asymmetry in the erosion and a test that measured it would say it was.
     */
    const covered = { x0: Infinity, x1: -Infinity, z0: Infinity, z1: -Infinity };
    const walkable = { x0: Infinity, x1: -Infinity, z0: Infinity, z1: -Infinity };
    for (let z = 0; z < field.depth; z += 1) {
      for (let x = 0; x < field.width; x += 1) {
        if (spanCount(field, x, z) === 0) continue;
        covered.x0 = Math.min(covered.x0, x);
        covered.x1 = Math.max(covered.x1, x);
        covered.z0 = Math.min(covered.z0, z);
        covered.z1 = Math.max(covered.z1, z);
        if (!spanWalkable(field, x, z, 0)) continue;
        walkable.x0 = Math.min(walkable.x0, x);
        walkable.x1 = Math.max(walkable.x1, x);
        walkable.z0 = Math.min(walkable.z0, z);
        walkable.z1 = Math.max(walkable.z1, z);
      }
    }

    expect(walkable.x0, 'something survived to measure').toBeLessThan(Infinity);
    const margins = [
      walkable.x0 - covered.x0,
      covered.x1 - walkable.x1,
      walkable.z0 - covered.z0,
      covered.z1 - walkable.z1,
    ];
    expect(margins, 'three cells in from every edge').toEqual([3, 3, 3, 3]);
  });

  function count(field: ReturnType<typeof voxeliseWalkable>): number {
    let total = 0;
    for (let z = 0; z < field.depth; z += 1) {
      for (let x = 0; x < field.width; x += 1) {
        for (let at = 0; at < spanCount(field, x, z); at += 1) {
          if (spanWalkable(field, x, z, at)) total += 1;
        }
      }
    }
    return total;
  }
});

describe('empty geometry', () => {
  it('is an empty field rather than a throw', () => {
    const field = voxeliseWalkable(
      { positions: new Float32Array(0), indices: new Uint32Array(0) },
      SETTINGS,
    );
    expect(field.width).toBe(0);
    expect(field.depth).toBe(0);
    expect(columnAt(field, 0, 0)).toBe(-1);
  });
});
