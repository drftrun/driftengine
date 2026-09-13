import { FramePacer } from './framePacer.ts';
import type { FramePacingReport } from './framePacer.ts';
import { bakeOverlay } from './frameOverlay.ts';
import type { FrameOverlay } from './frameOverlay.ts';

/**
 * The surface a clip is recorded from: a fixed-size frame, composited and paced.
 *
 * Three things it fixes, all of which were visible in the first export:
 *
 * **Aspect is rendered, not cropped.** The scene is drawn at the export's own
 * pixel size, so a vertical clip is *framed* vertically. Cropping a 16:9 view to
 * 9:16 throws away 44% of the width, and the subject is exactly what falls
 * outside — the shot was composed for the other rectangle.
 *
 * **The frame is composited.** The scene canvas is copied into a target of
 * exactly the requested size and the mark is stamped on top, so branding is
 * inside the video rather than in DOM that the capture never sees.
 *
 * **Frames are paced.** `captureStream(0)` records nothing until asked, so every
 * frame in the file is one the renderer actually finished. Capturing at a rate
 * the renderer cannot hold samples some frames twice and misses the next, which
 * is what uneven duplication looks like: judder.
 *
 * **The honest limit.** `MediaRecorder` timestamps by wall clock, so an export
 * runs in real time and no amount of pacing changes that. There is no in-browser
 * way to render slower than real time and still have the audio line up, short of
 * shipping a muxer — which is a dependency, and the standing rule says no. What
 * pacing *can* do is make every frame in the file the same distance from the last,
 * by counting animation frames rather than milliseconds — see `FramePacer`. A
 * device that cannot hold the requested rate then records a slower clip rather than
 * a juddering one, and the measurement in `pacing` says which it was.
 */
export interface LockableSurface {
  /** Pin the drawing buffer to an exact pixel size, ignoring CSS and DPR. */
  lockDrawingBuffer(width: number, height: number): void;
  unlockDrawingBuffer(): void;
}

export interface ExportTargetOptions {
  /** The canvas the scene is drawn into. */
  readonly source: HTMLCanvasElement;
  /** Whoever owns that canvas's drawing-buffer size. */
  readonly surface: LockableSurface;
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  /**
   * Stamped into every frame, and baked once.
   *
   * Accepts a function of the final frame size, because the size is not always
   * the one asked for — a device that cannot hold the rate records smaller. A
   * mark laid out for the larger frame and drawn into the smaller one lands on
   * fractional pixels, which is the difference between a wordmark and a smudge.
   */
  readonly overlay?: FrameOverlay | ((width: number, height: number) => FrameOverlay);
  /**
   * Drawn into every frame, live.
   *
   * The counterpart to `overlay`, which is baked once because a wordmark and a
   * share code do not change. Anything that *does* change per frame — a
   * speedometer, a clock, a lap counter — cannot go through that path at all, and
   * re-baking an overlay each frame would allocate a canvas per frame to say so.
   * So this is handed the composite's own context instead and draws straight into
   * it, after the scene and after the baked mark.
   *
   * Called once per composed frame, including the still-image path, so a still
   * carries whatever a clip would. Receives the *final* frame size for the same
   * reason `overlay` does: a device that cannot hold the rate records smaller, and
   * an instrument laid out for the larger frame lands on fractional pixels.
   *
   * The context is owned by the target: a hook that leaves transforms, clips or
   * composite state behind will corrupt later frames, so it must restore what it
   * changes. Save/restore is wrapped here so the common case needs no discipline.
   */
  readonly drawFrame?: (ctx: CanvasRenderingContext2D, width: number, height: number) => void;
  /**
   * The renderer's own presented-frame count, e.g. `() => renderer.presentedFrames`.
   *
   * Optional, and reached for no reason but this: `compose()` composites once per encoded
   * frame regardless of whether the renderer presented anything new since the call before —
   * it has no way to ask, only to draw whatever is on `source` right now — so a scene that
   * presents nothing between two frames of an export is composited twice, byte-identical, at
   * two different timestamps. Passing this closes the loop: `duplicateFrame` after `compose()`
   * says whether that just happened, read out of the renderer rather than guessed at from
   * outside it. Omit it and `compose()` behaves exactly as before — nothing here forces or
   * skips a draw, it only reports what already happened.
   */
  readonly presentedFrames?: () => number;
}

