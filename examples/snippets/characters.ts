/**
 * A body the geometry has trapped, noticed and nudged out, and a first-person accelerate.
 *
 * A snippet, typechecked with the examples and quoted by the manual's characters chapter.
 */
import { ESCAPE_SEALED, StallEscape, accelerateAlong } from '@driftengine/physics';
import type { Body, ColliderSet, StallInput } from '@driftengine/physics';

// #region escape
/** Thirty ticks of going nowhere arms it, and it may push four metres before calling it sealed. */
const escape = new StallEscape({ stalledTicks: 30, budgetM: 4 });

/** Last in the tick, after the move has resolved: it reads where the body ended up. */
export function unstick(
  body: Body,
  colliders: ColliderSet,
  input: StallInput,
  respawn: () => void,
): void {
  if (escape.step(body, colliders, input) === ESCAPE_SEALED) respawn();
}
// #endregion

// #region accelerate
/** Toward the wish, clamped against the shortfall along it: what makes air-strafing work. */
export function accelerate(
  velocity: { velX: number; velZ: number },
  wishX: number,
  wishZ: number,
  dt: number,
): number {
  return accelerateAlong(velocity, wishX, wishZ, 7, 50, dt);
}
// #endregion
