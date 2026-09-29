import { describe, expect, it } from 'vitest';
import {
  MOVER_MOTION,
  MOVER_NONE,
  MOVER_TWICE,
  advanceMover,
  claimRendererId,
  createMover,
  isMover,
} from './mover.ts';

/** A translation along x, column-major, so element 12 is the x a test can read back. */
function atX(x: number): Float32Array {
  return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 0, 1]);
}

describe('mover', () => {
  it('A MOVER DRAWN ON CONSECUTIVE FRAMES REMEMBERS WHERE IT WAS', () => {
    const mover = createMover();
    expect(advanceMover(mover, 7, 10, atX(1), null)).toBe(MOVER_NONE);
    expect(advanceMover(mover, 7, 11, atX(2), null)).toBe(MOVER_MOTION);
    expect(mover.previousModel[12]).toBe(1);
    expect(mover.model[12]).toBe(2);
  });

  it('a mover that missed a frame has no motion on its return', () => {
    const mover = createMover();
    advanceMover(mover, 7, 10, atX(1), null);
    expect(advanceMover(mover, 7, 12, atX(3), null)).toBe(MOVER_NONE);
    expect(mover.model[12]).toBe(3);
  });

  it('a mover drawn twice in one frame keeps the first draw and says so', () => {
    const mover = createMover();
    advanceMover(mover, 7, 10, atX(1), null);
    advanceMover(mover, 7, 11, atX(2), null);
    expect(advanceMover(mover, 7, 11, atX(9), null)).toBe(MOVER_TWICE);
    expect(mover.model[12]).toBe(2);
    expect(mover.previousModel[12]).toBe(1);
  });

  it('a mover handed to another renderer reads as not drawn last frame', () => {
    const mover = createMover();
    advanceMover(mover, 7, 10, atX(1), null);
    expect(advanceMover(mover, 8, 11, atX(2), null)).toBe(MOVER_NONE);
  });

  it('a skinned mover carries last frame’s palette, and a changed joint count is no motion', () => {
    const mover = createMover();
    advanceMover(mover, 7, 10, atX(0), new Float32Array([1, 2, 3]));
    expect(advanceMover(mover, 7, 11, atX(0), new Float32Array([4, 5, 6]))).toBe(MOVER_MOTION);
    expect(Array.from(mover.previousPalette.subarray(0, mover.previousPaletteLength))).toEqual([
      1, 2, 3,
    ]);
    expect(Array.from(mover.palette.subarray(0, mover.paletteLength))).toEqual([4, 5, 6]);
    expect(advanceMover(mover, 7, 12, atX(0), new Float32Array([7, 8]))).toBe(MOVER_NONE);
    expect(advanceMover(mover, 7, 13, atX(0), null)).toBe(MOVER_NONE);
  });

  /*
   * The renderer uploads a palette array as it stands, so an array longer than its rig would upload
   * joints that are not there. A rig of six floats, then one of three drawn three frames running,
   * leaves the longer array in the swap — and it has to be replaced, not reused.
   */
  it('keeps each palette exactly as long as its rig', () => {
    const mover = createMover();
    advanceMover(mover, 7, 10, atX(0), new Float32Array(6));
    advanceMover(mover, 7, 11, atX(0), new Float32Array(3));
    advanceMover(mover, 7, 12, atX(0), new Float32Array(3));
    expect(advanceMover(mover, 7, 13, atX(0), new Float32Array(3))).toBe(MOVER_MOTION);
    expect(mover.previousPalette.length).toBe(3);
    expect(mover.palette.length).toBe(3);
  });

  it('is told apart from a matrix, and renderer ids never repeat', () => {
    expect(isMover(createMover())).toBe(true);
    expect(isMover(atX(0))).toBe(false);
    expect(isMover(null)).toBe(false);
    const first = claimRendererId();
    expect(claimRendererId()).toBe(first + 1);
  });
});
