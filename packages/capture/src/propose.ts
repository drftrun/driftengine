/**
 * Each region as something a scene could hold — a *proposal*, and the word is load-bearing.
 *
 * **This is stage four and it is labelled as such.** A capture that guesses what an object is and
 * acts on the guess is a capture that puts a door where a cupboard was, and the cost is paid by
 * somebody who cannot see why. So a region arrives with what is known about it and nothing more,
 * and **a region nobody labelled becomes static scenery** — the safe default in the strict sense:
 * drawn, solid, and doing nothing. Being wrong about that costs nothing at all.
 *
 * The component names are the engine's own, as data. Nothing here imports an entity model, because
 * a proposal a consumer has not accepted yet should not have built anything.
 */
import { exactCos } from '@driftengine/core';

import type { Region } from './segment.ts';

export interface ProposeOptions {
  /** The steepest surface a character could stand on, in degrees. */
  readonly slopeDegrees?: number;
}

const DEFAULT_SLOPE = 45;

/** What a scene could make of a region. */
export interface EntityProposal {
  /** Its index in the regions it came from. */
  readonly region: number;
  readonly bounds: Float64Array;
  readonly label: string | null;
  /**
   * Components a scene might give it, by the engine's own names.
   *
   * A *suggestion*, and the word is load-bearing: nothing here knows what the thing is, only what
   * shape it is and whether anybody named it.
   */
  readonly components: readonly string[];
  /** Whether a character could stand on it. */
  readonly walkable: boolean;
}

/** Drawn and solid and nothing else, which is what an unlabelled region gets. */
export const SCENERY_COMPONENTS: readonly string[] = ['transform', 'mesh', 'collider'];
/** The same, and a navigation surface on top of it. */
export const WALKABLE_COMPONENTS: readonly string[] = [
  'transform',
  'mesh',
  'collider',
  'navigation',
];
/** Something small enough and named: a scene may want to move it. */
export const MOVABLE_COMPONENTS: readonly string[] = ['transform', 'mesh', 'collider', 'body'];

/**
 * Each region as a proposal.
 *
 * **An unlabelled region is scenery**, whatever its shape: drawn, solid, and doing nothing. A named
 * region small enough to pick up is offered as movable, and the floor — the largest surface a
 * character could stand on — is offered with a navigation surface. Nothing here is decided; a
 * consumer reads `components` as a starting point and overrides whatever it likes.
 */
export function proposeEntities(
  regions: readonly Region[],
  options: ProposeOptions = {},
): EntityProposal[] {
  const slope = exactCos(((options.slopeDegrees ?? DEFAULT_SLOPE) * Math.PI) / 180);
  let floor = -1;
  let widest = 0;
  regions.forEach((region, at) => {
    if ((region.normal[1] as number) < slope) return;
    if (region.area <= widest) return;
    widest = region.area;
    floor = at;
  });

  return regions.map((region, at) => {
    const walkable = at === floor;
    const span = Math.max(
      (region.bounds[3] as number) - (region.bounds[0] as number),
      (region.bounds[4] as number) - (region.bounds[1] as number),
      (region.bounds[5] as number) - (region.bounds[2] as number),
    );
    /* Named and small enough that a person could shift it: the only case that is not scenery. */
    const movable = region.label !== null && span < 1.2;
    return {
      region: at,
      bounds: region.bounds,
      label: region.label,
      components: walkable
        ? WALKABLE_COMPONENTS
        : movable
          ? MOVABLE_COMPONENTS
          : SCENERY_COMPONENTS,
      walkable,
    };
  });
}
