/**
 * Deciding which of a render loop's frames go into a recording, and measuring
 * what came out.
 *
 * The measuring half is not diagnostics bolted on afterwards — it is half the
 * reason this module exists. A clip that "judders" has at least three possible
 * causes (the renderer missing its rate, the encoder starved of bitrate, the
 * content itself stepping unevenly) and they are indistinguishable by eye. What
 * separates them is a number: how many frames the loop produced, how many were
 * handed to the recorder, and how far apart in wall-clock time those were.
 *
 * **The schedule counts animation frames, not milliseconds, and that is the
 * whole design.** A recorder stamps each frame with the instant it arrived, and
 * the only instants a render loop can offer are its display's own — so a
 * schedule expressed in wall-clock slots asks for moments that do not exist. It
 * then takes the nearest frame either side, alternately early and late, and the
 * file holds frames of uneven duration: 13.9 ms, 20.8 ms, 13.9 ms on a 144 Hz
 * panel asked for 60 a second. Capturing every *n*-th frame instead makes every
 * gap identical by construction, which is what makes the clip play evenly.
 *
 * The rate that comes out is therefore the display's rate divided by a whole
 * number — 60 from 60 Hz, 72 from 144, 60 from 240 — rather than exactly what
 * was asked for. That is the right trade: a clip at 72 fps whose frames are
 * evenly spaced is smooth, and one at exactly 60 whose frames are not is the
 * defect this replaced.
 *
 * Two rules the schedule follows, both learned from what a stutter looks like:
 *
 * - **Never two captures for one animation frame.** A duplicated frame is a
 *   frozen instant followed by a double-length step, which reads as a hitch
 *   even though nothing was dropped. Counting frames makes this true by
 *   construction.
 * - **After falling behind, resume — do not catch up.** Firing twice in quick
 *   succession to make up a missed slot converts one gap into a lurch forward.
 *   A gap is a frame nobody notices; a lurch is the artefact everybody calls
 *   lag.
 */
export interface FramePacingReport {
  readonly targetFps: number;
  /** Animation frames the loop produced while the pacer was running. */
  readonly rendered: number;
  /** Frames handed to the recorder. */
  readonly captured: number;
  /** Frames per second actually captured, over the whole run. */
  readonly capturedFps: number;
  /** Mean wall-clock gap between captured frames, ms. */
  readonly meanGapMs: number;
  /** The worst single gap, ms — the one the eye actually notices. */
  readonly worstGapMs: number;
  /**
   * Captures that arrived well outside the cadence the rest of the clip holds.
   *
   * Measured against the clip's *own* spacing rather than against the requested
   * rate, because the two are allowed to differ: a display that divides to 72 fps
   * or a loop that can only manage 40 both produce a clip whose every frame is
   * evenly spaced, and neither is a fault. What is a fault is one frame taking
   * half again as long as its neighbours, and that is what this counts.
   */
  readonly slipped: number;
  /** Animation frames per capture — the schedule the clip actually ran on. */
  readonly stride: number;
  readonly elapsedMs: number;
}

/**
 * How far outside the established cadence a gap has to fall to count as slipped.
 * A little over one gap, so ordinary display jitter is not reported as a fault.
 */
const SLIP_FACTOR = 1.4;
/** Weight of the newest gap in the cadence estimate. */
const CADENCE_EMA = 0.15;
/**
 * Animation frames the interval estimate is taken over.
 *
 * Sixteen: a quarter of a second at 60 Hz, which is long enough to absorb one bad
 * sample and short enough that the schedule is settled before anything is recorded.
 * The estimate is re-taken every time the window fills, so a loop that gets heavier
 * mid-clip is followed rather than held to a schedule it can no longer keep.
 */
const SAMPLE_WINDOW = 16;
/**
 * Slack in the stride calculation, as a share of the ratio being floored.
 *
 * Half a percent, and it is small because the estimator earns it. A 60 Hz display
 * asked for 30 fps wants a stride of exactly 2, and a measured interval of 16.6668 ms
 * gives a ratio of 1.99998 — so a bare `floor` answers 1 and doubles the rate. That
 * is the entire job: cover a measurement that lands a hair long, and floating point.
 *
 * It was five percent while the estimate came from a median, which sits *above* the
 * display's period and needed the room. A trimmed minimum sits at or just below it,
 * so the ratio errs high already and slack on top only pushes it over the next
 * boundary the wrong way: measured at five percent, a 100 Hz panel asked for 60
 * sometimes recorded 50 instead of 100, because a jittery window read the period as
 * 8.6 ms and 1.94 became 2.03.
 */
const STRIDE_SLACK = 0.005;
/**
 * How far past its boundary the measurement has to move before the stride changes,
 * in whole strides.
 *
 * A fifth, and this is the part slack alone could not do. The stride is a *discrete*
 * choice, so a ratio sitting near a boundary flips it on the noise in the estimate —
 * and a flip between 1 and 2 doubles the clip's frame rate. Measured on a loop with
 * 24% frame-time jitter and a true ratio of exactly 2.0: the median of a
 * sixteen-frame window wanders between 16.7 ms and 18.3 ms, which is a ratio between
 * 2.0 and 1.82, and the stride flipped five times in a ten-second clip.
 *
 * A display's period does not change, so the right default is to keep the schedule
 * already chosen and demand real evidence to leave it. A fifth of a stride is well
 * past what a median of sixteen frames is wrong by and well short of a genuine step.
 */
