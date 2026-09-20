import { describe, expect, test } from 'vitest';
import type { MeshData } from '@driftengine/drft';

import { Terrain } from './heightfield.ts';
import { heightfieldPatch } from './heightfieldPatch.ts';
import {
  CLIPMAP_PATCHES_ACROSS,
  CLIPMAP_PATCH_CELLS,
  clipmapFrame,
  clipmapLevelAt,
  clipmapPatchAt,
  clipmapPatchCount,
  emptyClipmapPatch,
  selectClipmap,
  type ClipmapPatch,
} from './clipmap.ts';

/** A field big enough to hold the whole clipmap, with a cross term so nothing is separable. */
function field(size: number): Terrain {
  const heights = new Float32Array(size * size);
  for (let z = 0; z < size; z += 1) {
    for (let x = 0; x < size; x += 1) {
      heights[z * size + x] =
        Math.sin(x * 0.11) * 3 + Math.cos(z * 0.07) * 2 + Math.sin((x + z) * 0.05) * 1.5;
    }
  }
  return new Terrain({ width: size, depth: size, spacingM: 1, heights, origin: [0, 0, 0] });
}

const LEVELS = 3;
const SIZE = 301;
/** Built once: three hundred squared of sines is the expensive part of this file, not the clipmap. */
const FIELD = field(SIZE);

function frameAt(x: number, z: number, levels = LEVELS) {
  return clipmapFrame(FIELD, x, z, { levels });
}

/** The vertices along one side of a patch mesh, as `[x, y, z]` triples in the order they are laid. */
function edgeVertices(
  mesh: MeshData,
  across: number,
  side: 'minusX' | 'plusX' | 'minusZ' | 'plusZ',
) {
  const out: [number, number, number][] = [];
  for (let at = 0; at <= across; at += 1) {
    const row = side === 'minusZ' ? 0 : side === 'plusZ' ? across : at;
    const column = side === 'minusX' ? 0 : side === 'plusX' ? across : at;
    const v = (row * (across + 1) + column) * 3;
    out.push([
      mesh.positions[v] as number,
      mesh.positions[v + 1] as number,
      mesh.positions[v + 2] as number,
    ]);
  }
  return out;
}

/** The height the coarse polyline has at `at`, by walking its segments. */
function chordAt(edge: readonly [number, number, number][], axis: 0 | 2, at: number): number {
  for (let i = 0; i + 1 < edge.length; i += 1) {
    const low = edge[i] as [number, number, number];
    const high = edge[i + 1] as [number, number, number];
    if (at < low[axis] - 1e-6 || at > high[axis] + 1e-6) continue;
    const span = high[axis] - low[axis];
    if (span === 0) return low[1];
    const t = (at - low[axis]) / span;
    return low[1] * (1 - t) + high[1] * t;
  }
  throw new Error(`the coarse edge does not reach ${at}`);
}

