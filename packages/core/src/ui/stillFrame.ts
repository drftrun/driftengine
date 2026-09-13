import { bakeOverlay } from './frameOverlay.ts';
import type { FrameOverlay } from './frameOverlay.ts';

/**
 * One frame, composited with the same mark a clip would carry.
 *
 * A free function rather than a static on `FrameRecorder`, and it was that static
 * until 2026-08-07. The reason for the move is the same reason it was static in the
 * first place, taken one step further: a still needs no `MediaRecorder`, so a browser
 * that cannot record video must still be able to save a screenshot. As a static it
 * could be *called* without a recorder but not *reached* without one — a bundler sees
 * the class, and the class drags the recorder, the export target and the frame pacer
 * in behind it. A consumer taking a screenshot was paying for the whole clip pipeline
 * to do it. Here it costs the overlay compositor and nothing else.
 *
 * Composited at the source's own size, because a still is a picture of what is on
 * screen rather than a clip that needs a platform's shape.
 *
 * **Call this inside the render pass**, before the page composites: a WebGL drawing
 * buffer is not guaranteed readable afterwards, and this copies black when it is not.
 * The same rule governs `Renderer.copyRegionTo`, and it has now cost a session twice —
 * once as a black still with a watermark on it, once as an empty preview box.
 */
export function stillFrame(
  source: HTMLCanvasElement,
  overlay?: FrameOverlay,
  drawFrame?: (ctx: CanvasRenderingContext2D, width: number, height: number) => void,
): HTMLCanvasElement | null {
  const still = document.createElement('canvas');
  still.width = source.width;
  still.height = source.height;
  const ctx = still.getContext('2d', { alpha: false });
  if (ctx === null) return null;
  ctx.drawImage(source, 0, 0);
  const mark = overlay === undefined ? null : bakeOverlay(overlay, still.width, still.height);
  if (mark !== null) ctx.drawImage(mark, 0, 0);
  // Same live layer a clip gets, so a still is not a different picture.
  if (drawFrame !== undefined) {
    ctx.save();
    drawFrame(ctx, still.width, still.height);
    ctx.restore();
  }
  return still;
}
