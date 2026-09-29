/**
 * Which object a draw is, so a reconstruction can find where that object was last frame.
 *
 * **The engine cannot infer this and does not try.** `drawMesh` is immediate: a mesh drawn three
 * times is three objects, and nothing in the call says which of last frame's three each one is. A
 * consumer that makes one `Mover` per moving object and passes it with every draw of that object
 * says exactly that, and the renderer keeps the rest — last frame's model and, for a skinned
 * draw, last frame's palette.
 *
 * **Plain data, advanced by the renderer.** No renderer is needed to make one, so a consumer holds
 * it beside the object it belongs to. Only a reconstructing WebGPU renderer reads or writes it; it
 * costs nothing anywhere else. The fields past `kind` are the renderer's and a caller leaves them
 * alone.
 *
 * **What would make this wrong** is a consumer whose objects are rebuilt every frame with no state
 * of their own to hold a mover in; the identity then has to live in whatever *does* persist.
 */

export const MOVER_KIND = 'drift.mover' as const;

export interface Mover {
  readonly kind: typeof MOVER_KIND;
  /** The renderer that last drew it, from `claimRendererId`; -1 before its first draw. */
  renderer: number;
  /** That renderer's frame serial at the last draw. */
  frame: number;
  readonly model: Float32Array;
  readonly previousModel: Float32Array;
  /**
   * This frame's palette, exactly `paletteLength` floats long once a skinned draw has set it.
   * Swapped with the previous one each frame and reallocated only when the rig changes.
   */
  palette: Float32Array;
  previousPalette: Float32Array;
  paletteLength: number;
  previousPaletteLength: number;
}

/** Nothing to reproject from: first draw, a missed frame, another renderer, or a changed rig. */
export const MOVER_NONE = 0;
/** Drawn on the frame before by this renderer: `previousModel` and `previousPalette` are real. */
export const MOVER_MOTION = 1;
/** Drawn already this frame. The second draw is a different object and the caller's error. */
export const MOVER_TWICE = 2;
export type MoverVerdict = typeof MOVER_NONE | typeof MOVER_MOTION | typeof MOVER_TWICE;

let nextRendererId = 1;

/** A number no other renderer in this page holds, so a mover can tell renderers apart. */
export function claimRendererId(): number {
  const id = nextRendererId;
  nextRendererId += 1;
  return id;
}

export function createMover(): Mover {
  return {
    kind: MOVER_KIND,
    renderer: -1,
    frame: -2,
    model: new Float32Array(16),
    previousModel: new Float32Array(16),
    palette: new Float32Array(0),
    previousPalette: new Float32Array(0),
    paletteLength: 0,
    previousPaletteLength: 0,
  };
}

export function isMover(value: unknown): value is Mover {
  return (
    typeof value === 'object' && value !== null && (value as { kind?: unknown }).kind === MOVER_KIND
  );
}

/**
 * Advance a mover to this draw, and say whether last frame's state is usable.
 *
 * **A second draw in one frame changes nothing**, so the first draw's motion stands; the caller
 * warns. Otherwise what the mover held becomes its previous and this draw becomes its current —
 * the palettes by swapping two arrays, so a steady rig allocates nothing after its first frame.
 *
 * **A changed joint count is no motion**: skinning a vertex with a palette of a different rig is
 * not an old pose of this one.
 */
export function advanceMover(
  mover: Mover,
  renderer: number,
  frame: number,
  model: ArrayLike<number>,
  palette: Float32Array | null,
): MoverVerdict {
  if (mover.renderer === renderer && mover.frame === frame) return MOVER_TWICE;
  const drawnLast = mover.renderer === renderer && mover.frame === frame - 1;

  mover.previousModel.set(mover.model);
  const spare = mover.previousPalette;
  mover.previousPalette = mover.palette;
  mover.palette = spare;
  mover.previousPaletteLength = mover.paletteLength;

  mover.model.set(model);
  if (palette === null) {
    mover.paletteLength = 0;
  } else {
    /* Exactly the rig's length, because the array is uploaded as it stands; reallocated only when
       the rig changes, which a steady character never does. */
    if (mover.palette.length !== palette.length) mover.palette = new Float32Array(palette.length);
    mover.palette.set(palette);
    mover.paletteLength = palette.length;
  }
  mover.renderer = renderer;
  mover.frame = frame;

  if (!drawnLast) return MOVER_NONE;
  if (mover.paletteLength !== mover.previousPaletteLength) return MOVER_NONE;
  return MOVER_MOTION;
}
