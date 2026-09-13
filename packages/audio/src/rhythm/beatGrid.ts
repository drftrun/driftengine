import type { BeatMap } from './beatMap.ts';

/**
 * A beat map from a tempo the player supplies rather than one we detected.
 *
 * The reason this exists is the workflow, not the maths. On TikTok and Reels
 * the trending sound is added *in the app*, replacing whatever audio the clip
 * arrived with — so the thing that has to line up is not our audio against
 * theirs, it is our *cuts* against their sound. A player who taps along to the
 * track they intend to use gets an edit that fits it, and it works with any
 * song in existence precisely because we never touch the song.
 *
 * The output is an ordinary `BeatMap`, so nothing downstream needs to know
 * where its beats came from.
 */
export function beatGrid(bpm: number, offsetSec: number, durationSec: number): BeatMap {
  const safeBpm = Number.isFinite(bpm) && bpm > 0 ? bpm : 120;
  const period = 60 / safeBpm;
  const length = Math.max(0, Number.isFinite(durationSec) ? durationSec : 0);

  /*
   * Wrapped into the first beat. A player nudging the offset will run it past a
   * whole beat without thinking about it, and a grid that then started a second
   * in would silently lose the opening cut.
   */
  const raw = Number.isFinite(offsetSec) ? offsetSec : 0;
  const first = ((raw % period) + period) % period;

  const count = length <= 0 ? 0 : Math.max(0, Math.floor((length - first) / period) + 1);
  const beats = new Float32Array(count);
  const strength = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    beats[i] = first + i * period;
    // Every fourth beat is the downbeat. Not detected — asserted, because that
    // is what a player tapping four to the bar means by it.
    strength[i] = i % 4 === 0 ? 1 : 0.6;
  }

  return {
    beats,
    strength,
    bpm: safeBpm,
    bpmConfidence: 1,
    energy: new Float32Array([1]),
    energyHz: 10,
    durationSec: length,
  };
}

/** Taps this far apart are two separate attempts, not one tempo. */
const STALE_MS = 3000;
/** Below four taps there are too few intervals to reject a fumble. */
const MIN_TAPS = 4;
const MAX_TAPS = 8;
/** Outside this a "tempo" is a double-tap or somebody who wandered off. */
const MIN_BPM = 60;
const MAX_BPM = 200;

/**
 * Tempo and phase, from somebody tapping along.
 *
 * Phase is the part that matters. A player could type a BPM; what they cannot
 * type is *where the downbeat falls* in the sound they are about to add, and a
 * grid at the right tempo with the wrong phase is off by up to half a beat
 * everywhere — worse than not syncing at all.
 */
export class TapTempo {
  private readonly taps: number[] = [];

  tap(nowMs: number): void {
    const previous = this.taps[this.taps.length - 1];
    // A gap means they stopped and started again. Averaging across it would
    // produce a tempo of a couple of beats a minute.
    if (previous !== undefined && nowMs - previous > STALE_MS) this.taps.length = 0;
    this.taps.push(nowMs);
    if (this.taps.length > MAX_TAPS) this.taps.shift();
  }

  /** Null until there is enough to be sure, and for anything implausible. */
  get bpm(): number | null {
    if (this.taps.length < MIN_TAPS) return null;

    const intervals: number[] = [];
    for (let i = 1; i < this.taps.length; i++) {
      intervals.push((this.taps[i] ?? 0) - (this.taps[i - 1] ?? 0));
    }
    // Median, not mean: anybody tapping along will fumble one, and a mean turns
    // a single 400 ms stumble into a double-digit BPM error.
    intervals.sort((a, b) => a - b);
    const median = intervals[intervals.length >> 1] ?? 0;
    if (median <= 0) return null;

    const bpm = 60_000 / median;
    if (bpm < MIN_BPM || bpm > MAX_BPM) return null;
    return bpm;
  }

  /** Seconds, from the same clock the taps were given in. */
  get offsetSec(): number {
    return (this.taps[this.taps.length - 1] ?? 0) / 1000;
  }

  reset(): void {
    this.taps.length = 0;
  }
}
