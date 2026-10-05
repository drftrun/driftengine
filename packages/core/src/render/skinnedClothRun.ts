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
 */
import { SkinnedCloth } from '@driftengine/physics';
import type { SkinnedClothSetup } from '@driftengine/physics';

import type { ClothParticlesHandle, RendererApi } from './backend/api.ts';
import { computeHostOf } from './backend/webgpu/computeHost.ts';
import type { ComputeHost } from './backend/webgpu/computeHost.ts';
import { GpuSkinnedCloth } from './backend/webgpu/gpuSkinnedCloth.ts';

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

/** A garment for `renderer`, from a set-up checked by name. */
export function createSkinnedCloth(
  renderer: RendererApi,
  setup: SkinnedClothSetup,
): SkinnedClothSolver {
  const host = computeHostOf(renderer);
  return host === null ? new CpuCloth(renderer, setup) : new DeviceCloth(host, setup);
}

class DeviceCloth implements SkinnedClothSolver {
  readonly runsOn = 'device';
  readonly particles: ClothParticlesHandle;
  private readonly cloth: GpuSkinnedCloth;

  constructor(
    private readonly host: ComputeHost,
    setup: SkinnedClothSetup,
  ) {
    this.cloth = new GpuSkinnedCloth(host.device(), setup);
    this.particles = this.cloth.particles;
  }

  step(globals: Float32Array, model: Float32Array, dt: number): void {
    if (this.host.lost()) return;
    this.cloth.advance(globals, model, dt, this.host.changeFrame());
  }

  setWind(x: number, y: number, z: number): void {
    this.cloth.setWind(x, y, z);
  }

  reset(): void {
    if (this.host.lost()) return;
    this.cloth.reset();
  }

  /** Its buffers at once — its work is submitted — and its textures with the frame's. */
  dispose(): void {
    this.cloth.dispose();
    this.host.retire(this.cloth.particles.textures);
  }

  /** The particles where the last step left them: the parity check's door, waits on the device. */
  read(): Promise<Float32Array> {
    return this.cloth.read();
  }
}

class CpuCloth implements SkinnedClothSolver {
  readonly runsOn = 'cpu';
  readonly particles: ClothParticlesHandle;
  private readonly cloth: SkinnedCloth;
  /** The frame's particles at `alpha`, before they go up. */
  private readonly staging: Float32Array;

  constructor(
    private readonly renderer: RendererApi,
    setup: SkinnedClothSetup,
  ) {
    this.cloth = new SkinnedCloth(setup);
    this.particles = renderer.createClothParticles(this.cloth.count);
    this.staging = new Float32Array(this.cloth.count * 3);
  }

  step(globals: Float32Array, model: Float32Array, dt: number): void {
    this.cloth.setPose(globals, model);
    this.cloth.advance(dt);
    this.cloth.interpolate(this.cloth.alpha, this.staging);
    this.renderer.updateClothParticles(this.particles, this.staging);
  }

  setWind(x: number, y: number, z: number): void {
    this.cloth.setWind(x, y, z);
  }

  reset(): void {
    this.cloth.reset();
  }

  dispose(): void {
    this.renderer.disposeClothParticles(this.particles);
  }
}