/**
 * How much smaller the fallback frame is, per side.
 *
 * Two thirds, which takes 1080x1920 to exactly 720x1280 and costs 56% of the
 * pixels — enough to buy back a frame rate, little enough that the clip is still
 * sharp on a phone. The choice between them is made from a *measurement* of what
 * the renderer is actually managing, never from a device string: the same model
 * of phone runs at two different rates depending on how warm it is.
 */
export const EXPORT_FALLBACK_SCALE = 2 / 3;
/**
 * The share of the target rate the renderer has to be holding to earn the full
 * frame. Below it, the export is already dropping frames before the extra
 * composite work is added.
 */
const FULL_SIZE_FPS_MARGIN = 1.15;

export interface ExportSize {
  readonly width: number;
  readonly height: number;
  /** True when the measurement forced the smaller frame. */
  readonly reduced: boolean;
}

/**
 * The size asked for, evened — for an encode whose schedule is *ours*.
 *
 * The counterpart to `exportSizeFor`, and the distinction is the whole point.
 * `exportSizeFor` trades pixels for frame rate, which is the right trade for a
 * real-time recorder: `MediaRecorder` stamps by wall clock, so a device that
 * cannot draw an export-size frame in 16 ms produces a *worse file*, and a
 * smaller frame it can hold is the better clip.
 *
 * An offline encode makes no such trade, because it has no clock to lose to.
 * Every frame is stamped with where it belongs (see `frameTimestampUs`), so a
 * device that needs 40 ms a frame produces the same file as one that needs 4 —
 * it just waits longer for it. Reducing there buys nothing but a shorter wait,
 * and it is paid for in the one thing the clip is for.
 *
 * That mattered most on exactly the devices least able to argue: the reduction
 * gate is `measuredFps × windowPixels / exportPixels ≥ targetFps × 1.15`, which
 * at a vsync-capped 60 fps needs a drawing buffer of 2.38 Mpx to clear. A phone
 * has about 1.5 Mpx (a ~412×915 viewport at a DPR capped to 2), so *no* 60 Hz
 * phone could ever earn the full frame: every mobile clip came out 720×1280 at
 * 6.1 Mbit/s where a desktop's was 1080×1920 at 13.7. Same shot, same 60 fps,
 * a quarter of the detail — which gets reported as a difference in "graphics
 * detail" rather than in frame rate. It was neither; it was pixels.
 *
 * Both dimensions stay even, for the same reason as below.
 */
export function exportSizeExact(width: number, height: number): ExportSize {
  return { width: even(width), height: even(height), reduced: false };
}

/**
 * The frame size to record at, given what the renderer is currently managing.
 *
 * Both dimensions stay even: every H.264 encoder in the share path wants an even
 * width and height, and an odd one is either rejected or silently padded.
 */
export function exportSizeFor(
  width: number,
  height: number,
  measuredFps: number,
  targetFps: number,
  /**
   * Pixels the measurement was taken at — the window's own drawing buffer.
   *
   * Without it the comparison is between a rate measured on a 1200x700 window and
   * a demand made of a 1080x1920 frame, which is three times the pixels: a
   * machine holding a comfortable 100 fps in the window is credited with being
   * able to hold it at the export size, and it cannot. That optimism is why an
   * export dropped frames on hardware whose preview was flawless. Omit for the
   * old behaviour, which is to trust the raw number.
   */
  measuredAtPixels = 0,
): ExportSize {
  /*
   * Fill rate is the binding cost here — shadow maps, water, the film pass are
   * all per-pixel — so the estimate is linear in pixel count. Crude, and far
   * closer than assuming the frame is free.
   */
  const estimate =
    measuredAtPixels > 0
      ? (measuredFps * measuredAtPixels) / Math.max(width * height, 1)
      : measuredFps;
  if (measuredFps <= 0 || estimate >= targetFps * FULL_SIZE_FPS_MARGIN) {
    return exportSizeExact(width, height);
  }
  return {
    width: even(width * EXPORT_FALLBACK_SCALE),
    height: even(height * EXPORT_FALLBACK_SCALE),
    reduced: true,
  };
}

