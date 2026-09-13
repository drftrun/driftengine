import type { ScheduleClock } from '../ambientLoop.ts';
import {
  LIFT_FLOOR_HZ,
  SLAM_ATTACK_SEC,
  SLAM_CLIP_KNEE,
  SLAM_CLOSED_HZ,
  SLAM_DECAY_SEC,
  SLAM_DRIVE,
  SLAM_DUCK,
  SLAM_OPEN_HZ,
  SLAM_SHELF_DB,
  SLAM_SHELF_HZ,
  clamp01,
  cutoffForSpeed,
  liftFrequencyHz,
  liftGainFor,
} from '../filters.ts';
import type { MixInsert } from './bus.ts';

/**
 * The stages a bus can carry, as things rather than as lines in one constructor.
 *
 * **These are transcriptions and they are meant to stay transcriptions.** Every node, every
 * constant and every connection order came out of `AudioGraph`'s constructor unchanged, because
 * the gate on the layout that uses them is that a render through it is sample-identical to one
 * frozen before any of this existed. An improvement made in passing here is a gate failure
 * somebody spends an hour attributing to the wrong thing.
 */

const RAMP = 0.08;

/** Ramp a parameter on the mix's clock. The same shape every stage here uses. */
function ramp(param: AudioParam, value: number, scheduleAt: ScheduleClock): void {
  const at = scheduleAt();
  param.cancelScheduledValues(at);
  param.setTargetAtTime(value, at, RAMP);
}

export interface MasterFilterInsert extends MixInsert {
  setCutoff(hz: number): void;
  setResonance(amount: number): void;
  readonly filter: BiquadFilterNode;
}

/**
 * The master low-pass: everything the player hears, including the world's own sound.
 *
 * Deliberately across the whole mix rather than the score alone — going under water muffles the
 * world, not only the music.
 */
export function masterFilterInsert(
  context: BaseAudioContext,
  scheduleAt: ScheduleClock,
): MasterFilterInsert {
  const filter = context.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = cutoffForSpeed(0, 1);
  filter.Q.value = 0.7;
  return {
    input: filter,
    output: filter,
    filter,
    setCutoff(hz: number): void {
      ramp(filter.frequency, Math.min(Math.max(hz, 40), 20000), scheduleAt);
    },
    /*
     * Not a second filter in the chain: the master low-pass is already there and already ramped, so
     * resonance raises its Q instead. A sweep then *colours* the music — the same whistle a DJ
     * filter makes — where an added layer would only sit on top of it. Zero restores the flat
     * response exactly.
     */
    setResonance(amount: number): void {
      ramp(filter.Q, 0.0001 + Math.max(0, Math.min(amount, 1)) * 12, scheduleAt);
    },
  };
}

export interface LiftInsert extends MixInsert {
  setAmount(amount: number): void;
}

/**
 * The lift: a high-pass and a duck, in series.
 *
 * This is the airborne effect proper, and it is a different idea from adding reverb on top of a
 * full-level track. The reference is the lift familiar from dance production, which does three
 * things at once — thins the low end, pulls the level down, and lets the wet through — and the
 * *thinning* is what reads as leaving the ground. Weight lives in the bass; take it away and the
 * track is suspended.
 *
 * Which is also why an earlier attempt to duck read as "the music going away" instead: it closed
 * the *low-pass*, and losing the treble is what distance sounds like, not what height sounds like.
 *
 * A bus's sends listen from the tap, and the layout puts this above it, so the tail is thin too.
 * Reverb fed from the unfiltered signal would put the bass back in the one place it cannot be
 * pushed out of again.
 */
export function liftInsert(context: BaseAudioContext, scheduleAt: ScheduleClock): LiftInsert {
  const highpass = context.createBiquadFilter();
  highpass.type = 'highpass';
  highpass.frequency.value = LIFT_FLOOR_HZ;
  highpass.Q.value = 0.7;
  const gain = context.createGain();
  highpass.connect(gain);
  return {
    input: highpass,
    output: gain,
    /*
     * One call for the whole airborne effect, because its three parts have to move together: the
     * low end thins, the dry level ducks, and what is left is mostly the sends. Splitting them
     * across three game-side calls is how they end up disagreeing, and a half-ducked, un-thinned
     * track is just quieter music.
     */
    setAmount(amount: number): void {
      ramp(highpass.frequency, liftFrequencyHz(amount), scheduleAt);
      ramp(gain.gain, liftGainFor(amount), scheduleAt);
    },
  };
}

export interface SlamInsert extends MixInsert {
  /**
   * Where the driven band is taken from, which is **not** this insert's series input.
   *
   * The layout connects the bus's own pre-insert signal here. Any low-cut ahead of the tap has to
   * be bypassed or the effect disappears exactly when the player is in the air: the lift *is* a
   * high-pass, so a slam taken from after it would be boosting a shelf on a band that had already
   * been removed, and would be at its weakest where half the gates are taken.
   */
  readonly wetInput: AudioNode;
  /** The dry path's duck and the wet path's blend, exposed so a test can assert an idle stage. */
  readonly dryGain: GainNode;
  readonly wetGain: GainNode;
  strike(amount: number): void;
}

