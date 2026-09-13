/**
 * What water does to a body that falls in.
 *
 * **Two things, and both are about momentum rather than about floating.** A kinematic body has no
 * mass to displace, so there is no buoyant force to compute — what a consumer actually wants is
 * that falling in *costs* something, and that the drop settles instead of accelerating into the
 * seabed.
 *
 * **Drag on every axis, not only the vertical one.** Killing horizontal momentum is the whole
 * reason falling in is a setback rather than a shortcut: a body that kept its speed underwater
 * would be taking a faster line.
 *
 * Zero game nouns, which is why it is here. What stays with a consumer is where the water is.
 */

export interface BuoyancyOptions {
  /**
   * The surface height. Default −Infinity, which is a world with no water in it.
   *
   * A consumer that has not asked reaches none of this and pays for none of it.
   */
  level?: number;
  /** How much of a body's speed a second of water takes, as a fraction. */
  drag?: number;
  /** The fastest a submerged body sinks, metres a second. Negative is downward. */
  sinkSpeed?: number;
}

export interface Buoyancy {
  readonly level: number;
  readonly drag: number;
  readonly sinkSpeed: number;
}

/** Anything with a velocity. Declared structurally so nothing is imported in either direction. */
export interface BuoyantState {
  velX: number;
  velY: number;
  velZ: number;
}

export function createBuoyancy(options: BuoyancyOptions = {}): Buoyancy {
  return {
    level: options.level ?? -Infinity,
    drag: options.drag ?? 0,
    sinkSpeed: options.sinkSpeed ?? 0,
  };
}

/**
 * Apply it, and report whether the body is submerged.
 *
 * @param y Where the body is. Under `level` is submerged.
 * @returns Whether it was, so a consumer can count the time or drown somebody — which is a game's
 *   decision and not this function's.
 */
export function applyBuoyancy(
  water: Buoyancy,
  y: number,
  state: BuoyantState,
  dt: number,
): boolean {
  if (y >= water.level) return false;

  /*
   * Clamped at zero: `1 − drag·dt` goes negative past `dt = 1/drag`, and a negative factor does
   * not slow a body, it throws it backwards. The worst a long step can do is stop it dead.
   */
  const kept = Math.max(0, 1 - water.drag * dt);
  state.velX *= kept;
  state.velY *= kept;
  state.velZ *= kept;

  /* A floor on the fall rather than a speed it is driven to: a body drifting down slower than
     terminal is left alone, and one falling faster is settled to it. */
  if (state.velY < water.sinkSpeed) state.velY = water.sinkSpeed;
  return true;
}
