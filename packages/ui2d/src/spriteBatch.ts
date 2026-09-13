/** The CPU side of a sprite draw: quads packed into one instance buffer, in submission order. */

/**
 * Floats per instance: two edge vectors, a UV rectangle, a tint, and an origin.
 *
 * Fourteen rather than a rounder sixteen because a vertex buffer's stride only has to be a multiple
 * of four bytes, and two floats a sprite is 8 KB at a four-thousand-sprite batch.
 */
export const SPRITE_FLOATS = 14;

/** Where a sprite goes, in whatever space the batch is being drawn in. */
export interface SpritePlacement {
  /**
   * The corner the sprite grows from, and *which* corner depends on the affine.
   *
   * In screen space y counts down, so this is the top-left; in a 2D world y counts up, so it is
   * the bottom-left. The batch does not know which it is in and does not need to: it is the same
   * arithmetic either way, and `camera2d.ts` is where the two conventions are written down.
   */
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  /**
   * Radians, anticlockwise in the mathematical sense — which reads as clockwise on screen, where y
   * counts down. Defaults to none.
   */
  readonly rotation?: number;
  /** The point rotation turns about, as a fraction of the sprite. Defaults to its centre. */
  readonly pivotX?: number;
  readonly pivotY?: number;
}

/** A rectangle of a texture, in the 0..1 the sampler reads. See `spriteSheet.ts`. */
export interface UvRect {
  readonly u0: number;
  readonly v0: number;
  readonly u1: number;
  readonly v1: number;
}

/**
 * A run of consecutive instances that share a texture.
 *
 * Runs exist because the number to hold down is material changes rather than draws: a tilemap over
 * one sheet is one run however many thousand tiles it is, and a run boundary is the only place the
 * pass has to touch the GPU between them.
 */
export interface SpriteRun {
  readonly texture: number;
  readonly first: number;
  readonly count: number;
}

/**
 * One frame's worth of sprites.
 *
 * Fixed capacity, filled from the front, reset each frame. It grows for nobody: a batch that
 * reallocated mid-frame would allocate in the hot path, and the failure it is protecting against —
 * a caller drawing more than it planned for — is one that wants counting rather than absorbing.
 */
export interface SpriteBatch {
  /** `capacity * SPRITE_FLOATS`, filled to `count * SPRITE_FLOATS`. */
  readonly instances: Float32Array;
  readonly capacity: number;
  count: number;
  /** Three entries a run: texture, first instance, length. */
  readonly runs: Int32Array;
  runCount: number;
  /** Sprites this frame refused for want of room. Zero is the only good value. */
  dropped: number;
}

export function createSpriteBatch(capacity: number): SpriteBatch {
  return {
    instances: new Float32Array(capacity * SPRITE_FLOATS),
    capacity,
    count: 0,
    /*
     * One run per sprite is the worst case — a caller alternating textures every draw — and
     * allocating for it costs twelve bytes a sprite against the fifty-six the sprite itself costs.
     * The alternative is a second capacity to overflow, on a path where overflowing means dropping
     * a draw the caller can see.
     */
    runs: new Int32Array(capacity * 3),
    runCount: 0,
    dropped: 0,
  };
}

export function resetSpriteBatch(batch: SpriteBatch): void {
  batch.count = 0;
  batch.runCount = 0;
  batch.dropped = 0;
}

/** Read a run back. For tests and diagnostics; the pass reads `runs` directly. */
export function spriteRun(batch: SpriteBatch, index: number): SpriteRun {
  const at = index * 3;
  return {
    texture: batch.runs[at] as number,
    first: batch.runs[at + 1] as number,
    count: batch.runs[at + 2] as number,
  };
}

/**
 * Push one quad. Allocates nothing.
 *
 * `source` of `null` is the whole texture and `tint` of `null` is opaque white, because those are
 * what a caller drawing a plain image wants and neither should cost an object per draw.
 */
export function drawSprite(
  batch: SpriteBatch,
  texture: number,
  placement: SpritePlacement,
  source: UvRect | null,
  tint: ArrayLike<number> | null,
): void {
  if (batch.count >= batch.capacity) {
    batch.dropped += 1;
    return;
  }

  const rotation = placement.rotation ?? 0;
  const cos = rotation === 0 ? 1 : Math.cos(rotation);
  const sin = rotation === 0 ? 0 : Math.sin(rotation);
  const w = placement.w;
  const h = placement.h;
  // The two edge vectors of the quad, turned.
  const ax = w * cos;
  const ay = w * sin;
  const bx = -h * sin;
  const by = h * cos;
  const pivotX = placement.pivotX ?? 0.5;
  const pivotY = placement.pivotY ?? 0.5;
  // The pivot does not move, so the origin is wherever it has to be for that to hold.
  const originX = placement.x + w * pivotX - (ax * pivotX + bx * pivotY);
  const originY = placement.y + h * pivotY - (ay * pivotX + by * pivotY);

  const at = batch.count * SPRITE_FLOATS;
  const f = batch.instances;
  f[at] = ax;
  f[at + 1] = ay;
  f[at + 2] = bx;
  f[at + 3] = by;
  f[at + 4] = source === null ? 0 : source.u0;
  f[at + 5] = source === null ? 0 : source.v0;
  f[at + 6] = source === null ? 1 : source.u1;
  f[at + 7] = source === null ? 1 : source.v1;
  f[at + 8] = tint === null ? 1 : (tint[0] as number);
  f[at + 9] = tint === null ? 1 : (tint[1] as number);
  f[at + 10] = tint === null ? 1 : (tint[2] as number);
  f[at + 11] = tint === null ? 1 : (tint[3] as number);
  f[at + 12] = originX;
  f[at + 13] = originY;

  const lastRun = (batch.runCount - 1) * 3;
  if (batch.runCount > 0 && batch.runs[lastRun] === texture) {
    batch.runs[lastRun + 2] = (batch.runs[lastRun + 2] as number) + 1;
  } else {
    const run = batch.runCount * 3;
    batch.runs[run] = texture;
    batch.runs[run + 1] = batch.count;
    batch.runs[run + 2] = 1;
    batch.runCount += 1;
  }
  batch.count += 1;
}
