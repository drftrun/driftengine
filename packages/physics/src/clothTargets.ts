/**
 * A skinned cloth's pose: where skinning puts every particle at the last two poses, where it puts
 * them at a step between, and where the colliders are.
 *
 * **Interpolated across the steps of one frame.** A frame that runs two steps moves its kinematic
 * particles half way at the first and the rest at the second, rather than all at once — a fixed
 * step must not turn a 120 Hz animation into a 60 Hz one with a jump in it. The model matrix is
 * blended the same way for the inertia carry; a blend of two rigid matrices is not quite rigid, by
 * the few thousandths of a degree a character turns between two steps.
 *
 * Before any pose the rest positions stand in, under an identity model, so a cloth that is never
 * posed is the plain solver it was in H1's tests.
 *
 * **The particles' skinned positions can be left to a device.** A GPU solver skins them itself, from
 * `skin`, so `particlesOnCpu` false keeps only what is per joint or per collider — the model
 * matrices, the skin matrices and the colliders' ends — and `position`, `normal` and `latest` then
 * hold the rest pose and are not to be read.
 */
import { placeColliders, skinMatrices, skinParticles } from './clothPose.ts';
import type { ClothCollider, SkinnedClothSetup } from './skinnedClothSetup.ts';

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** Skinned positions and normals from the last two poses, and the model matrices between. */
export class ClothTargets {
  /** Where skinning puts each particle at the step being taken. */
  readonly position: Float32Array;
  /** Its skinned normal at the latest pose. */
  readonly normal: Float32Array;
  /** The model matrix at the step being taken, and at the one before it. */
  readonly modelNow = new Float32Array(IDENTITY);
  readonly modelBefore = new Float32Array(IDENTITY);
  /** Each collider's two ends, six floats a collider, at the latest pose. */
  readonly colliderEnds: Float32Array;
  /** Each collider's two radii. */
  readonly colliderRadii: Float32Array;
  /** Whether a pose has been given at all. */
  posed = false;

  /** `model × global × inverse bind` a joint at the latest pose, or null for a cloth with no rig. */
  readonly skin: Float32Array | null;

  private readonly from: Float32Array;
  private readonly to: Float32Array;
  private readonly modelFrom = new Float32Array(IDENTITY);
  private readonly modelTo = new Float32Array(IDENTITY);
  private readonly scratch = new Float32Array(32);
  private readonly colliders: readonly ClothCollider[];

  constructor(
    private readonly setup: SkinnedClothSetup,
    private readonly particlesOnCpu = true,
  ) {
    const count = setup.positions.length;
    this.from = new Float32Array(setup.positions);
    this.to = new Float32Array(setup.positions);
    this.position = new Float32Array(setup.positions);
    this.normal = new Float32Array(count);
    const bones = (setup.inverseBind?.length ?? 0) / 16;
    this.skin = setup.joints === undefined || bones === 0 ? null : new Float32Array(bones * 16);
    this.colliders = setup.colliders ?? [];
    this.colliderEnds = new Float32Array(this.colliders.length * 6);
    this.colliderRadii = new Float32Array(this.colliders.length * 2);
    this.colliders.forEach((collider, k) => {
      this.colliderRadii[k * 2] = collider.radius;
      this.colliderRadii[k * 2 + 1] = collider.radius2 ?? collider.radius;
    });
    this.skinAt(new Float32Array(Math.max(16, bones * 16)), this.modelTo);
  }

  /** The model matrix the latest pose was given at. */
  get model(): Float32Array {
    return this.modelTo;
  }

  /** Take a new pose: the old one becomes where this frame's steps start from. */
  pose(globals: Float32Array, model: Float32Array): void {
    this.from.set(this.to);
    this.modelFrom.set(this.modelTo);
    this.modelTo.set(model);
    this.skinAt(globals, model);
    if (this.colliders.length > 0) {
      placeColliders(this.colliders, globals, model, this.scratch, this.colliderEnds);
    }
    this.posed = true;
  }

  /** Forget the pose before the latest: steps start where the latest one is. */
  settle(): void {
    this.from.set(this.to);
    this.position.set(this.to);
    this.modelFrom.set(this.modelTo);
    this.modelNow.set(this.modelTo);
    this.modelBefore.set(this.modelTo);
  }

  /**
   * The steps of a frame have run: the next frame's start from this pose, not the one before it, or
   * a frame given no new pose would interpolate back from the old one and jump the cloth.
   */
  consume(): void {
    this.from.set(this.to);
    this.modelFrom.set(this.modelTo);
  }

  /** The skinned positions and the model matrix `fraction` of the way from the last pose to this one. */
  at(fraction: number): void {
    const { from, to, position } = this;
    if (this.particlesOnCpu) {
      for (let i = 0; i < to.length; i++) {
        const a = from[i] as number;
        position[i] = a + ((to[i] as number) - a) * fraction;
      }
    }
    this.modelBefore.set(this.modelNow);
    for (let i = 0; i < 16; i++) {
      const a = this.modelFrom[i] as number;
      this.modelNow[i] = a + ((this.modelTo[i] as number) - a) * fraction;
    }
  }

  /** The latest skinned positions, which `reset` puts every particle at. */
  get latest(): Float32Array {
    return this.to;
  }

  private skinAt(globals: Float32Array, model: Float32Array): void {
    const { setup, skin } = this;
    if (skin !== null && setup.inverseBind !== undefined) {
      skinMatrices(globals, setup.inverseBind, model, this.scratch, skin);
    }
    if (!this.particlesOnCpu) return;
    skinParticles(
      setup.positions,
      setup.normals ?? null,
      setup.joints ?? null,
      setup.weights ?? null,
      setup.joints2 ?? null,
      setup.weights2 ?? null,
      skin,
      model,
      this.to,
      this.normal,
    );
  }
}