/**
 * The slam: a parallel band of driven low end, blended in for a fraction of a second and gone.
 *
 * For the instant a body passes a marker in the world: boost the low end of the score alone, and
 * hard-clip it a little. Which is parallel bass saturation, a production move rather than a game
 * one, and it lands in exactly the register a bass-led score leaves room in.
 *
 * **Parallel rather than in-line, and that is the load-bearing decision.** A shaper sitting in the
 * music path colours the score for the whole run — a track mastered near full scale is already
 * touching any knee low enough to be useful — so the effect would stop being an event and become
 * the sound of the game. With a dry path at unity and a wet path at zero, an idle graph is
 * sample-identical to one without this stage in it, which is what lets the identity gate pass
 * across a rewrite that moved it into a bus.
 */
export function slamInsert(context: BaseAudioContext, scheduleAt: ScheduleClock): SlamInsert {
  const dry = context.createGain();
  dry.gain.value = 1;
  const output = context.createGain();
  dry.connect(output);

  const shelf = context.createBiquadFilter();
  shelf.type = 'lowshelf';
  shelf.frequency.value = SLAM_SHELF_HZ;
  shelf.gain.value = 0;
  /*
   * And a low-pass across the driven band: boosted bass plus a low-pass reads better than
   * saturation on its own, because saturation alone is a *timbre* change that a listener has to be
   * paying attention to the score to notice. Closing a filter is a change in the whole shape of the
   * sound, and it is the move every dance record uses to mark a moment precisely because it works
   * on somebody who is not listening for it.
   */
  const lowpass = context.createBiquadFilter();
  lowpass.type = 'lowpass';
  lowpass.frequency.value = SLAM_OPEN_HZ;
  lowpass.Q.value = 1.1;
  const drive = context.createGain();
  drive.gain.value = 1;
  const shaper = context.createWaveShaper();
  shaper.curve = softClipCurve();
  // The clip generates harmonics well above the band it came from; without oversampling those
  // alias back down as grit that does not belong to the hit.
  shaper.oversample = '4x';
  const wet = context.createGain();
  wet.gain.value = 0;

  shelf.connect(lowpass);
  lowpass.connect(drive);
  drive.connect(shaper);
  shaper.connect(wet);
  wet.connect(output);

  return {
    input: dry,
    output,
    wetInput: shelf,
    dryGain: dry,
    wetGain: wet,
    /**
     * Slam the low end for an instant, hard enough to clip.
     *
     * Everything about the shape says *event*: twelve milliseconds of attack so it lands on the
     * tick rather than swelling into it, then an exponential decay back to nothing over about a
     * third of a second. Scheduled on the audio clock rather than eased from the frame loop, so the
     * envelope is sample-accurate and a dropped frame cannot stretch it.
     */
    strike(amount: number): void {
      const hit = clamp01(amount);
      if (hit < 0.05) return;
      const at = scheduleAt();
      const strikeParam = (param: AudioParam, idle: number, peak: number): void => {
        param.cancelScheduledValues(at);
        // From wherever the last slam left it, so gates a stride apart stack rather than each one
        // restarting the envelope from silence.
        param.setValueAtTime(param.value, at);
        param.linearRampToValueAtTime(peak, at + SLAM_ATTACK_SEC);
        param.setTargetAtTime(idle, at + SLAM_ATTACK_SEC, SLAM_DECAY_SEC);
      };
      strikeParam(wet.gain, 0, hit);
      strikeParam(dry.gain, 1, 1 - hit * SLAM_DUCK);
      strikeParam(shelf.gain, 0, hit * SLAM_SHELF_DB);
      strikeParam(drive.gain, 1, 1 + hit * SLAM_DRIVE);
      // Down to the sub band and back open. The filter is most of the effect now.
      strikeParam(lowpass.frequency, SLAM_OPEN_HZ, SLAM_CLOSED_HZ);
    },
  };
}

/**
 * A soft clipper, transparent until it is driven and saturating hard after.
 *
 * `tanh` rather than a hard corner: a hard clip of a bass note is a square wave, and a square
 * wave's odd harmonics march all the way up the spectrum as buzz. `tanh` rounds the corner, so what
 * comes out is the second and third harmonic — which is what "driven" sounds like as opposed to
 * "broken".
 *
 * Odd-length so there is a sample exactly at zero, which keeps silence silent.
 */
function softClipCurve(): Float32Array<ArrayBuffer> {
  const samples = 2049;
  const curve = new Float32Array(new ArrayBuffer(2049 * 4));
  for (let i = 0; i < samples; i++) {
    const x = (i / (samples - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * SLAM_CLIP_KNEE) / Math.tanh(SLAM_CLIP_KNEE);
  }
  return curve;
}