/**
 * Frame rates a clip may be recorded at, best first.
 *
 * A ladder rather than a constant: a clip records at 120 if it can, else 60, else 30,
 * falling one rung at a time rather than straight to the floor.
 * Each rung is half the one above it so a display's refresh divides cleanly by the
 * stride the pacer ends up using, which is what keeps the cadence even.
 */
export const CLIP_FPS_LADDER: readonly number[] = [240, 165, 144, 120, 90, 60, 30];

/**
 * The highest rate on the ladder this device can actually deliver, at this size.
 *
 * **The default is the device's own maximum** rather than a fixed rate. The ladder
 * therefore starts above any
 * panel this is likely to meet and walks down, so a 165 Hz monitor records 165 rather
 * than being rounded to the nearest tidy number. The rungs are the rates real displays
 * actually run at; anything between them is served by the next one down, which the
 * pacer can hit with a whole stride.
 *
 * Two ceilings, and both are hard. **A clip cannot be captured faster than the game
 * is drawn**, because `FramePacer` takes every n-th animation frame, so a 60 Hz panel
 * cannot produce a 120 fps file however fast the machine is; asking anyway would
 * write a file claiming 120 while holding 60, which is precisely the lie the frame
 * schedule exists to prevent. And **the export size is not the window size**, so the
 * measured rate is scaled by pixel count exactly as `exportSizeFor` scales it, or a
 * machine comfortable in a small window is credited with a 1080x1920 frame it cannot
 * push.
 *
 * Returns the lowest rung when nothing clears, rather than nothing: at that point the
 * device is slow enough that `exportSizeFor` is about to reduce the frame, and the
 * lower rate is what makes that reduction sufficient.
 */
export function clipFpsFor(
  width: number,
  height: number,
  measuredFps: number,
  /** Pixels the measurement was taken at. Zero trusts the raw number, as above. */
  measuredAtPixels = 0,
  ladder: readonly number[] = CLIP_FPS_LADDER,
): number {
  const lowest = ladder[ladder.length - 1] ?? 30;
  if (!Number.isFinite(measuredFps) || measuredFps <= 0) return lowest;

  const estimate =
    measuredAtPixels > 0
      ? (measuredFps * measuredAtPixels) / Math.max(width * height, 1)
      : measuredFps;

  for (const rate of ladder) {
    // Never above what the display itself produces, and never above what the frame
    // costs allow at export size.
    if (rate > measuredFps) continue;
    if (estimate >= rate * FULL_SIZE_FPS_MARGIN) return rate;
  }
  return lowest;
}

/** The aspect ratio a camera must be given to frame for this export. */
export function exportAspect(width: number, height: number): number {
  return width / Math.max(height, 1);
}

/**
 * Bits per second for a frame size and rate.
 *
 * Scaled to the pixel count rather than fixed. A constant 8 Mbit/s is generous
 * at 720p and thin at 1080x1920, and thin bitrate on high-motion footage reads
 * to the eye as stutter rather than as softness — a fast-cut gameplay edit is
 * nothing but high motion, so this is not a subtle effect. Bounded at both ends: below the
 * floor the picture falls apart, above the ceiling the upload is the slow part
 * of sharing.
 */
export function clipBitrate(width: number, height: number, fps: number): number {
  const bitsPerPixel = 0.11;
  const raw = width * height * fps * bitsPerPixel;
  return Math.round(Math.min(Math.max(raw, 2_500_000), 24_000_000));
}

function even(value: number): number {
  return Math.max(2, Math.round(value / 2) * 2);
}

