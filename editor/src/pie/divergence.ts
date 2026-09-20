/**
 * When two runs stop agreeing, name the frame and then the component.
 *
 * **Nobody else can build this panel, because nobody else records the fingerprints.** A rollback
 * session where two peers disagree, or a replay that stops matching its recording, is normally
 * debugged by printing state and staring; here both sides already carry a hash per frame, so the
 * frame it went wrong on is a search rather than a hunt, and the component it went wrong in is a
 * map comparison.
 *
 * **The search is a binary one, and it assumes agreement is a prefix.** Once a deterministic
 * simulation's state differs it keeps differing, so "agreed at frame f" implies "agreed everywhere
 * before f" and the boundary is a log-time search rather than a walk.
 *
 * **That assumption is load-bearing, and the sharp edge is worth knowing: a pair agreeing on the
 * last frame is reported as agreeing, whatever happened in between.** The first probe is the last
 * frame, because it answers the common case — two runs that match — in one comparison, and because
 * the search below needs a `high` that disagrees or its invariant is meaningless. A world that
 * clamps or quantises can diverge and come back together, and on such a pair this says they agree.
 * There is a test pinning exactly that rather than a comment hoping nobody meets it.
 *
 * **No divergence is reported as itself, never as frame zero.** Frame zero is a real frame, and a
 * caller that cannot tell "they agree" from "they diverged immediately" will eventually show the
 * wrong one of those to somebody.
 */
import type { Timeline } from './timeline.ts';
import { fingerprintAt, frameRange } from './timeline.ts';

/** The two runs agree everywhere they both reach. */
export const NO_DIVERGENCE = -1;
/** The two runs have no frame in common, so nothing was compared. Not the same as agreeing. */
export const NO_OVERLAP = -2;

/** Filled in by the search, for a test that wants to know it really was logarithmic. */
export interface DivergenceSearch {
  comparisons: number;
}

/**
 * The first frame at which two timelines disagree, over the frames they both hold.
 *
 * `NO_DIVERGENCE` where they agree throughout, `NO_OVERLAP` where there was nothing to compare.
 */
export function firstDivergentFrame<S, I, T, J>(
  a: Timeline<S, I>,
  b: Timeline<T, J>,
  search?: DivergenceSearch,
): number {
  if (search !== undefined) search.comparisons = 0;
  const left = frameRange(a);
  const right = frameRange(b);
  if (!left.any || !right.any) return NO_OVERLAP;

  const first = Math.max(left.first, right.first);
  const last = Math.min(left.last, right.last);
  if (first > last) return NO_OVERLAP;

  const agree = (frame: number): boolean => {
    if (search !== undefined) search.comparisons += 1;
    return fingerprintAt(a, frame) === fingerprintAt(b, frame);
  };

  /* The last frame first: agreeing there means agreeing everywhere, and it is the common case —
     two runs that match — answered in one comparison instead of a whole search. */
  if (agree(last)) return NO_DIVERGENCE;
  if (!agree(first)) return first;

  /*
   * `low` always agrees and `high` always disagrees, so the answer is `high` when they meet. Stated
   * as an invariant rather than as a bound, because every off-by-one in a binary search is a
   * violated invariant and this is the sentence that makes one visible.
   */
  let low = first;
  let high = last;
  while (high - low > 1) {
    const middle = low + Math.floor((high - low) / 2);
    if (agree(middle)) low = middle;
    else high = middle;
  }
  return high;
}
