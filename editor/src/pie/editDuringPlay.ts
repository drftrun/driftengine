/**
 * Change something at frame four hundred, and watch the rest happen differently.
 *
 * **The edit is the same `Command` an inspector emits when nothing is playing.** Not a parallel
 * mutation path, and that is the whole of why this is trustworthy rather than a debugging trick: a
 * change made during play goes through the object the editor already uses, so it is undoable, it is
 * the same change it would have been at rest, and there is no second way to write the world that
 * somebody has to remember to keep in step.
 *
 * **A command is applied by the replay, not on the spot.** Recording it and then re-simulating from
 * its frame is one path rather than two, and it is also the only arrangement under which scrubbing
 * away and back reproduces the edited run — an edit applied directly would vanish the moment a
 * keyframe was restored over it. The undo stack's rule that the stack applies exactly once is about
 * the stack; a replay re-applies after a restore that took the change back out, which is the same
 * change happening once each time it happens.
 *
 * **Edits are kept apart from the input log, and the plan had them in it.** An editor command is
 * not game input: it is not something a peer sends, and it is not something a recording of the game
 * produces. Putting the two in one log would make them indistinguishable to a network session that
 * replays inputs, which is exactly the thing that must never confuse them. Two logs, replayed at
 * the same point, keep the distinction and produce the same world.
 *
 * **Frames after the edit are forgotten rather than overwritten.** They record something that did
 * not happen; leaving them to be overwritten as the replay passes would leave anything beyond the
 * replay's end still describing the old run, looking recorded and being wrong.
 */
import { type Command } from '@driftengine/tools';
import type { PieSession } from './session.ts';
import { scrubTo, type ApplyInput, type ScrubOptions } from './scrub.ts';
import {
  frameRange,
  inputAt,
  recordFrame,
  truncateFrom,
  type Timeline,
  type TimelineOptions,
} from './timeline.ts';

/** Editor commands made during play, by the frame they took effect on. */
export interface EditLog {
  readonly byFrame: Map<number, Command[]>;
}

export function createEditLog(): EditLog {
  return { byFrame: new Map<number, Command[]>() };
}

/** Add a command to a frame. Several on one frame replay in the order they were made. */
export function recordEdit(log: EditLog, frame: number, command: Command): void {
  const at = log.byFrame.get(frame);
  if (at === undefined) log.byFrame.set(frame, [command]);
  else at.push(command);
}

export function editsAt(log: EditLog, frame: number): readonly Command[] {
  return log.byFrame.get(frame) ?? EMPTY;
}

const EMPTY: readonly Command[] = [];

/** Run the edits a frame carries. The one place a recorded command is applied. */
export function applyEditsAt(log: EditLog, frame: number): void {
  for (const command of editsAt(log, frame)) command.apply();
}

/** Everything a frame of play needs beyond the session itself. */
export interface Playback<S, I> {
  readonly timeline: Timeline<S, I> & TimelineOptions<S>;
  readonly edits: EditLog;
  /** What input a frame is given while playing live. A replay uses the recorded one instead. */
  readonly inputFor: (frame: number) => I;
  readonly applyInput: ApplyInput<I>;
  /** The world's digest, taken after the step. What a divergence search compares. */
  readonly fingerprint: () => string;
}

/** The hooks a replay of recorded time needs. Shared by scrubbing and by re-simulating. */
export function replayHooks<S, I>(playback: Playback<S, I>): ScrubOptions<I> {
  return {
    applyInput: playback.applyInput,
    beforeTick: (frame: number): void => {
      applyEditsAt(playback.edits, frame);
    },
  };
}

/** Advance one frame of live play and record it. Returns the frame that ran. */
export function playFrame<S, I>(session: PieSession<S>, playback: Playback<S, I>): number {
  const tick = session.frame;
  applyEditsAt(playback.edits, tick);
  const input = playback.inputFor(tick);
  playback.applyInput(input, tick);
  session.options.step(session.options.fixedDt, tick);
  session.frame = tick + 1;
  recordFrame(playback.timeline, tick, input, playback.fingerprint());
  return tick;
}

/**
 * Run recorded time again from `frame`, with whatever the edit log now says. False where it cannot.
 *
 * Frame 0 is the case worth naming: the world before the first tick is not in the timeline — a
 * keyframe holds the world *after* its own tick — so it comes from the session's own capture, which
 * is the same one `stopPie` restores. That is what makes "replay the whole session from the start"
 * possible rather than "replay from the earliest keyframe".
 */
export function resimulateFrom<S, I>(
  session: PieSession<S>,
  playback: Playback<S, I>,
  frame: number,
): boolean {
  const timeline = playback.timeline;
  const range = frameRange(timeline);
  if (!range.any || frame < range.first || frame > range.last) return false;

  if (frame === 0) {
    session.options.snapshotter.restore(session.before);
    session.frame = 0;
  } else if (!scrubTo(session, timeline, frame - 1, replayHooks(playback))) {
    /* No separate reachability check: `scrubTo` refuses a frame it cannot land on, and a second
       check asking the same question is one a perturbation cannot tell from its absence. */
    return false;
  }

  /* The recorded input is taken before the records are forgotten, because it is what the replay
     is replaying: the edit changes the world, not what anybody pressed. */
  const inputs: I[] = [];
  for (let tick = frame; tick <= range.last; tick += 1) {
    const input = inputAt(timeline, tick);
    if (input === null) return false;
    inputs.push(input);
  }
  truncateFrom(timeline, frame);

  for (let at = 0; at < inputs.length; at += 1) {
    const tick = frame + at;
    applyEditsAt(playback.edits, tick);
    playback.applyInput(inputs[at] as I, tick);
    session.options.step(session.options.fixedDt, tick);
    session.frame = tick + 1;
    recordFrame(timeline, tick, inputs[at] as I, playback.fingerprint());
  }
  return true;
}

/**
 * Make an edit take effect at `frame` and run the rest of the session again from there.
 *
 * False where the frame is outside what the timeline still holds, or where the frame before it can
 * no longer be reached — both of which mean the edited run cannot be produced, and saying so is
 * better than producing a different one.
 */
export function applyPlayEdit<S, I>(
  session: PieSession<S>,
  playback: Playback<S, I>,
  frame: number,
  command: Command,
): boolean {
  /*
   * Recorded first and taken back on failure, rather than checked first. Every check that could go
   * here — is the frame in range, can the frame before it be reached — is a question
   * `resimulateFrom` already asks, and asking it twice is a line no perturbation can distinguish
   * from its own absence. What is *not* duplicated is this: an edit that did not run must not be
   * left in the log claiming it did.
   */
  recordEdit(playback.edits, frame, command);
  if (resimulateFrom(session, playback, frame)) return true;

  const held = playback.edits.byFrame.get(frame);
  held?.pop();
  if (held?.length === 0) playback.edits.byFrame.delete(frame);
  return false;
}
