/**
 * Which tiles a view would sample, asked of a view nobody drew.
 *
 * **The estimate is allowed to be generous and never allowed to be short.** A tile it names that
 * the frame does not sample is a wasted fetch; a tile the frame samples that it does not name is a
 * tile that arrives late, which is the defect the whole wave exists to remove. Every case below is
 * one of those two directions, and the ones that pin a level pin it from the arithmetic rather than
 * from a run.
 */
import { frustumFromViewProjection, createFrustum, sphereInFrustum } from '@driftengine/core';
import { describe, expect, it } from 'vitest';
import { ADDRESS_MODE } from '../decodeGraph.ts';
import { hashTile } from '../tileHash.ts';
import type { LatentImage } from '../decodeCpu.ts';
import {
  LEVEL_MARGIN,
  latentTileGrid,
  tilesForView,
  type InstanceTileInfo,
  type MaterialTileGrid,
} from './viewTiles.ts';

/** gl-matrix's `perspective`, column-major and OpenGL-convention, as every camera here builds it. */
function perspective(fovy: number, aspect: number, near: number, far: number): Float32Array {
  const f = 1 / Math.tan(fovy / 2);
  const out = new Float32Array(16);
  out[0] = f / aspect;
  out[5] = f;
  out[10] = (far + near) / (near - far);
  out[11] = -1;
  out[14] = (2 * far * near) / (near - far);
  return out;
}

const IDENTITY = Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/**
 * A camera at `eye` looking along +x with +y up — **rotated**, so a view whose translation were
 * read as the camera's position would put it somewhere else entirely.
 */
function lookingAlongX(eye: readonly [number, number, number]): Float32Array {
  const out = new Float32Array(16);
  /* Rows are the camera's axes: right is +z, up is +y, and backward is -x. */
  out[8] = 1;
  out[5] = 1;
  out[2] = -1;
  out[12] = -eye[2];
  out[13] = -eye[1];
  out[14] = eye[0];
  out[15] = 1;
  return out;
}

/**
 * A 64-pixel square target through a 90-degree lens: one world unit at depth one is thirty-two
 * pixels, which is what makes every level below a whole number.
 */
const TARGET = 64;
const PROJ = perspective(Math.PI / 2, 1, 0.1, 100);

/** A grid whose hashes say where they came from: `prefix/level/tx,ty`. */
function grid(
  prefix: string,
  size: number,
  tile: number,
  mode: number = ADDRESS_MODE.LATTICE_CLAMP,
): MaterialTileGrid {
  const levels: string[][] = [];
  for (let level = 0; size >> level >= 1; level += 1) {
    const edge = size >> level;
    const across = Math.ceil(edge / tile);
    const row: string[] = [];
    for (let ty = 0; ty < across; ty += 1) {
      for (let tx = 0; tx < across; tx += 1)
        row.push(`${prefix}/${String(level)}/${String(tx)},${String(ty)}`);
    }
    levels.push(row);
  }
  return { width: size, height: size, tileSize: tile, addressMode: mode, levels };
}

interface Placed {
  at: readonly [number, number, number];
  radius: number;
  material: number;
  uv?: readonly [number, number, number, number];
  worldPerUv?: number;
}

function scene(
  materials: readonly (readonly MaterialTileGrid[])[],
  placed: readonly Placed[],
  target: readonly [number, number] = [TARGET, TARGET],
): InstanceTileInfo {
  const spheres = new Float32Array(placed.length * 4);
  const uvs = new Float32Array(placed.length * 4);
  const worldPerUv = new Float32Array(placed.length);
  const material = new Uint32Array(placed.length);
  placed.forEach((p, i) => {
    spheres.set([...p.at, p.radius], i * 4);
    uvs.set(p.uv ?? [0, 0, 1, 1], i * 4);
    worldPerUv[i] = p.worldPerUv ?? 1;
    material[i] = p.material;
  });
  return {
    count: placed.length,
    spheres,
    uvs,
    worldPerUv,
    material,
    materials,
    targetWidth: target[0],
    targetHeight: target[1],
  };
}

function tiles(
  view: Float32Array,
  info: InstanceTileInfo,
  budget = 1 << 20,
  proj = PROJ,
): string[] {
  const out: string[] = ['stale'];
  const count = tilesForView(view, proj, info, out, budget);
  expect(out).toHaveLength(count);
  return out;
}

const levelOf = (hash: string): number => Number(hash.split('/')[1]);
const levelsIn = (hashes: readonly string[]): number[] =>
  [...new Set(hashes.map(levelOf))].sort((a, b) => a - b);

