import type { ScheduleClock } from '../ambientLoop.ts';
import type { MixInsert } from './bus.ts';

/**
 * The stages a *return* bus carries: a reverb, and an echo.
 *
 * Separate from `inserts.ts` because they answer a different question. Those are stages a source
 * bus puts in its own path; these are what a bus at the end of a send is made of, and a consumer
 * building a return reaches for exactly one of them.
 */

const RAMP = 0.08;

/**
 * A synthesised impulse response: exponentially decaying noise.
 *
 * Not a real hall — a real one is a file, and files are what the registry is for. This exists so
 * reverb works before any asset has been recorded, on the same principle as every other sound here.
 *
 * **`random` is a parameter rather than `Math.random`**, and that is what makes a reverb tail
 * assertable at all: an unseeded generator builds a different hall every construction, so no render
 * carrying wet signal can be compared to another. Defaulting it here would have hidden that.
 */
export function impulseResponse(
  context: BaseAudioContext,
  seconds: number,
  decay: number,
  random: () => number,
): AudioBuffer {
  const rate = context.sampleRate;
  const length = Math.max(1, Math.floor(rate * seconds));
  const buffer = context.createBuffer(2, length, rate);
  for (let channel = 0; channel < 2; channel++) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < length; i++) {
      data[i] = (random() * 2 - 1) * (1 - i / length) ** decay;
    }
  }
  return buffer;
}

/**
 * A convolver, built once at registration.
 *
 * **Never on entry to anything.** Building an impulse allocates a stereo buffer and fills it sample
 * by sample, which costs milliseconds; doing that when a player crosses a threshold would put both
 * the allocation and the cost on the input path at the exact moment something is supposed to happen.
 */
export function convolverInsert(
  context: BaseAudioContext,
  seconds: number,
  decay: number,
  random: () => number,
): MixInsert {
  const convolver = context.createConvolver();
  convolver.buffer = impulseResponse(context, seconds, decay, random);
  return { input: convolver, output: convolver };
}

export interface DelayInsert extends MixInsert {
  setTime(seconds: number): void;
  setFeedback(amount: number): void;
  readonly timeSec: number;
}

/**
 * A delay line that feeds itself, at a level that must decay.
 *
 * The interval is worth exposing rather than fixing at a pleasant-sounding constant, because an
 * echo either lands *with* the music or against it, and which one depends on the tempo of whatever
 * is playing: a 0.28 s repeat under a 150 BPM track falls between the beats and reads as smear,
 * where a half-beat repeat reads as the room the track is in.
 */
export function delayInsert(
  context: BaseAudioContext,
  scheduleAt: ScheduleClock,
  { time = 0.28, feedback = 0.34 } = {},
): DelayInsert {
  const delay = context.createDelay(1);
  delay.delayTime.value = time;
  const loop = context.createGain();
  loop.gain.value = feedback;
  delay.connect(loop);
  loop.connect(delay);

  const ramp = (param: AudioParam, value: number): void => {
    const at = scheduleAt();
    param.cancelScheduledValues(at);
    param.setTargetAtTime(value, at, RAMP);
  };

  return {
    input: delay,
    output: delay,
    get timeSec(): number {
      return delay.delayTime.value;
    },
    setTime(seconds: number): void {
      if (!Number.isFinite(seconds)) return;
      // Clamped to the line's own capacity.
      ramp(delay.delayTime, Math.min(Math.max(seconds, 0.02), 0.98));
    },
    /**
     * How much of each repeat feeds the next.
     *
     * Clamped below 1, because a feedback path that does not decay is a drone that grows until it
     * clips — and one the caller cannot undo by turning the send down, since the energy is already
     * circulating.
     */
    setFeedback(amount: number): void {
      ramp(loop.gain, Math.min(Math.max(amount, 0), 0.88));
    },
  };
}
