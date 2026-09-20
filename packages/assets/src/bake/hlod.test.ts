import { describe, expect, test } from 'vitest';
import type { MeshData } from '@driftengine/drft';

import {
  IMPOSTOR_GUTTER,
  IMPOSTOR_TILE,
  buildImpostor,
  buildProxy,
  frameOf,
  octahedralCoord,
  octahedralDirection,
  PROXY_BASE_CELLS,
  PROXY_MIN_CELLS,
  proxyResolution,
  rasteriseView,
  sampleImpostor,
  type ProxyCell,
} from './hlod.ts';

/** A box, as eight corners and twelve triangles, in one flat colour. */
function box(
  cx: number,
  cy: number,
  cz: number,
  sx: number,
  sy: number,
  sz: number,
  colour: readonly [number, number, number],
): MeshData {
  const positions = new Float32Array(8 * 3);
  for (let i = 0; i < 8; i += 1) {
    positions[i * 3] = cx + ((i & 1) === 0 ? -sx : sx);
    positions[i * 3 + 1] = cy + ((i & 2) === 0 ? -sy : sy);
    positions[i * 3 + 2] = cz + ((i & 4) === 0 ? -sz : sz);
  }
  const indices = new Uint32Array([
    0, 2, 1, 1, 2, 3, 4, 5, 6, 5, 7, 6, 0, 1, 4, 1, 5, 4, 2, 6, 3, 3, 6, 7, 0, 4, 2, 2, 4, 6, 1, 3,
    5, 3, 7, 5,
  ]);
  return meshOf(positions, indices, colour);
}

/** A UV sphere, which is where the triangles a proxy has to remove come from. */
function sphere(
  cx: number,
  cy: number,
  cz: number,
  r: number,
  segments: number,
  colour: readonly [number, number, number],
): MeshData {
  const rings = segments;
  const positions = new Float32Array((rings + 1) * (segments + 1) * 3);
  let at = 0;
  for (let ring = 0; ring <= rings; ring += 1) {
    const phi = (ring / rings) * Math.PI;
    for (let seg = 0; seg <= segments; seg += 1) {
      const theta = (seg / segments) * Math.PI * 2;
      positions[at] = cx + r * Math.sin(phi) * Math.cos(theta);
      positions[at + 1] = cy + r * Math.cos(phi);
      positions[at + 2] = cz + r * Math.sin(phi) * Math.sin(theta);
      at += 3;
    }
  }
  const indices: number[] = [];
  const stride = segments + 1;
  for (let ring = 0; ring < rings; ring += 1) {
    for (let seg = 0; seg < segments; seg += 1) {
      const a = ring * stride + seg;
      indices.push(a, a + stride, a + 1, a + 1, a + stride, a + stride + 1);
    }
  }
  return meshOf(positions, Uint32Array.from(indices), colour);
}

function meshOf(
  positions: Float32Array,
  indices: Uint32Array,
  colour: readonly [number, number, number],
): MeshData {
  const vertices = positions.length / 3;
  const colors = new Float32Array(vertices * 3);
  for (let i = 0; i < vertices; i += 1) {
    colors[i * 3] = colour[0];
    colors[i * 3 + 1] = colour[1];
    colors[i * 3 + 2] = colour[2];
  }
  return {
    positions,
    normals: new Float32Array(vertices * 3),
    colors,
    emissive: new Float32Array(vertices),
    indices,
  } as MeshData;
}

/**
 * Four cells of a city block: two towers each, detailed enough that a proxy is worth having.
 *
 * Detailed on purpose. A proxy is a budget decision and `buildProxy` refuses a group that is
 * already cheap, so a group of plain boxes would be refused rather than shrunk — which is the
 * right answer and not the one this fixture is here to exercise.
 */
function block(): ProxyCell[] {
  const cells: ProxyCell[] = [];
  for (let cell = 0; cell < 4; cell += 1) {
    const ox = (cell % 2) * 20;
    const oz = Math.floor(cell / 2) * 20;
    cells.push({
      id: cell,
      meshes: [
        sphere(ox + 4, 6, oz + 4, 4, 24, [0.6, 0.6, 0.62]),
        sphere(ox + 13, 4, oz + 12, 3, 24, [0.5, 0.45, 0.4]),
      ],
    });
  }
  return cells;
}