/**
 * One instance straight ahead whose nearest point is at `depth`. With a 64-texel latent spanning
 * one world unit, the level its nearest pixel asks for is `log2(depth * 64 / 32)`, so a depth of 2
 * is level 2 exactly.
 */
function aheadAt(
  depth: number,
  proj = PROJ,
  target: readonly [number, number] = [TARGET, TARGET],
): string[] {
  const radius = 0.5;
  return tiles(
    IDENTITY,
    scene([[grid('a', 64, 16)]], [{ at: [0, 0, -(depth + radius)], radius, material: 0 }], target),
    1 << 20,
    proj,
  );
}

/** gl-matrix's `ortho`. */
function ortho(half: number, near: number, far: number): Float32Array {
  const out = new Float32Array(16);
  out[0] = 1 / half;
  out[5] = 1 / half;
  out[10] = -2 / (far - near);
  out[14] = -(far + near) / (far - near);
  out[15] = 1;
  return out;
}

describe('what is outside the view contributes nothing', () => {
  it('names no tile for an instance behind the camera, beside the view, or past the far plane', () => {
    const materials = [[grid('a', 64, 16)]];
    for (const at of [
      [0, 0, 5],
      [10, 0, -2.5],
      [0, -10, -2.5],
      [0, 0, -150],
    ] as const) {
      expect(
        tiles(IDENTITY, scene(materials, [{ at, radius: 0.5, material: 0 }])),
        `${at.join()}`,
      ).toEqual([]);
    }
  });

  it('keeps an instance that straddles a side plane, because half of it is on screen', () => {
    /* The right plane at depth 2.5 is x = 2.5; a sphere of half a unit at 2.8 crosses it. */
    const out = tiles(
      IDENTITY,
      scene([[grid('a', 64, 16)]], [{ at: [2.8, 0, -2.5], radius: 0.5, material: 0 }]),
    );
    expect(out.length).toBeGreaterThan(0);
    /* And one across the near plane, at a tenth: the plane is row four plus row three. */
    const near = tiles(
      IDENTITY,
      scene([[grid('a', 64, 16)]], [{ at: [0, 0, -0.05], radius: 0.1, material: 0 }]),
    );
    expect(near.length).toBeGreaterThan(0);
  });

  it('agrees with the engine’s own frustum test on every sphere', () => {
    /*
     * **The planes are extracted here rather than imported**, because this package is standalone
     * and its size floor says so. A rule that cannot be shared as code is shared as this test.
     */
    const frustum = frustumFromViewProjection(PROJ, createFrustum());
    const materials = [[grid('a', 4, 4)]];
    let seed = 7;
    const next = (): number => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return seed / 0x100000000;
    };
    let kept = 0;
    for (let i = 0; i < 2000; i += 1) {
      /* Single-precision values, so both tests see the numbers the instance table holds. */
      const at = [
        Math.fround(next() * 80 - 40),
        Math.fround(next() * 80 - 40),
        Math.fround(next() * 140 - 120),
      ] as const;
      const radius = Math.fround(next() * 4);
      const expected = sphereInFrustum(frustum, at[0], at[1], at[2], radius);
      const named = tiles(IDENTITY, scene(materials, [{ at, radius, material: 0 }])).length > 0;
      expect(named, `${at.join()} r ${String(radius)}`).toBe(expected);
      if (expected) kept += 1;
    }
    /* Both answers happened, or the corpus proved nothing. */
    expect(kept).toBeGreaterThan(200);
    expect(kept).toBeLessThan(1800);
  });

  it('reads the view as a whole matrix, so a turned and moved camera sees what is ahead of it', () => {
    const materials = [[grid('a', 64, 16)]];
    const view = lookingAlongX([10, 0, 3]);
    const at = (x: number, z: number): string[] =>
      tiles(view, scene(materials, [{ at: [x, 0, z], radius: 0.5, material: 0 }]));
    expect(at(15, 3).length).toBeGreaterThan(0);
    expect(at(5, 3)).toEqual([]);
    expect(at(10, 8)).toEqual([]);
    /* And not what a view read as `-translation` would see: that camera sits at (3, 0, -10). */
    expect(at(0, -15)).toEqual([]);
  });
});

