import { describe, expect, it } from 'vitest';

import type { BlockAtlas } from './atlas';
import { Block } from './blocks';
import { meshChunk, type LightSource } from './mesher';
import type { BlockSource } from './world';

/* The mesher reads `rects` and `fallback` and never touches the texture while meshing, so a
   stub keeps this test in the node environment. */
const ATLAS: BlockAtlas = {
  texture: null as never,
  rects: new Map(),
  fallback: { u0: 0, v0: 0, u1: 1, v1: 1 },
};

/** A fixed packed light, so the mesher's own arithmetic is what a test is measuring. */
const lit = (skyLevel: number, blockLevel = 0): LightSource => ({
  getPacked: () => (skyLevel << 4) | blockLevel,
});

const FULL_LIGHT = lit(15);
const HALF_LIGHT = lit(7);
const BLOCK_LIT = lit(0, 15);

/** A world containing only what a test puts in it. */
class Grid implements BlockSource {
  private readonly cells = new Map<string, Block>();

  put(x: number, y: number, z: number, id: Block): this {
    this.cells.set(`${x},${y},${z}`, id);
    return this;
  }

  getBlock(x: number, y: number, z: number): Block {
    return this.cells.get(`${x},${y},${z}`) ?? Block.AIR;
  }
}

describe('culled meshing', () => {
  it('gives a lone block six faces', () => {
    const mesh = meshChunk(new Grid().put(0, 10, 0, Block.STONE), 0, 0, ATLAS, FULL_LIGHT);
    expect(mesh.opaque).not.toBeNull();
    expect(mesh.opaque!.indices.length).toBe(6 * 6);
    expect(mesh.opaque!.positions.length / 3).toBe(6 * 4);
  });

  it('emits nothing for a block sealed on all six sides', () => {
    /* The whole point of culling, and invisible in a screenshot: a mesher that stopped culling
       would look identical and cost an order of magnitude more. */
    const grid = new Grid().put(1, 10, 1, Block.STONE);
    const around: readonly (readonly [number, number, number])[] = [
      [1, 0, 0],
      [-1, 0, 0],
      [0, 1, 0],
      [0, -1, 0],
      [0, 0, 1],
      [0, 0, -1],
    ];
    for (const [dx, dy, dz] of around) grid.put(1 + dx, 10 + dy, 1 + dz, Block.STONE);
    /* Six neighbours keep five outward faces each; the sealed centre contributes none. */
    expect(meshChunk(grid, 0, 0, ATLAS, FULL_LIGHT).opaque!.indices.length).toBe(30 * 6);
  });

  it('emits positions local to the chunk, not world-space', () => {
    /* Per-chunk culling needs a per-chunk transform, and a mesh baked in world coordinates
       cannot have one. A chunk far from the origin would also lose float precision. */
    const mesh = meshChunk(new Grid().put(33, 10, 33, Block.STONE), 2, 2, ATLAS, FULL_LIGHT);
    const p = mesh.opaque!.positions;
    for (let i = 0; i < p.length; i += 3) {
      expect(p[i]!).toBeGreaterThanOrEqual(0);
      expect(p[i]!).toBeLessThanOrEqual(16);
      expect(p[i + 2]!).toBeGreaterThanOrEqual(0);
      expect(p[i + 2]!).toBeLessThanOrEqual(16);
    }
  });

  it('writes every required attribute at its declared width', () => {
    /* `validateMeshData` rejects a short buffer, and its own comment says why: a driver may
       draw zeroes or drop the draw entirely rather than complain. */
    const data = meshChunk(new Grid().put(0, 10, 0, Block.STONE), 0, 0, ATLAS, FULL_LIGHT).opaque!;
    const vertices = data.positions.length / 3;
    expect(data.normals.length).toBe(vertices * 3);
    expect(data.colors.length).toBe(vertices * 3);
    expect(data.emissive.length).toBe(vertices * 1);
    expect(data.uvs!.length).toBe(vertices * 2);
  });

  it('darkens a vertex that sits in a corner', () => {
    /* Ambient occlusion is the reference's one baked term and the reason its terrain reads as
       solid. A mesher emitting flat white would look plausible and flat. */
    const open = meshChunk(new Grid().put(0, 10, 0, Block.STONE), 0, 0, ATLAS, FULL_LIGHT).opaque!;
    const tucked = meshChunk(
      new Grid().put(0, 10, 0, Block.STONE).put(1, 11, 0, Block.STONE).put(0, 11, 1, Block.STONE),
      0,
      0,
      ATLAS,
      FULL_LIGHT,
    ).opaque!;
    expect(Math.min(...tucked.colors)).toBeLessThan(Math.min(...open.colors));
  });

  it('darkens vertices the sky does not reach', () => {
    const grid = new Grid().put(0, 10, 0, Block.STONE);
    const bright = meshChunk(grid, 0, 0, ATLAS, FULL_LIGHT).opaque!;
    const dim = meshChunk(grid, 0, 0, ATLAS, HALF_LIGHT).opaque!;
    expect(Math.max(...dim.colors)).toBeLessThan(Math.max(...bright.colors));
  });

  it('never darkens a cell to pure black', () => {
    /* A sealed cave holds an ambient floor. Zero would be a hole in the picture. */
    const data = meshChunk(new Grid().put(0, 10, 0, Block.STONE), 0, 0, ATLAS, lit(0)).opaque!;
    expect(Math.min(...data.colors)).toBeGreaterThan(0);
  });

  it('writes block light into emissive, not into colour', () => {
    /* Emissive is what survives nightfall. Block light folded into the colour would be
       multiplied by the sun and go out at dusk, which is exactly backwards. */
    const data = meshChunk(new Grid().put(0, 10, 0, Block.STONE), 0, 0, ATLAS, BLOCK_LIT).opaque!;
    expect(Math.max(...data.emissive)).toBeGreaterThan(0);
    /* And with no sky at all, the colour is only the ambient floor. */
    expect(Math.max(...data.colors)).toBeLessThan(0.5);
  });

  it('separates a chunk into its render modes', () => {
    const grid = new Grid()
      .put(0, 10, 0, Block.STONE)
      .put(2, 10, 0, Block.LEAVES)
      .put(4, 10, 0, Block.WATER);
    const mesh = meshChunk(grid, 0, 0, ATLAS, FULL_LIGHT);
    expect(mesh.opaque).not.toBeNull();
    expect(mesh.cutout).not.toBeNull();
    expect(mesh.blend).not.toBeNull();
  });

  it('hides the shared face between two blocks of the same translucent kind', () => {
    /* Two water cells touching draw nothing between them; two different translucent kinds do.
       Getting this backwards puts a visible pane inside every ocean. */
    const pair = meshChunk(
      new Grid().put(0, 10, 0, Block.WATER).put(1, 10, 0, Block.WATER),
      0,
      0,
      ATLAS,
      FULL_LIGHT,
    ).blend!;
    /* Ten faces, not twelve: the touching pair is culled from both sides. */
    expect(pair.indices.length).toBe(10 * 6);
  });

  it('draws a water cell every face, including its top', () => {
    /* Water is wherever the cells are, not on one plane. An earlier version left the upward face
       to `drawWater` and got a sheet at sea level over dry inland basins and a hole wherever the
       sheet did not reach. See `GAPS.md`. */
    const one = meshChunk(new Grid().put(0, 10, 0, Block.WATER), 0, 0, ATLAS, FULL_LIGHT).blend!;
    expect(one.indices.length).toBe(6 * 6);
  });

  it('shades a face by which way it points', () => {
    /* The reference's fixed per-face tint: top full, bottom half, X sides 0.8, Z sides 0.7. It
       is what makes a voxel world read as blocky from any angle, and without it two faces of a
       cube lit by one sun look identical. */
    const data = meshChunk(new Grid().put(0, 10, 0, Block.STONE), 0, 0, ATLAS, FULL_LIGHT).opaque!;
    const shades = new Set<string>();
    for (let i = 0; i < data.colors.length; i += 3) shades.add(data.colors[i]!.toFixed(3));
    /* Four distinct brightnesses on a lone cube: top, bottom, X and Z. */
    expect(shades.size).toBe(4);
  });

  it('sits a water surface below the top of its cell', () => {
    /* The reference drops it in the vertex shader, and it is what makes water read as a liquid
       in a hole rather than a solid block of blue. */
    const water = meshChunk(new Grid().put(0, 10, 0, Block.WATER), 0, 0, ATLAS, FULL_LIGHT).blend!;
    const stone = meshChunk(new Grid().put(0, 10, 0, Block.STONE), 0, 0, ATLAS, FULL_LIGHT).opaque!;
    const topOf = (p: Float32Array): number => {
      let max = -Infinity;
      for (let i = 1; i < p.length; i += 3) max = Math.max(max, p[i]!);
      return max;
    };
    expect(topOf(water.positions)).toBeLessThan(topOf(stone.positions));
  });

  it('darkens water with depth below the sea', () => {
    /* Deep water turns a richer blue. Positional, so it bakes exactly as the reference computes
       it from worldPos.y. */
    const shallow = meshChunk(
      new Grid().put(0, 29, 0, Block.WATER),
      0,
      0,
      ATLAS,
      FULL_LIGHT,
    ).blend!;
    const deep = meshChunk(new Grid().put(0, 18, 0, Block.WATER), 0, 0, ATLAS, FULL_LIGHT).blend!;
    /* Compare the red channel: the deep tint pulls it down hardest. */
    expect(Math.max(...deep.colors)).toBeLessThan(Math.max(...shallow.colors));
  });

  it('gives an empty chunk no geometry at all', () => {
    const mesh = meshChunk(new Grid(), 0, 0, ATLAS, FULL_LIGHT);
    expect(mesh.opaque).toBeNull();
    expect(mesh.cutout).toBeNull();
    expect(mesh.blend).toBeNull();
  });
});

