import { sampleWind } from './wind.ts';
import type { WindProfile, WindState } from './wind.ts';

/**
 * The world's wind, as one value passed to everything that moves in it.
 *
 * Six draw calls each taking two or three loose floats is a contract nobody can
 * see: the rule "everything shares one wind" lives only in the discipline of
 * whoever writes the next call site. As a type it is checkable at a glance, and
 * adding a seventh consumer is a matter of accepting the same object rather
 * than remembering to pass matching numbers.
 *
 * Sample once per frame and pass it down. A system that samples its own is a
 * second wind however identical the inputs, because nothing then guarantees the
 * two stay in step.
 */
export interface WindField extends WindState {
  /**
   * Accumulated travel, for anything positioned by wind rather than displaced
   * by it — clouds, most obviously.
   *
   * Accumulated rather than derived from `velocity x time`, and that is the
   * whole reason this lives on the type. The bearing wanders, so multiplying a
   * *changing* direction by an absolute clock jumps whatever it positions the
   * instant the direction moves, by an amount proportional to how long the game
   * has been running. It is invisible in a short test and violent later.
   */
  driftX: number;
  driftZ: number;
}

export function createWindField(): WindField {
  return { velocityX: 0, velocityZ: 0, speed: 0, gust: 0, driftX: 0, driftZ: 0 };
}

/**
 * Advance the field one frame. `driftScale` converts wind speed into travel for
 * whatever the drift is positioning.
 */
export function advanceWindField(
  field: WindField,
  profile: WindProfile,
  timeSeconds: number,
  frameDt: number,
  driftScale: number,
): void {
  sampleWind(profile, timeSeconds, field);
  field.driftX += field.velocityX * driftScale * frameDt;
  field.driftZ += field.velocityZ * driftScale * frameDt;
}