const STRIDE_HYSTERESIS = 0.2;

/**
 * Animation frames per capture, given the target interval, what one animation frame
 * actually costs, and the schedule already running.
 *
 * Rounded down, so the rate that comes out is never *below* the one asked for while
 * the loop can hold it: a 100 Hz display asked for 60 records 100 rather than 50,
 * which is more frames than needed and smooth, where the other way round is fewer
 * frames than promised.
 *
 * `current` is held on to unless the measurement has moved clearly past its
 * boundary — see `STRIDE_HYSTERESIS`. Pass 0 to choose freely.
 */
function strideFor(targetIntervalMs: number, frameIntervalMs: number, current = 0): number {
  if (!(frameIntervalMs > 0)) return Math.max(1, current);
  const scaled = (targetIntervalMs / frameIntervalMs) * (1 + STRIDE_SLACK);
  if (
    current > 0 &&
    scaled >= current - STRIDE_HYSTERESIS &&
    scaled < current + 1 + STRIDE_HYSTERESIS
  ) {
    return current;
  }
  return Math.max(1, Math.floor(scaled));
}

/**
 * Second-smallest of `values`, sorted into `scratch`.
 *
 * **A trimmed minimum, and the choice of statistic is the whole point.** What is
 * being estimated is the display's period, and that is a *floor* on how long an
 * animation frame can take — a frame cannot come back sooner than the next vsync, it
 * can only take longer and land on a later one. So the low end of the distribution is
 * where the answer lives, and the mean and the median are both biased above it by
 * however hard the loop is working.
 *
 * Which matters because the estimate feeds a `floor`: a stride of 2 asks whether the
 * ratio is above or below 2, and an estimator that wanders either side of the answer
 * flips the clip's frame rate. Measured with a median of sixteen: on a loop with 24%
 * frame-time jitter and a true ratio of exactly 2, the median wandered between
 * 16.7 ms and 18.3 ms and the stride flipped, taking a 30 fps request to 36.
 *
 * Second-smallest rather than smallest because the minimum has no defence at all
 * against a bad sample — two callbacks in one frame, a clock that jumped, a tab
 * waking up — and one of those in a window would set a stride far too long. One
 * anomaly per sixteen frames is absorbed; two in the same window is not, which is a
 * trade rather than an oversight.
 *
 * Insertion sort into a caller-owned buffer, because this runs inside a render loop
 * and must not allocate. Sixteen elements nearly in order is a handful of
 * comparisons; the general case is still trivial at this size.
 */
function trimmedMinimum(values: Float64Array, scratch: Float64Array): number {
  const n = values.length;
  for (let i = 0; i < n; i++) {
    const value = values[i] ?? 0;
    let j = i - 1;
    while (j >= 0 && (scratch[j] ?? 0) > value) {
      scratch[j + 1] = scratch[j] ?? 0;
      j--;
    }
    scratch[j + 1] = value;
  }
  return scratch[Math.min(1, n - 1)] ?? 0;
}

export class FramePacer {
  private readonly intervalMs: number;
  /** Animation frames per capture. One until the loop's own rate is known. */
  private strideFrames = 1;
  private framesSinceCapture = 0;
  private startMs = 0;
  private lastCaptureMs = 0;
  /**
   * What one animation frame costs, ms — a trimmed minimum over a recent window.
   *
   * See `trimmedMinimum` for why the low end and not the middle. Three estimators
   * were tried before it and each failed in a way worth recording: a running minimum
   * over all time ratcheted down on anomalies until a clean 120 Hz loop recorded
   * **24 fps**; a mean was dragged up by every overrunning frame, doubling the rate
   * for the thirty frames an average takes to decay after one hitch; a median sat too
   * far above the floor and wandered across the stride boundary.
   */
  private frameIntervalMs = 0;
  /** Recent animation-frame intervals, and a scratch buffer to sort them in. */
  private readonly samples = new Float64Array(SAMPLE_WINDOW);
  private readonly sorted = new Float64Array(SAMPLE_WINDOW);
  private sampleCount = 0;
  /** The instant last seen, so a frame is only ever counted once. */
  private lastSeenMs = 0;
  private seen = false;
  /** Rolling estimate of the gap the clip is actually holding, for `slipped`. */
  private cadenceMs = 0;
  private renderedFrames = 0;
  private capturedFrames = 0;
  private gapSumMs = 0;
  private worstGapMs = 0;
  private slippedFrames = 0;
  private started = false;

  constructor(readonly targetFps: number) {
    this.intervalMs = 1000 / Math.max(targetFps, 1);
  }

