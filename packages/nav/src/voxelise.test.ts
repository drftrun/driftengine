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

/** A closed box, every face, as a modelling tool or `MeshBuilder.addBox` would emit it. */
function box(cx: number, cy: number, cz: number, hx: number, hy: number, hz: number): NavGeometry {
  const corners: number[] = [];
  for (const y of [cy - hy, cy + hy]) {
    for (const [x, z] of [
      [cx - hx, cz - hz],
      [cx + hx, cz - hz],
      [cx + hx, cz + hz],
      [cx - hx, cz + hz],
    ] as const) {
      corners.push(x, y, z);
    }
  }
  /* Bottom 0-3, top 4-7; each face as two triangles. */
  const faces = [
    [0, 1, 2, 3],
    [4, 7, 6, 5],
    [0, 4, 5, 1],
    [1, 5, 6, 2],
    [2, 6, 7, 3],
    [3, 7, 4, 0],
  ];
  return {
    positions: new Float32Array(corners),
    indices: new Uint32Array(faces.flatMap(([a, b, c, d]) => [a, b, c, a, c, d] as number[])),
  };
}

/** Whether the column under a world position has a walkable span within a cell of `height`. */
function walkableAt(
  field: ReturnType<typeof voxeliseWalkable>,
  x: number,
  z: number,
  height: number,
): boolean {
  const column = columnAt(field, x, z);
  if (column < 0) return false;
  const gx = column % field.width;
  const gz = Math.floor(column / field.width);
  for (let at = 0; at < spanCount(field, gx, gz); at += 1) {
    if (!spanWalkable(field, gx, gz, at)) continue;
    if (Math.abs(spanFloor(field, column, at) - height) <= field.cellHeight) return true;
  }
  return false;
}

/**
 * **Something standing on the floor is in the way.** A wall is a vertical face, which covers no
 * area seen from above, so sampling surfaces at cell centres never meets it: a building on the
 * ground read as a roof over walkable floor, and a navigation mesh built around one walked straight
 * through it. Steep faces are solids, rasterised over every cell they cross.
 */
describe('an obstacle on the floor', () => {
  it('takes the floor under a box taller than the agent out of the mesh', () => {
    const field = voxeliseWalkable(merge(plane(5, 0), box(0, 1.5, 0, 1.1, 1.5, 1.1)), SETTINGS);
    for (const x of [-1.1, 1.1]) {
      expect(walkableAt(field, x, 0, 0), `the floor under the face at x ${x}`).toBe(false);
    }
    expect(walkableAt(field, 1.6, 0, 0), 'the floor beside it, within the radius').toBe(false);
    expect(walkableAt(field, 3.5, 0, 0), 'the floor well clear of it').toBe(true);
  });

  /**
   * **The floor a closed box encloses stays walkable, cut off from everything outside.** A column
   * inside the box meets the floor, the box's bottom and its top, and nothing in that says the
   * space between is solid short of trusting every mesh's winding. Its walls are what make it
   * unreachable: the region builder finds no way in, so no route from outside enters it.
   */
  it('leaves the floor a closed box encloses as an island inside its walls', () => {
    const field = voxeliseWalkable(merge(plane(5, 0), box(0, 1.5, 0, 2.1, 1.5, 2.1)), SETTINGS);
    expect(walkableAt(field, 0, 0, 0), 'the enclosed floor').toBe(true);
    expect(walkableAt(field, 2.1, 0, 0), 'the ring of wall around it').toBe(false);
  });

  it('blocks with a wall that has no thickness and no top', () => {
    const wall: NavGeometry = {
      positions: new Float32Array([-5, 0, 0.1, 5, 0, 0.1, 5, 3, 0.1, -5, 3, 0.1]),
      indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
    };
    const field = voxeliseWalkable(merge(plane(5, 0), wall), SETTINGS);
    for (const x of [-2, 0, 2]) {
      expect(walkableAt(field, x, 0.1, 0), `the floor under the wall at x ${x}`).toBe(false);
      expect(walkableAt(field, x, 0.6, 0), `the floor beside it at x ${x}`).toBe(false);
      expect(walkableAt(field, x, 2, 0), `the floor two metres from it at x ${x}`).toBe(true);
    }
  });

  it('keeps the agent radius between the floor and the wall', () => {
    const field = voxeliseWalkable(merge(plane(5, 0), box(0, 1.5, 0, 1.1, 1.5, 1.1)), {
      ...SETTINGS,
      agentRadius: 1,
    });
    /* The face at x = 1.1 is in the column from 1 to 1.5, then two cells make a metre's radius. */
    expect(walkableAt(field, 1.75, 0, 0), 'within the radius of the face').toBe(false);
    expect(walkableAt(field, 2.25, 0, 0), 'at the edge of the radius').toBe(false);
    expect(walkableAt(field, 3.25, 0, 0), 'past it').toBe(true);
  });

  /**
   * **Shorter than the agent is not the same as a step.** Judged by the agent's height, a basin
   * 0.6 m high beside a 2 m agent was somewhere it could be, so the floor kept no margin and the
   * basin's top touched it; the polygons are flat, so two edges touching is a portal, and a route
   * went over the basin. The climb is what decides it, as it does for regions.
   */
  it('keeps the radius from a ledge higher than the agent can step', () => {
    /* The face at x = 1.3 is in the cell from 1 to 1.5, whose centre stands on the ledge's top. */
    const geometry = merge(plane(5, 0), box(0, 0.3, 0, 1.3, 0.3, 1.3));
    const stepping = voxeliseWalkable(geometry, { ...SETTINGS, maxStep: 1 });
    expect(walkableAt(stepping, 1.75, 0, 0), 'the floor beside a 0.6 m ledge').toBe(false);
    expect(walkableAt(stepping, 1.25, 0, 0.6), 'the ledge beside the floor').toBe(false);
    const climbing = voxeliseWalkable(geometry, { ...SETTINGS, maxStep: 4 });
    expect(walkableAt(climbing, 1.75, 0, 0), 'the same floor when 0.8 m is a step').toBe(true);
    expect(walkableAt(climbing, 1.25, 0, 0.6), 'and the same ledge').toBe(true);
  });

  it('leaves the top of a step the agent can stand on walkable', () => {
    const field = voxeliseWalkable(merge(plane(5, 0), box(0, 1.5, 0, 2, 1.5, 2)), SETTINGS);
    expect(walkableAt(field, 0, 0, 3), 'the middle of the roof').toBe(true);
  });
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
