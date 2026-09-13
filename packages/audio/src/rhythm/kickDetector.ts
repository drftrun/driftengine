import { RHYTHM_BANDS } from './bands.ts';
import { KickCore, MIN_INTERVAL_MS, PEAK_MAX_HZ, PEAK_MIN_HZ } from './kickCore.ts';

/**
 * Live kick detection, for things that react in the moment.
 *
 * The offline analyser in `beatMap.ts` is the one an edit is cut against,
 * because it can look ahead. This is its counterpart for the running game,
 * where being a few tens of milliseconds behind the transient is imperceptible
 * and re-analysing a whole track every frame would be absurd.
 *
 * Same bands, same whitening, same gates — so "a kick" means one thing in both
 * places. A replay whose cuts disagreed with the lights in its own footage
 * would be the most confusing possible bug.
 *
 * That is now shared code rather than a claim: `kickCore.ts` holds the decision and both files
 * call it. It was a claim until 2026-08-17, and the two had drifted apart in two ways while the
 * constants still looked identical — see that module's header for what they were.
 *
 * Ported from a production music-analysis detector. Every buffer is allocated once;
 * `update` runs per frame and must not allocate.
 */

/** How fast a pulse falls back to rest, per second. */
const PULSE_DECAY = 11;

/** Envelope of a pulse of `peak` strength, `seconds` after it fired. */
export function kickPulseAfter(peak: number, seconds: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0) return peak;
  const value = peak * Math.exp(-PULSE_DECAY * seconds);
  return value < 1e-3 ? 0 : value;
}

export interface KickDetectorNodes {
  /** Full-spectrum analyser on the playing source. */
  readonly wide: AnalyserNode;
  /** Analyser at the end of a low-pass → tracking band-pass chain. */
  readonly kick: AnalyserNode;
  /** The tracking band-pass, whose centre follows the detected fundamental. */
  readonly bandpass: BiquadFilterNode;
  readonly context: BaseAudioContext;
}

const PEAK_FOLLOW = 0.25;
const PEAK_FOLLOW_TIME = 0.02;

/**
 * A decibel magnitude as linear amplitude.
 *
 * `getFloatFrequencyData` reports silence as `-Infinity`, which is 0 rather than a very small
 * number, and every real bin is a negative decibel value.
 */
function decibelsToAmplitude(db: number): number {
  return Number.isFinite(db) ? Math.pow(10, db / 20) : 0;
}

export class KickDetector {
  /*
   * **Decibels, not the byte view, and this is a correctness matter rather than a precision
   * one.** `getByteFrequencyData` maps the spectrum from `minDecibels` to `maxDecibels` onto 0
   * to 255, which defaults to a window of -100 to -30 dB. Two things follow, and both were live
   * for as long as this detector has existed. Everything above -30 dBFS pins at 255, which on a
   * loud master is most of the low end for most of the track, so the bands this decided from
   * were clipped flat and `energy` measured 1.000 in every frame of a real track. And what came
   * back was a decibel scale where the shared arithmetic is tuned for linear amplitude: on a dB
   * scale a near-silent bin reads about 0.28 rather than about 0.0001, so the masking, the
   * floors and every ratio gate were comparing quantities they were never meant for. Gates like
   * `punch > bassline * 0.55` are nearly always true once both sides are compressed into the
   * same narrow band, which is a detector with its safeguards switched off.
   *
   * `getFloatFrequencyData` is the same data in dB with no window and no clipping, and
   * `band()` converts it back to linear amplitude, which is what `beatMap.ts` measures and what
   * `kickCore.ts` is tuned against.
   *
   * Explicitly backed by an ArrayBuffer: the analyser methods refuse a view that might be over
   * shared memory, which is what a bare typed array widens to.
   */
  private readonly wideFreq: Float32Array<ArrayBuffer>;
  private readonly kickFreq: Float32Array<ArrayBuffer>;
  private readonly ranges: Record<string, readonly [number, number]>;
  private readonly kickBand: readonly [number, number];

  private peakHz = 62;
  /** The shared decision, stepped once per frame. See `kickCore.ts`. */
  private readonly core = new KickCore();
  private lastHitMs = Number.NEGATIVE_INFINITY;
  private lastUpdateMs = 0;
  /** Reused so `core.step` is handed one object rather than a fresh literal every frame. */
  private readonly bands = { sub: 0, punch: 0, sweet: 0, bassline: 0, mud: 0, lowMid: 0, high: 0 };

  /** 0–1, spiking on a kick and decaying back. What a light should follow. */
  pulse = 0;
  /** Smoothed low-end presence, for anything that wants level rather than hits. */
  energy = 0;
  /**
   * 0–1, how much low end is arriving that the bassline does not explain.
   *
   * **The one to drive a visual from, and `energy` is usually not.** `energy` is the raw sum of
   * the two lowest bands with a gain on it, which is honest about what it says and useless on
   * anything mastered loud: on a bass-heavy master it reaches its own ceiling and stays there,
   * so a consumer reading it draws a constant. Measured on a phonk track through this detector:
   * `energy` sat at 1.000 in every frame of a two-minute sample.
   *
   * This is the whitened signal the detector already computes for its own gating — the level
   * left after the bassline, the mud and the low mids are masked out of it — which is the part
   * that actually moves with the kick rather than with how loud the track is. It keeps its
   * dynamics on the same material where `energy` has none, and it is deliberately not scaled:
   * it usually runs well under 0.25, and how far a consumer opens that up is a decision about
   * its own picture rather than about the music.
   */
  level = 0;

