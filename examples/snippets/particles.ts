/**
 * Particles a game positions itself, particles a compute shader writes, sprites from a flipbook,
 * and a flock of birds.
 *
 * A snippet, typechecked with the examples and quoted by the manual's particles chapter.
 */
import { DEVICE_PARTICLE_FLOATS } from '@driftengine/core';
import type {
  Camera,
  ComputeHandle,
  DeviceParticles,
  Environment,
  FlockParams,
  ParticleHandle,
  ParticleInstances,
  RendererApi,
  SurfaceTextureHandle,
  Vec3,
} from '@driftengine/core';

// #region planned
/**
 * A ring of embers placed by a plan, not simulated: positions are a function of time, so a clip
 * exported frame by frame draws exactly what the preview drew.
 */
export function drawRing(
  renderer: RendererApi,
  batch: ParticleHandle,
  data: ParticleInstances,
  camera: Camera,
  env: Environment,
  time: number,
): void {
  const count = data.positions.length / 3;
  for (let i = 0; i < count; i += 1) {
    const a = (i / count) * Math.PI * 2 + time * 0.5;
    const at = i * 3;
    data.positions[at] = Math.cos(a) * 3;
    data.positions[at + 1] = 1 + Math.sin(time + i) * 0.2;
    data.positions[at + 2] = Math.sin(a) * 3;
    data.velocities[at] = -Math.sin(a);
    data.velocities[at + 1] = 0;
    data.velocities[at + 2] = Math.cos(a);
    data.colors[at] = 3;
    data.colors[at + 1] = 1.4;
    data.colors[at + 2] = 0.4;
    data.sizes[i] = 0.05;
    data.alphas[i] = 1;
  }
  data.count = count;
  renderer.drawParticles(batch, data, camera, env, time);
}
// #endregion

// #region flock
/** Birds circling a point, every one's path a function of its index and the clock. */
export function birds(renderer: RendererApi): (camera: Camera, time: number) => void {
  const flock = renderer.createFlock(40);
  const circling: FlockParams = {
    center: [0, 0, 0],
    radius: 30,
    height: 25,
    count: 40,
    speed: 9,
    scale: 0.4,
  };
  const dark: Vec3 = [0.1, 0.1, 0.12];
  return (camera, time) => renderer.drawFlock(flock, camera, time, circling, dark);
}
// #endregion

// #region sprites
/**
 * Smoke from a flipbook: an image of four by four cells, blended back to front, softened where it
 * meets the ground and faded as it reaches the eye.
 */
export function smokeSprites(
  renderer: RendererApi,
  flipbook: SurfaceTextureHandle,
): ParticleHandle {
  return renderer.createParticles(300, {
    material: 'sprite',
    blend: 'alpha',
    texture: flipbook,
    cells: [4, 4],
    blendCells: true,
    softDepth: 0.2,
    cameraFade: 1.5,
    sort: true,
  });
}

/** After the pool's update: each particle's cell from its age, the sixteen cells over its life. */
export function stepFlipbook(particles: ParticleInstances): void {
  const frames = particles.frames;
  if (frames === undefined) return;
  for (let i = 0; i < particles.count; i += 1) frames[i] = (particles.ages[i] ?? 0) * 15.999;
}
// #endregion

// #region device
/** `GPUBufferUsage.STORAGE | VERTEX`, as values: the globals exist only in a browser. */
const STORAGE_VERTEX = 0x0080 | 0x0020;

/** A buffer a compute shader fills with `capacity` particles and a pool then draws. WebGPU only. */
export function particleBuffer(device: GPUDevice, capacity: number): DeviceParticles {
  const buffer = device.createBuffer({
    size: capacity * DEVICE_PARTICLE_FLOATS * 4,
    usage: STORAGE_VERTEX,
  });
  return { buffer, count: capacity };
}

/** Each frame: step the simulation on the device, then draw what it wrote, where it lies. */
export function drawSimulated(
  renderer: RendererApi,
  simulate: ComputeHandle,
  batch: ParticleHandle,
  particles: DeviceParticles,
  camera: Camera,
  env: Environment,
  time: number,
): void {
  renderer.dispatchCompute(simulate);
  renderer.drawDeviceParticles(batch, particles, camera, env, time);
}
// #endregion
