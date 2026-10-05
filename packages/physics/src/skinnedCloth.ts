/**
 * A skinned cloth on the CPU: the reference solver, and the one WebGL2 and Node run.
 *
 * **Whole fixed steps, whatever the frame.** The set-up names its step (a garment's is 1/60); a
 * caller in the engine's own fixed-step loop calls `step` once a tick, and any other calls `advance`
 * with the frame's time and the remainder waits for the next frame. The cloth therefore behaves the
 * same at 60, 120 and 144 frames a second, and a frame draws it on `alpha` between its last two
 * steps — the engine's rule, and what keeps a high refresh rate from drawing the same cloth twice.
 *
 * **What it gives up**: an `advance` of a long time runs that many steps, with no ceiling; a caller
 * that stalls for a second gets a second of cloth. The engine's loop clamps its own catch-up, and a
 * caller outside it is expected to clamp the time it hands over.
 *
 * Every step allocates nothing. The WebGPU solver in `@driftengine/core` runs the same kernels over
 * the same data (`skinnedClothSolve.ts`, `clothLimits.ts`) under the same `ClothControl`, and is held
 * to this one by a parity check on the device.
 */
import { batchesOf } from './clothBatches.ts';
import { ClothControl } from './clothControl.ts';
import type { ClothDevice } from './clothControl.ts';
import { applyColliders, applyMaxDistance, applyStops } from './clothLimits.ts';
import { carryParticles } from './clothPose.ts';
import type { ClothTargets } from './clothTargets.ts';
import { exactExp } from './exact.ts';
import type { ClothBatches } from './clothBatches.ts';
import {
  finishParticles,
  predictParticles,
  solveBendingBatch,
  solveDistanceBatch,
  solveTethers,
} from './skinnedClothSolve.ts';
import { validateClothSetup } from './skinnedClothSetup.ts';
import type {
  ClothLimits,
  ResolvedClothParameters,
  SkinnedClothSetup,
  TetherConstraints,
} from './skinnedClothSetup.ts';

/** One kind of constraint, ready to solve: its arrays, its multipliers and its batches. */
interface Solvable {
  readonly indices: Uint32Array;
  readonly rest: Float32Array;
  readonly compliance: Float32Array;
  readonly lambda: Float32Array;
  readonly batches: ClothBatches;
}

function solvable(
  name: string,
  indices: Uint32Array,
  arity: number,
  rest: Float32Array,
  compliance: Float32Array,
  inverseMass: Float32Array,
  given: Uint32Array | undefined,
): Solvable {
  const batches = batchesOf(name, indices, arity, inverseMass, given);
  return { indices, rest, compliance, lambda: new Float32Array(rest.length), batches };
}

/**
 * A garment's particles, constraints and solver state, stepped at the set-up's fixed step. Read
 * `positions` after a step, or `interpolate` between the last two for a frame's `alpha`. The
 * schedule — poses, steps, resets, the blend — is `ClothControl`'s; this is its CPU device.
 */
export class SkinnedCloth {
  /** How many particles. */
  readonly count: number;
  /** Where each particle is now, three floats a particle. */
  readonly positions: Float32Array;
  /** Metres a second, three floats a particle. */
  readonly velocities: Float32Array;
  readonly inverseMass: Float32Array;
  /** The parameters with their defaults filled in. */
  readonly parameters: ResolvedClothParameters;

  /** Where each particle was when the last step began, for drawing on `alpha`. */
  private readonly stepStart: Float32Array;
  /** Where each particle was when the current substep began, for its velocity. */
  private readonly substepStart: Float32Array;
  private readonly distance: Solvable;
  private readonly bending: Solvable | null;
  private readonly tethers: TetherConstraints | null;
  private readonly control: ClothControl;
  private readonly targets: ClothTargets;
  private readonly limits: ClothLimits;
  private readonly colliders: number;
  /** The air the cloth drags toward, metres a second: the set-up's until `setWind` says otherwise. */
  private readonly wind: [number, number, number];

  constructor(setup: SkinnedClothSetup) {
    validateClothSetup(setup);
    this.count = setup.positions.length / 3;
    this.positions = new Float32Array(setup.positions);
    this.velocities = new Float32Array(setup.positions.length);
    this.stepStart = new Float32Array(setup.positions);
    this.substepStart = new Float32Array(setup.positions.length);
    this.inverseMass = new Float32Array(setup.inverseMass);
    const { distance, bending } = setup;
    this.distance = solvable(
      'distance',
      distance.pairs,
      2,
      distance.rest,
      distance.compliance,
      this.inverseMass,
      distance.batches,
    );
    this.bending =
      bending === undefined
        ? null
        : solvable(
            'bending',
            bending.quads,
            4,
            bending.rest,
            bending.compliance,
            this.inverseMass,
            bending.batches,
          );
    this.tethers = setup.tethers ?? null;
    this.limits = setup.limits ?? {};
    this.colliders = setup.colliders?.length ?? 0;
    /* Made once, so a step builds nothing: the control calls back into the private step. */
    const device: ClothDevice = {
      targetsChanged: () => {},
      rest: () => {
        this.rest();
      },
      step: (fraction, blend) => {
        this.stepAt(fraction, blend);
      },
    };
    this.control = new ClothControl(setup, device);
    this.parameters = this.control.parameters;
    this.targets = this.control.targets;
    this.wind = [...this.parameters.wind];
  }

