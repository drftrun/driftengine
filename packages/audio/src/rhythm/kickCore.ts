/**
 * What a kick is, in one place.
 *
 * Two analysers decide it: `beatMap.ts` offline, where an edit is cut, and `kickDetector.ts`
 * live, where a light flashes. Their headers have always claimed the same bands, the same
 * whitening and the same gates, because a replay whose cuts disagree with the lights in its own
 * footage is the most confusing possible bug. They were two copies of that claim, and two copies
 * drift: by the time this module was written they disagreed in two ways that a reader comparing
 * the constants would not have seen.
 *
 *  - **Whitening.** Offline it was `kickBand - mask`; live it was `rms * 0.6 + kickBand * 0.6 -
 *    mask`, a different quantity with a term the offline path has no equivalent for.
 *  - **Time.** Every envelope was a fixed per-*step* lerp, and the two step at different rates:
 *    a 5 ms hop offline, one call per rendered frame live. The same constant `0.1` is therefore
 *    a 47 ms time constant in one and a 158 ms time constant in the other, and live it also
 *    changed with the consumer's frame rate, so the same track detected differently on a 60 Hz
 *    screen and a 144 Hz one.
 *
 * So the shared part lives here and both call it. The envelopes take a `dtSec` and smooth in
 * *time* rather than per step, which is what makes one set of constants mean one thing at any
 * rate. The rates are derived from the offline hop the constants were tuned at, so the offline
 * analyser is unchanged to the last bit and the live one moves onto its terms.
 *
 * What stays outside: how the bands are measured (an FFT hop offline, an `AnalyserNode` live),
 * peak picking and tempo, which need to look forward, and the pulse envelope, which is a
 * lighting concern rather than a detection one.
 */

/** The seven band levels a kick is decided from, each 0 to 1. */
export interface KickBands {
  readonly sub: number;
  readonly punch: number;
  readonly sweet: number;
  readonly bassline: number;
  readonly mud: number;
  readonly lowMid: number;
  readonly high: number;
}

/**
 * The step the constants below were tuned at: `beatMap.ts`'s own analysis hop.
 *
 * Every rate is derived from this, so a smoothing factor written as "per hop" keeps meaning
 * exactly what it meant when it was chosen, and a caller stepping at any other interval gets the
 * same curve in time rather than a different one.
 */
const REFERENCE_STEP_SEC = 0.005;

/** A per-step factor at the reference hop, as a rate per second. */
function ratePerSecond(perStep: number): number {
  return -Math.log(1 - perStep) / REFERENCE_STEP_SEC;
}

/** Envelope smoothing, named for what it follows. Written per hop, applied in time. */
const ONSET_FAST_RATE = ratePerSecond(0.62);
const ONSET_SLOW_RATE = ratePerSecond(0.1);
const FLOOR_MEAN_RATE = ratePerSecond(0.012);
const FLOOR_DEV_RATE = ratePerSecond(0.04);
const TRANSIENT_MEAN_RATE = ratePerSecond(0.016);
const TRANSIENT_DEV_RATE = ratePerSecond(0.05);

/** How much of the low end a sustained bassline is allowed to explain away. */
const MASK_BASSLINE = 0.68;
const MASK_MUD = 0.22;
const MASK_LOW_MID = 0.08;
const MASK_SCALE = 0.55;

/** Floors, as a minimum and as a multiple of the signal's own deviation. */
const ENERGY_FLOOR_MIN = 0.0028;
const ENERGY_FLOOR_DEV = 1.05;
const ONSET_FLOOR_MIN = 0.0009;
const ONSET_FLOOR_DEV = 1.35;

/** Shape gates. Each rejects something loud that is not a kick. */
const PUNCH_OVER_BASSLINE = 0.55;
const SUB_OVER_MUD = 0.24;
const LOW_SHARE_MIN = 0.18;
const BASS_DOMINANCE_MIN = 0.55;

/** Ignore a rise this soon after the last one — one hit is one pulse. */
export const MIN_INTERVAL_MS = 74;

/** Where a kick's fundamental may sit. Outside this it is not a kick drum. */
export const PEAK_MIN_HZ = 45;
export const PEAK_MAX_HZ = 95;

/**
 * How much of an envelope's remaining distance to cover in `dtSec`.
 *
 * Zero for a step that did not advance and one for a step long enough that whatever was held is
 * stale, which is the right answer to a backgrounded tab: snap to what is true now rather than
 * ease from a value that describes a minute ago.
 */
function approach(rate: number, dtSec: number): number {
  if (!(dtSec > 0)) return 0;
  return 1 - Math.exp(-rate * dtSec);
}