describe('winding', () => {
  /**
   * Every triangle is wound counter-clockwise seen from outside the block.
   *
   * **This is what the renderer culls by, and only one backend enforces it.** The engine draws
   * the world with back faces culled and a counter-clockwise front, so a quad wound the other
   * way is discarded. WebGL2 hid that for the whole of this port's construction — its scene
   * target resolve left `CULL_FACE` disabled, so the world was drawn double-sided from the
   * second frame on and a backwards face still showed. WebGPU culls as documented, and the
   * ground vanished.
   *
   * Measured rather than eyeballed: the geometric normal of each triangle, `(b-a) x (c-a)`,
   * has to point the same way as the vertex normal the mesher wrote beside it.
   */
  it('winds every face counter-clockwise from outside', () => {
    const mesh = meshChunk(new Grid().put(0, 10, 0, Block.STONE), 0, 0, ATLAS, FULL_LIGHT);
    const { positions, normals, indices } = mesh.opaque!;
    const at = (i: number): [number, number, number] => [
      positions[i * 3]!,
      positions[i * 3 + 1]!,
      positions[i * 3 + 2]!,
    ];

    const backwards: string[] = [];
    for (let tri = 0; tri < indices.length / 3; tri++) {
      const ia = indices[tri * 3]!;
      const a = at(ia);
      const b = at(indices[tri * 3 + 1]!);
      const c = at(indices[tri * 3 + 2]!);
      const ab: [number, number, number] = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const ac: [number, number, number] = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const geometric: [number, number, number] = [
        ab[1] * ac[2] - ab[2] * ac[1],
        ab[2] * ac[0] - ab[0] * ac[2],
        ab[0] * ac[1] - ab[1] * ac[0],
      ];
      const n: [number, number, number] = [
        normals[ia * 3]!,
        normals[ia * 3 + 1]!,
        normals[ia * 3 + 2]!,
      ];
      const agreement = geometric[0] * n[0] + geometric[1] * n[1] + geometric[2] * n[2];
      if (agreement <= 0) backwards.push(`[${n.join(',')}] tri ${tri}`);
    }

    expect(backwards).toEqual([]);
  });
});
