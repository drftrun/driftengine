/**
 * Landing on a frame that was played, rather than on a frame like it.
 *
 * Restore the nearest keyframe at or before the target and re-advance with the recorded input.
 * Because the simulation is deterministic, the result is the original frame exactly — so the
 * assertion worth making is a fingerprint comparison, which is stronger than any spot check of
 * state and is the only one that covers the parts of the world a test did not think to look at.
 *
 * **The property that matters is not that scrubbing back works; it is that playing forward
 * afterwards is unchanged.** A scrubber that perturbs the simulation is worse than no scrubber,
 * because what it then produces is a version of the bug that is not the bug, and somebody spends
 * an afternoon on the difference. So the test that earns this file compares a scrub-then-play run
 * against a straight-through run, frame for frame.
 *
 * **Two numbers here both look like "the frame", and they differ by one.** A timeline frame `f` is
 * the *tick numbered f*: the input it holds is what that tick was given, and the fingerprint is the
 * world after it ran. A session counts *ticks that have run*, so a session sitting on timeline
 * frame `f` has `session.frame === f + 1`, and a session that has run nothing sits on −1. Every
 * conversion in this file is written out rather than inlined, because an off-by-one here does not
 * throw: it lands one frame from where somebody asked and looks entirely healthy.
 *
 * **Scrubbing forward does not restore.** Going from frame 100 to 140 needs the forty frames
 * between and nothing else; restoring the last keyframe first would run more frames to reach the
 * same place, and would make forward scrubbing fail when a keyframe has been dropped — which it
 * has no reason to need.
 */
import type { PieSession } from './session.ts';
import {
  inputAt,
  nearestKeyframeBefore,
  reachable,
  snapshotAt,
  type Timeline,
} from './timeline.ts';

/**
 * What a recorded input does to the world before its tick runs.
 *
 * A seam rather than a shape: what an input *is* belongs to the game, and a scrubber that knew
 * would be a scrubber every game had to agree with.
 */
export type ApplyInput<I> = (input: I, frame: number) => void;

export interface ScrubOptions<I> {
  readonly applyInput?: ApplyInput<I>;
  /**
   * Anything else that happened before this tick the first time round — an editor command made
   * during play, which `editDuringPlay.ts` records.
   *
   * **Called before `applyInput`**, because an edit changes the world and the input is what the
   * world is then driven with. The reverse order would let one frame's input act on the world as
   * it was before the edit, which is a frame that never happened.
   */
  readonly beforeTick?: (frame: number) => void;
}

/** Which timeline frame a session is sitting on. −1 before anything has run. */
export function sessionFrame<S>(session: PieSession<S>): number {
  return session.frame - 1;
}

/**
 * Put the session on timeline `frame`. False where the timeline can no longer reach it.
 *
 * False rather than the nearest frame it can reach: silently landing somewhere else is the defect
 * `timeline.ts` refuses in its own header, and refusing it there only to undo it here would be
 * worse than never refusing it at all.
 */
export function scrubTo<S, I>(
  session: PieSession<S>,
  timeline: Timeline<S, I>,
  frame: number,
  options: ScrubOptions<I> = {},
): boolean {
  const here = sessionFrame(session);
  if (frame === here) return true;
  if (!reachable(timeline, frame)) return false;

  if (frame < here) {
    const keyframe = nearestKeyframeBefore(timeline, frame);
    if (keyframe < 0) return false;
    const snapshot = snapshotAt(timeline, keyframe);
    if (snapshot === null) return false;
    session.options.snapshotter.restore(snapshot);
    /* A keyframe holds the world *after* its own tick ran, so the session is now one past it and
       the replay starts at the next tick. Re-running the keyframe's own tick would run it twice,
       which for anything that accumulates is a world that never existed. */
    session.frame = keyframe + 1;
  }

  for (let tick = session.frame; tick <= frame; tick += 1) {
    options.beforeTick?.(tick);
    const input = inputAt(timeline, tick);
    if (input !== null && options.applyInput !== undefined) options.applyInput(input, tick);
    session.options.step(session.options.fixedDt, tick);
    session.frame = tick + 1;
  }
  return true;
}
