import { RHYTHM_BANDS, createBandEnergies } from './bands.ts';
import type { BandEnergies } from './bands.ts';
import { KickCore } from './kickCore.ts';

/**
 * Offline rhythm analysis: where the kicks are in a whole track.
 *
 * Computed once, ahead of time, from decoded samples. That is the important
 * difference from a live detector, and it buys three things a live one cannot:
 *
 *   1. **Cuts land on the beat.** A real-time detector necessarily fires
 *      *after* the transient it is detecting, and by a varying amount. Offline
 *      we can look ahead — pick the peak of the onset curve and then walk back
 *      to where the transient actually began, which is a fixed reference rather
 *      than "whenever the level happened to cross a threshold".
 *   2. **Determinism.** Two people watching the same shared run see the same
 *      edit, and the same run watched twice is identical. Nothing here reads a
 *      clock or `Math.random`.
 *   3. **Structure.** Choosing where to spend the best shot needs to see the
 *      whole track. Real-time analysis by definition cannot.
 *
 * The detection is ported from a production kick detector, whose central idea is
 * *whitening*: in bass-led electronic music the low end is dominated by a sustained
 * 808, so raw low energy is loud all the time and useless. Subtract a weighted
 * bassline/mud/low-mid mask from the kick band and take the difference between
 * a fast and a slow envelope, and only the transient survives.
 */
export interface BeatMap {
  /**
   * Detected kick onsets in seconds, ascending. These are the hits the
   * analyser is *sure* about — deliberately not every beat in the track.
   */
  readonly beats: Float32Array;
  /** 0–1 per detected beat, for weighting cuts and flashes. */
  readonly strength: Float32Array;
  readonly bpm: number;
  /** 0–1. Low means the hits are real but irregular — a rubato passage. */
  readonly bpmConfidence: number;
  /** Coarse loudness envelope, for finding drops and quiet passages. */
  readonly energy: Float32Array;
  readonly energyHz: number;
  readonly durationSec: number;
}

/**
 * Analysis hop. 5 ms is a fifth of the placement tolerance and coarse enough
 * that a three-minute track is under a tenth of a second of work.
 */
const HOP_SEC = 0.005;
/** Energy envelope resolution, for structure rather than for timing. */
const ENERGY_HZ = 10;
/**
 * Refractory period, from the prior art. A kick's body rings for longer than
 * this, and without it one hit is reported three times.
 */
const MIN_INTERVAL_SEC = 0.074;
/**
 * Half-width of the peak-picking window, in hops (±40 ms).
 *
 * A candidate must be the largest onset within this window. Wider merges
 * genuinely separate kicks at fast tempos; narrower lets a ringing tail count
 * as its own peak, which is how one hit became two beats 64 ms apart in the
 * first working version.
 */
const PEAK_WINDOW_HOPS = 8;
/**
 * Where a transient is considered to have *started*, as a fraction of its peak.
 *
 * Reporting the peak itself is late and, worse, late by an amount that varies
 * with how sharp the hit is — soft kicks land tens of milliseconds behind hard
 * ones, so an edit drifts against its own music. Walking back to a fixed
 * fraction of the peak gives the same reference point for every hit.
 */
const ONSET_BACKTRACK = 0.35;
/**
 * Minimum strength for a beat to be reported at all.
 *
 * A transient that barely clears its own adaptive floor is indistinguishable
 * from the track breathing, and its *timing* is correspondingly vague — the
 * peak is broad, so the reported instant wanders. Nothing downstream would cut
 * on one anyway, since the director weights by strength.
 */
const MIN_STRENGTH = 0.03;
/** Plausible tempo range. Outside it the estimate is a harmonic, not a tempo. */
const MIN_BPM = 60;
const MAX_BPM = 200;

/*
 * The smoothing, whitening, floors and shape gates moved to `kickCore.ts`, which `kickDetector`
 * now shares with this file. They were the same numbers in both, applied at different rates and
 * to a different whitening — see that module's header. The hop below is the step they were tuned
 * at and is what the core's own rates are derived from, so nothing about this file's output
 * moved when they left it.
 */

