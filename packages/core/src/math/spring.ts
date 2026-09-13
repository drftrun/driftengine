import { angleDelta, wrapAngle } from './scalar.ts';

/**
 * A critically damped spring: a value that *accelerates* toward a target and
 * settles on it.
 *
 * The counterpart to `damp`, and the difference is the whole reason this exists.
 * `damp` is a first-order lag: its speed is proportional to the error it has
 * already accumulated, so it is fastest on the first frame of a move and
 * asymptotic for the rest of it. It cannot ease in, cannot settle, and — the
 * part that bites — cannot follow a *moving* target without falling behind,
 * because the only way it can travel at the target's speed is to build up an
 * error of `speed / lambda` and hold it. A replay camera damping onto a character
 * at 14 m/s was measured framing every shot 2.2 m further out than the shot
 * asked for, and re-accumulating that error as a straight slide after every cut.
 *
 * This carries a velocity, so it has an acceleration profile — it leads into a
 * move and comes to rest at the end of one — and it is stepped against the
 * target's *own* velocity, so a target moving smoothly is ridden along with at
 * zero steady-state error rather than trailed.
 *
 * Long-lived and stateful by nature, hence a class: one per axis, constructed
 * once and mutated in place, so a per-frame caller allocates nothing.
 */
export class Spring {
  value = 0;
  velocity = 0;

  /** Place the spring, with no motion unless one is given. Use on a cut. */
  reset(value: number, velocity = 0): void {
    this.value = value;
    this.velocity = velocity;
  }

  /**
   * Step toward `target`, which is itself travelling at `targetVelocity`.
   *
   * `rate` is the convergence rate in 1/seconds, as `damp`'s lambda is — higher
   * is tighter — though the two are not numerically interchangeable: a spring at
   * the same figure is gentler, because it spends the start of a move
   * accelerating rather than covering ground.
   */
  step(target: number, targetVelocity: number, rate: number, dt: number): number {
    this.advance(
      this.value - startOf(target, targetVelocity, dt),
      target,
      targetVelocity,
      rate,
      dt,
    );
    return this.value;
  }

  /**
   * The same, along the shortest arc, for angles. The value stays folded into
   * (-π, π] so a long session cannot accumulate an unbounded angle.
   */
  stepAngle(target: number, targetVelocity: number, rate: number, dt: number): number {
    const from = startOf(target, targetVelocity, dt);
    this.advance(-angleDelta(this.value, from), target, targetVelocity, rate, dt);
    this.value = wrapAngle(this.value);
    return this.value;
  }

  /**
   * The analytic solution of `e'' = -ω²e - 2ωe'` over one step, in the target's
   * own frame of reference — which is what makes a moving target free of lag,
   * and only if the error going in is measured in that same frame. See
   * `startOf`: solving from an error taken against where the target has *got to*
   * while integrating to where it is *going* leaves a step's worth of target
   * motion unaccounted for every frame, which converges on twice the target's
   * velocity and 2V/ω of standing error — 4.56 m of the 4.667 m predicted, in
   * the first measurement taken of this.
   *
   * Solved rather than integrated because a spring stepped by Euler diverges
   * once `ω·dt` approaches 1, and this runs on a frame that can be 250 ms long
   * when a tab wakes up. `decay` stands in for `e^-x` with a rational
   * approximation that stays inside (0, 1] for every non-negative x, so a long
   * frame overshoots nothing — it just arrives.
   */
  private advance(
    error: number,
    target: number,
    targetVelocity: number,
    rate: number,
    dt: number,
  ): void {
    const omega = rate > 0 ? rate : 0;
    const relative = this.velocity - targetVelocity;
    const x = omega * dt;
    const decay = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
    const slope = relative + omega * error;
    this.value = target + (error + slope * dt) * decay;
    this.velocity = targetVelocity + (relative - omega * slope * dt) * decay;
  }
}

/**
 * Where a target travelling at `targetVelocity` was when this step began.
 *
 * `target` is where it has arrived, which is the natural thing for a caller to
 * have and the wrong end of the step to measure an error against.
 */
function startOf(target: number, targetVelocity: number, dt: number): number {
  return target - targetVelocity * dt;
}