/**
 * The running state both analysers keep, advanced one step at a time.
 *
 * Allocation-free after construction: `step` writes fields and returns nothing, because the live
 * path calls it every frame.
 */
export class KickCore {
  private onsetFast = 0;
  private onsetSlow = 0;
  private lowBandMean = 0;
  private lowBandDev = 0;
  private transientMean = 0;
  private transientDev = 0;
  private prevSub = 0;
  private prevPunch = 0;

  /** The kick band with the bassline's contribution taken out of it. */
  whitened = 0;
  /** How much of that arrived just now rather than being present. */
  onset = 0;
  /** Energy that *arrived* in the kick bands, rather than energy that is there. */
  flux = 0;
  /** The adaptive thresholds `onset` and `whitened` have to clear. */
  onsetFloor = 0;
  energyFloor = 0;
  /** Whether the spectral shape is kick-like at all, before any threshold. */
  shaped = false;

  /**
   * One step. `dtSec` is how long it covers, which is the hop offline and the frame time live.
   *
   * `peakHz` is the tracked fundamental where a caller has one; the offline path has no
   * band-pass to track and passes the centre of the allowed range, which is the same as saying
   * it does not use this gate.
   */
  step(bands: KickBands, dtSec: number, peakHz: number = (PEAK_MIN_HZ + PEAK_MAX_HZ) / 2): void {
    const { sub, punch, sweet, bassline, mud, lowMid, high } = bands;

    /*
     * Whitening: the kick band minus what a sustained bassline contributes to it. This is the
     * step that turns "the low end is loud" — true for the whole track — into "something just
     * hit", true for a few steps.
     */
    const kickBand = sub * 0.35 + punch * 0.45 + sweet * 0.2;
    const mask = bassline * MASK_BASSLINE + mud * MASK_MUD + lowMid * MASK_LOW_MID;
    this.whitened = Math.max(0, kickBand - mask * MASK_SCALE);

    this.onsetFast += (this.whitened - this.onsetFast) * approach(ONSET_FAST_RATE, dtSec);
    this.onsetSlow += (this.whitened - this.onsetSlow) * approach(ONSET_SLOW_RATE, dtSec);
    this.onset = Math.max(0, this.onsetFast - this.onsetSlow);

    /*
     * A decaying kick has plenty of energy present and none arriving, which is what keeps one
     * hit one beat.
     */
    this.flux = Math.max(0, sub - this.prevSub) * 0.58 + Math.max(0, punch - this.prevPunch) * 0.42;
    this.prevSub = sub;
    this.prevPunch = punch;

    /*
     * Adaptive floors, so the same analyser works on tracks mastered ten decibels apart — which
     * matters the moment somebody imports their own.
     */
    this.lowBandMean += (this.whitened - this.lowBandMean) * approach(FLOOR_MEAN_RATE, dtSec);
    this.lowBandDev +=
      (Math.abs(this.whitened - this.lowBandMean) - this.lowBandDev) *
      approach(FLOOR_DEV_RATE, dtSec);

    const transientSignal = this.onset + this.flux * 0.18;
    this.transientMean +=
      (transientSignal - this.transientMean) * approach(TRANSIENT_MEAN_RATE, dtSec);
    this.transientDev +=
      (Math.abs(transientSignal - this.transientMean) - this.transientDev) *
      approach(TRANSIENT_DEV_RATE, dtSec);

    this.energyFloor =
      this.lowBandMean + Math.max(ENERGY_FLOOR_MIN, this.lowBandDev * ENERGY_FLOOR_DEV);
    this.onsetFloor =
      this.transientMean + Math.max(ONSET_FLOOR_MIN, this.transientDev * ONSET_FLOOR_DEV);

    const lowSum = sub + punch;
    const lowShare = lowSum / Math.max(1e-6, lowSum + bassline + mud + lowMid + high);
    const percussiveBody = lowMid * 0.72 + high * 0.58;
    const bassDominance = (sub * 0.62 + punch * 0.38) / Math.max(1e-6, percussiveBody + mud * 0.45);

    this.shaped =
      punch > bassline * PUNCH_OVER_BASSLINE &&
      sub > mud * SUB_OVER_MUD &&
      lowShare > LOW_SHARE_MIN &&
      bassDominance > BASS_DOMINANCE_MIN &&
      peakHz >= PEAK_MIN_HZ &&
      peakHz <= PEAK_MAX_HZ;
  }

  /** Whether this step is a hit, ignoring how recently the last one was. */
  get rising(): boolean {
    return this.shaped && this.onset > this.onsetFloor && this.whitened > this.energyFloor;
  }
}
