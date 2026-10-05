/**
 * Textured sprite particles: a flipbook, a soft edge where they cut a floor, an eye fade, sorting.
 *
 *     /spriteParticles.html                 sixteen sprites half sunk into a floor, hard-edged
 *     /spriteParticles.html?soft=0.4        the same with a 40 cm soft edge: the straight line
 *                                           each card draws where it cuts the floor fades out
 *     /spriteParticles.html?blendcells=1    frames between cells blended, not stepped
 *     /spriteParticles.html?sort=1          alpha sprites drawn farthest first
 *     /spriteParticles.html?blend=additive  added rather than laid over
 *     /spriteParticles.html?facing=velocity each card's up along its travel
 *     /spriteParticles.html?device=1        the same sixteen written by a compute shader into a
 *                                           buffer of the page's own and drawn where they lie
 *                                           (`drawDeviceParticles`): the default's frame, pixel
 *                                           for pixel, on WebGPU; on WebGL2 nothing, said once
 *
 * **The controls**: `?soft=0` against `?soft=0.4` moves only pixels near where a card meets the
 * floor or a card behind it; the cells are numbered and coloured, so a frame drawn from the wrong
 * cell shows its number. Deterministic: a fixed camera, closed forms, no clock.
 */
import {
  Camera,
  MeshBuilder,
  createEnvironment,
  createRenderer,
} from '../../packages/core/src/index';
import type {
  ComputeDefinition,
  DeviceParticles,
  ParticleBlend,
  ParticleFacing,
  ParticleInstances,
  RendererApi,
  Vec3,
} from '../../packages/core/src/index';
import { DEV_RENDERER, askedQuality } from './askedQuality';

const ASKED = new URLSearchParams(location.search);
const BACKGROUND: Vec3 = [0.05, 0.06, 0.08];
const COUNT = 16;

/** A 4×4 flipbook: each cell a soft disc of its own hue, its number in the middle. */
function flipbook(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d');
  if (ctx === null) return canvas;
  ctx.clearRect(0, 0, 512, 512);
  for (let cell = 0; cell < 16; cell++) {
    const x = (cell % 4) * 128 + 64;
    const y = Math.floor(cell / 4) * 128 + 64;
    const gradient = ctx.createRadialGradient(x, y, 4, x, y, 60);
    const hue = (cell * 360) / 16;
    gradient.addColorStop(0, `hsla(${hue}, 90%, 70%, 1)`);
    gradient.addColorStop(1, `hsla(${hue}, 90%, 50%, 0)`);
    ctx.fillStyle = gradient;
    ctx.fillRect(x - 64, y - 64, 128, 128);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.9)';
    ctx.font = 'bold 40px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(cell), x, y);
  }
  return canvas;
}

function floor(): ReturnType<MeshBuilder['build']> {
  return new MeshBuilder()
    .addQuad([-8, 0, 6], [8, 0, 6], [8, 0, -8], [-8, 0, -8], [0.5, 0.52, 0.55])
    .build();
}

function particles(): ParticleInstances {
  const n = COUNT;
  const out: ParticleInstances = {
    positions: new Float32Array(n * 3),
    sizes: new Float32Array(n),
    spins: new Float32Array(n),
    colors: new Float32Array(n * 3).fill(1),
    alphas: new Float32Array(n).fill(0.9),
    ages: new Float32Array(n),
    seeds: new Float32Array(n),
    velocities: new Float32Array(n * 3),
    frames: new Float32Array(n),
    heights: new Float32Array(n),
    count: n,
    capacity: n,
  };
  for (let i = 0; i < n; i++) {
    /* Two rows, front to back, each card's centre a little under the floor. */
    out.positions.set([((i % 8) - 3.5) * 1.4, 0.35, (i < 8 ? 0 : -3) - (i % 3) * 0.6], i * 3);
    out.sizes[i] = 0.8;
    out.heights?.set([i % 2 === 0 ? 0 : 1.1], i);
    out.frames?.set([i + 0.5], i);
    out.velocities.set([Math.cos(i), 1, Math.sin(i)], i * 3);
  }
  return out;
}

/**
 * The same sixteen, written on the device: `particles()` in WGSL, into the layout
 * `DEVICE_PARTICLE_FLOATS` names. Velocity is left at zero, which a camera-facing card never reads.
 */