  /**
   * Whether this animation frame is one the recording wants, without committing.
   *
   * The query half of `offer`, and it exists so a caller can decide *before
   * rendering* whether the frame it is about to draw will be kept. A renderer that
   * draws every animation frame and then discards most of them spends its whole
   * budget competing with the frame it means to keep.
   *
   * Called once per animation frame, before drawing. That is also where the loop's
   * own interval is measured, since it is the only call that sees every frame:
   * `offer` only sees the ones that were drawn.
   *
   * Allocation-free: this is called from inside a render loop.
   */
  due(nowMs: number): boolean {
    this.observe(nowMs);
    if (!this.started) return true;
    return this.framesSinceCapture >= this.strideFrames;
  }

  /**
   * Commit to the frame `due` was asked about.
   *
   * **`nowMs` must be the instant `due` was given, not the instant the frame
   * finished drawing.** Both halves have to agree about when the frame is, or a
   * frame is counted twice — once on the way in and once on the way out — and the
   * loop's measured interval comes out at half its true value.
   *
   * A caller with nothing to gate may pass whatever clock it has, as long as it is
   * the same one every frame.
   */
  offer(nowMs: number): boolean {
    this.observe(nowMs);
    if (!this.started) {
      this.started = true;
      this.startMs = nowMs;
      this.lastCaptureMs = nowMs;
      this.framesSinceCapture = 0;
      this.capturedFrames = 1;
      return true;
    }

    if (this.framesSinceCapture < this.strideFrames) return false;

    const gap = nowMs - this.lastCaptureMs;
    this.gapSumMs += gap;
    if (gap > this.worstGapMs) this.worstGapMs = gap;
    // Against the cadence so far, and only once there is one to compare with.
    if (this.cadenceMs > 0 && gap > this.cadenceMs * SLIP_FACTOR) this.slippedFrames++;
    this.cadenceMs =
      this.cadenceMs === 0 ? gap : this.cadenceMs + (gap - this.cadenceMs) * CADENCE_EMA;
    this.lastCaptureMs = nowMs;
    this.framesSinceCapture = 0;
    this.capturedFrames++;
    return true;
  }

  /** One animation frame seen, for the interval estimate and the frame count. */
  private observe(nowMs: number): void {
    if (this.seen && nowMs === this.lastSeenMs) return;
    const since = this.seen ? nowMs - this.lastSeenMs : 0;
    this.lastSeenMs = nowMs;
    this.seen = true;
    this.renderedFrames++;
    if (this.started) this.framesSinceCapture++;
    if (since <= 0) return;

    this.samples[this.sampleCount % SAMPLE_WINDOW] = since;
    this.sampleCount++;
    /*
     * Until there is a window to take a median of, the estimate is the *shortest*
     * frame seen so far. A schedule is needed before sixteen frames have passed — a
     * recording that waited would capture all sixteen of them, a burst at the head of
     * every clip — and of the estimators available before then the minimum is the one
     * that errs the safe way: it reads the loop as faster than it is, which makes the
     * stride longer and captures *fewer* frames than intended rather than more.
     *
     * The minimum's own failing, that one anomalous frame owns it for good, cannot
     * bite here: sixteen frames later the median takes over and never gives it back.
     */
    if (this.sampleCount < SAMPLE_WINDOW) {
      if (this.frameIntervalMs === 0 || since < this.frameIntervalMs) {
        this.frameIntervalMs = since;
        this.strideFrames = strideFor(this.intervalMs, since);
      }
      return;
    }
    /*
     * Re-taken when the window fills rather than on every frame: sorting sixteen
     * numbers is cheap but this is a render loop, and a display's period does not
     * change between one frame and the next.
     */
    if (this.sampleCount % SAMPLE_WINDOW !== 0) return;
    this.frameIntervalMs = trimmedMinimum(this.samples, this.sorted);
    this.strideFrames = strideFor(this.intervalMs, this.frameIntervalMs, this.strideFrames);
  }

  /**
   * Forget what has been measured, keep the schedule.
   *
   * For a recording with a warm-up in front of it: the frames a device spends
   * getting an encoder and a driver going are genuinely awful — measured at 411 ms
   * and 503 ms for a 1080x1920 clip — and they are not what the clip is like. Left in
   * the report they become the worst gap and a couple of slipped frames, which is the
   * evidence an export decides whether to warn the player on.
   *
   * The schedule survives on purpose: it was chosen from those same frames and it is
   * still right.
   */
  resetMeasurement(): void {
    this.startMs = this.lastCaptureMs;
    this.capturedFrames = 1;
    this.renderedFrames = 0;
    this.gapSumMs = 0;
    this.worstGapMs = 0;
    this.slippedFrames = 0;
    this.cadenceMs = 0;
  }

  get report(): FramePacingReport {
    const elapsedMs = this.started ? Math.max(this.lastCaptureMs - this.startMs, 0) : 0;
    const gaps = Math.max(this.capturedFrames - 1, 0);
    return {
      targetFps: this.targetFps,
      rendered: this.renderedFrames,
      captured: this.capturedFrames,
      capturedFps: elapsedMs > 0 ? (gaps * 1000) / elapsedMs : 0,
      meanGapMs: gaps > 0 ? this.gapSumMs / gaps : 0,
      worstGapMs: this.worstGapMs,
      slipped: this.slippedFrames,
      stride: this.strideFrames,
      elapsedMs,
    };
  }
}