/**
 * Whether a frame read at `presentedCount` repeats the one composed at `lastPresentedCount`.
 *
 * `null` says nothing has been composed yet, so a first frame is never a duplicate of a frame
 * that never happened — a literal `0` there would misread the renderer's own starting count as
 * a repeat of it. Pulled out of `compose()` on purpose: it is the one piece of that method's
 * job that touches no canvas, so it is the one piece a test can hold to account without a DOM —
 * this repository's tests run in `node`, per `vitest.config.ts`, and `ExportTarget` itself
 * creates a real `<canvas>` at construction.
 */
export function isDuplicateFrame(
  lastPresentedCount: number | null,
  presentedCount: number,
): boolean {
  return lastPresentedCount !== null && presentedCount === lastPresentedCount;
}

export class ExportTarget {
  private readonly composite: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly pacer: FramePacer;
  private mark: HTMLCanvasElement | null = null;
  private stream: MediaStream | null = null;
  private videoTrack: MediaStreamTrack | null = null;
  private acquired = false;
  /** The instant this animation frame was decided on — see `captureDue`. */
  private frameAtMs = 0;
  /**
   * The renderer's `presentedFrames` as of the last `compose()`, or null before the first one.
   *
   * Null rather than 0, deliberately: a renderer's own count starts at 0 too, and a first
   * frame compared against that literal would read as a duplicate of a frame that never
   * happened. Null can only mean "nothing composed yet".
   */
  private lastPresentedFrames: number | null = null;
  /** What the last `compose()` found. See `duplicateFrame`. */
  private wasDuplicate = false;

  constructor(private readonly options: ExportTargetOptions) {
    const canvas = document.createElement('canvas');
    canvas.width = options.width;
    canvas.height = options.height;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (ctx === null) throw new Error('This browser cannot composite an export frame.');
    this.composite = canvas;
    this.ctx = ctx;
    this.pacer = new FramePacer(options.fps);
  }

  get width(): number {
    return this.options.width;
  }

  get height(): number {
    return this.options.height;
  }

  get aspect(): number {
    return exportAspect(this.options.width, this.options.height);
  }

  /**
   * Take over the render surface and hand back the stream to record.
   *
   * `captureStream(0)` rather than a frame rate: the recorder then takes a frame
   * only when `frameRendered` says one is ready, so it can never sample the same
   * rendered frame twice.
   */
  /**
   * Take over the render surface and bake the mark, without a stream.
   *
   * For an offline render, which composites and encodes frames itself and has nothing to
   * stream to. `acquire` is this plus a stream; keeping them separate means the offline
   * path never creates a `MediaStream` it would only have to stop.
   */
  lock(): void {
    if (this.acquired) return;
    this.options.surface.lockDrawingBuffer(this.options.width, this.options.height);
    this.acquired = true;
    const { overlay, width, height } = this.options;
    const resolved = typeof overlay === 'function' ? overlay(width, height) : overlay;
    this.mark = resolved === undefined ? null : bakeOverlay(resolved, width, height);
  }

  /** Whether the source canvas has actually taken the locked size yet. */
  get ready(): boolean {
    const { source, width, height } = this.options;
    return source.width === width && source.height === height;
  }

  acquire(): MediaStream {
    if (this.stream !== null) return this.stream;
    this.lock();
    const stream = this.composite.captureStream(0);
    this.stream = stream;
    this.videoTrack = stream.getVideoTracks()[0] ?? null;
    return stream;
  }

  /**
   * Whether the next frame drawn will be kept.
   *
   * Asked *before* rendering, so the render loop can skip a frame the recorder
   * would only throw away — see `FramePacer.due` for why that is a correctness
   * matter and not merely a saving.
   *
   * **Call this once per animation frame, drawing or not.** The instant is kept and
   * reused when the frame is handed over, so the schedule is queried and advanced
   * on one clock. It used to take a second reading at the end of the render pass,
   * which put the pacer's grid a whole render ahead of the frames arriving and cost
   * most of the rate: target 60 fps on a 60 Hz display captured 59.5 when a frame
   * cost 4 ms, 40 at 6 ms and 30 at 12 ms, and an export-size frame always costs
   * more than 6 ms.
   */
  captureDue(nowMs: number): boolean {
    this.frameAtMs = nowMs;
    if (this.stream === null) return true;
    return this.pacer.due(nowMs);
  }

