/**
 * A skinned cloth for a renderer: `@driftengine/physics`' solver, run as compute on WebGPU — the
 * particles never leave the device — and as `SkinnedCloth` on the CPU under WebGL2, which has no
 * compute. One schedule, `ClothControl`, and the same kernels either way; what a frame draws is
 * `particles`, through `setCloth(binding, cloth.particles)`.
 *
 * **A function rather than renderer methods, so a game pays for it only by importing it.** See
 * `backend/webgpu/computeHost.ts` for the door it reaches the device through, and why.
 *
 * **The CPU fallback's cost**, measured on a desktop part: a few hundred particles are a
 * millisecond a frame on the main thread, and 4,500 are twenty — a garment that size wants the
 * device. The device solver ran 4,500 particles in 0.65 ms a frame, most of it the dispatches
 * rather than the particles (`demo/dev/skinnedCloth.html?bench=1`).
 *
 * **Several garments step as one with `createSkinnedClothSet`**: one pass, one submit and one
 * garment's dispatches a step for all of them, where a garment each was a pass, a submit and its
 * own dispatches each. They must share a step, substeps, iterations and most steps a frame.
 */
import { SkinnedCloth } from '@driftengine/physics';
import type { SkinnedClothSetup } from '@driftengine/physics';

import type { ClothParticlesHandle, RendererApi } from './backend/api.ts';
import { computeHostOf } from './backend/webgpu/computeHost.ts';
import type { ComputeHost } from './backend/webgpu/computeHost.ts';
import { GpuClothSet } from './backend/webgpu/gpuClothSet.ts';

/** A garment a renderer solves, from `createSkinnedCloth`. */
export interface SkinnedClothSolver {
  /** What `setCloth(binding, particles)` draws the garment's bound meshes by. */
  readonly particles: ClothParticlesHandle;
  /** Where the solver runs: on the device, or on the CPU beneath a backend without compute. */
  readonly runsOn: 'device' | 'cpu';
  /**
   * One frame: the rig's pose — each joint's global matrix, model space, sixteen floats a joint,
   * and the model matrix — and `dt` seconds, run as whole fixed steps; the particles at the frame's
   * `alpha` are then what the frame draws. **Once a frame, before the draws**, as
   * `updateClothParticles` is: a second in one frame would reach every draw of it on WebGPU.
   */
  step(globals: Float32Array, model: Float32Array, dt: number): void;
  /**
   * The air the cloth drags toward from the next step, world space, metres a second: the frame's
   * sample of the scene's one `WindField`, so a garment moves with everything else in the air.
   */
  setWind(x: number, y: number, z: number): void;
  /** Back to the skinned pose, settled, as a teleport resets it. */
  reset(): void;
  dispose(): void;
}

/** Garments a renderer solves together, from `createSkinnedClothSet`, each named by its index. */
export interface SkinnedClothSet {
  /** Each garment's particles, in the order its set-up was given: what `setCloth` draws it by. */
  readonly particles: readonly ClothParticlesHandle[];
  /** Where the set runs: on the device, or on the CPU beneath a backend without compute. */
  readonly runsOn: 'device' | 'cpu';
  /**
   * Garment `g`'s rig for the next `step`: each joint's global matrix, model space, sixteen floats a
   * joint, and the model matrix. A garment not posed in a frame steps toward its last pose.
   */
  setPose(g: number, globals: Float32Array, model: Float32Array): void;
  /** The air garment `g` drags toward from its next step: the frame's sample of the one wind. */
  setWind(g: number, x: number, y: number, z: number): void;
  /** Garment `g` back to its skinned pose, settled, as a teleport resets it. */
  reset(g: number): void;
  /**
   * `dt` seconds for every garment, run as whole fixed steps; each garment's particles at its
   * `alpha` are then what the frame draws. **Once a frame, before the draws**, as a solver's `step`.
   */
  step(dt: number): void;
  dispose(): void;
}

/** A garment for `renderer`, from a set-up checked by name. */
export function createSkinnedCloth(
  renderer: RendererApi,
  setup: SkinnedClothSetup,
): SkinnedClothSolver {
  const host = computeHostOf(renderer);
  const set =
    host === null ? new CpuClothSet(renderer, [setup]) : new DeviceClothSet(host, [setup]);
  return new OneGarment(set);
}

/** A set of one, as a solver: what `createSkinnedCloth` hands back. */
class OneGarment implements SkinnedClothSolver {
  readonly particles: ClothParticlesHandle;
  readonly runsOn: 'device' | 'cpu';

