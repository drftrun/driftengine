import { describe, expect, it } from 'vitest';

import { MAX_POINT_LIGHTS, resolvePointLights } from './lightBudget.ts';
import { createAreaLightBuffer } from './areaLights.ts';
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
  clusteredLightTotal,
  LIGHT_RECORD,
  LIGHT_TEXELS,
  lightBase,
  lightChannelsOf,
  NO_IES_PROFILE,
  POINT_LIGHT_COS_INNER,
  POINT_LIGHT_COS_OUTER,
  createClusterTable,
  sliceOfViewDepth,
  LIGHT_FIXTURE_FLAG,
  clusteredMode,
  createClusterLightSet,
  fillClusterLightSet,
  halfBits,
  halfValue,
  lampSourceRadius,
  lightHasFixture,
  packSizeAndWeight,
  writeLightRecord,
  type ClusterLightSet,
} from './clusteredLights.ts';

describe("the cluster table's shape", () => {
  it('holds every cluster, and a cluster never straddles a row', () => {
    expect(CLUSTER_COUNT).toBe(CLUSTER_X * CLUSTER_Y * CLUSTER_Z);
    /*
     * Twenty texels a cluster into a 320-texel row is 16 clusters a row, exactly. A straddle would
     * mean the shader's texel address had to carry the wrap, and getting that wrong reads as
     * lights belonging to the froxel next door.
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
     * 320 x 222 texels of RGBA32UI: 284,160 uints, 1.1 MB.
     *
     * **222 since 4.8.7**: a sixth texel a light for its own falloff exponent, one row of 320, 5 KB
     * of a table near 1.1 MB.
     *
     * **It was 59 rows until 2026-09-25, when a froxel's run went from five texels to twenty**:
     * sixteen lights a froxel to seventy-six, because a candlelit interior asked up to fifty of one
     * and the froxels that overflowed drew as rectangles. The froxel region went from 270 KB to
     * 1.05 MB and the light region is unchanged at five rows.
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
    expect(TABLE_HEIGHT).toBe(222);
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
    /* The emitter size and the weight share the colour's texel as two halves; the binner was
       handed shadow slots, so this light is flagged as having a fixture to read. */
    const packed = table[LIGHT_RECORD.sizeAndWeight] ?? 0;
    expect(halfValue(packed & 0x7fff), 'and the emitter size beside the colour').toBeCloseTo(
      0.1,
      3,
    );
    expect(halfValue(packed >>> 16), 'with the weight beside it').toBe(1);
    expect(packed & LIGHT_FIXTURE_FLAG).toBe(LIGHT_FIXTURE_FLAG);
    expect(record[LIGHT_RECORD.shadowSlot], 'and the shadow slot in the third texel').toBeCloseTo(
      0,
      4,
    );
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
     * A hundred lights stacked in one froxel against a cap of 76. Spread across the tile's own
     * height so they are genuinely at different distances from its centre, which is what the
     * overflow rule ranks on.
     */
    const positions: number[] = [];
    const radii: number[] = [];
    for (let n = 0; n < 100; n++) {
      positions.push(0.7698, -0.35 + (0.7 * n) / 99, -12);
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
     * The cluster's centre in y is zero. Seventy-six lights close to it and one far out at the
     * edge, supplied first, so the far one is in the list before the cap is reached and must be
     * the one evicted rather than the last arrival.
     */
    const positions: number[] = [0.7698, 0.74, -12];
    const radii: number[] = [0.2];
    for (let n = 0; n < 76; n++) {
      positions.push(0.7698, -0.05 + (0.1 * n) / 75, -12);
      radii.push(0.2);
    }
    bin(lightSet(positions, radii), table);

    const here = occupied(table).find(([c]) => c === CLUSTER_8_4_8);
    expect(here?.[1], 'the light at the edge is the one dropped').not.toContain(0);
    expect(here?.[1]).toHaveLength(MAX_LIGHTS_PER_CLUSTER);
  });

  it('A FULL CLUSTER ENDS HOLDING THE SEVENTY-SIX NEAREST ITS CENTRE, WHATEVER ORDER THEY ARRIVE IN', () => {
    /*
     * Ninety-six lights in the froxel's plane, all at one x and one depth, so their distance from
     * the centre is their |y|: rank r stands 0.02 + 0.0075·r from it, alternately above and below,
     * the farthest at 0.73 inside a tile 0.77 each side. Light n has rank 7n mod 96, which visits
     * every rank once, so near and far arrive mixed and the rule has to evict repeatedly. The
     * twenty evicted are the lights ranked 76 to 95, which is n = 55·r mod 96 since 7·55 ≡ 1:
     *   r:  76 77 78 79 80 81 82 83 84 85 86 87 88 89 90 91 92 93 94 95
     *   n:  52 11 66 25 80 39 94 53 12 67 26 81 40 95 54 13 68 27 82 41
     */
    const table = createClusterTable();
    const positions: number[] = [];
    const radii: number[] = [];
    for (let n = 0; n < 96; n++) {
      const rank = (7 * n) % 96;
      positions.push(0.7698, (rank % 2 === 0 ? 1 : -1) * (0.02 + 0.0075 * rank), -12);
      radii.push(0.2);
    }
    bin(lightSet(positions, radii), table);
    const here = occupied(table).find(([c]) => c === CLUSTER_8_4_8);
    const evicted = [
      11, 12, 13, 25, 26, 27, 39, 40, 41, 52, 53, 54, 66, 67, 68, 80, 81, 82, 94, 95,
    ];
    const held = here?.[1] ?? [];
    expect(held).toHaveLength(76);
    for (const n of evicted)
      expect(held, `light ${n} is one of the twenty farthest`).not.toContain(n);
  });

  it('A FROXEL ASKED FOR FIFTY LIGHTS SHADES ALL FIFTY', () => {
    /*
     * **The number a candlelit interior asked of one froxel, measured.** Candles, lanterns and
     * braziers asked 461 of 3,456 froxels for more than sixteen and one for fifty. At a cap of
     * sixteen each of those kept its nearest and its neighbour kept a different set, and the step
     * between two froxels drew as a hard rectangle on the vault.
     */
    const table = createClusterTable();
    const positions: number[] = [];
    const radii: number[] = [];
    for (let n = 0; n < 50; n++) {
      positions.push(0.7698, -0.35 + (0.7 * n) / 49, -12);
      radii.push(0.2);
    }
    bin(lightSet(positions, radii), table);
    const here = occupied(table).find(([c]) => c === CLUSTER_8_4_8);
    expect(here?.[1]).toHaveLength(50);
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

  /*
   * A spot at the centre of cluster (8, 4, 8) aimed along +x, its sphere ten metres: the sphere
   * reaches all three froxels below, and the cone reaches one of them.
   *
   * At slice 8 (depth 10 to 13.3352) tile 12 spans x 5.132 to 8.554 and tile 4 spans -6.843 to
   * -3.849, both in row 4 (y within 0.8555). Row 0 of tile 8 spans y -7.699 to -5.132.
   *
   * - (12, 4, 8): its centre is 6.073 m along the axis and 0.332 m off it, inside a 10° cone.
   * - (4, 4, 8): its centre is 6.124 m behind the apex, and its bounding sphere 2.398 m: past
   *   `A + 90°` from the axis, so the nearest point of the cone is the apex and the gap is 3.73.
   * - (8, 0, 8): its centre is 6.42 m off the axis and 0.086 m along it, so 6.31 m from the cone
   *   against a bounding sphere of 2.27.
   */
  it('A SPOT IS BINNED INTO THE FROXELS ITS CONE REACHES, NOT EVERY ONE ITS SPHERE TOUCHES', () => {
    const at = (i: number, j: number, k: number): number => i + j * 16 + k * 16 * 9;
    const point = lightSet([0.7698, 0, -12], [10]);
    const spot: ClusterLightSet = {
      ...point,
      directions: new Float32Array([1, 0, 0]),
      coneCos: new Float32Array([Math.cos((8 * Math.PI) / 180), Math.cos((10 * Math.PI) / 180)]),
    };
    const pointTable = createClusterTable();
    bin(point, pointTable);
    const lit = new Set(occupied(pointTable).map(([c]) => c));
    for (const c of [at(8, 4, 8), at(12, 4, 8), at(4, 4, 8), at(8, 0, 8)]) {
      expect(lit.has(c), `the sphere reaches ${c}`).toBe(true);
    }

    const spotTable = createClusterTable();
    bin(spot, spotTable);
    const coned = new Set(occupied(spotTable).map(([c]) => c));
    expect(coned.has(at(8, 4, 8)), 'the froxel holding the apex').toBe(true);
    expect(coned.has(at(12, 4, 8)), 'down the axis').toBe(true);
    expect(coned.has(at(4, 4, 8)), 'behind the apex').toBe(false);
    expect(coned.has(at(8, 0, 8)), 'beside the cone').toBe(false);
    expect(coned.size).toBeLessThan(lit.size / 4);
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

/*
 * **The record a plain light is read in two texels of**, and every piece that keeps that exact: the
 * half precision the size and weight share a word at, the flag that says the rest is worth reading,
 * and the one assembly both renderers fill the binner's input with.
 */
describe('the two-texel record', () => {
  const floatOf = (bits: number): number => {
    const word = new Uint32Array([bits]);
    return new Float32Array(word.buffer)[0] ?? Number.NaN;
  };

  function oneLight(extra: Partial<ClusterLightSet> = {}): ClusterLightSet {
    return {
      count: 1,
      positions: new Float32Array([1, 2, 3]),
      colors: new Float32Array([0.5, 0.25, 1]),
      radii: new Float32Array([8]),
      sourceRadii: new Float32Array([0.1]),
      weights: new Float32Array([0.75]),
      ...extra,
    };
  }

  it('rounds to the nearest half, ties to even', () => {
    expect(halfBits(1)).toBe(0x3c00);
    expect(halfBits(-2)).toBe(0xc000);
    expect(halfBits(0.1)).toBe(0x2e66);
    expect(halfBits(65504)).toBe(0x7bff);
    /* Past the largest half by more than half a step, which is infinity. */
    expect(halfBits(65520)).toBe(0x7c00);
    /* Exactly between 1 and the next half: even wins, which is 1. Between the next two: up. */
    expect(halfBits(1 + 2 ** -11)).toBe(0x3c00);
    expect(halfBits(1 + 3 * 2 ** -11)).toBe(0x3c02);
    expect(halfBits(-0)).toBe(0x8000);
    expect(halfBits(Number.NaN) & 0x7c00).toBe(0x7c00);
  });

  it('flushes what only a subnormal half could hold to a signed zero', () => {
    expect(halfBits(2 ** -14)).toBe(0x0400);
    expect(halfBits(6e-5)).toBe(0);
    expect(halfBits(-6e-5)).toBe(0x8000);
  });

  it('reads every normal half and zero back to the bits it came from', () => {
    for (let half = 0; half < 0x10000; half++) {
      const exponent = (half >>> 10) & 0x1f;
      if (exponent === 0x1f || (exponent === 0 && (half & 0x3ff) !== 0)) continue;
      expect(halfBits(halfValue(half))).toBe(half);
    }
  });

  it('packs the size in the low half, the weight in the high, and the flag in the size sign', () => {
    const plain = packSizeAndWeight(0.1, 0.75, false);
    expect(plain & 0xffff).toBe(halfBits(0.1));
    expect(plain >>> 16).toBe(halfBits(0.75));
    expect(plain & LIGHT_FIXTURE_FLAG).toBe(0);
    const fixture = packSizeAndWeight(0.1, 0.75, true);
    expect(fixture & LIGHT_FIXTURE_FLAG).toBe(LIGHT_FIXTURE_FLAG);
    expect(fixture & 0x7fff).toBe(halfBits(0.1));
    /* A negative size reads as its magnitude, so it cannot pose as the flag. */
    expect(packSizeAndWeight(-0.1, 1, false) & LIGHT_FIXTURE_FLAG).toBe(0);
    /* A negative weight keeps its sign: a DriftLight field's own light carries one. */
    expect(halfValue(packSizeAndWeight(0, -0.5, false) >>> 16)).toBe(-0.5);
  });

  it('writes a plain light that the shader can stop reading after two texels', () => {
    const record = new Uint32Array(LIGHT_TEXELS * 4);
    writeLightRecord(oneLight(), 0, 0, record, 0);
    expect(floatOf(record[LIGHT_RECORD.positionY] ?? 0)).toBe(2);
    expect(floatOf(record[LIGHT_RECORD.radius] ?? 0)).toBe(8);
    expect(floatOf(record[LIGHT_RECORD.colorG] ?? 0)).toBe(0.25);
    const packed = record[LIGHT_RECORD.sizeAndWeight] ?? 0;
    expect(packed & LIGHT_FIXTURE_FLAG).toBe(0);
    expect(halfValue(packed & 0x7fff)).toBe(lampSourceRadius(0.1));
    expect(halfValue(packed >>> 16)).toBe(0.75);
    /* What the shader assumes in place of texels two to four is exactly what they hold. */
    expect(floatOf(record[LIGHT_RECORD.shadowSlot] ?? 0)).toBe(NO_SHADOW_SLOT);
    expect(floatOf(record[LIGHT_RECORD.directionX] ?? 0)).toBe(0);
    expect(floatOf(record[LIGHT_RECORD.cosInner] ?? 0)).toBe(POINT_LIGHT_COS_INNER);
    expect(floatOf(record[LIGHT_RECORD.cosOuter] ?? 0)).toBe(POINT_LIGHT_COS_OUTER);
    expect(floatOf(record[LIGHT_RECORD.iesProfile] ?? 0)).toBe(NO_IES_PROFILE);
    expect(floatOf(record[LIGHT_RECORD.cookie] ?? 0)).toBe(NO_IES_PROFILE);
    expect(floatOf(record[LIGHT_RECORD.iesAxisZ] ?? 0)).toBe(0);
    /* Channel 1, which is what the shader takes for a plain light it does not read further. */
    expect(floatOf(record[LIGHT_RECORD.channels] ?? 0)).toBe(1);
  });

  /*
   * **A light on channels of its own is read to its fifth texel**, where its mask sits: a plain
   * light is taken to be on channel 1 without being read, so a light anywhere else has to say so
   * through the fixture flag, or the clustered arm would light every surface with it. A mask that
   * is not a whole number from 1 to 255 is channel 1 on both arms.
   */
  it('A LIGHT ON CHANNELS OF ITS OWN CARRIES THEM, AND IS READ AS FAR AS THEY ARE', () => {
    const record = new Uint32Array(LIGHT_TEXELS * 4);
    writeLightRecord(oneLight({ channels: new Float32Array([2]) }), 0, 0, record, 0);
    expect(floatOf(record[LIGHT_RECORD.channels] ?? 0)).toBe(2);
    expect((record[LIGHT_RECORD.sizeAndWeight] ?? 0) & LIGHT_FIXTURE_FLAG).not.toBe(0);
    expect(lightHasFixture(oneLight({ channels: new Float32Array([1]) }), 0, 0)).toBe(false);
    expect(lightHasFixture(oneLight({ channels: new Float32Array([3]) }), 0, 0)).toBe(true);
    for (const bad of [0, 256, 1.5, Number.NaN]) {
      writeLightRecord(oneLight({ channels: new Float32Array([bad]) }), 0, 0, record, 0);
      expect(floatOf(record[LIGHT_RECORD.channels] ?? 0), String(bad)).toBe(1);
    }
    expect(lightChannelsOf(7)).toBe(7);
    expect(lightChannelsOf(undefined)).toBe(1);
  });

  /*
   * **A light with its own falloff exponent is read to its sixth texel**, where the exponent sits:
   * a plain light is taken to fall off by the frame's rule without being read, so a light that
   * names its own has to say so through the fixture flag. Anything not a positive finite number is
   * the frame's rule, 0, on both arms.
   */
  it('A LIGHT WITH ITS OWN FALLOFF EXPONENT CARRIES IT, AND IS READ AS FAR AS IT IS', () => {
    const record = new Uint32Array(LIGHT_TEXELS * 4);
    writeLightRecord(oneLight({ falloffExponents: new Float32Array([8]) }), 0, 0, record, 0);
    expect(floatOf(record[LIGHT_RECORD.falloffExponent] ?? 0)).toBe(8);
    expect((record[LIGHT_RECORD.sizeAndWeight] ?? 0) & LIGHT_FIXTURE_FLAG).not.toBe(0);
    expect(lightHasFixture(oneLight({ falloffExponents: new Float32Array([0]) }), 0, 0)).toBe(
      false,
    );
    for (const bad of [-2, Number.NaN, Number.POSITIVE_INFINITY]) {
      writeLightRecord(oneLight({ falloffExponents: new Float32Array([bad]) }), 0, 0, record, 0);
      expect(floatOf(record[LIGHT_RECORD.falloffExponent] ?? 0), String(bad)).toBe(0);
    }
    expect(LIGHT_RECORD.falloffExponent, 'in the sixth texel').toBe(20);
  });

  it('flags a light with a shadow slot, a cone, a profile or a cookie, and nothing else', () => {
    const flagged = (set: ClusterLightSet, slots = 0): boolean => {
      const record = new Uint32Array(LIGHT_TEXELS * 4);
      writeLightRecord(set, 0, slots, record, 0);
      return ((record[LIGHT_RECORD.sizeAndWeight] ?? 0) & LIGHT_FIXTURE_FLAG) !== 0;
    };
    expect(flagged(oneLight())).toBe(false);
    /* A direction alone is not a fixture: with no cone it changes nothing the shader computes. */
    expect(flagged(oneLight({ directions: new Float32Array([0, -1, 0]) }))).toBe(false);
    expect(flagged(oneLight(), 1)).toBe(true);
    expect(flagged(oneLight({ coneCos: new Float32Array([0.9, 0.8]) }))).toBe(true);
    expect(flagged(oneLight({ iesProfiles: new Float32Array([0]) }))).toBe(true);
    expect(flagged(oneLight({ cookies: new Float32Array([3]) }))).toBe(true);
    expect(lightHasFixture(oneLight(), 0, 1)).toBe(true);
    expect(lightHasFixture(oneLight(), 0, 0)).toBe(false);
  });

  it('names the frame plain until one light carries a fixture', () => {
    const many = (extra: Partial<ClusterLightSet> = {}): ClusterLightSet => ({
      ...oneLight(),
      count: 3,
      positions: new Float32Array(9),
      colors: new Float32Array(9),
      radii: new Float32Array([1, 1, 1]),
      sourceRadii: new Float32Array(3),
      weights: new Float32Array([1, 1, 1]),
      ...extra,
    });
    expect(clusteredMode(many(), 3, 0)).toBe(1);
    expect(
      clusteredMode(many({ coneCos: new Float32Array([-1, -2, -1, -2, 0.9, 0.8]) }), 3, 0),
    ).toBe(2);
    /* The third light's cone is past the count, so it is not this frame's. */
    expect(
      clusteredMode(many({ coneCos: new Float32Array([-1, -2, -1, -2, 0.9, 0.8]) }), 2, 0),
    ).toBe(1);
    expect(clusteredMode(many(), 3, 16)).toBe(2);
  });

  /*
   * The defect this assembly replaced: both renderers copied five arrays and dropped the rest, so
   * every spot, profile and cookie shaded as a bare point light with clustering on.
   */
  it('carries every fixture field, and no emitter size where none was given', () => {
    const directions = new Float32Array([0, -1, 0]);
    const coneCos = new Float32Array([0.9, 0.8]);
    const iesProfiles = new Float32Array([1]);
    const iesAxes = new Float32Array([1, 0, 0]);
    const cookies = new Float32Array([2]);
    const set = fillClusterLightSet(
      {
        lightCount: 1,
        lightPositions: new Float32Array(3),
        lightColors: new Float32Array(3),
        lightRadii: new Float32Array([5]),
        lightWeights: new Float32Array([1]),
        lightDirections: directions,
        lightConeCos: coneCos,
        lightIesProfiles: iesProfiles,
        lightIesAxes: iesAxes,
        lightCookies: cookies,
      },
      createClusterLightSet(),
    );
    expect(set.directions).toBe(directions);
    expect(set.coneCos).toBe(coneCos);
    expect(set.iesProfiles).toBe(iesProfiles);
    expect(set.iesAxes).toBe(iesAxes);
    expect(set.cookies).toBe(cookies);
    /* The fixed arm reads a missing size as none; this read the radius, a five-metre emitter. */
    expect(set.sourceRadii[0] ?? 0).toBe(0);
  });

  it('rounds the fixed arm the way the record rounds it', () => {
    const resolved = resolvePointLights(
      {
        lightCount: 1,
        lightPositions: new Float32Array(MAX_POINT_LIGHTS * 3),
        lightColors: new Float32Array(MAX_POINT_LIGHTS * 3),
        lightRadii: new Float32Array(MAX_POINT_LIGHTS).fill(8),
        lightSourceRadii: new Float32Array(MAX_POINT_LIGHTS).fill(0.1),
        lightWeights: new Float32Array(MAX_POINT_LIGHTS).fill(0.3),
      },
      'smooth',
      {
        count: 0,
        falloff: 0,
        positions: new Float32Array(0),
        colors: new Float32Array(0),
        radii: new Float32Array(0),
        sourceRadii: new Float32Array(0),
        weights: new Float32Array(0),
        directions: new Float32Array(0),
        coneCos: new Float32Array(0),
        iesProfiles: new Float32Array(0),
        iesAxes: new Float32Array(0),
        cookies: new Float32Array(0),
        axesAndChannels: new Float32Array(MAX_POINT_LIGHTS * 4),
        conesAndFalloffs: new Float32Array(MAX_POINT_LIGHTS * 4),
        heldSourceRadii: new Float32Array(MAX_POINT_LIGHTS),
        heldWeights: new Float32Array(MAX_POINT_LIGHTS),
      },
    );
    const record = new Uint32Array(LIGHT_TEXELS * 4);
    writeLightRecord(
      oneLight({ sourceRadii: new Float32Array([0.1]), weights: new Float32Array([0.3]) }),
      0,
      0,
      record,
      0,
    );
    const packed = record[LIGHT_RECORD.sizeAndWeight] ?? 0;
    expect(resolved.sourceRadii[0]).toBe(Math.fround(halfValue(packed & 0x7fff)));
    expect(resolved.weights[0]).toBe(Math.fround(halfValue(packed >>> 16)));
    expect(resolved.weights[0]).not.toBe(Math.fround(0.3));
  });
});

/*
 * **A rectangle past the fixed arm's is a record in the table**, told from a lamp by its negative
 * radius — its reach — with its axes and extents where a spot keeps its fixture, and binned into
 * the froxels its reach touches without a cone test, whose cosine slot it holds a half-height in.
 */
describe('a rectangle in the froxel table', () => {
  const floatOf = (bits: number): number =>
    new Float32Array(new Uint32Array([bits]).buffer)[0] ?? 0;
  function withAreas(count: number): ClusterLightSet {
    const areas = createAreaLightBuffer(3);
    areas.count = 3;
    areas.positions.set([9, 9, 9, 0.7698, 0, -12, 1, 2, 3]);
    areas.colors.set([0, 0, 0, 2, 1, 0.5, 0, 0, 0]);
    areas.right.set([0, 0, 0, 1, 0, 0, 0, 0, 0]);
    areas.up.set([0, 0, 0, 0, 0, 1, 0, 0, 0]);
    areas.sizes.set([1, 1, 0.6, 0.4, 1, 1]);
    areas.twoSided.set([0, 1, 0]);
    areas.ranges?.set([1, 0.5, 1]);
    areas.barnDoors?.set([0, 0, 0.5, 0.3, 0, 0]);
    return {
      count,
      positions: new Float32Array(count * 3),
      colors: new Float32Array(count * 3),
      radii: new Float32Array(count),
      sourceRadii: new Float32Array(count),
      weights: new Float32Array(count).fill(1),
      areas,
      areaFrom: 1,
      areaCount: 1,
    };
  }

  it('A RECTANGLE IS A RECORD WITH ITS REACH NEGATED AND ITS SHAPE IN THE FIXTURE TEXELS', () => {
    const lights = withAreas(0);
    expect(clusteredLightTotal(lights)).toBe(1);
    expect(lightHasFixture(lights, 0, 0)).toBe(true);
    const record = new Uint32Array(LIGHT_TEXELS * 4);
    writeLightRecord(lights, 0, 0, record, 0);
    expect(floatOf(record[LIGHT_RECORD.positionX] ?? 0)).toBeCloseTo(0.7698);
    expect(floatOf(record[LIGHT_RECORD.radius] ?? 0)).toBe(-0.5);
    expect(floatOf(record[LIGHT_RECORD.colorR] ?? 0)).toBe(2);
    expect((record[LIGHT_RECORD.sizeAndWeight] ?? 0) & LIGHT_FIXTURE_FLAG).not.toBe(0);
    expect(floatOf(record[LIGHT_RECORD.shadowSlot] ?? 0), 'two-sided').toBe(1);
    expect(floatOf(record[LIGHT_RECORD.directionX] ?? 0), 'right').toBe(1);
    expect(floatOf(record[LIGHT_RECORD.cosInner] ?? 0), 'half-width').toBeCloseTo(0.6);
    expect(floatOf(record[LIGHT_RECORD.cosOuter] ?? 0), 'half-height').toBeCloseTo(0.4);
    expect(floatOf(record[LIGHT_RECORD.iesAxisZ] ?? 0), 'up').toBe(1);
    expect(floatOf(record[LIGHT_RECORD.barnDoorCos] ?? 0), 'the doors').toBe(0.5);
    expect(floatOf(record[LIGHT_RECORD.barnDoorLength] ?? 0)).toBe(Math.fround(0.3));
    expect(floatOf(record[LIGHT_RECORD.falloffExponent] ?? 0), 'no exponent').toBe(0);
    expect(clusteredMode(lights, 1, 0)).toBe(2);
  });

  /*
   * At the centre of cluster (8, 4, 8), whose box is 0.77 m to its nearest face: a reach of half a
   * metre stays inside it, and a half-height of 0.4 read as a cone's cosine would cull it from the
   * very froxel it sits in.
   */
  it('is binned by its reach into the froxel it stands in, and no cone test drops it', () => {
    const table = createClusterTable();
    buildLightClusters(withAreas(0), VIEW_IDENTITY, 1, 1000, TAN_60, 16 / 9, table, 0);
    const holding: number[] = [];
    for (let cluster = 0; cluster < CLUSTER_COUNT; cluster++) {
      if ((table[clusterBase(cluster)] ?? 0) > 0) holding.push(cluster);
    }
    expect(holding).toEqual([8 + 4 * 16 + 8 * 16 * 9]);
  });
});

const VIEW_IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const TAN_60 = 0.5773502691896258;