function allMeshes(cells: readonly ProxyCell[]): MeshData[] {
  return cells.flatMap((cell) => [...cell.meshes]);
}

function triangleCount(meshes: readonly MeshData[]): number {
  let total = 0;
  for (const mesh of meshes) total += mesh.indices.length / 3;
  return total;
}

function boundsOf(meshes: readonly MeshData[]): number[] {
  const bounds = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (const mesh of meshes) {
    for (let at = 0; at + 2 < mesh.positions.length; at += 3) {
      for (let axis = 0; axis < 3; axis += 1) {
        const value = mesh.positions[at + axis] as number;
        if (value < (bounds[axis] as number)) bounds[axis] = value;
        if (value > (bounds[axis + 3] as number)) bounds[axis + 3] = value;
      }
    }
  }
  return bounds;
}

/** One tree: a trunk and a canopy, which is the thing impostors are famously asked to draw. */
function tree(): MeshData {
  const trunk = box(0, 1.5, 0, 0.35, 1.5, 0.35, [0.35, 0.22, 0.12]);
  const canopy = sphere(0, 4.2, 0, 2.1, 14, [0.16, 0.45, 0.14]);
  return mergeMeshes([trunk, canopy]);
}

function mergeMeshes(meshes: readonly MeshData[]): MeshData {
  let vertices = 0;
  let indices = 0;
  for (const mesh of meshes) {
    vertices += mesh.positions.length / 3;
    indices += mesh.indices.length;
  }
  const positions = new Float32Array(vertices * 3);
  const colors = new Float32Array(vertices * 3);
  const out = new Uint32Array(indices);
  let vertexAt = 0;
  let indexAt = 0;
  for (const mesh of meshes) {
    positions.set(mesh.positions, vertexAt * 3);
    colors.set(mesh.colors, vertexAt * 3);
    for (let i = 0; i < mesh.indices.length; i += 1) {
      out[indexAt + i] = (mesh.indices[i] as number) + vertexAt;
    }
    vertexAt += mesh.positions.length / 3;
    indexAt += mesh.indices.length;
  }
  const merged = positions.length / 3;
  return {
    positions,
    normals: new Float32Array(merged * 3),
    colors,
    emissive: new Float32Array(merged),
    indices: out,
  } as MeshData;
}

/** Fraction of pixels where two coverage masks disagree, over the pixels either one covers. */
function silhouetteAgreement(a: Float32Array, b: Float32Array, resolution: number): number {
  let both = 0;
  let either = 0;
  for (let at = 0; at < resolution * resolution; at += 1) {
    const inA = (a[at * 4 + 3] as number) > 0.5;
    const inB = (b[at * 4 + 3] as number) > 0.5;
    if (inA && inB) both += 1;
    if (inA || inB) either += 1;
  }
  return either === 0 ? 1 : both / either;
}

