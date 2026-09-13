import { describe, expect, it } from 'vitest';

import { MAX_POINT_LIGHTS } from './lightBudget.ts';
import {
  CLUSTER_COUNT,
  CLUSTER_TEXELS,
  CLUSTER_X,
  CLUSTER_Y,
  CLUSTER_Z,
  LIGHT_REGION_TEXELS,
  MAX_LIGHTS_PER_CLUSTER,
  TABLE_HEIGHT,
  TABLE_WIDTH,
  NO_SHADOW_SLOT,
  buildLightClusters,
  clusterBase,
  LIGHT_RECORD,
  LIGHT_TEXELS,
  lightBase,
  NO_IES_PROFILE,
  POINT_LIGHT_COS_INNER,
  POINT_LIGHT_COS_OUTER,
  createClusterTable,
  sliceOfViewDepth,
} from './clusteredLights.ts';

describe("the cluster table's shape", () => {
  it('holds every cluster, and a cluster never straddles a row', () => {
    expect(CLUSTER_COUNT).toBe(CLUSTER_X * CLUSTER_Y * CLUSTER_Z);
    /*
     * Eight texels a cluster into a 256-texel row is 32 clusters a row, exactly. A straddle would
     * mean the shader's texel address needed a divide, and the whole point of choosing 256 was
     * that it does not.
     */
    expect(TABLE_WIDTH % CLUSTER_TEXELS).toBe(0);
    expect(LIGHT_REGION_TEXELS % TABLE_WIDTH).toBe(0);
    expect(TABLE_HEIGHT * TABLE_WIDTH).toBe(LIGHT_REGION_TEXELS + CLUSTER_COUNT * CLUSTER_TEXELS);
  });

  it('gives each cluster one count texel and the rest to indices', () => {
    expect((CLUSTER_TEXELS - 1) * 4).toBe(MAX_LIGHTS_PER_CLUSTER);
  });

  it('allocates the table once, at the size the shape implies', () => {
    /*
     * 320 x 59 texels of RGBA32UI: 75,520 uints, 295 KB.
     *
     * **It was 57 rows, then 58, and is 59 as of 2026-08-27** — each step is one more texel in a
     * light's record, and 320 lights times one texel is 320 texels, which is exactly one row. The
     * fourth carried the spot's cone; the fifth carries an asymmetric photometric profile's
     * azimuth reference. The number is asserted rather than derived so that a layout change has to
     * come here and say what it cost, and what it costs is **5 KB against a 270 KB froxel region,
     * 1.7% of the table** — the reading to distrust is that a fifth texel of four is a quarter,
     * which is a quarter of the smaller half.
     */
    expect(createClusterTable()).toHaveLength(TABLE_WIDTH * TABLE_HEIGHT * 4);
    expect(TABLE_HEIGHT).toBe(59);
  });

  it('lays the last cluster inside the table rather than one texel past it', () => {
    /* The off-by-one that would corrupt nothing and read as an empty cluster. */
    expect(clusterBase(CLUSTER_COUNT - 1) + CLUSTER_TEXELS * 4).toBe(
      TABLE_WIDTH * TABLE_HEIGHT * 4,
    );
  });
});

describe('the depth partition', () => {
  /*
   * Hand-derived from `near * (far/near)^(k/24)` with near 1 and far 1000, which puts the slice
   * boundaries at 1000^(k/24). None of these is computed with the function under test.
   */
  const NEAR = 1;
  const FAR = 1000;

  it('puts the near plane in the first slice and the far plane in the last', () => {
    expect(sliceOfViewDepth(NEAR, NEAR, FAR)).toBe(0);
    expect(sliceOfViewDepth(999.9, NEAR, FAR)).toBe(CLUSTER_Z - 1);
  });

  it('clamps rather than running off either end', () => {
    expect(sliceOfViewDepth(0.01, NEAR, FAR)).toBe(0);
    expect(sliceOfViewDepth(5000, NEAR, FAR)).toBe(CLUSTER_Z - 1);
  });

  it('places a known depth in the slice the exponent names', () => {
    /* ln(31.7)/ln(1000) = 0.50036, times 24 is 12.009, so slice 12; 31.5 gives 11.987, so 11. */
    expect(sliceOfViewDepth(31.7, NEAR, FAR)).toBe(12);
    expect(sliceOfViewDepth(31.5, NEAR, FAR)).toBe(11);
    /* ln(12)/ln(1000) = 0.35973, times 24 is 8.633. Slice 8 spans 10 to 13.335. */
    expect(sliceOfViewDepth(12, NEAR, FAR)).toBe(8);
  });

  it('spends its slices where depth is discriminable, which linear would not', () => {
    /*
     * Half the slices inside the first 5% of the range. That is the property the exponential
     * partition is chosen for, and a linear one would put slice 12 at depth 500.
     */
    expect(sliceOfViewDepth(FAR * 0.05, NEAR, FAR)).toBeGreaterThan(CLUSTER_Z / 2);
  });
});

