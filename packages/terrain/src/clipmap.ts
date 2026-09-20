/**
 * Which squares of the field to draw, at what detail, for a camera standing somewhere.
 *
 * **A clipmap is rings of patches whose step doubles outward**, so the ground under the camera is
 * drawn at full resolution and the horizon at a sixteenth of it, and the vertex count stays flat
 * however large the world is. The hard part is not the rings; it is that they have to meet.
 *
 * **Two failures decide the whole design and neither is visible in a list of patches.** A field
 * cell drawn by two patches is z-fighting on the ground. A field cell drawn by none is a hole
 * through to the sky. Both come out of the arithmetic that snaps each level's block to a lattice,
 * so that is what the tests assert directly: every cell in the footprint, counted.
 *
 * **Each level's block is snapped to an even patch index**, which is what makes the levels nest:
 * an origin at an even multiple of a level's patch span is a multiple of the next level's patch
 * span, so a finer block's edge always falls on a coarser patch boundary and never through the
 * middle of one. A coarse patch is therefore covered by the finer block entirely or not at all,
 * and culling it when it is covered leaves no gap and no overlap. The block being an even number
 * of patches on each side of that index is why `patchesAcross` must be a multiple of four.
 *
 * **The hole a finer level leaves is not fixed at the centre**, which is the part that looks wrong
 * and is right. Levels snap to their own lattices and re-centre at different moments, so the finer
 * block sits a patch off-centre in the coarser one about half the time. Culling by *coverage*
 * rather than by a fixed central hole is what makes that harmless — and a fixed hole is what the
 * usual implementation does, which is why it needs an L-shaped strip to take up the slack.
 *
 * **The selection is one decision per patch**, taking the frame and an index and reading nothing
 * else. That is what lets it move into a compute pass beside the cluster cut rather than be
 * rewritten there: `clipmapPatchAt` is the body of that shader, and the test that asks for the
 * patches in a scrambled order is what holds it.
 *
 * What it does *not* do is build geometry. `heightfieldPatch` does that, including moving a fine
 * edge's odd vertices onto its coarse neighbour's chord — this module's job is to tell it which
 * neighbour is coarser, because a patch that is not told draws an edge that follows the field
 * while the patch beside it cuts the chord beneath.
 */
import type { Terrain } from './heightfield.ts';
import type { HeightfieldPatchOptions } from './heightfieldPatch.ts';

/** Drawn cells along one edge of every patch, at every level. */
export const CLIPMAP_PATCH_CELLS = 8;

/** Patches along one edge of a level's block. A multiple of four, for the reason above. */
export const CLIPMAP_PATCHES_ACROSS = 8;

/** Levels a frame builds when the caller does not say. */
export const CLIPMAP_LEVELS = 4;

export interface ClipmapOptions {
  readonly levels?: number;
  readonly patchCells?: number;
  readonly patchesAcross?: number;
}

/**
 * Everything a per-patch decision needs, computed once for a camera.
 *
 * Deliberately plain data: an `Int32Array` of origins and four numbers. What a compute pass would
 * be handed as a uniform block, and nothing a shader could not hold.
 */
export interface ClipmapFrame {
  readonly levels: number;
  readonly patchCells: number;
  readonly patchesAcross: number;
  /** Two entries a level: the field-cell index of the block's first cell, x then z. */
  readonly origins: Int32Array;
  /** Cells the field has, which is one fewer than its samples. */
  readonly fieldCellsX: number;
  readonly fieldCellsZ: number;
}

/** A selected patch, in exactly the terms `heightfieldPatch` takes. */
export interface ClipmapPatch {
  level: number;
  /** Grid index of the patch's first sample, along x. */
  x: number;
  z: number;
  /** Field cells the patch spans: `patchCells * step`. */
  cells: number;
  /** Field cells per drawn cell: `1 << level`. */
  step: number;
  /** The step of each neighbour that is *coarser* than this patch. The finer side is the one that
      moves, so nothing is said about a neighbour at the same level or a finer one. */
  neighbours: {
    minusX?: number;
    plusX?: number;
    minusZ?: number;
    plusZ?: number;
  };
}

/** A patch to write into, so a caller looping over indices allocates nothing. */
export function emptyClipmapPatch(): ClipmapPatch {
  return { level: 0, x: 0, z: 0, cells: 0, step: 1, neighbours: {} };
}

/**
 * Snap a camera to each level's block, once, for a frame.
 *
 * The camera is in world coordinates and the blocks are in field cells, because that is what
 * `heightfieldPatch` indexes by and converting in one place is one place to be wrong.
 */
export function clipmapFrame(
  terrain: Terrain,
  cameraX: number,
  cameraZ: number,
  options: ClipmapOptions = {},
): ClipmapFrame {
  const levels = Math.max(1, Math.round(options.levels ?? CLIPMAP_LEVELS));
  const patchCells = Math.max(1, Math.round(options.patchCells ?? CLIPMAP_PATCH_CELLS));
  const patchesAcross = Math.round(options.patchesAcross ?? CLIPMAP_PATCHES_ACROSS);
  if (patchesAcross % 4 !== 0) {
    throw new Error(
      `clipmapFrame: patchesAcross must be a multiple of four so the levels nest, got ${patchesAcross}`,
    );
  }

  const spacing = terrain.spacingM;
  const cellX = Math.floor((cameraX - (terrain.origin[0] ?? 0)) / spacing);
  const cellZ = Math.floor((cameraZ - (terrain.origin[2] ?? 0)) / spacing);

  const origins = new Int32Array(levels * 2);
  for (let level = 0; level < levels; level += 1) {
    const span = patchCells << level;
    origins[level * 2] = blockOrigin(cellX, span, patchesAcross);
    origins[level * 2 + 1] = blockOrigin(cellZ, span, patchesAcross);
  }
  return {
    levels,
    patchCells,
    patchesAcross,
    origins,
    fieldCellsX: terrain.width - 1,
    fieldCellsZ: terrain.depth - 1,
  };
}

