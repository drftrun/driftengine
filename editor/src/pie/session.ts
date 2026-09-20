/**
 * Play in the editor, and stop with the scene exactly as it was.
 *
 * **The oldest defect an editor has is that playing changes the scene.** You press play, something
 * moves, you press stop, and the world you spent an hour arranging is now the world the simulation
 * left behind. Every engine has shipped it at some point, and the reason is always the same: play
 * mutated the authored state and stopping had nothing to put back.
 *
 * So the session captures the world before the first step and restores it on stop, and the
 * assertion in its test is a **digest comparison** rather than a spot check of a few fields — a
 * spot check passes for a world that differs everywhere the test did not look, which is most of it.
 *
 * **The world reaches the session through the snapshotter, and the plan had it as a parameter.**
 * `Snapshotter<S>` already closes over whatever it saves and restores; a `world` argument beside it
 * would be a second reference to the same thing, read by nothing here, and the first edit that made
 * the two disagree would be silent. The engine's own seam is the whole of what this needs.
 *
 * **Advancing and stepping are different verbs on purpose.** A loop calls `advancePie` every frame
 * and it does nothing while paused; a person presses step and `stepPie` advances exactly that many
 * frames whatever the state, then leaves the session paused. One function for both would mean
 * either that the loop defeats the pause or that a person cannot step while paused, and the second
 * is the only time anybody wants to.
 */
import type { Snapshotter } from '@driftengine/network';

/** One fixed step. The signature `RewindLoop` and the engine's loop already use. */
export type SimStep = (dt: number, tick: number) => void;

export type PieState = 'playing' | 'paused' | 'stopped';

export interface PieOptions<S> {
  /** How the world is saved, restored and hashed. The only route to the world this needs. */
  readonly snapshotter: Snapshotter<S>;
  /** What one frame does. Supplied, never reached for: the loop is the caller's. */
  readonly step: SimStep;
  /**
   * Seconds per fixed step.
   *
   * Required rather than defaulted, for the reason `RewindOptions` gives about the same number: a
   * replay stepped at a different delta from the run it is replaying produces a different world
   * while looking entirely healthy.
   */
  readonly fixedDt: number;
}

export interface PieSession<S> {
  readonly options: PieOptions<S>;
  state: PieState;
  /** Frames advanced since play began. The tick a step is given. */
  frame: number;
  /** The world as it was before the first step. Restored on stop, and never written again. */
  readonly before: S;
}

/**
 * Begin playing. The world is captured first, before a single step runs.
 *
 * Captured at start rather than at stop, which is the only order that works: at stop there is
 * nothing left to capture but the world play produced.
 */
export function startPie<S>(options: PieOptions<S>): PieSession<S> {
  const before = options.snapshotter.create();
  options.snapshotter.save(before);
  return { options, state: 'playing', frame: 0, before };
}

/**
 * Stop, and put the world back exactly as it was. Safe to call on a stopped session.
 *
 * The frame goes back to zero as well, because a stopped session is one that has not played — and
 * a frame counter surviving a stop is a number that means nothing and that a panel will show.
 */
export function stopPie<S>(session: PieSession<S>): void {
  if (session.state === 'stopped') return;
  session.options.snapshotter.restore(session.before);
  session.state = 'stopped';
  session.frame = 0;
}

export function pausePie<S>(session: PieSession<S>): void {
  if (session.state === 'playing') session.state = 'paused';
}

/** Resume from where the pause left it. A stopped session does not resume; it is started again. */
export function resumePie<S>(session: PieSession<S>): void {
  if (session.state === 'paused') session.state = 'playing';
}

export function pieFrame<S>(session: PieSession<S>): number {
  return session.frame;
}

/**
 * Advance the frames a running loop owes. Returns how many ran.
 *
 * Nothing runs while paused or stopped, which is what makes a loop that calls this unconditionally
 * — the ordinary arrangement — correct without the loop knowing what state the session is in.
 */
export function advancePie<S>(session: PieSession<S>, frames: number): number {
  if (session.state !== 'playing') return 0;
  return run(session, frames);
}

/**
 * Advance exactly this many frames whatever the state, and leave the session paused.
 *
 * Paused afterwards because stepping is what somebody does *instead* of playing: a step that
 * resumed would run away on the next frame, which is the opposite of what the button is for. A
 * stopped session is not stepped — there is nothing to step through until play has begun.
 */
export function stepPie<S>(session: PieSession<S>, frames: number): number {
  if (session.state === 'stopped') return 0;
  const ran = run(session, frames);
  session.state = 'paused';
  return ran;
}

function run<S>(session: PieSession<S>, frames: number): number {
  const count = Math.max(0, Math.floor(frames));
  for (let i = 0; i < count; i += 1) {
    /* The tick is the frame about to run, so the first is 0 and the counter is the count of frames
       that have happened. A tick taken after the increment would start at 1 and every recorded
       frame would be off by one against the timeline that stores it. */
    session.options.step(session.options.fixedDt, session.frame);
    session.frame += 1;
  }
  return count;
}
