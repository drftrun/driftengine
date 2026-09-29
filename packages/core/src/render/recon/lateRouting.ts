/**
 * Two decisions about one draw in a reconstructing frame, and why they are the same set.
 *
 * A blended draw goes **late** — after the reconstruction, at output resolution, unjittered — and a
 * mover's motion is **tracked**, only for draws that land in the picture being reconstructed. A
 * planar mirror and a probe bake are other pictures drawn through the same verbs, and the overlay
 * after `endFrame` is past the picture altogether; routing any of them late, or counting a mirrored
 * draw as a mover's second draw of the frame, would be wrong in the way that reads as a ghost.
 *
 * Plain booleans rather than a state object, so the per-draw call allocates nothing.
 */
export function routesLate(
  reconstructing: boolean,
  mirror: boolean,
  probe: boolean,
  presented: boolean,
): boolean {
  return reconstructing && !mirror && !probe && !presented;
}

/** The same set as `routesLate`, named for the other reader. */
export function tracksMotion(
  reconstructing: boolean,
  mirror: boolean,
  probe: boolean,
  presented: boolean,
): boolean {
  return routesLate(reconstructing, mirror, probe, presented);
}