  constructor(private readonly nodes: KickDetectorNodes) {
    this.wideFreq = new Float32Array(nodes.wide.frequencyBinCount);
    this.kickFreq = new Float32Array(nodes.kick.frequencyBinCount);

    const nyquist = nodes.context.sampleRate / 2;
    const bin = (hz: number, length: number): number =>
      Math.max(0, Math.min(length, Math.floor((hz / nyquist) * length)));

    const ranges: Record<string, readonly [number, number]> = {};
    for (const [name, band] of Object.entries(RHYTHM_BANDS)) {
      const from = bin(band.lowHz, this.wideFreq.length);
      ranges[name] = [from, Math.max(from + 1, bin(band.highHz, this.wideFreq.length))];
    }
    this.ranges = ranges;
    this.kickBand = [
      bin(PEAK_MIN_HZ, this.kickFreq.length),
      Math.max(1, bin(PEAK_MAX_HZ, this.kickFreq.length)),
    ];
  }

  /** One frame. Reads the analysers and advances the pulse. */
  update(nowMs: number): void {
    const dtSec = this.lastUpdateMs === 0 ? 1 / 60 : (nowMs - this.lastUpdateMs) / 1000;
    this.lastUpdateMs = nowMs;

    this.nodes.wide.getFloatFrequencyData(this.wideFreq);
    this.nodes.kick.getFloatFrequencyData(this.kickFreq);

    const bands = this.bands;
    bands.sub = this.band('sub');
    bands.punch = this.band('punch');
    bands.sweet = this.band('sweet');
    bands.bassline = this.band('bassline');
    bands.mud = this.band('mud');
    bands.lowMid = this.band('lowMid');
    bands.high = this.band('high');

    /*
     * Follow the track's actual kick fundamental rather than assuming one.
     * A 55 Hz 808 and an 80 Hz acoustic kick are both kicks, and a fixed
     * band-pass tuned between them hears neither well.
     */
    this.trackPeak();

    /*
     * The decision itself, shared with `beatMap.ts` — see `kickCore.ts`. It takes `dtSec`, which
     * is what makes this detector behave the same whether a consumer calls it sixty times a
     * second or a hundred and forty-four. It used to be a per-call lerp, so the same track was
     * detected differently on different displays, and differently again from the offline
     * analyser that the cuts of a replay are made against.
     */
    this.core.step(bands, dtSec, this.peakHz);

    const hit = this.core.rising && nowMs - this.lastHitMs > MIN_INTERVAL_MS;
    const onset = this.core.onset;
    const onsetFloor = this.core.onsetFloor;
    const lowSum = bands.sub + bands.punch;

    // Decay first, then let a hit override — so a hit always starts from full
    // rather than from whatever was left of the previous one.
    this.pulse = kickPulseAfter(this.pulse, dtSec);
    if (hit) {
      this.lastHitMs = nowMs;
      this.pulse = Math.min(1, 0.55 + (onset - onsetFloor) / Math.max(1e-6, onsetFloor * 3));
    }
    this.energy = Math.min(1, lowSum * 1.6);
    /* Clamped only so the documented range holds; the whitening is what keeps it well below 1
       on real material, and that is the property a consumer is reading it for. */
    this.level = Math.min(1, this.core.whitened);
  }

  /**
   * The band's RMS amplitude, which is what `beatMap.ts` measures and what `kickCore.ts` is
   * tuned against.
   *
   * **The sum of squares, not the mean of the magnitudes, and the difference is not cosmetic.**
   * `beatMap` runs a filter bank over the samples and takes the root mean square of what comes
   * out, so its numbers are the amplitude actually present in that band. A mean of per-bin
   * magnitudes is that amplitude divided by however many bins the band happens to span, which
   * changes with the FFT size and is a different quantity from the one every floor and gate here
   * was tuned on. Measured on a real track through the site: a mean gave one detected kick in
   * eight seconds, because the absolute floors sat far above a signal that had been divided by
   * the width of its own band. Parseval is the relation that puts the two back on one scale.
   */
  private band(name: string): number {
    const range = this.ranges[name];
    if (range === undefined) return 0;
    let sum = 0;
    for (let i = range[0]; i < range[1]; i++) {
      const amplitude = decibelsToAmplitude(this.wideFreq[i] ?? -Infinity);
      sum += amplitude * amplitude;
    }
    return Math.sqrt(sum);
  }

  /** Slide the band-pass toward whichever bin in the kick range is loudest. */
  private trackPeak(): void {
    let peakValue = -Infinity;
    let peakIndex = this.kickBand[0];
    for (let i = this.kickBand[0]; i < this.kickBand[1]; i++) {
      /* Compared in decibels, which is monotonic in amplitude, so the loudest bin is the same
         one either way and there is nothing to convert for an argmax. */
      const v = this.kickFreq[i] ?? -Infinity;
      if (v > peakValue) {
        peakValue = v;
        peakIndex = i;
      }
    }
    if (!Number.isFinite(peakValue)) return;

    const nyquist = this.nodes.context.sampleRate / 2;
    const hz = (peakIndex / Math.max(1, this.kickFreq.length)) * nyquist;
    const clamped = Math.min(Math.max(hz, PEAK_MIN_HZ), PEAK_MAX_HZ);
    this.peakHz += (clamped - this.peakHz) * PEAK_FOLLOW;
    this.nodes.bandpass.frequency.setTargetAtTime(
      this.peakHz,
      this.nodes.context.currentTime,
      PEAK_FOLLOW_TIME,
    );
  }
}