/**
 * Binning, against positions worked out by hand rather than by running the binner.
 *
 * The frame every case below is derived in: near 1, far 1000, a 60 degree vertical field of view
 * so `tan(fovY/2)` is 0.5773502691896258, and 16:9. The camera sits at the origin looking down
 * -z, which is what an identity view matrix gives, so a world z of -12 is a view depth of 12.
 *
 * Slice 8 spans depth 1000^(8/24) to 1000^(9/24), which is 10 to 13.3352. At depth 12 the frustum
 * half-height is 12 x 0.57735 = 6.9282 and the half-width is that times 16/9, 12.3168.
 *
 * Tile 8 of 16 spans NDC x 0 to 0.125, so world x 0 to 1.5396 at that depth; its centre is
 * 0.7698. Tile 4 of 9 spans NDC y -0.1111 to 0.1111, so world y -0.7698 to 0.7698, centred on
 * zero. A light at (0.7698, 0, -12) therefore sits in the middle of cluster (8, 4, 8), whose
 * index is 8 + 4 x 16 + 8 x 144 = 1224.
 */
describe('binning lights into froxels', () => {
  const NEAR = 1;
  const FAR = 1000;
  const TAN_HALF_FOV = 0.5773502691896258;
  const ASPECT = 16 / 9;
  /** The camera at the origin looking down -z. */
  const VIEW = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

  const CLUSTER_8_4_8 = 8 + 4 * 16 + 8 * 16 * 9;

  function lightSet(
    positions: number[],
    radii: number[],
  ): import('./clusteredLights.ts').ClusterLightSet {
    const n = radii.length;
    return {
      count: n,
      positions: new Float32Array(positions),
      colors: new Float32Array(n * 3).fill(1),
      radii: new Float32Array(radii),
      sourceRadii: new Float32Array(n).fill(0.1),
      weights: new Float32Array(n).fill(1),
    };
  }

  function bin(set: import('./clusteredLights.ts').ClusterLightSet, table: Uint32Array): number {
    return buildLightClusters(set, VIEW, NEAR, FAR, TAN_HALF_FOV, ASPECT, table, MAX_POINT_LIGHTS);
  }

  /** Every cluster holding at least one light, as `[clusterIndex, [lightIndex, …]]`. */
  function occupied(table: Uint32Array): [number, number[]][] {
    const out: [number, number[]][] = [];
    for (let cluster = 0; cluster < CLUSTER_COUNT; cluster++) {
      const base = clusterBase(cluster);
      const count = table[base] ?? 0;
      if (count === 0) continue;
      out.push([cluster, Array.from({ length: count }, (_, n) => table[base + 4 + n] ?? 0)]);
    }
    return out;
  }

  it('puts a light wholly inside one froxel into that froxel and no other', () => {
    const table = createClusterTable();
    /* Radius 0.5, against a 0.7698 clearance to the nearest face of the box. */
    bin(lightSet([0.7698, 0, -12], [0.5]), table);
    expect(occupied(table)).toEqual([[CLUSTER_8_4_8, [0]]]);
  });

  it('puts a light spanning a slice boundary into both slices', () => {
    const table = createClusterTable();
    /*
     * Slice 8 ends at depth 13.3352. A light at depth 13 with radius 1 reaches 14, so it must
     * appear in slice 9 as well as slice 8, in the same tile column.
     */
    bin(lightSet([0.7698, 0, -13], [1]), table);
    const slices = new Set(occupied(table).map(([c]) => Math.floor(c / (16 * 9))));
    expect([...slices].sort((a, b) => a - b)).toEqual([8, 9]);
  });

  it('bins a light behind the camera into nothing', () => {
    const table = createClusterTable();
    /* Ten metres the wrong way with a one metre radius: nothing in front can reach it. */
    bin(lightSet([0, 0, 10], [1]), table);
    expect(occupied(table)).toEqual([]);
  });

  it('carries a light record the shader can read back', () => {
    const table = createClusterTable();
    const set = lightSet([0.7698, 0, -12], [0.5]);
    expect(bin(set, table)).toBe(1);

    /* The record is floats carried as their own bits, so it reads back through the same view. */
    const record = new Float32Array(table.buffer, 0, 12);
    expect(record[0]).toBeCloseTo(0.7698, 4);
    expect(record[2]).toBeCloseTo(-12, 4);
    expect(record[3], 'the radius rides in w beside the position').toBeCloseTo(0.5, 4);
    expect(record[7], 'and the emitter size beside the colour').toBeCloseTo(0.1, 4);
    expect(record[8], 'with the weight in the third texel').toBeCloseTo(1, 4);
    expect(record[9], 'and the shadow slot beside it').toBeCloseTo(0, 4);
  });

  it('gives a light past the shadow pool no slot rather than one that is not there', () => {
    const table = createClusterTable();
    /* Twenty lights against sixteen shadow uniform slots: the last four carry no map. */
    const positions: number[] = [];
    const radii: number[] = [];
    for (let n = 0; n < 20; n++) {
      positions.push(0.7698, 0, -12);
      radii.push(0.2);
    }
    bin(lightSet(positions, radii), table);

    /*
     * The stride is derived rather than written as a literal, which it was: `20 * 12` and
     * `15 * 12 + 9` went stale the moment the record grew a fourth texel for the spot fields, and
     * the failure read as the binner having stopped assigning shadow slots.
     */
    const STRIDE = LIGHT_TEXELS * 4;
    const records = new Float32Array(table.buffer, 0, 20 * STRIDE);
    const slotOf = (light: number): number =>
      records[light * STRIDE + LIGHT_RECORD.shadowSlot] ?? 0;
    expect(slotOf(15), 'the last light with a slot names its own index').toBeCloseTo(15, 4);
    expect(slotOf(16), 'and the first one past the pool names none').toBeCloseTo(NO_SHADOW_SLOT, 4);
    expect(slotOf(19)).toBeCloseTo(NO_SHADOW_SLOT, 4);
  });

  /*
   * **The collapse, asserted as arithmetic rather than as pixels.**
   *
   * A point light is a spot whose cone admits every direction, and the shader's term is
   * `smoothstep(cosOuter, cosInner, dot(-L, dir))`. With the outer edge at −2 and the inner at −1,
   * every direction on the sphere satisfies `dot >= -1 >= cosInner`, so the expression is exactly
   * 1 — not approximately, and with no branch. That is what makes every published scene
   * bit-identical by construction rather than by measurement, so it is checked here where the
   * numbers are written rather than only in a capture.
   */
  it('gives a light with no cone one that admits every direction', () => {
    const table = createClusterTable();
    bin(lightSet([0.7698, 0, -12], [0.3]), table);
    const record = lightBase(0);
    const read = (slot: number): number => {
      const bits = new Uint32Array(1);
      bits[0] = table[record + slot] ?? 0;
      return new Float32Array(bits.buffer)[0] ?? 0;
    };
    expect(read(LIGHT_RECORD.cosInner)).toBe(POINT_LIGHT_COS_INNER);
    expect(read(LIGHT_RECORD.cosOuter)).toBe(POINT_LIGHT_COS_OUTER);
    /* Hand-evaluated: smoothstep is 1 at or past its upper edge, and dot never goes below −1. */
    expect(POINT_LIGHT_COS_OUTER).toBeLessThan(-1);
    expect(POINT_LIGHT_COS_INNER).toBe(-1);
    /* And no profile, which the shader tests for with a negative index. */
    expect(read(LIGHT_RECORD.iesProfile)).toBe(NO_IES_PROFILE);
  });

  it('carries a cone a caller did supply', () => {
    const table = createClusterTable();
    const set = {
      ...lightSet([0.7698, 0, -12], [0.3]),
      directions: new Float32Array([0, -1, 0]),
      coneCos: new Float32Array([0.94, 0.87]),
      iesProfiles: new Float32Array([2]),
    };
    bin(set, table);
    const record = lightBase(0);
    const read = (slot: number): number => {
      const bits = new Uint32Array(1);
      bits[0] = table[record + slot] ?? 0;
      return new Float32Array(bits.buffer)[0] ?? 0;
    };
    expect(read(LIGHT_RECORD.directionY)).toBeCloseTo(-1, 6);
    expect(read(LIGHT_RECORD.cosInner)).toBeCloseTo(0.94, 6);
    expect(read(LIGHT_RECORD.cosOuter)).toBeCloseTo(0.87, 6);
    expect(read(LIGHT_RECORD.iesProfile)).toBe(2);
  });

  it('writes indices in increasing light order', () => {
    const table = createClusterTable();
    /* Three lights in one cluster, supplied nearest last so an arrival order would show. */
    bin(lightSet([0.7698, 0, -12, 0.7698, 0.2, -12, 0.7698, -0.2, -12], [0.3, 0.3, 0.3]), table);
    const here = occupied(table).find(([c]) => c === CLUSTER_8_4_8);
    expect(here?.[1]).toEqual([0, 1, 2]);
  });

  it('reports a count that never exceeds the cap, and keeps the list sorted through overflow', () => {
    const table = createClusterTable();
    /*
     * Forty lights stacked in one froxel against a cap of 28. Spread across the tile's own
     * height so they are genuinely at different distances from its centre, which is what the
     * overflow rule ranks on.
     */
    const positions: number[] = [];
    const radii: number[] = [];
    for (let n = 0; n < 40; n++) {
      positions.push(0.7698, -0.35 + (0.7 * n) / 39, -12);
      radii.push(0.2);
    }
    bin(lightSet(positions, radii), table);

    const here = occupied(table).find(([c]) => c === CLUSTER_8_4_8);
    const held = here?.[1] ?? [];
    expect(held).toHaveLength(MAX_LIGHTS_PER_CLUSTER);
    /* Ascending, whatever the overflow did to the slots on the way. */
    expect([...held].sort((a, b) => a - b)).toEqual(held);
    /* And the survivors are a subset of what was offered, with no repeats. */
    expect(new Set(held).size).toBe(held.length);
  });

  it('keeps the nearest when a cluster overflows', () => {
    const table = createClusterTable();
    /*
     * The cluster's centre in y is zero. Twenty-eight lights close to it and one far out at the
     * edge, supplied first, so the far one is in the list before the cap is reached and must be
     * the one evicted rather than the last arrival.
     */
    const positions: number[] = [0.7698, 0.74, -12];
    const radii: number[] = [0.2];
    for (let n = 0; n < 28; n++) {
      positions.push(0.7698, -0.05 + (0.1 * n) / 27, -12);
      radii.push(0.2);
    }
    bin(lightSet(positions, radii), table);

    const here = occupied(table).find(([c]) => c === CLUSTER_8_4_8);
    expect(here?.[1], 'the light at the edge is the one dropped').not.toContain(0);
    expect(here?.[1]).toHaveLength(MAX_LIGHTS_PER_CLUSTER);
  });

  it('finds an off-axis light in the tiles it covers at depth, not just at its near edge', () => {
    /*
     * **The regression `cluster-check.mjs` found.** The tile box used to be derived by projecting
     * the sphere at its nearest depth, which magnifies an off-axis interval away from the centre:
     * this light spans NDC y -58 to -3 at its near edge, so it clamped to the bottom tile row and
     * every other row it genuinely covers was skipped. The lights it dropped were real, and the
     * frame simply lacked them on WebGL2.
     *
     * A light 8.882 m below the axis at 8.2 m depth with an 8 m radius. At the far end of its own
     * extent the half-height is 9.353, so it spans NDC y -1.80 to -0.09 — which is tile row 0 and
     * rows above it, not row 0 alone.
     */
    const table = createClusterTable();
    buildLightClusters(
      lightSet([5.184, -8.882, -8.2], [8]),
      VIEW,
      0.5,
      400,
      TAN_HALF_FOV,
      ASPECT,
      table,
      MAX_POINT_LIGHTS,
    );
    const rows = new Set(occupied(table).map(([c]) => Math.floor((c % (16 * 9)) / 16)));
    expect(rows.size, 'more than the one edge row').toBeGreaterThan(1);
    expect(rows.has(1), 'including the row the gate found missing').toBe(true);
  });

  it('allocates nothing after the first call', () => {
    const table = createClusterTable();
    const set = lightSet([0.7698, 0, -12], [0.5]);
    bin(set, table);
    /*
     * Not a memory measurement — those are unreliable in a test character. What this pins is that
     * the table is the only thing written: a second call over the same table produces the same
     * bytes, so nothing is accumulating in it frame over frame.
     */
    const first = Uint32Array.from(table);
    bin(set, table);
    expect(Array.from(table)).toEqual(Array.from(first));
  });
});