describe('a proxy stands in for a whole cell group', () => {
  test('has fewer triangles than its members and covers the same bounds', () => {
    const cells = block();
    const source = allMeshes(cells);
    const proxy = buildProxy(cells, 0);
    if (proxy === null) throw new Error('the block should be worth a proxy');

    /* Half or fewer, which is `isOutlineWorthWriting`'s budget and not a second opinion. */
    expect(proxy.indices.length / 3).toBeLessThanOrEqual(triangleCount(source) / 2);

    /*
     * The same bounds within one grid cell. A proxy that shrinks the group is one that pops when
     * the real geometry replaces it, and a proxy that grows it is one that fails a cull the real
     * geometry passes.
     */
    const want = boundsOf(source);
    const got = boundsOf([proxy]);
    const span = Math.max(
      (want[3] as number) - (want[0] as number),
      (want[4] as number) - (want[1] as number),
      (want[5] as number) - (want[2] as number),
    );
    const tolerance = (span / proxyResolution(0)) * 2;
    for (let i = 0; i < 6; i += 1) {
      expect(Math.abs((got[i] as number) - (want[i] as number))).toBeLessThan(tolerance);
    }
  });

  test('is coarser at a higher level, which is what makes the hierarchy a hierarchy', () => {
    const cells = block();
    const near = buildProxy(cells, 0);
    const far = buildProxy(cells, 2);
    if (near === null || far === null) throw new Error('both levels should build');
    expect(far.indices.length).toBeLessThan(near.indices.length);
    expect(proxyResolution(2)).toBeLessThan(proxyResolution(0));
  });

  test('refuses a group already cheap enough to draw, rather than returning something bigger', () => {
    /*
     * Four plain boxes are forty-eight triangles. Every grid a proxy could use produces more than
     * that, so the honest answer is that this group has no proxy — and the caller finds out from
     * the return rather than from a frame that got slower.
     */
    const cheap: ProxyCell[] = [
      { id: 0, meshes: [box(0, 1, 0, 1, 1, 1, [1, 0, 0])] },
      { id: 1, meshes: [box(6, 1, 0, 1, 1, 1, [0, 1, 0])] },
      { id: 2, meshes: [box(0, 1, 6, 1, 1, 1, [0, 0, 1])] },
      { id: 3, meshes: [box(6, 1, 6, 1, 1, 1, [1, 1, 0])] },
    ];
    expect(buildProxy(cheap, 0)).toBeNull();
  });

  test('refuses an empty group rather than answering an empty mesh', () => {
    expect(buildProxy([], 0)).toBeNull();
    expect(buildProxy([{ id: 7, meshes: [] }], 0)).toBeNull();
  });

  test('keeps the silhouette a distant viewer sees', () => {
    /*
     * The claim a proxy actually has to meet. Not "the geometry is similar" — a distant group is a
     * few hundred pixels and what survives is its outline, so that is what is measured, from six
     * directions, as intersection over union.
     */
    const cells = block();
    const source = allMeshes(cells);
    const proxy = buildProxy(cells, 0);
    if (proxy === null) throw new Error('the block should be worth a proxy');

    const frame = frameOf(source);
    const resolution = 64;
    const merged = mergeMeshes(source);
    const want = new Float32Array(resolution * resolution * 4);
    const got = new Float32Array(resolution * resolution * 4);
    const directions = [
      [0, 0, 1],
      [1, 0, 0],
      [0, 0, -1],
      [-1, 0, 0],
      [0.577, 0.577, 0.577],
      [-0.577, 0.577, -0.577],
    ];
    for (const dir of directions) {
      rasteriseView(merged, frame, dir, resolution, want);
      rasteriseView(proxy, frame, dir, resolution, got);
      /*
       * Measured over these six directions: 0.9152 from either side, 0.9433 front and back,
       * 0.9401 and 0.9750 from the two three-quarter views. The sides are the worst because that
       * is where the two towers of a cell overlap and the grid merges them into one blob.
       */
      expect(silhouetteAgreement(want, got, resolution)).toBeGreaterThan(0.91);
    }
  });

  test('is the same mesh every time it is baked', () => {
    const a = buildProxy(block(), 1);
    const b = buildProxy(block(), 1);
    if (a === null || b === null) throw new Error('both bakes should build');
    expect([...a.indices]).toEqual([...b.indices]);
    expect([...a.positions]).toEqual([...b.positions]);
  });
});

