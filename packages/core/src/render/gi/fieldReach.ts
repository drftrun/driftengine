/**
 * Whether the traced field reaches the probes it lights: how many cascades a grid needs, and which
 * scheduled probes the field reaches this frame.
 *
 * **A probe traced where the field is not learns that the world is sky.** Every ray it casts finds
 * nothing and falls to the sky colour, the floor under it and the wall beside it included, so it
 * reports the open sky from every side: a covered arcade lit like a field at noon. The field is
 * composed around the camera, and three cascades from a 4 m inner one reach 16 m, so a courtyard 36
 * m long had its far end lit exactly that way from wherever the viewer stood, a milky wash over
 * everything past the outermost cascade that the rasterised grid did not have.
 *
 * Two answers, one for each way it happens. A grid is given the cascades that reach all of it from
 * anywhere inside it; and a probe the field still does not reach, because the camera has left the
 * grid, is left out of the schedule and keeps the light it has, rather than being overwritten with
 * a sky it never saw. What it gives up is that probe following a change while the camera is away.
 */
import { GLOBAL_FIELD_BLEND } from './globalField.ts';
import type { ProbeGrid } from '../probeGrid.ts';

/** The share of the outermost cascade's half-extent a probe can trust, inside its fading faces. */
const TRUSTED = 1 - 2 * GLOBAL_FIELD_BLEND;

/**
 * Cascades enough for the outermost to hold the whole grid, and one probe step past it, within the
 * part of it that is trusted, wherever inside the grid the camera stands. At least `least` and at
 * most `most`: each cascade is the same number of samples, so the bound is on memory, not reach.
 */
export function cascadesForGrid(
  grid: ProbeGrid,
  radius: number,
  least: number,
  most: number,
): number {
  let span = 0;
  let step = 0;
  for (let axis = 0; axis < 3; axis++) {
    const spacing = grid.spacing[axis] as number;
    span = Math.max(span, spacing * ((grid.counts[axis] as number) - 1));
    step = Math.max(step, spacing);
  }
  const needed = (span + step) / TRUSTED;
  let cascades = 1;
  while (radius * 2 ** (cascades - 1) < needed && cascades < most) cascades++;
  return Math.min(most, Math.max(least, cascades));
}

const at: [number, number, number] = [0, 0, 0];

/**
 * Keeps, in place and in order, the scheduled probes inside the trusted part of the outermost
 * cascade, `bounds` as `[minX, minY, minZ, maxX, maxY, maxZ]`. Returns how many are kept.
 */
export function probesTheFieldReaches(
  grid: ProbeGrid,
  scheduled: Int32Array,
  count: number,
  bounds: ArrayLike<number>,
): number {
  let kept = 0;
  for (let i = 0; i < count; i++) {
    const layer = scheduled[i] as number;
    grid.positionOf(layer, at);
    let inside = true;
    for (let axis = 0; axis < 3; axis++) {
      const low = bounds[axis] as number;
      const high = bounds[axis + 3] as number;
      const band = GLOBAL_FIELD_BLEND * (high - low);
      const p = at[axis] as number;
      if (p < low + band || p > high - band) inside = false;
    }
    if (inside) scheduled[kept++] = layer;
  }
  return kept;
}
