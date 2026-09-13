/**
 * What a drag on the look zone turns out to be.
 *
 * Separated from `TouchControls` because it is the one part of touch handling
 * with a right answer that can be checked without a device: everything else is
 * DOM plumbing, but this is a classification, and getting it wrong silently
 * removes a control rather than breaking one visibly.
 */
export type RightGesture = 'pending' | 'look' | 'secondary';

export interface RightGestureOptions {
  /** Travel before a drag is classified at all, pixels. */
  gestureMovePx: number;
  /** A flick has to finish inside this to count as one, milliseconds. */
  swipeMaxMs: number;
  /** Vertical travel over horizontal required to read as a deliberate flick. */
  swipeDominance: number;
}

/**
 * Classify a drag from its travel and duration.
 *
 * The bias is deliberate and one-way: **when in doubt, it is a look.** Looking
 * is continuous and constant, the secondary flick is occasional, and the two
 * failure modes are not equal — a missed flick costs one slide, while a look
 * wrongly eaten costs the camera for the whole gesture, which is felt as the
 * controls being broken rather than as a missed input.
 *
 * That asymmetry is exactly what went wrong: any quick downward drag was read
 * as a flick, so trying to look *down* quickly did not move the camera at all.
 * Looking left and right stayed fine, because no gesture competes for it.
 */
export function classifyRightGesture(
  dx: number,
  dy: number,
  elapsedMs: number,
  options: RightGestureOptions,
): RightGesture {
  if (Math.hypot(dx, dy) < options.gestureMovePx) return 'pending';
  const quick = elapsedMs < options.swipeMaxMs;
  // Downward only, and steeply so: dy is positive toward the bottom of the
  // screen, and a flick that is merely mostly-down is far likelier to be
  // somebody looking at the ground.
  if (quick && dy > 0 && dy > options.swipeDominance * Math.abs(dx)) return 'secondary';
  return 'look';
}

/**
 * Whether a released touch was a tap, and therefore fires the primary.
 *
 * Stated as its own rule because getting it wrong is how the primary went
 * missing. The press used to be queued only for a touch still *unresolved* at
 * release — but a motionless touch is promoted to the held form after
 * `holdResolveMs`, which the caller runs on a frame clock, so every tap longer
 * than that resolve was discarded. On a phone that is most of them: a
 * comfortable tap is 80 to 150 ms against a 90 ms resolve, which is exactly the
 * shape of *"sometimes the jump is missed."*
 *
 * So a tap is defined by what it *did*, not by which state it happened to be
 * parked in: it stayed inside `gestureMovePx` of where it landed and it was
 * short. A touch that travelled further has already been read as a look or a
 * flick and did its work there; firing a press on its release as well would put
 * a jump on the end of every camera drag, which is the complaint this scheme
 * was built to fix.
 *
 * `travelPx` is the *greatest* distance reached from the start, not the
 * distance at release: a thumb that swings out and returns is not a tap, and
 * measuring only the final point cannot tell the two apart.
 */
export function isTapRelease(
  travelPx: number,
  durationMs: number,
  options: { gestureMovePx: number; tapMaxMs: number },
): boolean {
  return travelPx <= options.gestureMovePx && durationMs < options.tapMaxMs;
}