  constructor(private readonly set: DeviceClothSet | CpuClothSet) {
    this.particles = set.particles[0] as ClothParticlesHandle;
    this.runsOn = set.runsOn;
  }

  step(globals: Float32Array, model: Float32Array, dt: number): void {
    this.set.setPose(0, globals, model);
    this.set.step(dt);
  }

  setWind(x: number, y: number, z: number): void {
    this.set.setWind(0, x, y, z);
  }

  reset(): void {
    this.set.reset(0);
  }

  dispose(): void {
    this.set.dispose();
  }

  /** The particles where the last step left them: the parity check's door. */
  read(): Promise<Float32Array> {
    return this.set.read(0);
  }
}

/**
 * Garments for `renderer` stepped together, from set-ups checked by name: one pass, one submit and
 * one garment's dispatches a step on the device, whatever the count. They must agree on `step`,
 * `substeps`, `iterations` and `maxSteps`, and are refused by the first they disagree on.
 */
export function createSkinnedClothSet(
  renderer: RendererApi,
  setups: readonly SkinnedClothSetup[],
): SkinnedClothSet {
  const host = computeHostOf(renderer);
  return host === null ? new CpuClothSet(renderer, setups) : new DeviceClothSet(host, setups);
}

class DeviceClothSet implements SkinnedClothSet {
  readonly runsOn = 'device';
  readonly particles: readonly ClothParticlesHandle[];
  private readonly set: GpuClothSet;

  constructor(
    private readonly host: ComputeHost,
    setups: readonly SkinnedClothSetup[],
  ) {
    this.set = new GpuClothSet(host.device(), setups);
    const particles: ClothParticlesHandle[] = [];
    for (let g = 0; g < this.set.size; g++) particles.push(this.set.particles(g));
    this.particles = particles;
  }

  setPose(g: number, globals: Float32Array, model: Float32Array): void {
    if (this.host.lost()) return;
    this.set.setPose(g, globals, model);
  }

  setWind(g: number, x: number, y: number, z: number): void {
    this.set.setWind(g, x, y, z);
  }

  reset(g: number): void {
    if (this.host.lost()) return;
    this.set.reset(g);
  }

  step(dt: number): void {
    if (this.host.lost()) return;
    this.set.step(dt, this.host.changeFrame());
  }

  /** Its buffers at once — its work is submitted — and its textures with the frame's. */
  dispose(): void {
    this.set.dispose();
    for (let g = 0; g < this.set.size; g++) this.host.retire(this.set.particles(g).textures);
  }

  /** Garment `g`'s particles where its last step left them: the parity check's, waits on the device. */
  read(g: number): Promise<Float32Array> {
    return this.set.read(g);
  }
}

class CpuClothSet implements SkinnedClothSet {
  readonly runsOn = 'cpu';
  readonly particles: readonly ClothParticlesHandle[];
  private readonly cloths: readonly SkinnedCloth[];
  /** Each garment's particles at `alpha`, before they go up. */
  private readonly staging: readonly Float32Array[];

  constructor(
    private readonly renderer: RendererApi,
    setups: readonly SkinnedClothSetup[],
  ) {
    this.cloths = setups.map((setup) => new SkinnedCloth(setup));
    this.particles = this.cloths.map((cloth) => renderer.createClothParticles(cloth.count));
    this.staging = this.cloths.map((cloth) => new Float32Array(cloth.count * 3));
  }

  setPose(g: number, globals: Float32Array, model: Float32Array): void {
    this.at(g).setPose(globals, model);
  }

  setWind(g: number, x: number, y: number, z: number): void {
    this.at(g).setWind(x, y, z);
  }

  reset(g: number): void {
    this.at(g).reset();
  }

  step(dt: number): void {
    for (let g = 0; g < this.cloths.length; g++) {
      const cloth = this.cloths[g] as SkinnedCloth;
      const staging = this.staging[g] as Float32Array;
      cloth.advance(dt);
      cloth.interpolate(cloth.alpha, staging);
      this.renderer.updateClothParticles(this.particles[g] as ClothParticlesHandle, staging);
    }
  }

  dispose(): void {
    for (const particles of this.particles) this.renderer.disposeClothParticles(particles);
  }

  /** Garment `g`'s particles where its last step left them, as the device set reads its own. */
  read(g: number): Promise<Float32Array> {
    return Promise.resolve(new Float32Array(this.at(g).positions));
  }

  private at(g: number): SkinnedCloth {
    const cloth = this.cloths[g];
    if (cloth === undefined) throw new Error(`skinned cloth set: no garment ${g}`);
    return cloth;
  }
}