describe('an octahedral impostor', () => {
  const DIRECTIONS = 8;

  test('reconstructs the silhouette from a direction it baked', () => {
    const mesh = tree();
    const impostor = buildImpostor(mesh, DIRECTIONS);
    const dir = new Float32Array(3);
    /* A tile centre, so the sampled direction is one that was rasterised. */
    octahedralDirection(3 / (DIRECTIONS - 1), 5 / (DIRECTIONS - 1), dir);

    const want = new Float32Array(IMPOSTOR_TILE * IMPOSTOR_TILE * 4);
    rasteriseView(mesh, impostor.frame, dir, IMPOSTOR_TILE, want);

    const got = new Float32Array(IMPOSTOR_TILE * IMPOSTOR_TILE * 4);
    const sample = new Float32Array(4);
    for (let y = 0; y < IMPOSTOR_TILE; y += 1) {
      for (let x = 0; x < IMPOSTOR_TILE; x += 1) {
        sampleImpostor(impostor, dir, (x + 0.5) / IMPOSTOR_TILE, (y + 0.5) / IMPOSTOR_TILE, sample);
        got.set(sample, (y * IMPOSTOR_TILE + x) * 4);
      }
    }
    /*
     * 1.0000 measured, and exactly rather than nearly: the direction round-trips to its own tile,
     * so the blend weight on every other tile is zero and the sample is a lookup of the texel the
     * bake wrote. Anything less here means the octahedral map does not invert.
     */
    expect(silhouetteAgreement(want, got, IMPOSTOR_TILE)).toBeGreaterThan(0.99);
  });

  test('reconstructs a direction between two baked ones to a stated error', () => {
    /*
     * **The number that matters, and it is worse than the one above on purpose.** Between tiles
     * the sample blends four views with no parallax correction, so a shape with depth ghosts.
     * **0.9083 measured** for a tree at eight directions a side, against 1.0000 on a baked one —
     * so the honest claim is that the worst direction is nine-tenths right, not that the atlas
     * reconstructs the object. The fix when a consumer needs better is more directions, and the
     * cost is their square: sixteen a side is four times the atlas.
     */
    const mesh = tree();
    const impostor = buildImpostor(mesh, DIRECTIONS);
    const dir = new Float32Array(3);
    octahedralDirection(3.5 / (DIRECTIONS - 1), 5.5 / (DIRECTIONS - 1), dir);

    const want = new Float32Array(IMPOSTOR_TILE * IMPOSTOR_TILE * 4);
    rasteriseView(mesh, impostor.frame, dir, IMPOSTOR_TILE, want);
    const got = new Float32Array(IMPOSTOR_TILE * IMPOSTOR_TILE * 4);
    const sample = new Float32Array(4);
    for (let y = 0; y < IMPOSTOR_TILE; y += 1) {
      for (let x = 0; x < IMPOSTOR_TILE; x += 1) {
        sampleImpostor(impostor, dir, (x + 0.5) / IMPOSTOR_TILE, (y + 0.5) / IMPOSTOR_TILE, sample);
        got.set(sample, (y * IMPOSTOR_TILE + x) * 4);
      }
    }
    expect(silhouetteAgreement(want, got, IMPOSTOR_TILE)).toBeGreaterThan(0.9);
  });

  test('gives every tile a gutter, so a tap at a tile edge cannot reach the next tile', () => {
    const impostor = buildImpostor(tree(), DIRECTIONS);
    const stride = IMPOSTOR_TILE + IMPOSTOR_GUTTER * 2;
    expect(impostor.size).toBe(stride * DIRECTIONS);
    expect(IMPOSTOR_GUTTER).toBeGreaterThanOrEqual(1);

    /*
     * The gutter repeats the edge, so the four texels a bilinear tap at the very edge of a tile
     * reads all belong to that tile. Asserted as the values rather than as the arithmetic: the
     * gutter texel equals the edge texel it clamps to.
     */
    for (let tile = 0; tile < DIRECTIONS * DIRECTIONS; tile += 1) {
      const tx = (tile % DIRECTIONS) * stride;
      const ty = Math.floor(tile / DIRECTIONS) * stride;
      for (let y = 0; y < stride; y += 1) {
        for (let x = 0; x < stride; x += 1) {
          const inX = Math.min(IMPOSTOR_TILE - 1, Math.max(0, x - IMPOSTOR_GUTTER));
          const inY = Math.min(IMPOSTOR_TILE - 1, Math.max(0, y - IMPOSTOR_GUTTER));
          if (inX === x - IMPOSTOR_GUTTER && inY === y - IMPOSTOR_GUTTER) continue;
          const at = ((ty + y) * impostor.size + tx + x) * 4;
          const clamped =
            ((ty + inY + IMPOSTOR_GUTTER) * impostor.size + tx + inX + IMPOSTOR_GUTTER) * 4;
          for (let c = 0; c < 4; c += 1) {
            expect(impostor.atlas[at + c]).toBe(impostor.atlas[clamped + c]);
          }
        }
      }
    }
  });

  test('dilates colour into the transparent texels, which is what stops distant trees glowing', () => {
    /*
     * **The defect.** A transparent texel left at the clear colour is still read by a bilinear tap
     * at the silhouette, so every edge pixel blends the object with black — a dark rim on a lit
     * tree, and on an additive or unlit pass a bright one. The fix is that transparent texels
     * carry their nearest opaque neighbour's colour, so the blend is the object's own colour at a
     * lower alpha and the rim is the alpha ramp it should be.
     */
    const impostor = buildImpostor(tree(), DIRECTIONS);
    const stride = IMPOSTOR_TILE + IMPOSTOR_GUTTER * 2;
    let checked = 0;
    for (let y = 1; y < impostor.size - 1; y += 1) {
      for (let x = 1; x < impostor.size - 1; x += 1) {
        const at = (y * impostor.size + x) * 4;
        if ((impostor.atlas[at + 3] as number) > 0) continue;
        const neighbours = [
          ((y - 1) * impostor.size + x) * 4,
          ((y + 1) * impostor.size + x) * 4,
          (y * impostor.size + x - 1) * 4,
          (y * impostor.size + x + 1) * 4,
        ];
        let opaque = false;
        for (const n of neighbours) if ((impostor.atlas[n + 3] as number) > 0) opaque = true;
        if (!opaque) continue;
        checked += 1;
        const luminance =
          (impostor.atlas[at] as number) +
          (impostor.atlas[at + 1] as number) +
          (impostor.atlas[at + 2] as number);
        expect(luminance).toBeGreaterThan(0);
      }
    }
    /* And the loop above really did find silhouette texels rather than passing on an empty set. */
    expect(checked).toBeGreaterThan(200);
    expect(stride * DIRECTIONS).toBe(impostor.size);
  });

  test('is the same atlas every time it is baked', () => {
    const a = buildImpostor(tree(), 4);
    const b = buildImpostor(tree(), 4);
    expect([...a.atlas]).toEqual([...b.atlas]);
    expect(a.size).toBe(b.size);
  });

  test('carries the framing it was baked with, because an atlas alone cannot be placed', () => {
    const mesh = tree();
    const impostor = buildImpostor(mesh, 4);
    const frame = frameOf([mesh]);
    expect(impostor.frame.radius).toBeCloseTo(frame.radius, 6);
    expect(impostor.frame.cy).toBeCloseTo(frame.cy, 6);
  });
});

