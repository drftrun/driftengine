/**
 * Which frame a change to a dynamic mesh or an instanced batch belongs to.
 *
 * **A consumer may change geometry in its simulation step, before `beginFrame`.** That change is
 * what the *next* frame draws, so it is that frame's — counting it against the frame last begun
 * would say the geometry changed a frame early and then did not change at all, which is a motion
 * vector on the wrong frame and none on the right one.
 *
 * Only the **first** change in a frame keeps the state before it: a second rewrite in the same
 * frame must not replace "where it was last frame" with "where it was a moment ago".
 */

export function frameOfChange(serial: number, inFrame: boolean): number {
  return inFrame ? serial : serial + 1;
}

export function keepsPrevious(lastChange: number, frame: number): boolean {
  return lastChange !== frame;
}

/** Slots `0 … n-1` pair with last frame's; a slot past last frame's count is new and has no past. */
export function pairedInstances(previousCount: number, count: number): number {
  return Math.min(previousCount, count);
}
