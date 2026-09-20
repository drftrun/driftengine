import type { MixLevels } from '../graph.ts';
import type { MixBus } from './bus.ts';
import type { MixConsole } from './console.ts';
import {
  liftInsert,
  masterFilterInsert,
  slamInsert,
  type LiftInsert,
  type MasterFilterInsert,
  type SlamInsert,
} from './inserts.ts';
import { convolverInsert, delayInsert, type DelayInsert } from './returns.ts';

/**
 * The mix as it has always been, expressed in buses and inserts.
 *
 * ```
 *   music ─ [align] ─ [lift] ─ tap ─ [slam] ─┐
 *     └─ sends from tap ─────────────────────┼→ master ─ [master lowpass] ─ out ─→ destination
 *   effects ───────────────────────────────── ┘                                    ↑
 *   reverb · longReverb · delay ──────────────────────────────────────────────────┘
 * ```
 *
 * **This is a transcription and it is meant to stay one.** Every level, every frequency and every
 * connection order is the one `AudioGraph`'s constructor had, because the gate on this file is that
 * an offline render through it is sample-identical to a render frozen before it existed. An
 * improvement to the mix cannot be made here without breaking that gate — deliberately, so that a
 * change to how the mix sounds arrives in its own commit where a diff attributes it.
 *
 * **The three returns are parented to nothing and wired straight to `out`.** They join the mix
 * downstream of the master filter, which is what the mix has always done: a reverb tail put through
 * a low-pass the dry signal has already passed reads as a duller room rather than as a room.
 */
export interface DefaultLayout {
  readonly music: MixBus;
  readonly effects: MixBus;
  readonly reverb: MixBus;
  readonly longReverb: MixBus;
  readonly delay: MixBus;
  readonly lift: LiftInsert;
  readonly slam: SlamInsert;
  readonly masterFilter: MasterFilterInsert;
  readonly delayLine: DelayInsert;
}

/**
 * The long tail: seconds of impulse, and how fast it decays inside them.
 *
 * Long enough to carry a whole airborne moment — a jump is under a second, a glide several — and
 * decaying slowly enough that the music is *spread out* rather than merely echoed. Beyond about
 * eight seconds it stops sounding like a space and starts sounding like a stuck effect.
 */
const LONG_REVERB_SECONDS = 6;
const LONG_REVERB_DECAY = 1.5;
/** The short one: the room the music is played in, rather than where it goes. */
const SHORT_REVERB_SECONDS = 2.4;
const SHORT_REVERB_DECAY = 2.6;
/** Baseline delay feedback: one clear repeat, not a rhythm of its own. */
const DELAY_FEEDBACK = 0.34;

export function defaultLayout(mix: MixConsole, levels: MixLevels): DefaultLayout {
  const masterFilter = masterFilterInsert(mix.context, () => mix.scheduleAt());
  mix.master.insert(masterFilter);

  /*
   * Music and effects have their own bus because players expect to turn them down independently —
   * muting the score while keeping the game audible is the single most-used audio setting there is.
   */
  const music = mix.bus('music', { level: levels.music });
  const slam = slamInsert(mix.context, () => mix.scheduleAt());
  /*
   * The slam's wet arm is late by its shaper's latency and meets the dry arm and every send at the
   * output, so all of them wait for it here, at the head of the bus. See `SlamInsert.align`.
   */
  music.insert(slam.align);
  const lift = liftInsert(mix.context, () => mix.scheduleAt());
  music.insert(lift);
  /*
   * Below the tap, so the sends never hear it: a six-second convolution of a clipped bass hit is a
   * mess, and it would still be arriving three gates later.
   */
  music.insert(slam, { postSend: true });
  // And its wet band is taken from the music as it arrives, upstream of the lift's high-pass. See
  // `SlamInsert.wetInput` for why that is the one wiring mistake this stage can make.
  music.feedFromInput(slam.wetInput);

  const effects = mix.bus('effects', { level: levels.effects });

  /*
   * **The sends are fed from the music alone.** They hung off the shared bus first, which put
   * reverb and delay on every sound the game made when only the score should carry them. A footstep
   * with a six-second tail on it is not atmosphere, it is a bug, and the effects that carry the
   * world's own sound need to stay dry and immediate to be legible.
   */
  const reverb = mix.bus('reverb', { parent: null });
  reverb.insert(
    convolverInsert(mix.context, SHORT_REVERB_SECONDS, SHORT_REVERB_DECAY, () => mix.random()),
  );
  reverb.output.connect(mix.out);

  /*
   * A second, much longer reverb, on its own return rather than a swappable impulse: building one
   * allocates and costs milliseconds, and doing that on a jump would put both on the input path.
   * Two convolvers cost two returns and nothing else.
   */
  const longReverb = mix.bus('longReverb', { parent: null });
  longReverb.insert(
    convolverInsert(mix.context, LONG_REVERB_SECONDS, LONG_REVERB_DECAY, () => mix.random()),
  );
  longReverb.output.connect(mix.out);

  const delay = mix.bus('delay', { parent: null });
  const delayLine = delayInsert(mix.context, () => mix.scheduleAt(), { feedback: DELAY_FEEDBACK });
  delay.insert(delayLine);
  delay.output.connect(mix.out);

  // At zero, so an idle graph is exactly the dry mix. Every send is opened by a caller.
  music.send(reverb, 0);
  music.send(longReverb, 0);
  music.send(delay, 0);

  return { music, effects, reverb, longReverb, delay, lift, slam, masterFilter, delayLine };
}