describe('the level is the one the sampler would choose', () => {
  it('names finer tiles for a near instance than for a far one', () => {
    /* Nearest points at 2 and 40: levels 2 and log2(80), less the margin. */
    expect(levelsIn(aheadAt(2))[0]).toBe(1);
    expect(levelsIn(aheadAt(40))).toEqual([6]);
  });

  it('names both levels for an instance exactly at a boundary', () => {
    /*
     * Level 2 exactly: a sampler an estimate's width away picks level 1 or level 2, and trilinear
     * blends toward 3 as it recedes. Being conservative costs a level's tiles; not being costs a
     * visible transition in exactly the place the estimate was least sure.
     */
    expect(levelsIn(aheadAt(2))).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('names only the level it is inside when it is well inside one', () => {
    /* Level 2.5: the sampler blends levels 2 and 3, and nothing finer can be asked for. */
    expect(levelsIn(aheadAt(2 * Math.SQRT2))).toEqual([2, 3, 4, 5, 6]);
  });

  it('treats the margin as the width of a boundary, and no wider', () => {
    expect(levelsIn(aheadAt(2 * 2 ** (LEVEL_MARGIN / 2)))[0]).toBe(1);
    expect(levelsIn(aheadAt(2 * 2 ** (LEVEL_MARGIN * 2)))[0]).toBe(2);
  });

  it('names every coarser level, which is what a sampler falls back to', () => {
    /*
     * **A fine tile with no coarse parent resident is a hole rather than a blur**, and a surface
     * seen at a grazing angle asks for coarser levels than its distance says. The coarse tail
     * costs at most a third of the finest level's tiles.
     */
    const out = aheadAt(2);
    expect(out.filter((h) => levelOf(h) === 1)).toHaveLength(4);
    expect(out.filter((h) => levelOf(h) >= 2)).toHaveLength(5);
  });

  it('picks one level at every depth through an orthographic view', () => {
    /* Eight units across sixty-four pixels is eight pixels a unit: level 3, less the margin. */
    const flat = ortho(4, 0.1, 100);
    expect(levelsIn(aheadAt(2, flat))).toEqual([2, 3, 4, 5, 6]);
    expect(levelsIn(aheadAt(40, flat))).toEqual([2, 3, 4, 5, 6]);
  });

  it('takes the level from the axis with fewer pixels on a stretched target', () => {
    /* Sixty-four across and thirty-two down through a square lens: sixteen pixels a unit. */
    expect(levelsIn(aheadAt(2, PROJ, [64, 32]))).toEqual([2, 3, 4, 5, 6]);
    expect(levelsIn(aheadAt(2, PROJ, [32, 64]))).toEqual([2, 3, 4, 5, 6]);
  });

  it('names level zero for an instance the camera is inside', () => {
    const out = tiles(
      IDENTITY,
      scene([[grid('a', 64, 16)]], [{ at: [0, 0, -1], radius: 3, material: 0 }]),
    );
    expect(levelsIn(out)[0]).toBe(0);
  });

  it('still puts coarse before fine when the instance’s centre is behind the eye', () => {
    /* Its clip w is negative there, and a negative footprint would turn the priorities over. */
    const out = tiles(
      IDENTITY,
      scene([[grid('a', 64, 16)]], [{ at: [0, 0, 1], radius: 3, material: 0 }]),
    );
    expect(levelsIn(out)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(levelOf(out[0] as string)).toBe(6);
    expect(levelOf(out[out.length - 1] as string)).toBe(0);
    /* And an instance the camera is inside fills the screen, so it outranks one ahead of it. */
    const both = tiles(
      IDENTITY,
      scene(
        [[grid('b', 64, 16)], [grid('a', 64, 16)]],
        [
          { at: [0, 0, -3], radius: 0.5, material: 0 },
          { at: [0, 0, 1], radius: 3, material: 1 },
        ],
      ),
    );
    expect(both[0]).toBe('a/6/0,0');
  });

  it('reads a radius that is negative or not a number as a point', () => {
    for (const radius of [-1, Number.NaN]) {
      const info = scene(
        [[grid('a', 64, 16)], [grid('b', 64, 16)]],
        [
          { at: [0.4, 0, -1], radius, material: 0 },
          { at: [0, 0, -3], radius: 0.5, material: 1 },
        ],
      );
      const full = tiles(IDENTITY, info);
      /* A point half a unit inside the edge of the view is on screen. */
      expect(
        full.some((h) => h.startsWith('a/')),
        String(radius),
      ).toBe(true);
      expect(tiles(IDENTITY, info, 3)).toEqual(full.slice(0, 3));
    }
  });

  it('names every level when the surface’s density is not known', () => {
    for (const worldPerUv of [0, Number.NaN, -1, Infinity]) {
      const out = tiles(
        IDENTITY,
        scene([[grid('a', 64, 16)]], [{ at: [0, 0, -40.5], radius: 0.5, material: 0, worldPerUv }]),
      );
      expect(levelsIn(out), String(worldPerUv)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    }
  });

  it('names every level, in a stable order, when the target has no size', () => {
    for (const target of [
      [0, 0],
      [Number.NaN, Number.NaN],
    ] as const) {
      const info = scene(
        [[grid('a', 64, 16)], [grid('b', 64, 16)]],
        [
          { at: [0, 0, -40.5], radius: 0.5, material: 0 },
          { at: [1, 0, -3], radius: 0.5, material: 1 },
        ],
        target,
      );
      const full = tiles(IDENTITY, info);
      expect(levelsIn(full), String(target[0])).toEqual([0, 1, 2, 3, 4, 5, 6]);
      expect(tiles(IDENTITY, info, 5)).toEqual(full.slice(0, 5));
    }
  });

  it('names nothing from a grid whose tiles have no edge', () => {
    for (const tileSize of [0, Number.NaN, 0.5]) {
      const broken: MaterialTileGrid = {
        width: 64,
        height: 64,
        tileSize,
        addressMode: ADDRESS_MODE.LATTICE_CLAMP,
        levels: [['x']],
      };
      const out = tiles(IDENTITY, scene([[broken]], [{ at: [0, 0, -2], radius: 1, material: 0 }]));
      expect(out, String(tileSize)).toEqual([]);
    }
  });

  it('takes a latent’s size from its longer edge, as the device does', () => {
    /* 64 by 16 is a 64-texel latent to the level choice; its level 0 is 4 tiles by 1. */
    const wide: MaterialTileGrid = {
      width: 64,
      height: 16,
      tileSize: 16,
      addressMode: ADDRESS_MODE.LATTICE_CLAMP,
      levels: [0, 1, 2, 3, 4, 5, 6].map((level) => {
        const across = Math.ceil(Math.max(1, 64 >> level) / 16);
        const down = Math.ceil(Math.max(1, 16 >> level) / 16);
        return Array.from({ length: across * down }, (_, i) => `w/${String(level)}/${String(i)}`);
      }),
    };
    const out = tiles(IDENTITY, scene([[wide]], [{ at: [0, 0, -2.5], radius: 0.5, material: 0 }]));
    expect(levelsIn(out)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(out.filter((h) => levelOf(h) === 1)).toHaveLength(2);
    /* And turned on its side, 16 by 64, whose level 1 is one tile by two. */
    const tall: MaterialTileGrid = {
      ...wide,
      width: 16,
      height: 64,
      levels: wide.levels.map((row, level) => row.map((_, i) => `t/${String(level)}/${String(i)}`)),
    };
    const upright = tiles(
      IDENTITY,
      scene([[tall]], [{ at: [0, 0, -2.5], radius: 0.5, material: 0 }]),
    );
    expect(levelsIn(upright)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(upright.filter((h) => levelOf(h) === 1)).toHaveLength(2);
  });
});

describe('the texture coordinates an instance spans decide the tiles', () => {
  /** Level 0's tiles for one instance close enough to need level 0, as `tx,ty` pairs. */
  function levelZero(uv: readonly [number, number, number, number], mode: number): string[] {
    const out = tiles(
      IDENTITY,
      scene([[grid('a', 64, 16, mode)]], [{ at: [0, 0, -1], radius: 0.5, material: 0, uv }]),
    );
    return out
      .filter((h) => levelOf(h) === 0)
      .map((h) => h.split('/')[2] as string)
      .sort();
  }
  const columns = (...xs: number[]): string[] =>
    xs.flatMap((x) => [0, 1, 2, 3].map((y) => `${String(x)},${String(y)}`)).sort();

  it('names only the columns a partial span reaches', () => {
    expect(levelZero([0, 0, 0.2, 1], ADDRESS_MODE.LATTICE_CLAMP)).toEqual(columns(0));
    expect(levelZero([0, 0, 0.2, 1], ADDRESS_MODE.CENTRE_CLAMP)).toEqual(columns(0));
  });

  it('names the next column when bilinear filtering reads across the edge', () => {
    /* u = 0.25 on a lattice is texel 15.75, and its right-hand neighbour is texel 16. */
    expect(levelZero([0, 0, 0.25, 1], ADDRESS_MODE.LATTICE_CLAMP)).toEqual(columns(0, 1));
    expect(levelZero([0, 0, 0.25, 1], ADDRESS_MODE.CENTRE_CLAMP)).toEqual(columns(0, 1));
  });

  it('reaches half a texel less far on a centre-addressed texture than on a lattice', () => {
    /* u = 15.3 / 64 is texel 14.8 by centres and 15.06 on the lattice, whose neighbour is 16. */
    expect(levelZero([0, 0, 15.3 / 64, 1], ADDRESS_MODE.CENTRE_CLAMP)).toEqual(columns(0));
    expect(levelZero([0, 0, 15.3 / 64, 1], ADDRESS_MODE.LATTICE_CLAMP)).toEqual(columns(0, 1));
    /* And starts half a texel earlier: u = 16.25 / 64 is texel 15.75, in the first column. */
    expect(levelZero([16.25 / 64, 0, 0.4, 1], ADDRESS_MODE.CENTRE_CLAMP)).toEqual(columns(0, 1));
  });

  it('names the neighbour a wrapping lattice reads past a tile edge after the seam', () => {
    /* 1.25 wraps to 0.25, texel 15.75, whose neighbour is texel 16 in the second column. */
    expect(levelZero([0.9, 0, 1.25, 1], ADDRESS_MODE.LATTICE_WRAP)).toEqual(columns(0, 1, 3));
  });

  it('names every tile for an address mode it does not know', () => {
    expect(levelZero([0.4, 0, 0.5, 1], 7)).toEqual(columns(0, 1, 2, 3));
  });

  it('reads a span given high end first as the same span', () => {
    expect(levelZero([0.2, 0, 0, 1], ADDRESS_MODE.CENTRE_CLAMP)).toEqual(columns(0));
    expect(levelZero([1.05, 0, 0.9, 1], ADDRESS_MODE.CENTRE_WRAP)).toEqual(columns(0, 3));
  });

  it('names both edges for a wrapping span that crosses the seam, and one for a clamping span', () => {
    expect(levelZero([0.9, 0, 1.05, 1], ADDRESS_MODE.CENTRE_WRAP)).toEqual(columns(0, 3));
    expect(levelZero([0.9, 0, 1.05, 1], ADDRESS_MODE.LATTICE_WRAP)).toEqual(columns(0, 3));
    expect(levelZero([-0.1, 0, 0.05, 1], ADDRESS_MODE.CENTRE_WRAP)).toEqual(columns(0, 3));
    expect(levelZero([0.9, 0, 1.05, 1], ADDRESS_MODE.CENTRE_CLAMP)).toEqual(columns(3));
    expect(levelZero([0.9, 0, 1.05, 1], ADDRESS_MODE.LATTICE_CLAMP)).toEqual(columns(3));
  });

  it('names every column for a span that repeats, wherever it starts', () => {
    expect(levelZero([0, 0, 10, 1], ADDRESS_MODE.CENTRE_WRAP)).toEqual(columns(0, 1, 2, 3));
    expect(levelZero([3.5, 0, 4.6, 1], ADDRESS_MODE.LATTICE_WRAP)).toEqual(columns(0, 1, 2, 3));
    /* Without end, which no range of whole numbers can hold. */
    expect(levelZero([0, 0, Infinity, 1], ADDRESS_MODE.CENTRE_WRAP)).toEqual(columns(0, 1, 2, 3));
    expect(levelZero([-Infinity, 0, 0.1, 1], ADDRESS_MODE.LATTICE_WRAP)).toEqual(
      columns(0, 1, 2, 3),
    );
    /* More than once round, from late in one repeat to early in the one after next. */
    expect(levelZero([0.9, 0, 2.05, 1], ADDRESS_MODE.LATTICE_WRAP)).toEqual(columns(0, 1, 2, 3));
    /* A span that is not a number is not a reason to name nothing. */
    expect(levelZero([Number.NaN, 0, 0.1, 1], ADDRESS_MODE.CENTRE_CLAMP)).toEqual(
      columns(0, 1, 2, 3),
    );
  });

  it('repeats along one axis without reaching into the other', () => {
    /*
     * Ten repeats across, and a band from a twentieth to a tenth of the way down: the first row and
     * nothing else. (From zero it would name the last row too — a wrapping sample at the seam reads
     * the texel on the other side of it.)
     */
    const out = tiles(
      IDENTITY,
      scene(
        [[grid('a', 64, 16, ADDRESS_MODE.CENTRE_WRAP)]],
        [{ at: [0, 0, -1], radius: 0.5, material: 0, uv: [0, 0.05, 10, 0.1] }],
      ),
    );
    expect(out.filter((h) => levelOf(h) === 0).sort()).toEqual([
      'a/0/0,0',
      'a/0/1,0',
      'a/0/2,0',
      'a/0/3,0',
    ]);
  });

  it('clamps a span that leaves the square on a clamping texture to the edge it leaves by', () => {
    expect(levelZero([-3, 0, -2, 1], ADDRESS_MODE.CENTRE_CLAMP)).toEqual(columns(0));
    expect(levelZero([2, 0, 3, 1], ADDRESS_MODE.LATTICE_CLAMP)).toEqual(columns(3));
  });
});

describe('the budget keeps what matters most', () => {
  /*
   * Six instances over four materials, placed so that every rule of the order decides something:
   * a nearer instance outranks a farther one, a large instance's coarse tiles are capped at its
   * size, a shared tile carries its best claim, and ties go to whichever was named first.
   */
  const materials = [
    [grid('a', 64, 16)],
    [grid('b', 64, 16)],
    [grid('c', 64, 16)],
    [grid('d', 64, 16)],
  ];
  const info = scene(materials, [
    { at: [1, 0, -6.5], radius: 0.5, material: 1 },
    { at: [0, 1, -3.5], radius: 0.5, material: 0 },
    { at: [-1, 0, -2.5], radius: 0.5, material: 0 },
    { at: [0, -1, -3], radius: 2, material: 2 },
    { at: [-1, 1, -6.5], radius: 0.5, material: 3 },
    { at: [1, 1, -6.5], radius: 0.5, material: 1 },
  ]);
  const at = (prefix: string, level: number, tx: number, ty: number): string =>
    `${prefix}/${String(level)}/${String(tx)},${String(ty)}`;
  const grid4 = (prefix: string, level: number, edge: number): string[] =>
    Array.from({ length: edge * edge }, (_, i) =>
      at(prefix, level, i % edge, Math.floor(i / edge)),
    );

  it('orders by the screen a tile covers, and a tie by what was named first', () => {
    /*
     * Pixels a unit are 32 over the instance's depth, times the tile's world edge at its level
     * (a quarter at level 0, doubling), capped at the instance's diameter:
     *
     * - `c`, radius 2 at depth 3: 42.7 for levels 6 to 4, then 21.3, 10.7, 5.3, 2.7.
     * - `a`, at depth 2.5 through its second instance: 12.8 for levels 6 to 2, 6.4 for level 1.
     *   Its first instance, at 3.5, claimed the same tiles at 9.1 and was outbid.
     * - `b` and `d` at 6.5: 4.9 for levels 6 to 3. `b`'s second instance ties its first and
     *   changes nothing, so `b` still comes before `d`.
     */
    expect(tiles(IDENTITY, info)).toEqual([
      at('c', 6, 0, 0),
      at('c', 5, 0, 0),
      at('c', 4, 0, 0),
      at('c', 3, 0, 0),
      at('a', 6, 0, 0),
      at('a', 5, 0, 0),
      at('a', 4, 0, 0),
      at('a', 3, 0, 0),
      at('a', 2, 0, 0),
      at('c', 2, 0, 0),
      ...grid4('a', 1, 2),
      ...grid4('c', 1, 2),
      at('b', 6, 0, 0),
      at('b', 5, 0, 0),
      at('b', 4, 0, 0),
      at('b', 3, 0, 0),
      at('d', 6, 0, 0),
      at('d', 5, 0, 0),
      at('d', 4, 0, 0),
      at('d', 3, 0, 0),
      ...grid4('c', 0, 4),
    ]);
  });

  it('returns a prefix of the unbounded answer at every budget', () => {
    /*
     * **The strongest form of "keeps the highest-priority entries"**: whatever the budget, the
     * answer is the first entries of the answer with no budget, so a cap never trades a tile that
     * matters for one that matters less.
     */
    const full = tiles(IDENTITY, info);
    for (let budget = 0; budget <= full.length + 2; budget += 1) {
      expect(tiles(IDENTITY, info, budget), `budget ${String(budget)}`).toEqual(
        full.slice(0, budget),
      );
    }
  });

  it('keeps that prefix over scenes where shared tiles are displaced and claimed again', () => {
    const shared = [
      [grid('a', 64, 16)],
      [grid('b', 32, 8), grid('c', 16, 16, ADDRESS_MODE.CENTRE_WRAP)],
      [grid('d', 128, 16, ADDRESS_MODE.LATTICE_WRAP), grid('a', 64, 16)],
    ];
    let seed = 11;
    const next = (): number => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return seed / 0x100000000;
    };
    let longest = 0;
    for (let trial = 0; trial < 40; trial += 1) {
      const placed = Array.from({ length: 7 }, (): Placed => {
        const u = next() * 2 - 0.5;
        const v = next() * 2 - 0.5;
        return {
          at: [next() * 8 - 4, next() * 8 - 4, -(next() * 20 + 0.5)],
          radius: next() * 2,
          material: Math.floor(next() * shared.length),
          uv: [u, v, u + next() * 1.2, v + next() * 1.2],
          worldPerUv: 0.25 + next() * 4,
        };
      });
      const random = scene(shared, placed);
      const full = tiles(IDENTITY, random);
      longest = Math.max(longest, full.length);
      expect(new Set(full).size).toBe(full.length);
      for (let budget = 0; budget <= full.length; budget += 1) {
        expect(
          tiles(IDENTITY, random, budget),
          `trial ${String(trial)} budget ${String(budget)}`,
        ).toEqual(full.slice(0, budget));
      }
    }
    expect(longest).toBeGreaterThan(40);
  });

  it('names a tile two instances share once', () => {
    const full = tiles(IDENTITY, info);
    expect(new Set(full).size).toBe(full.length);
    const union = new Set<string>();
    for (let i = 0; i < info.count; i += 1) {
      const one = scene(materials, [
        {
          at: [info.spheres[i * 4], info.spheres[i * 4 + 1], info.spheres[i * 4 + 2]] as [
            number,
            number,
            number,
          ],
          radius: info.spheres[i * 4 + 3] as number,
          material: info.material[i] as number,
        },
      ]);
      for (const hash of tiles(IDENTITY, one)) union.add(hash);
    }
    expect([...union].sort()).toEqual([...full].sort());
  });

  it('does bounded work however many tiles a level has', () => {
    /*
     * A 4096-texel latent has 65,536 tiles at level 0. **Prediction runs several times a frame**,
     * so naming thirty-two of them must not walk the rest: an instance's levels only lose priority
     * as they get finer, and the first tile the budget refuses ends that instance.
     */
    const huge = grid('h', 4096, 16);
    let reads = 0;
    const levelsRead = new Set<number>();
    const counted: MaterialTileGrid = {
      ...huge,
      levels: new Proxy(
        huge.levels.map(
          (row) =>
            new Proxy(row, {
              get(target, key, receiver) {
                if (typeof key === 'string' && /^\d+$/.test(key)) reads += 1;
                return Reflect.get(target, key, receiver) as unknown;
              },
            }),
        ),
        {
          get(target, key, receiver) {
            if (typeof key === 'string' && /^\d+$/.test(key)) levelsRead.add(Number(key));
            return Reflect.get(target, key, receiver) as unknown;
          },
        },
      ),
    };
    /* Sixty-four world units to the texture's width puts level 0 in reach at this depth. */
    const near: Placed = { at: [0, 0, -1], radius: 0.5, material: 0, worldPerUv: 64 };
    const out = tiles(IDENTITY, scene([[counted]], [near]), 32);
    expect(levelsIn(tiles(IDENTITY, scene([[huge]], [near]), 4))).toEqual([9, 10, 11, 12]);
    expect(out).toHaveLength(32);
    expect(reads).toBeLessThanOrEqual(32 + huge.levels.length);
    /*
     * Levels 12 to 6 hold twenty-five tiles and level 5 the other seven, and a refused tile is
     * never read — so the proof that nothing past level 5 was walked is that no finer row was
     * even asked for.
     */
    expect([...levelsRead].sort((a, b) => a - b)).toEqual([5, 6, 7, 8, 9, 10, 11, 12]);
    expect(out).toEqual(tiles(IDENTITY, scene([[huge]], [near]), 1 << 20).slice(0, 32));
  });

  it('leaves nothing behind from a call that threw', () => {
    const a = grid('a', 64, 16);
    const broken = { ...a, levels: null } as unknown as MaterialTileGrid;
    const place: Placed = { at: [0, 0, -3], radius: 0.5, material: 0 };
    expect(() => tiles(IDENTITY, scene([[a, broken]], [place]))).toThrow(TypeError);
    expect(tiles(IDENTITY, scene([[a]], [place]))).toEqual([
      'a/6/0,0',
      'a/5/0,0',
      'a/4/0,0',
      'a/3/0,0',
      'a/2/0,0',
    ]);
  });

  it('names nothing for a budget of nothing, and clears what the array held', () => {
    expect(tiles(IDENTITY, info, 0)).toEqual([]);
    expect(tiles(IDENTITY, info, -3)).toEqual([]);
    expect(tiles(IDENTITY, info, Number.NaN)).toEqual([]);
  });
});

describe('the answer is a function of the view', () => {
  it('is the same twice, and the same after a different view in between', () => {
    const materials = [[grid('a', 64, 16)], [grid('b', 32, 8)]];
    const info = scene(materials, [
      { at: [-1, 0, -2.5], radius: 0.5, material: 0 },
      { at: [1, 0, -6.5], radius: 2, material: 1 },
    ]);
    const first = tiles(IDENTITY, info);
    expect(tiles(IDENTITY, info)).toEqual(first);
    tiles(
      lookingAlongX([0, 0, 0]),
      scene([[grid('c', 4096, 16)]], [{ at: [2, 0, 0], radius: 1, material: 0 }]),
      7,
    );
    expect(tiles(IDENTITY, info)).toEqual(first);
  });
});

describe('a latent becomes a grid of content-addressed tiles', () => {
  /** A 20 by 12 latent of two components with its whole chain, every texel distinct. */
  function latent(seed: number): LatentImage {
    const level = (width: number, height: number, salt: number) => ({
      width,
      height,
      data: Float32Array.from(
        { length: width * height * 2 },
        (_, i) => seed * 1000 + salt * 100 + i,
      ),
    });
    const base = level(20, 12, 0);
    return {
      ...base,
      channels: 2,
      mips: [level(10, 6, 1), level(5, 3, 2), level(2, 1, 3), level(1, 1, 4)],
    };
  }

  it('cuts every level into tiles of the given edge, the last row and column short', () => {
    const tiled = latentTileGrid(latent(1), 8, ADDRESS_MODE.CENTRE_WRAP);
    expect(tiled.levels.map((row) => row.length)).toEqual([6, 2, 1, 1, 1]);
    expect([tiled.width, tiled.height, tiled.tileSize, tiled.addressMode]).toEqual([
      20,
      12,
      8,
      ADDRESS_MODE.CENTRE_WRAP,
    ]);
  });

  it('addresses a tile by its texels, as hashTile addresses every tile in this package', () => {
    const image = latent(1);
    const tiled = latentTileGrid(image, 8, ADDRESS_MODE.CENTRE_WRAP);
    /* Tile (2, 1) of level 0 is texels 16..19 by 8..11: four by four, the short corner. */
    const texels = new Float32Array(4 * 4 * 2);
    for (let y = 0; y < 4; y += 1) {
      for (let x = 0; x < 4; x += 1) {
        const from = ((8 + y) * 20 + 16 + x) * 2;
        texels.set(image.data.subarray(from, from + 2), (y * 4 + x) * 2);
      }
    }
    expect(tiled.levels[0]?.[1 * 3 + 2]).toBe(hashTile(new Uint8Array(texels.buffer)));
  });

  it('gives identical content one address, and a changed texel a new one in its tile only', () => {
    const a = latentTileGrid(latent(1), 8, ADDRESS_MODE.CENTRE_WRAP);
    expect(latentTileGrid(latent(1), 8, ADDRESS_MODE.CENTRE_WRAP).levels).toEqual(a.levels);
    const changed = latent(1);
    changed.data[(9 * 20 + 3) * 2 + 1] = -1;
    const b = latentTileGrid(changed, 8, ADDRESS_MODE.CENTRE_WRAP);
    const differing = (a.levels[0] ?? []).filter((hash, i) => hash !== b.levels[0]?.[i]);
    expect(differing).toEqual([a.levels[0]?.[3]]);
    expect(b.levels.slice(1)).toEqual(a.levels.slice(1));
  });

  it('refuses a chain whose levels do not halve, because the grid could not say where a tile is', () => {
    const image = latent(1);
    const wrong = { ...image, mips: [{ width: 9, height: 6, data: new Float32Array(9 * 6 * 2) }] };
    expect(() => latentTileGrid(wrong, 8, ADDRESS_MODE.CENTRE_WRAP)).toThrow(
      /level 1 .*9 by 6.*10 by 6/,
    );
    expect(() => latentTileGrid(image, 0, ADDRESS_MODE.CENTRE_WRAP)).toThrow(/tile/);
    const short = { ...image, data: new Float32Array(20 * 12 * 2 - 1) };
    expect(() => latentTileGrid(short, 8, ADDRESS_MODE.CENTRE_WRAP)).toThrow(/level 0 holds 479/);
  });

  it('lets two instances of different materials with the same content share their tiles', () => {
    const one = latentTileGrid(latent(3), 8, ADDRESS_MODE.CENTRE_CLAMP);
    const two = latentTileGrid(latent(3), 8, ADDRESS_MODE.CENTRE_CLAMP);
    const info = scene(
      [[one], [two]],
      [
        { at: [-0.5, 0, -2], radius: 0.5, material: 0 },
        { at: [0.5, 0, -2], radius: 0.5, material: 1 },
      ],
    );
    const out = tiles(IDENTITY, info);
    const alone = tiles(
      IDENTITY,
      scene([[one]], [{ at: [-0.5, 0, -2], radius: 0.5, material: 0 }]),
    );
    expect(new Set(out)).toEqual(new Set(alone));
  });
});