const WRITE_WGSL = /* wgsl */ `
@group(0) @binding(0) var<storage, read_write> out: array<f32>;
@compute @workgroup_size(16) fn main(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= 16u) { return; }
  let at = i * 16u;
  let f = f32(i);
  out[at] = (f32(i % 8u) - 3.5) * 1.4;
  out[at + 1u] = 0.35;
  out[at + 2u] = select(-3.0, 0.0, i < 8u) - f32(i % 3u) * 0.6;
  out[at + 3u] = 0.8;
  out[at + 4u] = 0.0;
  out[at + 5u] = 1.0;
  out[at + 6u] = 1.0;
  out[at + 7u] = 1.0;
  out[at + 8u] = 0.9;
  out[at + 9u] = 0.0;
  out[at + 10u] = 0.0;
  out[at + 11u] = 0.0;
  out[at + 12u] = 0.0;
  out[at + 13u] = 0.0;
  out[at + 14u] = f + 0.5;
  out[at + 15u] = select(1.1, 0.0, i % 2u == 0u);
}
`;

/** `GPUBufferUsage.STORAGE | VERTEX`, as values: the globals exist only in a browser. */
const STORAGE_VERTEX = 0x0080 | 0x0020;

/** A compute that fills a buffer of the page's own, and that buffer as the particles to draw. */
function deviceParticles(): {
  definition: ComputeDefinition;
  particles: () => DeviceParticles | null;
} {
  let pipeline: GPUComputePipeline | null = null;
  let group: GPUBindGroup | null = null;
  let buffer: GPUBuffer | null = null;
  return {
    definition: {
      label: 'sprite writer',
      init({ device }) {
        buffer = device.createBuffer({ size: COUNT * 16 * 4, usage: STORAGE_VERTEX });
        pipeline = device.createComputePipeline({
          layout: 'auto',
          compute: { module: device.createShaderModule({ code: WRITE_WGSL }), entryPoint: 'main' },
        });
        group = device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [{ binding: 0, resource: { buffer } }],
        });
      },
      dispatch({ pass }) {
        if (pipeline === null || group === null) return;
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, group);
        pass.dispatchWorkgroups(1);
      },
    },
    particles: () => (buffer === null ? null : { buffer, count: COUNT }),
  };
}

async function main(): Promise<void> {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const stats = document.getElementById('stats') as HTMLElement;
  const created = await createRenderer(canvas, askedQuality(), DEV_RENDERER);
  const renderer: RendererApi = created.renderer;
  const env = createEnvironment({
    directionalDir: [0.3, 0.8, 0.5],
    directionalColor: [0.9, 0.9, 0.85],
    ambient: [0.25, 0.27, 0.3],
    fogDensity: 0,
  });
  const camera = new Camera();
  camera.fovYDeg = 45;
  camera.position[1] = 2.2;
  camera.position[2] = 7;
  camera.lookAt(0, 0.3, -1);
  renderer.resize();
  camera.updateMatrices(canvas.height > 0 ? canvas.width / canvas.height : 1);

  const ground = renderer.createMesh(floor());
  const texture = renderer.createSurfaceTexture(flipbook(), { colorSpace: 'srgb' });
  const blend = (ASKED.get('blend') ?? 'alpha') as ParticleBlend;
  const batch = renderer.createParticles(COUNT, {
    material: 'sprite',
    blend,
    texture,
    cells: [4, 4],
    blendCells: ASKED.get('blendcells') === '1',
    softDepth: Number(ASKED.get('soft') ?? 0),
    cameraFade: Number(ASKED.get('camerafade') ?? 0),
    sort: ASKED.get('sort') === '1',
    facing: (ASKED.get('facing') ?? 'camera') as ParticleFacing,
  });
  const data = particles();
  const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const device = ASKED.get('device') === '1' ? deviceParticles() : null;
  const compute =
    device !== null && renderer.computeSupported
      ? renderer.registerCompute(device.definition)
      : null;
  /* Written once: nothing here moves, and a dispatch is submitted at once. */
  if (compute !== null) renderer.dispatchCompute(compute);

  const frame = (): void => {
    renderer.beginFrame(BACKGROUND);
    renderer.bindMeshPass(camera, env);
    renderer.drawMesh(ground, identity);
    const written = device?.particles() ?? null;
    if (device === null) renderer.drawParticles(batch, data, camera, env, 0);
    else if (written !== null) renderer.drawDeviceParticles(batch, written, camera, env, 0);
    else renderer.drawDeviceParticles(batch, { buffer: {} as GPUBuffer, count: 0 }, camera, env, 0);
    renderer.endFrame();
    requestAnimationFrame(frame);
  };
  frame();
  stats.textContent = `${created.backend} · ${COUNT} sprites · ${location.search || 'defaults'}`;
}

void main();