/** How much of each masking band is subtracted from the kick band. */

/**
 * Settling time before any beat may be reported.
 *
 * Every filter and running mean starts at zero, so the first hop of any track
 * looks like an enormous transient against a floor of nothing — a guaranteed
 * false beat at the start of every song, including one that opens with four
 * bars of silence. The curves are built over a warm-up prefix first and that
 * prefix is then discarded, so a genuine downbeat at 0 is still found.
 */
const WARMUP_SEC = 0.5;

/** A map with no beats in it, for when there is no music to analyse. */
export function emptyBeatMap(durationSec = 0): BeatMap {
  return {
    beats: new Float32Array(0),
    strength: new Float32Array(0),
    bpm: 0,
    bpmConfidence: 0,
    energy: new Float32Array(0),
    energyHz: ENERGY_HZ,
    durationSec,
  };
}

export function analyseTrack(samples: Float32Array, sampleRate: number): BeatMap {
  const durationSec = samples.length / sampleRate;
  const curves = buildCurves(samples, sampleRate);
  const { beats, strength } = pickPeaks(curves);
  const { bpm, confidence } = estimateTempo(beats);

  return {
    beats: Float32Array.from(beats),
    strength: Float32Array.from(strength),
    bpm,
    bpmConfidence: confidence,
    energy: curves.energy,
    energyHz: ENERGY_HZ,
    durationSec,
  };
}

interface Curves {
  /** Whitened transient strength per hop. */
  readonly onset: Float32Array;
  /** Adaptive threshold per hop. */
  readonly floor: Float32Array;
  /** Whether the spectral shape at this hop is kick-like at all. */
  readonly shaped: Uint8Array;
  readonly energy: Float32Array;
  readonly hopSec: number;
}

/**
 * One pass over the samples, producing the curves peak-picking works on.
 *
 * Separated from peak-picking because they want opposite things: this is
 * causal and streaming, that one needs to look forward and backward. Trying to
 * do both at once is what produces a detector that fires on the wrong edge.
 */
function buildCurves(samples: Float32Array, sampleRate: number): Curves {
  const hopSamples = Math.max(1, Math.round(sampleRate * HOP_SEC));
  const hops = Math.max(1, Math.floor(samples.length / hopSamples));
  const warmupHops = Math.min(hops, Math.round(WARMUP_SEC / HOP_SEC));

  const filters = createBandFilters(sampleRate);
  const energies = createBandEnergies();

  const onset = new Float32Array(hops);
  const floor = new Float32Array(hops);
  const shaped = new Uint8Array(hops);
  const energyHops = Math.max(1, Math.round(1 / (ENERGY_HZ * HOP_SEC)));
  const energy = new Float32Array(Math.max(1, Math.ceil(hops / energyHops)));

  /* Every running mean, envelope and gate this analyser shares with the live detector. */
  const core = new KickCore();
  let energyAccum = 0;
  let energyCount = 0;
  let energyIndex = 0;

  // Warm-up runs the same maths over the opening prefix and throws the results
  // away, leaving the filters and running means settled for the real pass.
  for (let pass = 0; pass < warmupHops + hops; pass++) {
    const settling = pass < warmupHops;
    const hop = settling ? pass : pass - warmupHops;
    const start = hop * hopSamples;
    measureBands(samples, start, hopSamples, filters, energies);

    const { sub, punch, sweet, bassline, mud, lowMid, high } = energies;

    if (!settling) {
      energyAccum += sub + punch + bassline + mud + lowMid + high;
      energyCount++;
      if (energyCount >= energyHops && energyIndex < energy.length) {
        energy[energyIndex++] = energyAccum / energyCount;
        energyAccum = 0;
        energyCount = 0;
      }
    }

    /*
     * The shared decision: whitening, onset, flux, the adaptive floors and the shape gates, all
     * in `kickCore.ts` so that a kick means the same thing here and in `kickDetector.ts`. The
     * hop is what the core smooths over, which is what its own constants were tuned at.
     */
    core.step(energies, HOP_SEC);

    if (settling) continue;

    /*
     * The offline path's own extra condition on top of the shared shape gates: the whitened
     * level has to clear its own floor as well. Live, that is one of the two threshold tests
     * `KickCore.rising` makes; here it belongs with the shape because peak picking applies the
     * onset threshold itself, a few lines further on, against a curve it can look along.
     */
    const kickLike = core.shaped && core.whitened > core.energyFloor;

    onset[hop] = core.onset;
    floor[hop] = core.onsetFloor;
    shaped[hop] = kickLike ? 1 : 0;
  }

  if (energyCount > 0 && energyIndex < energy.length) {
    energy[energyIndex] = energyAccum / energyCount;
  }

  return { onset, floor, shaped, energy, hopSec: HOP_SEC };
}

