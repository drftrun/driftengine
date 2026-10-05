/**
 * When a skinned cloth steps: its poses, whole fixed steps, the reset a teleport forces, the steps
 * a reset settles and the blend back into the simulation after it — apart from what a step does to
 * the particles, which a `ClothDevice` owns.
 *
 * **Apart so that two solvers take one decision.** `SkinnedCloth` here moves particles in arrays on
 * the CPU; `@driftengine/core` moves them in buffers on a GPU. Both are driven by this, so a frame
 * runs the same steps at the same fractions on either, a teleport resets both at the same pose, and
 * a blend reaches the simulation over the same steps — which is what lets the device parity check
 * compare positions rather than schedules.
 *
 * **What it gives up**: a device sees a step as a fraction and a blend share, not as the arrays it
 * came from, so a device that wanted a different schedule — substeps chosen per frame, say — would
 * have to grow this rather than decide it alone.
 */
import { jumped } from './clothPose.ts';
import { ClothTargets } from './clothTargets.ts';
import { resolveClothParameters } from './skinnedClothSetup.ts';
import type { ResolvedClothParameters, SkinnedClothSetup } from './skinnedClothSetup.ts';

/** What moves a skinned cloth's particles: the CPU's arrays, or a GPU's buffers. */
export interface ClothDevice {
  /**
   * The targets changed what they hold — took a pose, settled on it, or consumed the one a frame
   * stepped toward. A device that keeps its own copy of the skinned positions follows here.
   */
  targetsChanged(change: 'posed' | 'settled' | 'consumed'): void;
  /** Every particle at its latest skinned position, at rest, its step start with it. */
  rest(): void;
  /**
   * One fixed step, `fraction` of the way from the last pose to the latest. `blend` is the share of
   * the simulation kept against the skinned pose after it, or 0 for no blend at all — not 1, which
   * is a real last step of a blend and is applied.
   */
  step(fraction: number, blend: number): void;
}

/** A skinned cloth's schedule, over one device. */
export class ClothControl {
  readonly parameters: ResolvedClothParameters;
  readonly targets: ClothTargets;
  private accumulator = 0;
  /** Steps left in the blend from the skinned pose after a reset. */
  private blendLeft = 0;

  /**
   * `particlesOnCpu` false leaves the skinned particle positions to the device: the targets keep
   * the model matrices, the skin matrices and the colliders, which is all a GPU needs from them.
   */
  constructor(
    setup: SkinnedClothSetup,
    private readonly device: ClothDevice,
    particlesOnCpu = true,
  ) {
    this.parameters = resolveClothParameters(setup.parameters);
    this.targets = new ClothTargets(setup, particlesOnCpu);
  }

  /**
   * The skeleton's pose for the steps to come: each joint's global matrix, model space, sixteen
   * floats a joint, and the model matrix. The first pose, and one past the teleport thresholds,
   * resets the cloth to it; any other is reached across the steps of the next `advance`.
   */
  setPose(globals: Float32Array, model: Float32Array): void {
    const { teleportDistance, teleportAngle } = this.parameters;
    const first = !this.targets.posed;
    const jump = !first && jumped(this.targets.model, model, teleportDistance, teleportAngle);
    this.targets.pose(globals, model);
    this.device.targetsChanged('posed');
    if (first || jump) this.reset();
  }

  /**
   * Every particle at its skinned position, at rest; then the set-up's settle steps at once, and its
   * blend steps from the skinned pose into the simulation over the steps that follow.
   */
  reset(): void {
    this.targets.settle();
    this.device.targetsChanged('settled');
    this.device.rest();
    this.accumulator = 0;
    this.blendLeft = 0;
    for (let s = 0; s < this.parameters.settleSteps; s++) this.stepAt(1);
    this.blendLeft = this.parameters.blendSteps;
  }

  /**
   * Advance by `dt` seconds of the caller's time, in whole fixed steps; how many ran. The remainder
   * is kept for the next call, and `alpha` says how far into the next step it reaches.
   */
  advance(dt: number): number {
    this.accumulator += dt;
    const step = this.parameters.step;
    /* A millionth of a step of slack, so 1/30 is two steps of 1/60 and not one and a remainder. */
    const steps = Math.floor((this.accumulator + step * 1e-6) / step);
    for (let k = 0; k < steps; k++) {
      this.accumulator -= step;
      this.stepAt((k + 1) / steps);
    }
    if (steps > 0) this.consume();
    if (this.accumulator < 0) this.accumulator = 0;
    return steps;
  }

  /** How far the time handed to `advance` reaches into the next step, 0 to 1. */
  get alpha(): number {
    return Math.min(1, this.accumulator / this.parameters.step);
  }

  /** One fixed step, all the way to the latest pose: for a caller in the engine's fixed-step loop. */
  step(): void {
    this.stepAt(1);
    this.consume();
  }

  private consume(): void {
    this.targets.consume();
    this.device.targetsChanged('consumed');
  }

  /** The targets moved to `fraction`, the share a blend keeps, then the device's step. */
  private stepAt(fraction: number): void {
    this.targets.at(fraction);
    let blend = 0;
    if (this.blendLeft > 0) {
      blend = (this.parameters.blendSteps - this.blendLeft + 1) / this.parameters.blendSteps;
      this.blendLeft--;
    }
    this.device.step(fraction, blend);
  }
}