describe('the clipmap covers the ground once', () => {
  test('draws every field cell in its footprint exactly once', () => {
    /*
     * **The gate the whole selection exists to pass.** A cell drawn twice is z-fighting on the
     * ground; a cell drawn never is a hole through to the sky. Both are decided entirely by the
     * arithmetic that snaps each level's block, and neither is visible in a patch list.
     */
    const frame = frameAt(150.5, 150.5);
    const patches = selectClipmap(frame);
    const counts = new Map<number, number>();
    for (const patch of patches) {
      for (let z = patch.z; z < patch.z + patch.cells; z += 1) {
        for (let x = patch.x; x < patch.x + patch.cells; x += 1) {
          const key = z * SIZE + x;
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
      }
    }
    for (const count of counts.values()) expect(count).toBe(1);

    /* And the footprint is the coarsest block, whole: no hole where a finer level was culled out
       of it and nothing put back. */
    const coarsest = LEVELS - 1;
    const span = CLIPMAP_PATCH_CELLS << coarsest;
    const x0 = frame.origins[coarsest * 2] as number;
    const z0 = frame.origins[coarsest * 2 + 1] as number;
    const width = CLIPMAP_PATCHES_ACROSS * span;
    for (let z = z0; z < z0 + width; z += 7) {
      for (let x = x0; x < x0 + width; x += 7) {
        expect(counts.get(z * SIZE + x)).toBe(1);
      }
    }
  });

  test('draws the ground under the camera at the finest level', () => {
    const frame = frameAt(150.5, 150.5);
    expect(clipmapLevelAt(frame, 150, 150)).toBe(0);
    /* And a cell far out is coarse, which is the entire reason for a clipmap. */
    expect(clipmapLevelAt(frame, 150 + 100, 150)).toBe(LEVELS - 1);
  });

  test('keeps covering the ground once as the camera moves across a level boundary', () => {
    /*
     * **Where the arithmetic breaks if it is going to.** Each level snaps to its own even patch
     * lattice, so the levels re-centre at different moments — and a step that leaves one level
     * snapped and another not is exactly where a gap or an overlap appears. Walked a whole coarse
     * patch, a cell at a time.
     */
    const seen = new Int32Array(SIZE * SIZE);
    /* Thirty-three cells: one whole patch of the coarsest level here, plus one, so every phase of
       every level's snapping is visited. */
    for (let step = 0; step < 33; step += 1) {
      const frame = frameAt(150.5 + step, 150.5);
      let covered = 0;
      let twice = -1;
      const stamp = step + 1;
      for (const patch of selectClipmap(frame)) {
        for (let z = patch.z; z < patch.z + patch.cells; z += 1) {
          const row = z * SIZE;
          for (let x = patch.x; x < patch.x + patch.cells; x += 1) {
            /* Counted rather than asserted per cell: four million assertions is a minute of
               vitest and one assertion is the same claim. */
            if (seen[row + x] === stamp) twice = row + x;
            seen[row + x] = stamp;
            covered += 1;
          }
        }
      }
      expect(twice).toBe(-1);
      /*
       * **65,536 exactly, at every one of the thirty-three positions**: eight patches of
       * thirty-two field cells a side, squared. An area equal to the footprint with no cell
       * counted twice is the two claims together — no overlap *and* no hole — which is what
       * counting gives that spot-checking a few cells does not. It also says the finer blocks
       * never reach outside the coarsest one, which the snapping makes true and nothing else
       * would have revealed.
       */
      expect(covered).toBe((CLIPMAP_PATCHES_ACROSS * (CLIPMAP_PATCH_CELLS << (LEVELS - 1))) ** 2);
      expect(covered).toBe(65536);
    }
  });
});

describe('the selection is a per-patch decision, which is what puts it on the GPU', () => {
  test('answers the same for a patch whatever order the patches are asked in', () => {
    /*
     * One thread per patch, alongside the cluster cut, and that is only true if the answer for a
     * patch depends on nothing but the frame and its own index. A selection that accumulated state
     * as it walked would pass every coverage test above and could not be moved to a compute pass.
     */
    const frame = frameAt(150.5, 150.5);
    const total = clipmapPatchCount(frame);
    expect(total).toBe(LEVELS * CLIPMAP_PATCHES_ACROSS * CLIPMAP_PATCHES_ACROSS);

    const forward: string[] = [];
    const out = emptyClipmapPatch();
    for (let index = 0; index < total; index += 1) {
      if (clipmapPatchAt(frame, index, out)) forward.push(describePatch(out));
    }
    const shuffled: string[] = [];
    for (let i = 0; i < total; i += 1) {
      /* A stride coprime with the count, so the walk hits every index in a different order. */
      const index = (i * 37) % total;
      if (clipmapPatchAt(frame, index, out)) shuffled.push(describePatch(out));
    }
    expect([...shuffled].sort()).toEqual([...forward].sort());
    expect(forward.length).toBeGreaterThan(100);
  });

  test('is the same selection every time, which a replay depends on', () => {
    const a = selectClipmap(frameAt(150.5, 150.5)).map(describePatch);
    const b = selectClipmap(frameAt(150.5, 150.5)).map(describePatch);
    expect(a).toEqual(b);
  });
});

function describePatch(patch: ClipmapPatch): string {
  const n = patch.neighbours;
  return [
    patch.level,
    patch.x,
    patch.z,
    patch.cells,
    patch.step,
    n.minusX ?? '-',
    n.plusX ?? '-',
    n.minusZ ?? '-',
    n.plusZ ?? '-',
  ].join('/');
}

describe('a ring meets the ring outside it without a crack', () => {
  test('every finer patch names the coarser step across the boundary', () => {
    const frame = frameAt(150.5, 150.5);
    const patches = selectClipmap(frame);
    let boundaries = 0;
    for (const patch of patches) {
      for (const [side, dx, dz] of [
        ['minusX', -1, 0],
        ['plusX', 1, 0],
        ['minusZ', 0, -1],
        ['plusZ', 0, 1],
      ] as const) {
        const probeX = patch.x + (dx > 0 ? patch.cells : dx < 0 ? -1 : 0);
        const probeZ = patch.z + (dz > 0 ? patch.cells : dz < 0 ? -1 : 0);
        const level = clipmapLevelAt(frame, probeX, probeZ);
        const declared = patch.neighbours[side];
        if (level > patch.level) {
          expect(declared).toBe(1 << level);
          boundaries += 1;
        } else {
          expect(declared).toBeUndefined();
        }
      }
    }
    /* Each level above the finest contributes a ring of them; nothing here is vacuous. */
    expect(boundaries).toBeGreaterThan(20);
  });

  test('the finer edge lies on the coarser edge, vertex for vertex', () => {
    /*
     * **The terrain equivalent of Wave 2A's level-of-detail guarantee, and the reason a skirt is
     * not needed.** The fine patch's odd vertices are moved onto the coarse chord by
     * `heightfieldPatch`, so the two edges are the same polyline and there is nothing between them
     * to fill. What this asserts is that the clipmap gives it the information to do that — a patch
     * whose neighbour declaration is missing produces a fine edge that follows the field while its
     * neighbour cuts the chord, and the gap is a hole through to the sky.
     */
    const terrain = FIELD;
    const frame = clipmapFrame(terrain, 150.5, 150.5, { levels: LEVELS });
    const patches = selectClipmap(frame);
    const byOrigin = new Map<string, ClipmapPatch>();
    for (const patch of patches) byOrigin.set(`${patch.x},${patch.z}`, patch);

    let checked = 0;
    for (const patch of patches) {
      const coarserStep = patch.neighbours.plusX;
      if (coarserStep === undefined) continue;
      const neighbour = patches.find(
        (other) =>
          other.x === patch.x + patch.cells &&
          other.z <= patch.z &&
          other.z + other.cells >= patch.z + patch.cells,
      );
      if (neighbour === undefined) continue;

      const fine = heightfieldPatch(terrain, {
        x: patch.x,
        z: patch.z,
        cells: patch.cells,
        step: patch.step,
        neighbours: patch.neighbours,
      });
      const coarse = heightfieldPatch(terrain, {
        x: neighbour.x,
        z: neighbour.z,
        cells: neighbour.cells,
        step: neighbour.step,
        neighbours: neighbour.neighbours,
      });
      const fineEdge = edgeVertices(fine, patch.cells / patch.step, 'plusX');
      const coarseEdge = edgeVertices(coarse, neighbour.cells / neighbour.step, 'minusX');
      for (const [x, y, z] of fineEdge) {
        expect(x).toBeCloseTo(coarseEdge[0]?.[0] as number, 6);
        expect(y).toBeCloseTo(chordAt(coarseEdge, 2, z), 4);
      }
      checked += 1;
    }
    expect(checked).toBeGreaterThan(3);
    expect(byOrigin.size).toBe(patches.length);
  });

  test('hands `heightfieldPatch` options it accepts, for every patch it selects', () => {
    /* The surface consumers already depend on, driven by the new selection rather than replaced. */
    const terrain = FIELD;
    const patches = selectClipmap(clipmapFrame(terrain, 150.5, 150.5, { levels: LEVELS }));
    for (const patch of patches) {
      const mesh = heightfieldPatch(terrain, {
        x: patch.x,
        z: patch.z,
        cells: patch.cells,
        step: patch.step,
        neighbours: patch.neighbours,
      });
      const across = patch.cells / patch.step;
      expect(across).toBe(CLIPMAP_PATCH_CELLS);
      expect(mesh.positions.length / 3).toBe((across + 1) * (across + 1));
    }
  });
});

describe('the clipmap says what it cannot draw', () => {
  test('drops a patch that would run off the field rather than clamping it', () => {
    /*
     * A patch clamped to the field's edge draws the edge sample stretched flat across its whole
     * area, which is a shelf of ground that is not there. The field ends, and the clipmap says so
     * by not selecting the patch.
     */
    const small = field(80);
    const frame = clipmapFrame(small, 5, 5, { levels: LEVELS });
    for (const patch of selectClipmap(frame)) {
      expect(patch.x).toBeGreaterThanOrEqual(0);
      expect(patch.z).toBeGreaterThanOrEqual(0);
      expect(patch.x + patch.cells).toBeLessThanOrEqual(small.width - 1);
      expect(patch.z + patch.cells).toBeLessThanOrEqual(small.depth - 1);
    }
  });

  test('answers no level for a cell outside the clipmap', () => {
    const frame = frameAt(150.5, 150.5);
    expect(clipmapLevelAt(frame, -50, 150)).toBe(-1);
    expect(clipmapLevelAt(frame, 150, 100000)).toBe(-1);
  });

  test('answers no level for a cell inside a block but off the field', () => {
    /*
     * **The two are different questions and only this one can tell them apart.** A cell outside
     * every block is obviously undrawn; a cell a block reaches over but the field does not is the
     * case where the answer is a level that exists and a patch that was dropped. Everything
     * coarser is dropped too — a coarse patch starts no later and ends no earlier than the fine
     * one inside it — so the honest answer is that nothing draws it.
     */
    const frame = clipmapFrame(field(80), 5, 5, { levels: LEVELS });
    /* Inside the finest block, which reaches back past the field's own origin. */
    expect(frame.origins[0]).toBeLessThan(0);
    expect(clipmapLevelAt(frame, -5, -5)).toBe(-1);
  });

  test('refuses a patch count that is not a multiple of four', () => {
    /*
     * Half the block has to be an even number of patches, or a level's origin stops being a
     * multiple of the next level's patch span and the blocks no longer nest. That is not a
     * tuneable: it is the arithmetic the coverage rests on.
     */
    expect(() => clipmapFrame(field(80), 40, 40, { patchesAcross: 6 })).toThrow(/multiple of four/);
  });
});