/**
 * Turn the onset curve into beat times.
 *
 * A beat is a local maximum of the onset that clears its adaptive floor and is
 * shaped like a kick. Reporting the peak itself would be late by an amount that
 * varies with how sharp the hit is, so the time is walked back to where the
 * transient crossed a fixed fraction of that peak — the same reference point
 * for a soft kick and a hard one.
 */
function pickPeaks(curves: Curves): { beats: number[]; strength: number[] } {
  const { onset, floor, shaped, hopSec } = curves;
  const beats: number[] = [];
  const strength: number[] = [];
  let lastBeatSec = -Infinity;

  for (let hop = 0; hop < onset.length; hop++) {
    if (shaped[hop] !== 1) continue;
    const value = onset[hop] ?? 0;
    const threshold = floor[hop] ?? 0;
    if (value <= threshold) continue;

    // Must be the largest onset nearby, or a ringing tail counts as its own hit.
    let isPeak = true;
    const from = Math.max(0, hop - PEAK_WINDOW_HOPS);
    const to = Math.min(onset.length - 1, hop + PEAK_WINDOW_HOPS);
    for (let i = from; i <= to; i++) {
      if (i === hop) continue;
      const other = onset[i] ?? 0;
      // Ties go to the earlier hop, so a plateau reports its leading edge.
      if (other > value || (other === value && i < hop)) {
        isPeak = false;
        break;
      }
    }
    if (!isPeak) continue;

    // Walk back to the start of the rise.
    let onsetHop = hop;
    const target = value * ONSET_BACKTRACK;
    while (onsetHop > from && (onset[onsetHop - 1] ?? 0) > target) onsetHop--;

    const atSec = onsetHop * hopSec;
    if (atSec - lastBeatSec <= MIN_INTERVAL_SEC) continue;

    // How far past its own floor the transient reached, which scales with the
    // track rather than with an absolute level.
    const power = Math.min(1, (value - threshold) / Math.max(1e-6, threshold * 4));
    if (power < MIN_STRENGTH) continue;

    lastBeatSec = atSec;
    beats.push(atSec);
    strength.push(power);
  }

  return { beats, strength };
}

/**
 * The most beats a gap between two reported ones may span, and how near a whole
 * number of beats it has to land to count as one.
 */
const MAX_SPANNED_BEATS = 4;
const SPAN_TOLERANCE = 0.12;

/**
 * How many beats an interval spans, or 0 when it is not a whole number of them.
 *
 * The analyser reports the hits it is sure of, so a gap between two of them is
 * one beat or several, and deciding which is a single question asked in one
 * place: the tempo estimate folds an interval down by this number, and the
 * confidence count tests regularity with it. Two copies of the rule would agree
 * until the first time either was tuned.
 */
function spannedBeats(interval: number, beat: number): number {
  const ratio = interval / beat;
  const nearest = Math.round(ratio);
  if (nearest < 1 || nearest > MAX_SPANNED_BEATS) return 0;
  return Math.abs(ratio - nearest) <= SPAN_TOLERANCE ? nearest : 0;
}

