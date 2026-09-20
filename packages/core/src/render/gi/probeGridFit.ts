/**
 * A probe grid for a scene that asked for indirect light and declared no grid.
 *
 * **A declared grid always wins.** This exists so that turning the feature on shows light rather
 * than a warning, which is the difference between a feature a consumer can try and one they have
 * to study first. A scene that cares about where its probes stand says so and this is never asked.
 *
 * **Every axis carries the same spacing.** Fitting each axis to its own extent would make a probe's
 * cell a slab, and a slab interpolates over different distances along different axes — so a
 * surface's indirect light would change as it turned, which is the one thing an irradiance probe
 * must not do. When the budget bites, the spacing widens uniformly and the cells stay cubic.
 */

import { type Vec3 } from '../../math/color.ts';
import type { ProbeGridOptions } from '../probeGrid.ts';

/** How far outside the scene the outermost probes stand, in cells. */
const MARGIN_CELLS = 1;

/**
 * A grid covering `bounds` at about `spacing` metres, within `maxProbes`.
 *
 * The probes surround the scene rather than stopping at it: a surface on the boundary has to be
 * between probes on both sides of it, and a grid that stopped at the bounds would leave every
 * outward-facing wall interpolating between probes that are all behind it.
 */
export function fitProbeGrid(
  bounds: { readonly min: ArrayLike<number>; readonly max: ArrayLike<number> },
  spacing: number,
  maxProbes: number,
): ProbeGridOptions {
  const budget = Math.max(1, Math.floor(maxProbes));
  const extent = [0, 1, 2].map((axis) =>
    Math.max(0, (bounds.max[axis] as number) - (bounds.min[axis] as number)),
  );
  const centre = [0, 1, 2].map(
    (axis) => ((bounds.min[axis] as number) + (bounds.max[axis] as number)) / 2,
  );

  /*
   * Widened until the whole grid fits the budget, by whole steps rather than by solving for it:
   * the count is a ceiling of a ratio, so the closed form would still have to be checked and a
   * loop over a handful of doublings is clearer than a formula nobody can verify by reading.
   */
  let step = Math.max(1e-3, spacing);
  let counts = countsFor(extent, step);
  while (counts[0] * counts[1] * counts[2] > budget && step < 1e9) {
    step *= 1.5;
    counts = countsFor(extent, step);
  }

  /*
   * **A budget too small for a margin collapses to one probe**, which is not a special case
   * anywhere: `probeGrid.ts` says a world that bakes one environment is a grid of one, through the
   * same array, convolution and shader. An axis with any extent needs three probes to surround it,
   * so the smallest grid that surrounds anything is twenty-seven — and a budget below that cannot
   * be met by widening, however far the step goes.
   */
  if (counts[0] * counts[1] * counts[2] > budget) {
    return {
      origin: [centre[0] as number, centre[1] as number, centre[2] as number],
      spacing: [step, step, step],
      counts: [1, 1, 1],
    };
  }

  const origin: Vec3 = [0, 0, 0];
  for (let axis = 0; axis < 3; axis += 1) {
    /* Centred on the scene, so the margin outside each face is the same. */
    origin[axis] = (centre[axis] as number) - (step * ((counts[axis] as number) - 1)) / 2;
  }
  return {
    origin,
    spacing: [step, step, step],
    counts: [counts[0] as number, counts[1] as number, counts[2] as number],
  };
}

/**
 * Probes an axis needs to span `extent` at `step`, with a cell of margin at each end.
 *
 * At least one, always: an axis with no extent — a scene that is a floor, or a point — is a single
 * probe rather than a count of zero, which would make the grid empty and the shading read nothing.
 */
function countsFor(extent: readonly number[], step: number): number[] {
  return extent.map((length) =>
    length <= 0 ? 1 : Math.ceil(length / step) + 1 + 2 * MARGIN_CELLS - 1,
  );
}
