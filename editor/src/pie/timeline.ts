/**
 * What was played, kept so any frame of it can be reached again.
 *
 * **Keyframes and the input between them, not a snapshot per frame.** A snapshot every frame is
 * unaffordable at any useful length — a modest world at sixty frames a second is tens of megabytes
 * a minute — and it is also unnecessary, because the simulation is deterministic. A snapshot every
 * *n* frames plus the input recorded since reconstructs any frame exactly, and determinism is the
 * property this whole wave spends. Nothing else in this file matters as much as that sentence.
 *
 * **A frame outside the range is unavailable, never the nearest one.** A ring drops its oldest
 * frames, and a scrubber that quietly hands back the oldest it still has shows a frame that is not
 * the frame asked for while looking exactly like one that is. Somebody then reasons about a bug
 * from a frame the bug did not happen on. Saying "gone" is the only honest answer, and it is also
 * the one a timeline widget can draw, by not drawing that part of the track.
 *
 * **A fingerprint per frame, not per keyframe.** It is what Task 6 compares against a re-run, and
 * comparing only at keyframes would find a divergence up to `interval` frames after it began —
 * which is the difference between naming the frame that broke and naming the region it is in.
 */

export interface Timeline<S, I> {
  /** Frames between keyframes. One would be a snapshot per frame; see the header. */
  readonly interval: number;
  /** How many frames the ring holds before it starts dropping the oldest. */
  readonly capacity: number;
  /** Recorded frames, oldest first. Never longer than `capacity`. */
  readonly frames: RecordedFrame<S, I>[];
  /**
   * Snapshot slots from dropped keyframes, waiting to be filled again.
   *
   * **A free list rather than reusing the dropped frame's own slot**, which is what this did first
   * and which does not work: the frame falling off the back is a keyframe only one time in
   * `interval`, and it is almost never the same frame as the one that needs a slot. A test counting
   * allocations found thirteen where three were claimed. With a pool the two rates match in steady
   * state — a keyframe is dropped exactly as often as one is made — and the count stops at three.
   */
  readonly spare: S[];
}

export interface RecordedFrame<S, I> {
  frame: number;
  /** The world at this frame, or null where this frame is not a keyframe. */
  snapshot: S | null;
  /** What was fed to the simulation on this frame. */
  input: I;
  /** What the world hashed to after this frame ran. */
  fingerprint: string;
}

export interface TimelineOptions<S> {
  readonly interval?: number;
  readonly capacity?: number;
  /** Makes a slot to save into. Called only when the pool of dropped slots is empty. */
  readonly createSnapshot: () => S;
  readonly saveSnapshot: (into: S) => void;
}

export interface TimelineRange {
  readonly first: number;
  readonly last: number;
  /** False where nothing has been recorded, which is not the same as a range of one frame. */
  readonly any: boolean;
}

export function createTimeline<S, I>(
  options: TimelineOptions<S>,
): Timeline<S, I> & TimelineOptions<S> {
  return {
    interval: Math.max(1, Math.floor(options.interval ?? 30)),
    capacity: Math.max(1, Math.floor(options.capacity ?? 3600)),
    frames: [],
    spare: [],
    createSnapshot: options.createSnapshot,
    saveSnapshot: options.saveSnapshot,
  };
}

/**
 * Record one frame. A keyframe every `interval` frames, counted from frame zero.
 *
 * The snapshot is taken here rather than passed in, so a caller cannot record a keyframe whose
 * contents are from a different moment than the fingerprint beside it — the one mistake that makes
 * a whole timeline quietly wrong.
 */
export function recordFrame<S, I>(
  timeline: Timeline<S, I> & TimelineOptions<S>,
  frame: number,
  input: I,
  fingerprint: string,
): void {
  const keyframe = frame % timeline.interval === 0;
  if (timeline.frames.length >= timeline.capacity) {
    const dropped = timeline.frames.shift();
    /* Its slot goes back to the pool rather than to the collector, so a timeline at capacity
       allocates nothing per frame — which is the whole reason the ring has a fixed size. */
    if (dropped?.snapshot != null) timeline.spare.push(dropped.snapshot);
  }

  let snapshot: S | null = null;
  if (keyframe) {
    snapshot = timeline.spare.pop() ?? timeline.createSnapshot();
    timeline.saveSnapshot(snapshot);
  }
  timeline.frames.push({ frame, snapshot, input, fingerprint });
}

/** What the timeline still holds. */
export function frameRange<S, I>(timeline: Timeline<S, I>): TimelineRange {
  const first = timeline.frames[0];
  const last = timeline.frames[timeline.frames.length - 1];
  if (first === undefined || last === undefined) return { first: 0, last: 0, any: false };
  return { first: first.frame, last: last.frame, any: true };
}

export function recordedAt<S, I>(
  timeline: Timeline<S, I>,
  frame: number,
): RecordedFrame<S, I> | null {
  return timeline.frames.find((one) => one.frame === frame) ?? null;
}

/** The world saved at this frame, or null where it is not a keyframe or is no longer held. */
export function snapshotAt<S, I>(timeline: Timeline<S, I>, frame: number): S | null {
  return recordedAt(timeline, frame)?.snapshot ?? null;
}

export function fingerprintAt<S, I>(timeline: Timeline<S, I>, frame: number): string | null {
  return recordedAt(timeline, frame)?.fingerprint ?? null;
}

export function inputAt<S, I>(timeline: Timeline<S, I>, frame: number): I | null {
  return recordedAt(timeline, frame)?.input ?? null;
}

/**
 * The latest keyframe at or before `frame`, or −1 where the timeline no longer reaches it.
 *
 * **At or before, and −1 rather than the oldest.** Returning the oldest keyframe for a frame that
 * has been dropped is how a scrubber lies: the caller re-advances from it and lands somewhere that
 * is not where they asked to go, with nothing to tell them.
 */
export function nearestKeyframeBefore<S, I>(timeline: Timeline<S, I>, frame: number): number {
  const range = frameRange(timeline);
  if (!range.any || frame < range.first || frame > range.last) return -1;
  for (let at = timeline.frames.length - 1; at >= 0; at -= 1) {
    const one = timeline.frames[at] as RecordedFrame<S, I>;
    if (one.frame > frame) continue;
    if (one.snapshot !== null) return one.frame;
  }
  return -1;
}

/**
 * Forget every frame from `frame` onward, returning their snapshot slots to the pool.
 *
 * What re-simulating needs: an edit at frame `n` makes every frame after it a record of something
 * that did not happen. Keeping them and overwriting as the replay passes would leave the frames
 * beyond the replay's end still describing the old run, which is worse than forgetting them —
 * they would look recorded and be wrong.
 */
export function truncateFrom<S, I>(timeline: Timeline<S, I>, frame: number): number {
  let dropped = 0;
  for (let at = timeline.frames.length - 1; at >= 0; at -= 1) {
    const one = timeline.frames[at] as RecordedFrame<S, I>;
    if (one.frame < frame) break;
    if (one.snapshot !== null) timeline.spare.push(one.snapshot);
    timeline.frames.pop();
    dropped += 1;
  }
  return dropped;
}

/** Whether this frame can be reached: it is recorded, and a keyframe at or before it survives. */
export function reachable<S, I>(timeline: Timeline<S, I>, frame: number): boolean {
  return recordedAt(timeline, frame) !== null && nearestKeyframeBefore(timeline, frame) >= 0;
}