/**
 * Tempo from the gaps between the beats that were reported.
 *
 * The reported beats are the hits the analyser is sure of and deliberately not
 * every beat in the track, so a gap between two of them is a whole number of
 * beats rather than one. Both steps below follow from that: the beat is chosen
 * as the gap that accounts for the most others, and every gap is then folded
 * down to a single beat before the median is taken.
 *
 * A statistic over the raw gaps cannot work however it is chosen, and a mean is
 * not the only thing this rules out. The gaps form one cluster per number of
 * beats skipped, so a mean sits between clusters and a median sits at the edge
 * of one — neither lands on a beat, and the error grows with the share of
 * beats missed rather than staying small.
 *
 * Confidence is the share of gaps that are a whole number of beats. Low
 * confidence means the hits are real but do not lie on one pulse, which is a
 * signal a caller should use rather than an error — and it is also the honest
 * reading when the track has no single tempo.
 *
 * **What this cannot do**: separate a track counted at every other kick from
 * one played at half the speed. Their gaps are identical, so nothing here can
 * tell them apart, and such a track is reported at half its tempo with full
 * confidence. It takes alternate kicks about 15 dB down to reach that state.
 * The evidence that would settle it is not in the beat list and is not usably
 * in the onset curve either — measured, the missing kick sits below the floor
 * that would report it; `docs/IMPROVEMENTS.md` carries both numbers.
 */
function estimateTempo(beats: readonly number[]): { bpm: number; confidence: number } {
  if (beats.length < 3) return { bpm: 0, confidence: 0 };

  const intervals: number[] = [];
  for (let i = 1; i < beats.length; i++) {
    intervals.push((beats[i] ?? 0) - (beats[i - 1] ?? 0));
  }
  const sorted = [...intervals].sort((a, b) => a - b);

  /*
   * The beat is the gap that accounts for the most other gaps.
   *
   * Taking the middle of the set instead is what this replaces, and it is wrong
   * for a reason no amount of tuning reaches: every interval is a whole number
   * of beats, so the set has one cluster per number of beats skipped, and its
   * middle falls at the top of one cluster or the foot of the next rather than
   * on a beat. Measured on synthetic tracks whose kicks are two in three, that
   * put four tempos of six at *exactly half* their true value, and a fully
   * detected 140 counted 2.6% slow.
   *
   * Scoring every observed gap as a candidate is what makes it robust rather
   * than merely better placed. A single unrepresentative gap — a ghost hit
   * close behind a real one, or one straddling a tempo change — explains
   * nothing but itself and loses; picking a fixed quantile cannot tell the two
   * apart, and a 128 read that way came out at 112 off one gap of 1.14 beats.
   *
   * Ties go to the longer candidate: within one cluster the choice moves the
   * base by less than the tolerance and the median below settles the value.
   *
   * The cost is a pass over the gaps per gap. This runs once per track, off the
   * frame loop, and a ten-minute track at 174 counts under two million steps.
   * What would make it wrong is calling it per frame, which is what the live
   * detector exists for.
   */
  let base = 0;
  let explainedByBase = -1;
  for (const candidate of sorted) {
    if (candidate <= 0) continue;
    let explained = 0;
    for (const interval of intervals) {
      if (spannedBeats(interval, candidate) > 0) explained++;
    }
    if (explained >= explainedByBase) {
      explainedByBase = explained;
      base = candidate;
    }
  }
  if (base <= 0) return { bpm: 0, confidence: 0 };

  /*
   * The base decides only how the gaps group; the median of what they fold to
   * decides the tempo, so a base a hop or two off its cluster costs nothing.
   */
  const folded: number[] = [];
  for (const interval of intervals) {
    const spanned = spannedBeats(interval, base);
    if (spanned > 0) folded.push(interval / spanned);
  }
  folded.sort((a, b) => a - b);
  const median = folded[folded.length >> 1] ?? base;
  if (median <= 0) return { bpm: 0, confidence: 0 };

  let bpm = 60 / median;
  // Fold octave errors back into a plausible range: catching every other kick
  // reads as half tempo, and catching both hits of a double reads as twice it.
  while (bpm < MIN_BPM) bpm *= 2;
  while (bpm > MAX_BPM) bpm /= 2;

  /*
   * Confidence counts intervals that are a whole multiple of the median, not
   * only ones equal to it. A detector that misses the occasional quiet kick
   * leaves a double-length gap, and that is still perfectly regular — treating
   * it as disagreement would report a steady track as rubato.
   */
  let regular = 0;
  for (const interval of intervals) {
    if (spannedBeats(interval, median) > 0) regular++;
  }

  return { bpm, confidence: regular / intervals.length };
}