  /**
   * The air the steps to come drag the cloth toward, world space, metres a second: the frame's
   * sample of the scene's one wind, so a garment moves with the smoke and the grass rather than
   * with a second wind of its own. See `AGENTS.md`, "One wind, sampled once".
   */
  setWind(x: number, y: number, z: number): void {
    this.wind[0] = x;
    this.wind[1] = y;
    this.wind[2] = z;
  }

  /** See `ClothControl.setPose`. */
  setPose(globals: Float32Array, model: Float32Array): void {
    this.control.setPose(globals, model);
  }

  /** See `ClothControl.reset`. */
  reset(): void {
    this.control.reset();
  }

  /** See `ClothControl.advance`. */
  advance(dt: number): number {
    return this.control.advance(dt);
  }

  /** How far the time handed to `advance` reaches into the next step, 0 to 1. */
  get alpha(): number {
    return this.control.alpha;
  }

  /** Each particle between the start and the end of the last step, at `alpha`, into `out`. */
  interpolate(alpha: number, out: Float32Array): void {
    const from = this.stepStart;
    const to = this.positions;
    for (let i = 0; i < to.length; i++) {
      const a = from[i] as number;
      out[i] = a + ((to[i] as number) - a) * alpha;
    }
  }

  /** One fixed step, all the way to the latest pose: for a caller in the engine's fixed-step loop. */
  step(): void {
    this.control.step();
  }

  /** Every particle at its latest skinned position, at rest. */
  private rest(): void {
    this.positions.set(this.targets.latest);
    this.stepStart.set(this.positions);
    this.velocities.fill(0);
  }

  /**
   * One fixed step, `fraction` of the way from the last pose to the latest: carried by the share of
   * the character's motion it does not keep, its kinematic particles placed, then its substeps —
   * each predicted, constrained, limited and turned into velocities.
   */
  private stepAt(fraction: number, blend: number): void {
    /* Where the last step ended, kinematic particles included, before this one moves anything. */
    this.stepStart.set(this.positions);
    const { step, substeps, iterations, damping, drag, gravity } = this.parameters;
    const wind = this.wind;
    const targets = this.targets;
    carryParticles(
      this.positions,
      this.velocities,
      this.inverseMass,
      targets.modelBefore,
      targets.modelNow,
      this.parameters.linearInertia,
      this.parameters.angularInertia,
    );
    placeKinematic(this.positions, this.inverseMass, targets.position);
    const h = step / substeps;
    const invH = 1 / h;
    const invH2 = invH * invH;
    const keep = exactExp(damping * h);
    const dragKeep = exactExp(drag * h);
    for (let s = 0; s < substeps; s++) {
      predictParticles(
        this.positions,
        this.substepStart,
        this.velocities,
        this.inverseMass,
        h,
        keep,
        dragKeep,
        gravity,
        wind,
      );
      this.distance.lambda.fill(0);
      this.bending?.lambda.fill(0);
      for (let pass = 0; pass < iterations; pass++) {
        this.solve(this.distance, solveDistanceBatch, invH2);
        if (this.bending !== null) this.solve(this.bending, solveBendingBatch, invH2);
        const tethers = this.tethers;
        if (tethers !== null) {
          solveTethers(this.positions, tethers.particles, tethers.anchors, tethers.lengths);
        }
      }
      this.limit();
      finishParticles(this.positions, this.substepStart, this.velocities, this.inverseMass, invH);
    }
    if (blend > 0) this.blend(blend);
  }

  /** The limits and the colliders, after the constraints, so a garment pulling into the body loses. */
  private limit(): void {
    const { positions, inverseMass, targets, limits } = this;
    const { maxDistanceScale, margin } = this.parameters;
    if (limits.maxDistance !== undefined) {
      applyMaxDistance(
        positions,
        inverseMass,
        targets.position,
        limits.maxDistance,
        maxDistanceScale,
      );
    }
    if (limits.backstop !== undefined) {
      applyStops(positions, inverseMass, targets.position, targets.normal, limits.backstop, -1);
    }
    if (limits.frontstop !== undefined) {
      applyStops(positions, inverseMass, targets.position, targets.normal, limits.frontstop, 1);
    }
    if (this.colliders > 0) {
      applyColliders(
        positions,
        inverseMass,
        limits.thickness ?? null,
        margin,
        targets.colliderEnds,
        targets.colliderRadii,
        this.colliders,
      );
    }
  }

  /** After a reset, the share of the simulation drawn grows from nothing to all over the blend. */
  private blend(share: number): void {
    const target = this.targets.position;
    for (let i = 0; i < this.positions.length; i++) {
      const t = target[i] as number;
      this.positions[i] = t + ((this.positions[i] as number) - t) * share;
      this.velocities[i] = (this.velocities[i] as number) * share;
    }
  }

  /** Every batch of one kind, in colour order. */
  private solve(kind: Solvable, kernel: typeof solveDistanceBatch, invH2: number): void {
    const { batches, order } = kind.batches;
    for (let b = 0; b + 1 < batches.length; b++) {
      kernel(
        this.positions,
        this.inverseMass,
        kind.indices,
        kind.rest,
        kind.compliance,
        kind.lambda,
        order,
        batches[b] as number,
        batches[b + 1] as number,
        invH2,
      );
    }
  }
}

/** Every kinematic particle exactly where skinning puts it at this step. */
function placeKinematic(
  position: Float32Array,
  inverseMass: Float32Array,
  target: Float32Array,
): void {
  for (let i = 0; i < inverseMass.length; i++) {
    if ((inverseMass[i] as number) !== 0) continue;
    position[i * 3] = target[i * 3] as number;
    position[i * 3 + 1] = target[i * 3 + 1] as number;
    position[i * 3 + 2] = target[i * 3 + 2] as number;
  }
}
