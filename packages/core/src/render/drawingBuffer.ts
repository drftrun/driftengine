/**
 * A ceiling on how many pixels one frame may be, independent of how big the window is.
 *
 * `maxDevicePixelRatio` caps *density* — pixels per CSS pixel — which is the right lever
 * for "is this panel high-DPI" and the wrong one for "how much frame is this". Density
 * held constant, the cost of a frame is still whatever area the player last dragged their
 * window to, and the frame is roughly 90% fragment-bound, so window size is an
 * uncontrolled multiplier on the whole renderer.
 *
 * That is fine right up until it isn't, because vsync quantises the consequence. A frame
 * that fits a 120 Hz slot with 5% to spare and then grows 10% does not run 10% slower; it
 * misses the slot and is shown at 60. Going fullscreen is exactly such a growth — the
 * browser's toolbar was the margin — so the symptom arrives as "fullscreen halves the
 * frame rate", which sounds like a bug in fullscreen and is arithmetic about area.
 *
 * A budget makes that cost bounded and, more usefully, *legible*: a player can move it
 * and watch the frame rate move, which is the same argument that put the resolution lever
 * on the settings screen. Zero means uncapped, for a machine that would rather have the
 * pixels.
 */

/** Mutable so the caller can own one and keep `resize` allocation-free. */
export interface BufferSize {
  width: number;
  height: number;
}

/** Smallest drawing buffer worth asking a driver for; zero is a GL error, not a picture. */
const MIN_SIDE = 2;

/**
 * Fit `width` x `height` under `maxPixels`, preserving aspect, into `out`.
 *
 * Writes rather than returns, because `Renderer.resize` runs every frame and per-frame
 * allocation is forbidden (AGENTS.md). Non-positive and non-finite budgets mean uncapped:
 * this runs in the frame loop, where a corrupt stored setting has to degrade to the old
 * behaviour rather than throw.
 *
 * Scaled by the square root of the ratio, so both axes shrink together and
 * `Renderer.aspect` still describes the shot the camera composed for. Rounded *down*, so
 * the budget is a promise rather than an approximation — the whole point is that a number
 * a player chose is the number they get.
 */
export function fitToPixelBudget(
  width: number,
  height: number,
  maxPixels: number,
  out: BufferSize,
): void {
  out.width = width;
  out.height = height;
  if (!Number.isFinite(maxPixels) || maxPixels <= 0) return;

  const pixels = width * height;
  if (pixels <= maxPixels) return;

  const scale = Math.sqrt(maxPixels / pixels);
  out.width = Math.max(MIN_SIDE, Math.floor(width * scale));
  out.height = Math.max(MIN_SIDE, Math.floor(height * scale));
}

/**
 * The size the next frame is drawn at, into `out`.
 *
 * **A locked buffer is handed back exactly, and no cap of any kind touches it.** That is
 * the one rule in here that is not about performance: a lock is a caller naming a size for
 * a reason no quality setting can see — a clip is 1080x1920 whatever anybody's frame rate
 * is, and `Renderer.aspect` follows the lock so the replay's shots are composed for the
 * *file* rather than for the window it is being written from. A budget applied over the
 * top would silently write a file that is not the size it claims and re-frame every shot
 * in it. Pass `dpr` already clamped; unlocked, the CSS box is scaled by it and then fitted
 * under `maxPixels`.
 */
export function drawingBufferSize(
  cssWidth: number,
  cssHeight: number,
  dpr: number,
  lockedWidth: number,
  lockedHeight: number,
  maxPixels: number,
  out: BufferSize,
): void {
  if (lockedWidth > 0 && lockedHeight > 0) {
    out.width = lockedWidth;
    out.height = lockedHeight;
    return;
  }
  fitToPixelBudget(Math.round(cssWidth * dpr), Math.round(cssHeight * dpr), maxPixels, out);
}
