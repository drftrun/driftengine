/**
 * A bound on a promise, and the sentinel that says it was reached.
 *
 * **Its own module because two callers share it and one of them learned the hard way that a bound
 * on part of a path is not a bound on the path.** The WebGPU branch is an acquisition *and* a
 * construction: an adapter, a device and a probe, then a dynamically imported backend, a surface
 * and a renderer. Bounding only the first half leaves the second half unbounded, and a boot that
 * stalls there stalls exactly as completely — with the added confusion that a deadline exists,
 * visibly, and never fires. Reported from outside precisely that way.
 */

/** Returned in place of a value that did not arrive in time. */
export const TIMED_OUT = Symbol('timed out');

/**
 * `work`, or `TIMED_OUT` if it has not settled within `ms`.
 *
 * `Infinity` and anything non-positive wait without bound, which is how a caller asks for the
 * behaviour that existed before deadlines did. The timer is always cleared: a pending one keeps a
 * process alive after the answer is known, which turns a passing suite into one that hangs at the
 * end.
 *
 * **A synchronous stall is not covered and cannot be.** Nothing in JavaScript races a call that
 * does not yield, so this bounds the awaits and says so rather than implying more.
 */
export async function withDeadline<T>(work: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  if (!Number.isFinite(ms) || ms <= 0) return work;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