describe('the octahedral direction map', () => {
  test('covers the sphere and returns unit vectors', () => {
    const dir = new Float32Array(3);
    let up = 0;
    let down = 0;
    for (let v = 0; v <= 8; v += 1) {
      for (let u = 0; u <= 8; u += 1) {
        octahedralDirection(u / 8, v / 8, dir);
        expect(Math.hypot(dir[0] as number, dir[1] as number, dir[2] as number)).toBeCloseTo(1, 5);
        if ((dir[1] as number) > 0) up += 1;
        if ((dir[1] as number) < 0) down += 1;
      }
    }
    /* Both hemispheres, which a hemi-octahedral map would not give and which a tree needs. */
    expect(up).toBeGreaterThan(0);
    expect(down).toBeGreaterThan(0);
  });
});

describe('the rasteriser behind both bakes', () => {
  test('draws the nearest surface, not the last one', () => {
    /*
     * **From below, and that is the direction that can tell.** Seen from above, everything at the
     * centre of a tree is canopy whichever triangle wins, so the view that catches a missing depth
     * test is the one where the answer differs: from underneath, the trunk's foot is nearest and
     * the canopy is behind it. Without a depth test the canopy wins because it is later in the
     * buffer, and every impostor of a tree is green underneath.
     */
    const mesh = tree();
    const frame = frameOf([mesh]);
    const resolution = 24;
    const below = new Float32Array(resolution * resolution * 4);
    rasteriseView(mesh, frame, [0, -1, 0], resolution, below);
    const centre = ((resolution / 2) * resolution + resolution / 2) * 4;
    expect(below[centre + 3]).toBe(1);
    /* Trunk brown, (0.35, 0.22, 0.12): more red than green. Canopy green is the other way. */
    expect(below[centre]).toBeGreaterThan(below[centre + 1] as number);

    const above = new Float32Array(resolution * resolution * 4);
    rasteriseView(mesh, frame, [0, 1, 0], resolution, above);
    expect(above[centre + 1]).toBeGreaterThan(above[centre] as number);
  });

  test('draws a triangle whichever way it is wound', () => {
    /*
     * Bake input is not consistently wound — an OBJ with a mirrored group, a CAD export, a shell
     * some tool reversed. A rasteriser that culls by winding drops those faces, and what it leaves
     * is an impostor with holes in it that only appear from some directions.
     */
    const forward = box(0, 0, 0, 1, 1, 1, [1, 0, 0]);
    const reversed = meshOf(
      forward.positions,
      Uint32Array.from({ length: forward.indices.length }, (_, i) => {
        const tri = Math.floor(i / 3);
        const lane = i % 3;
        return forward.indices[tri * 3 + (lane === 0 ? 0 : 3 - lane)] as number;
      }),
      [1, 0, 0],
    );
    const frame = frameOf([forward]);
    const a = new Float32Array(16 * 16 * 4);
    const b = new Float32Array(16 * 16 * 4);
    rasteriseView(forward, frame, [0, 0, 1], 16, a);
    rasteriseView(reversed, frame, [0, 0, 1], 16, b);
    let covered = 0;
    for (let at = 0; at < 16 * 16; at += 1) {
      expect(a[at * 4 + 3]).toBe(b[at * 4 + 3]);
      if ((a[at * 4 + 3] as number) > 0) covered += 1;
    }
    /* A hundred exactly: the cube's half-extent is 1 against a framing radius of √3, so it covers
       ±0.577 of the tile, which at sixteen texels is ten of them each way. */
    expect(covered).toBe(100);
  });
});

