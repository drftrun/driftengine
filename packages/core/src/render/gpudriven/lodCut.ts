/**
 * Choosing which level of the cluster graph to draw, per cluster, independently.
 *
 * **Independently is the whole point.** A cluster asks only about its own error and its parent's,
 * never about its neighbours — and the graph's monotonic-error guarantee is what makes the result
 * crack-free anyway. That is why this can run per cluster on the device with no communication.
 *
 * **Both halves of the rule are needed.** "Draw it if its own error is small enough" alone draws
 * every ancestor as well; "draw it if its parent's error is too large" alone draws nothing at the
 * root, where the parent error is infinite and therefore always too large — which is exactly the
 * case that makes the coarsest level appear and never disappear.
 */

/**
 * How large a geometric error appears on screen, in pixels.
 *
 * Distance is clamped below by the cluster's own radius, so a cluster the camera is inside reports
 * an enormous error rather than dividing by something near zero — which is the difference between
 * "always use the finest level here" and a non-finite number reaching a comparison.
 */
export function projectedError(
  error: number,
  distance: number,
  radius: number,
  screenHeight: number,
  fovY: number,
): number {
  const safe = Math.max(distance, radius, 1e-4);
  const scale = screenHeight / (2 * Math.tan(fovY / 2));
  return (error * scale) / safe;
}

export function distanceTo(
  cx: number,
  cy: number,
  cz: number,
  ex: number,
  ey: number,
  ez: number,
): number {
  return Math.hypot(cx - ex, cy - ey, cz - ez);
}

/**
 * Whether this cluster is the one to draw.
 *
 * True when its own error is acceptable and its parent's is not — see the header for why both
 * halves are required.
 */
export function clusterSelected(
  ownError: number,
  parentError: number,
  distance: number,
  radius: number,
  screenHeight: number,
  fovY: number,
  thresholdPixels: number,
): boolean {
  const own = projectedError(ownError, distance, radius, screenHeight, fovY);
  const parent = projectedError(parentError, distance, radius, screenHeight, fovY);
  return own <= thresholdPixels && parent > thresholdPixels;
}