/**
 * The first field cell of a level's block along one axis.
 *
 * The camera's patch index rounded *down to an even one*, then half the block subtracted. Even is
 * what makes the origin a multiple of twice the span, which is the next level's span — the one
 * property everything else rests on.
 */
function blockOrigin(cameraCell: number, span: number, patchesAcross: number): number {
  const patch = Math.floor(cameraCell / span);
  const even = 2 * Math.floor(patch / 2);
  return (even - patchesAcross / 2) * span;
}

/** Patches a frame decides about: every index a compute pass would launch a thread for. */
export function clipmapPatchCount(frame: ClipmapFrame): number {
  return frame.levels * frame.patchesAcross * frame.patchesAcross;
}

/** Whether `[x, x + span)` on both axes lies inside level `level`'s block. */
function insideBlock(
  frame: ClipmapFrame,
  level: number,
  x: number,
  z: number,
  span: number,
): boolean {
  const width = frame.patchesAcross * (frame.patchCells << level);
  const x0 = frame.origins[level * 2] as number;
  const z0 = frame.origins[level * 2 + 1] as number;
  return x >= x0 && z >= z0 && x + span <= x0 + width && z + span <= z0 + width;
}

function onField(frame: ClipmapFrame, x: number, z: number, span: number): boolean {
  return x >= 0 && z >= 0 && x + span <= frame.fieldCellsX && z + span <= frame.fieldCellsZ;
}

/**
 * The level whose drawn patch covers a field cell, or `-1` where nothing draws it.
 *
 * The finest level whose block contains the cell and whose patch there fits on the field. Finest
 * rather than any, because a coarser patch over the same ground is exactly what gets culled.
 */
export function clipmapLevelAt(frame: ClipmapFrame, cellX: number, cellZ: number): number {
  for (let level = 0; level < frame.levels; level += 1) {
    const span = frame.patchCells << level;
    const x0 = frame.origins[level * 2] as number;
    const z0 = frame.origins[level * 2 + 1] as number;
    const width = frame.patchesAcross * span;
    if (cellX < x0 || cellZ < z0 || cellX >= x0 + width || cellZ >= z0 + width) continue;
    const px = x0 + Math.floor((cellX - x0) / span) * span;
    const pz = z0 + Math.floor((cellZ - z0) / span) * span;
    if (!onField(frame, px, pz, span)) continue;
    return level;
  }
  return -1;
}

/**
 * Decide one patch, by index, writing it into `out`.
 *
 * Returns whether it is drawn. Reads the frame and the index and nothing else, which is what makes
 * this the body of a compute shader rather than a loop that has to be rewritten as one.
 */
export function clipmapPatchAt(frame: ClipmapFrame, index: number, out: ClipmapPatch): boolean {
  const perLevel = frame.patchesAcross * frame.patchesAcross;
  const level = Math.floor(index / perLevel);
  if (level < 0 || level >= frame.levels) return false;
  const within = index - level * perLevel;
  const i = within % frame.patchesAcross;
  const j = Math.floor(within / frame.patchesAcross);

  const step = 1 << level;
  const span = frame.patchCells * step;
  const x = (frame.origins[level * 2] as number) + i * span;
  const z = (frame.origins[level * 2 + 1] as number) + j * span;

  if (!onField(frame, x, z, span)) return false;
  /* Covered by the level inside this one, whole — which is the only way it can be covered, because
     a finer block's edge falls on this level's patch boundaries. */
  if (level > 0 && insideBlock(frame, level - 1, x, z, span)) return false;

  out.level = level;
  out.x = x;
  out.z = z;
  out.cells = span;
  out.step = step;
  out.neighbours = {};
  declareCoarser(frame, out, 'minusX', x - 1, z);
  declareCoarser(frame, out, 'plusX', x + span, z);
  declareCoarser(frame, out, 'minusZ', x, z - 1);
  declareCoarser(frame, out, 'plusZ', x, z + span);
  return true;
}

/** Name a neighbour's step where it is coarser than this patch, and say nothing otherwise. */
function declareCoarser(
  frame: ClipmapFrame,
  patch: ClipmapPatch,
  side: keyof ClipmapPatch['neighbours'],
  probeX: number,
  probeZ: number,
): void {
  const level = clipmapLevelAt(frame, probeX, probeZ);
  if (level <= patch.level) return;
  patch.neighbours[side] = 1 << level;
}

/** Every drawn patch, as a list. The convenience over `clipmapPatchAt`, not a second rule. */
export function selectClipmap(frame: ClipmapFrame): ClipmapPatch[] {
  const patches: ClipmapPatch[] = [];
  const total = clipmapPatchCount(frame);
  const scratch = emptyClipmapPatch();
  for (let index = 0; index < total; index += 1) {
    if (!clipmapPatchAt(frame, index, scratch)) continue;
    patches.push({ ...scratch, neighbours: { ...scratch.neighbours } });
  }
  return patches;
}

/** A selected patch as the options `heightfieldPatch` takes, with nothing added or renamed. */
export function clipmapPatchOptions(patch: ClipmapPatch): HeightfieldPatchOptions {
  return {
    x: patch.x,
    z: patch.z,
    cells: patch.cells,
    step: patch.step,
    neighbours: patch.neighbours,
  };
}