describe('the dilation is bounded, which is what keeps it a dilation', () => {
  test('leaves a texel far outside the silhouette at the clear colour', () => {
    /*
     * **A flood fill and a dilation differ by one line**, and the line is that a pass marks what it
     * filled only after the pass ends. Marking as it goes lets the colour run the length of the
     * scan in a single pass — every texel to the right of the object takes its neighbour's colour,
     * which takes its neighbour's, and the whole tile fills asymmetrically from one side. The
     * result is still deterministic and still the same every run, so only a bound catches it.
     */
    const impostor = buildImpostor(tree(), 4);
    const stride = IMPOSTOR_TILE + IMPOSTOR_GUTTER * 2;
    /* The tile looking straight along one axis, and its bottom-right corner, which a tree whose
       framing sphere fits the tile cannot reach. */
    const at = ((1 * stride + stride - 1) * impostor.size + 1 * stride + stride - 1) * 4;
    expect(impostor.atlas[at + 3]).toBe(0);
    expect(impostor.atlas[at]).toBe(0);
    expect(impostor.atlas[at + 1]).toBe(0);
    expect(impostor.atlas[at + 2]).toBe(0);
  });

  test('refuses a single direction, which is a billboard and a different thing', () => {
    expect(() => buildImpostor(tree(), 1)).toThrow(/at least 2/);
  });
});

describe('the two halves of the octahedral map are inverses', () => {
  test('a direction survives a trip through a coordinate and back', () => {
    /*
     * **The round trip is through a direction and not through a coordinate, because the square is
     * not injective.** Its four corners are all the south pole, so `(0, 0)` comes back as `(1, 1)`
     * — correctly. A direction is the side that has one answer.
     *
     * **And only the lower hemisphere can tell.** Both halves fold when `|ex| + |ez| > 1`, and a
     * grid of tiles near the middle of the square never reaches it, so an impostor test at a
     * central tile passes with either fold missing. This is what holds both.
     */
    const coord = new Float32Array(2);
    const back = new Float32Array(3);
    let below = 0;
    for (let i = 0; i < 200; i += 1) {
      /* A spiral over the sphere: even coverage, and it visits both hemispheres. */
      const y = 1 - (2 * i) / 199;
      const r = Math.sqrt(Math.max(0, 1 - y * y));
      const theta = i * 2.399963;
      const dir = [r * Math.cos(theta), y, r * Math.sin(theta)];
      if (y < 0) below += 1;
      octahedralCoord(dir, coord);
      expect(coord[0]).toBeGreaterThanOrEqual(0);
      expect(coord[0]).toBeLessThanOrEqual(1);
      octahedralDirection(coord[0] as number, coord[1] as number, back);
      for (let c = 0; c < 3; c += 1) expect(back[c]).toBeCloseTo(dir[c] as number, 5);
    }
    expect(below).toBeGreaterThan(80);
  });
});

describe('the level schedule', () => {
  test('stops at the finest grid a coarse level will build, rather than counting down to none', () => {
    expect(proxyResolution(0)).toBe(PROXY_BASE_CELLS);
    expect(proxyResolution(1)).toBe(PROXY_BASE_CELLS / 2);
    /* A hierarchy deep enough to run out: without the floor this reaches zero cells, and a grid of
       no cells is a proxy of nothing rather than the coarsest one available. */
    expect(proxyResolution(9)).toBe(PROXY_MIN_CELLS);
    expect(proxyResolution(-3)).toBe(PROXY_BASE_CELLS);
  });
});