/**
 * A one-pole band-pass follower per band.
 *
 * A filter bank rather than an FFT. The detector only ever reads seven band
 * energies, so a transform producing hundreds of bins computes — and then
 * discards — the wrong shape of answer at several times the cost.
 */
interface BandFilter {
  /** Two low-pass coefficients bracketing the band; the difference is the band. */
  readonly lowA: number;
  readonly highA: number;
  low: number;
  high: number;
}

interface BandFilters {
  readonly sub: BandFilter;
  readonly punch: BandFilter;
  readonly sweet: BandFilter;
  readonly bassline: BandFilter;
  readonly mud: BandFilter;
  readonly lowMid: BandFilter;
  readonly high: BandFilter;
}

function onePole(cutoffHz: number, sampleRate: number): number {
  // Clamped below Nyquist so a high band on a low sample rate degrades to a
  // pass-through instead of going unstable.
  const x = Math.exp((-2 * Math.PI * Math.min(cutoffHz, sampleRate * 0.49)) / sampleRate);
  return 1 - x;
}

function makeFilter(lowHz: number, highHz: number, sampleRate: number): BandFilter {
  return {
    lowA: onePole(highHz, sampleRate),
    highA: onePole(lowHz, sampleRate),
    low: 0,
    high: 0,
  };
}

function createBandFilters(sampleRate: number): BandFilters {
  const b = RHYTHM_BANDS;
  return {
    sub: makeFilter(b.sub.lowHz, b.sub.highHz, sampleRate),
    punch: makeFilter(b.punch.lowHz, b.punch.highHz, sampleRate),
    sweet: makeFilter(b.sweet.lowHz, b.sweet.highHz, sampleRate),
    bassline: makeFilter(b.bassline.lowHz, b.bassline.highHz, sampleRate),
    mud: makeFilter(b.mud.lowHz, b.mud.highHz, sampleRate),
    lowMid: makeFilter(b.lowMid.lowHz, b.lowMid.highHz, sampleRate),
    high: makeFilter(b.high.lowHz, b.high.highHz, sampleRate),
  };
}

/** RMS in each band over one hop, written into a caller-owned record. */
function measureBands(
  samples: Float32Array,
  start: number,
  count: number,
  filters: BandFilters,
  out: BandEnergies,
): void {
  let sub = 0;
  let punch = 0;
  let sweet = 0;
  let bassline = 0;
  let mud = 0;
  let lowMid = 0;
  let high = 0;

  const end = Math.min(start + count, samples.length);
  for (let i = start; i < end; i++) {
    const x = samples[i] ?? 0;
    sub += step(filters.sub, x);
    punch += step(filters.punch, x);
    sweet += step(filters.sweet, x);
    bassline += step(filters.bassline, x);
    mud += step(filters.mud, x);
    lowMid += step(filters.lowMid, x);
    high += step(filters.high, x);
  }

  const inv = 1 / Math.max(1, end - start);
  out.sub = Math.sqrt(sub * inv);
  out.punch = Math.sqrt(punch * inv);
  out.sweet = Math.sqrt(sweet * inv);
  out.bassline = Math.sqrt(bassline * inv);
  out.mud = Math.sqrt(mud * inv);
  out.lowMid = Math.sqrt(lowMid * inv);
  out.high = Math.sqrt(high * inv);
}

/** Advance one filter by one sample and return that sample's squared output. */
function step(filter: BandFilter, x: number): number {
  filter.low += (x - filter.low) * filter.lowA;
  filter.high += (x - filter.high) * filter.highA;
  const band = filter.low - filter.high;
  return band * band;
}