  /**
   * One rendered frame. Composites and offers it to the recorder if it is due.
   *
   * Must be called at the end of the render pass, in the same task: a WebGL
   * drawing buffer is only guaranteed readable until the browser composites the
   * page, so copying it from a timer produces black frames on some drivers.
   *
   * Takes no instant on purpose — it uses the one `captureDue` was given for this
   * frame. There is no second clock to get wrong.
   *
   * Returns true when the frame was captured, so a caller can count.
   */
  frameRendered(): boolean {
    if (this.stream === null) return false;
    /*
     * Until the lock has actually taken effect the scene canvas is still the
     * window's size, and copying it would stretch the first frames to the export
     * aspect — the exact distortion this class exists to avoid. Skipping them
     * costs a fraction of a second of clip and guarantees every recorded frame
     * is genuinely the requested shape.
     */
    const { source } = this.options;
    if (source.width !== this.options.width || source.height !== this.options.height) return false;
    if (!this.pacer.offer(this.frameAtMs)) return false;
    this.compose();
    const track = this.videoTrack;
    if (track !== null && 'requestFrame' in track) {
      (track as MediaStreamTrack & { requestFrame(): void }).requestFrame();
    }
    return true;
  }

  /**
   * Draw the current scene plus the mark into the composite.
   *
   * Also the still-image path: a downloadable frame is the cheapest shareable
   * artefact there is, and it must carry the same mark as the clip.
   *
   * **Draws unconditionally, even when `duplicateFrame` is about to say the source has not
   * changed.** Deciding what to do with a repeated frame — drop it, hold the last one longer,
   * encode it anyway — is a policy choice about the file being produced, and this class
   * produces composites rather than files; see `presentedFrames` on `ExportTargetOptions` for
   * where that decision gets the information it needs to make it.
   */
  compose(): HTMLCanvasElement {
    const { source, width, height, drawFrame, presentedFrames } = this.options;
    if (presentedFrames !== undefined) {
      const count = presentedFrames();
      this.wasDuplicate = isDuplicateFrame(this.lastPresentedFrames, count);
      this.lastPresentedFrames = count;
    }
    this.ctx.drawImage(source, 0, 0, width, height);
    if (this.mark !== null) this.ctx.drawImage(this.mark, 0, 0);
    if (drawFrame !== undefined) {
      // Wrapped, so a hook cannot leak transform or composite state into the next
      // frame — see `drawFrame`. Cheap: save/restore on a 2D context is a stack push.
      this.ctx.save();
      drawFrame(this.ctx, width, height);
      this.ctx.restore();
    }
    return this.composite;
  }

  /**
   * Whether the frame `compose()` just drew is byte-identical to the one before it, because
   * the renderer's own count of presented frames did not move between the two calls.
   *
   * False when `presentedFrames` was never supplied, and false for the very first `compose()`
   * regardless — a frame nothing has been compared against yet is not a repeat of anything.
   */
  get duplicateFrame(): boolean {
    return this.wasDuplicate;
  }

  get pacing(): FramePacingReport {
    return this.pacer.report;
  }

  /** Start the measurement over, keeping the schedule. See `FramePacer`. */
  resetPacing(): void {
    this.pacer.resetMeasurement();
  }

  /** Give the surface back. Safe to call more than once. */
  release(): void {
    if (this.acquired) {
      this.options.surface.unlockDrawingBuffer();
      this.acquired = false;
    }
    // Only the track this class created. The audio the caller mixed in belongs
    // to the audio graph and must survive to be recorded again.
    this.videoTrack?.stop();
    this.videoTrack = null;
    this.stream = null;
    this.mark = null;
    /* So a caller that locks the same instance again starts with nothing to compare against,
       rather than measuring its next frame against a session that already ended. */
    this.lastPresentedFrames = null;
    this.wasDuplicate = false;
  }
}
