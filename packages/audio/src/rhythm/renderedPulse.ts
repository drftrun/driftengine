import { RHYTHM_BANDS } from './bands.ts';

/**
 * The kick envelope of an already-rendered mix, readable at any instant.
 *
 * `KickDetector` reacts to a live analyser, which is the only thing possible when the
 * music has not been written yet. An offline clip render has the opposite problem and
 * the better one: the score is a finished `AudioBuffer` before the first frame is drawn,
 * so the pulse for frame `f` can be *read* at exactly `f/60` rather than chased.
 *
 * Which matters because without it an offline clip's lights would sit still while the
 * live game's pulse with the music. A replay and an export have to carry the same
 * timing, the same effects and the same flashing as the live run.
 *
 * The envelope is computed once, at a fixed hop, and read by interpolation — so the
 * cost is one pass over the score instead of an analysis per frame, and two exports of
 * the same run flash identically.
 *
 * Game-agnostic: a buffer in, a level out.
 */

/** Analysis hop, seconds. About 5 ms, so a kick's attack lands in one or two windows. */
const HOP_SEC = 0.005;
/**
 * How fast the envelope may fall, per second of level.
 *
 * A kick's *attack* is what a light answers to, so the reading rises instantly and
 * decays: without that the flash ends the moment the transient does, which reads as a
 * flicker rather than as a pulse. Six is a little under a fifth of a second to fall from
 * full, which is the length the live detector's own envelope settles to.
 */
const DECAY_PER_SEC = 6;

/**
 * Resonance of each band-pass stage.
 *
 * Two is narrow enough to matter and wide enough to keep a kick's whole attack. The
 * *cascade* is what does the work: one stage leaves a 140 Hz bassline about 12 dB down,
 * which is not separation. Two measure 20 dB — an amplitude ratio of ten — so a bassline
 * louder than the kick stops swamping it.
 */
const STAGE_Q = 2;

/**
 * Band-limited energy per hop, over the whole signal in one pass.
 *
 * **One pass, with the filter state carried across hops.** The first version filtered
 * each window from a fresh state, which makes every window boundary an impulse — and an
 * impulse into a resonant filter rings at the filter's own frequency, so a pure 140 Hz
 * bassline produced 66 Hz energy out of nothing. Measured: the bassline read 0.47 of the
 * clip's peak between kicks, where it should have read a tenth of that. A filter is a
 * thing with memory and cutting its memory up destroys what it is for.
 *
 * Centred on the geometric mean of `sub.lowHz` and `sweet.highHz`, so "a kick" means
 * here what `RHYTHM_BANDS` means everywhere else in the engine — the same numbers drive
 * the offline edit's cuts, and a light disagreeing with a cut about what a kick is would
 * be a clip fighting itself.
 */
function kickEnergyPerHop(samples: Float32Array, rate: number, hop: number): Float32Array {
  const centreHz = Math.sqrt(RHYTHM_BANDS.sub.lowHz * RHYTHM_BANDS.sweet.highHz);
  const f = 2 * Math.sin((Math.PI * centreHz) / rate);
  const q = 1 / STAGE_Q;
  const count = Math.max(1, Math.ceil(samples.length / hop));
  const levels = new Float32Array(count);

  let lowA = 0;
  let bandA = 0;
  let lowB = 0;
  let bandB = 0;
  let sum = 0;
  let bin = 0;
  let taken = 0;
  for (let i = 0; i < samples.length; i++) {
    const input = samples[i] ?? 0;
    const highA = input - lowA - q * bandA;
    bandA += f * highA;
    lowA += f * bandA;
    // The second stage reads the first's band output: two poles become four.
    const highB = bandA - lowB - q * bandB;
    bandB += f * highB;
    lowB += f * bandB;
    sum += bandB * bandB;
    taken++;
    if (taken === hop) {
      levels[bin] = Math.sqrt(sum / hop);
      bin++;
      sum = 0;
      taken = 0;
    }
  }
  if (taken > 0 && bin < count) levels[bin] = Math.sqrt(sum / taken);
  return levels;
}

export class RenderedPulse {
  private readonly levels: Float32Array;
  private readonly hopSec: number;

  /**
   * @param buffer The rendered mix. Channel 0 is read; a kick is not a stereo event.
   */
  constructor(buffer: AudioBuffer) {
    const rate = buffer.sampleRate;
    const samples = buffer.getChannelData(0);
    const hop = Math.max(1, Math.round(HOP_SEC * rate));
    const raw = kickEnergyPerHop(samples, rate, hop);
    const count = raw.length;

    let peak = 0;
    for (const level of raw) {
      if (level > peak) peak = level;
    }

    /*
     * Normalised against the loudest moment in this clip, not against an absolute
     * figure. A quiet track would otherwise never flash and a loud one would sit at
     * full — and the light is a *reaction to the music*, which is relative by nature.
     */
    const scale = peak > 1e-6 ? 1 / peak : 0;
    const fall = (DECAY_PER_SEC * hop) / rate;
    let envelope = 0;
    for (let i = 0; i < count; i++) {
      const level = (raw[i] ?? 0) * scale;
      // Rise instantly, fall slowly: a light answers a kick's attack, not its energy.
      envelope = level > envelope ? level : Math.max(level, envelope - fall);
      raw[i] = envelope;
    }

    this.levels = raw;
    this.hopSec = hop / rate;
  }

  /**
   * The pulse at `seconds`, 0–1.
   *
   * Interpolated between hops so a light moves smoothly at any frame rate rather than
   * stepping at the analysis rate.
   */
  at(seconds: number): number {
    const position = Math.max(0, seconds) / this.hopSec;
    const index = Math.floor(position);
    const first = this.levels[Math.min(index, this.levels.length - 1)] ?? 0;
    const second = this.levels[Math.min(index + 1, this.levels.length - 1)] ?? first;
    const fraction = position - index;
    return first + (second - first) * fraction;
  }
}
