/**
 * Sixteen batches of one mesh, culled — a whole batch behind an occluder, each instance out of view.
 *
 *     /instancedCull.html                 the default backend
 *     /instancedCull.html?backend=webgl2  the other one
 *     /instancedCull.html?cull=0          the control: the same batches, drawn whole
 *     /instancedCull.html?gputiming=1     the device's own timestamps, which is where it shows
 *
 * Ten thousand spheres of about 2,300 triangles each, as sixteen batches of **one** mesh — a block
 * each, which is what a region's props are — seen from low down so most of the field is outside the
 * view, with a wall declared to the occlusion buffer that hides every row behind the first.
 *
 * **Culling must be invisible**: the picture with `?cull=0` is the same picture, pixel for pixel, and
 * a capture pair proves it. **It must also be work saved**, which the readout shows: how many blocks
 * the batch test drops, how many instances the instance test keeps — computed here by the same two
 * functions against the same view and the renderer's own occlusion buffer — and the GPU time.
 *
 * **What a failure looks like**: spheres missing at the edges of the view (over-culling, which a
 * diff against the control finds); the hidden rows still costing time (the batch test not reaching
 * the occlusion buffer); the two backends differing; or sixteen batches of one mesh refused.
 */
import {
  Camera,
  MeshBuilder,
  batchBoxVisible,
  createBounds,
  createEnvironment,
  createMeshInstances,
  createRenderer,
  cullInstances,
  frustumFromViewProjection,
  instancesBox,
} from '../../packages/core/src/index';
import type { MeshInstances, RendererApi, Vec3 } from '../../packages/core/src/index';
import { DEV_RENDERER, askedQuality } from './askedQuality';

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const CLEAR: Vec3 = [0.05, 0.06, 0.08];
/** Blocks across and down, spheres across a block, and metres between spheres and between blocks. */
const BLOCKS = 4;
const SIDE = 25;
const SPACING = 2;
const GAP = 30;
const PITCH = SIDE * SPACING + GAP;
const FRAMES = 90;

async function main(): Promise<void> {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const stats = document.getElementById('stats') as HTMLElement;
  const cull = new URLSearchParams(location.search).get('cull') !== '0';
  const created = await createRenderer(
    canvas,
    { ...askedQuality(), occlusionCulling: 256 },
    DEV_RENDERER,
  );
  await created.renderer.ready();
  const renderer: RendererApi = created.renderer;

  const sphere = renderer.createMesh(
    new MeshBuilder().addSphere([0, 0.8, 0], 0.8, [0.8, 0.55, 0.3], 0, 48, 24).build(),
  );
  /* The mesh's own sphere, which is what the renderer culls each instance by. */
  const local = createBounds();
  local.centre.set([0, 0.8, 0]);
  local.radius = 0.8;

  const blocks: { batch: ReturnType<RendererApi['createInstanced']>; data: MeshInstances }[] = [];
  for (let b = 0; b < BLOCKS * BLOCKS; b++) {
    const data = createMeshInstances(SIDE * SIDE);
    const ox = (b % BLOCKS) * PITCH;
    const oz = Math.floor(b / BLOCKS) * PITCH;
    for (let i = 0; i < SIDE * SIDE; i++) {
      const m = i * 16;
      data.models.set(IDENTITY, m);
      data.models[m + 12] = ox + (i % SIDE) * SPACING;
      data.models[m + 14] = oz + Math.floor(i / SIDE) * SPACING;
      data.tints.set([0.55 + 0.03 * b, 0.8, 1 - 0.03 * b], i * 3);
    }
    data.count = SIDE * SIDE;
    const batch = renderer.createInstanced(sphere, data.capacity, { cull });
    renderer.uploadInstanced(batch, data);
    blocks.push({ batch, data });
  }

  const floor = renderer.createMesh(
    new MeshBuilder().addBox([150, -0.1, 150], [220, 0.1, 220], [0.35, 0.37, 0.4]).build(),
  );
  /* A wall across the field after the first row of blocks, drawn and declared to the occlusion
     buffer, tall enough from this eye to hide every row behind it.
     **Near the eye on purpose.** An occluder hides what stands on the ground well behind it: a
     block's base and the wall's base project to nearly the same screen row when both are far, and
     a rectangle straddling the wall's bottom edge abstains — the ground is not an occluder, so
     nothing covers below that line. At street height with buildings a few tens of metres away the
     two bases are texels apart, which is the case this engine's cities are. */
  const WALL_MIN: Vec3 = [-40, 0, PITCH - 22];
  const WALL_MAX: Vec3 = [BLOCKS * PITCH + 40, 40, PITCH - 20];
  const wall = renderer.createMesh(
    new MeshBuilder()
      .addBox(
        [(WALL_MIN[0] + WALL_MAX[0]) / 2, 20, (WALL_MIN[2] + WALL_MAX[2]) / 2],
        [(WALL_MAX[0] - WALL_MIN[0]) / 2, 20, 1],
        [0.5, 0.45, 0.42],
      )
      .build(),
  );

  const env = createEnvironment();
  env.directionalDir = [0.3, 0.8, 0.5];
  env.ambient = [0.25, 0.27, 0.3];

  const camera = new Camera();
  camera.fovYDeg = 40;
  camera.near = 0.3;
  camera.far = 600;
  camera.position[0] = 40;
  camera.position[1] = 5;
  camera.position[2] = -25;
  camera.lookAt(70, 2, 60);
  renderer.resize();
  camera.updateMatrices(canvas.height > 0 ? canvas.width / canvas.height : 1);

  /* What the camera should keep, by the same two tests the renderer runs, against the same view and
     the renderer's own occlusion buffer — asked after the wall is declared, inside the frame. */
  const frustum = new Float32Array(24);
  frustumFromViewProjection(camera.viewProjection, frustum);
  const kept = createMeshInstances(SIDE * SIDE);
  const batchBox = new Float32Array(6);
  let expected = 0;
  let hiddenBlocks = 0;
  const count = (): void => {
    expected = 0;
    hiddenBlocks = 0;
    for (const { data } of blocks) {
      instancesBox(data, local, batchBox);
      if (!batchBoxVisible(batchBox, frustum, renderer)) {
        hiddenBlocks += 1;
        continue;
      }
      expected += cullInstances(data, local, frustum, kept);
    }
  };

  let frame = 0;
  let gpu = 0;
  const draw = (): void => {
    /* The whole frame in one bracket: WebGL2 issues draws as they are called, WebGPU replays them
       at endFrame, and the bracket has to hold both. */
    renderer.gpuTimer.beginFrame();
    renderer.beginFrame(CLEAR);
    renderer.gpuTimer.begin('rest');
    renderer.bindMeshPass(camera, env);
    renderer.addOccluder(WALL_MIN, WALL_MAX, IDENTITY);
    renderer.drawMesh(floor, IDENTITY);
    renderer.drawMesh(wall, IDENTITY);
    if (frame === 0) count();
    for (const { batch, data } of blocks) renderer.drawInstanced(batch, data);
    renderer.endFrame();
    renderer.gpuTimer.end();
    renderer.gpuTimer.endFrame();
    const sample = renderer.gpuTimer.poll();
    if (sample !== null) gpu = sample.rest;
    frame += 1;
    stats.textContent =
      `${created.backend} · cull ${cull ? 'on' : 'off'} · ${BLOCKS * BLOCKS} batches of one mesh · ` +
      `${hiddenBlocks} out of view or occluded · ${expected} of ${BLOCKS * BLOCKS * SIDE * SIDE} ` +
      `instances kept · ${gpu.toFixed(2)} ms gpu`;
    if (frame < FRAMES) requestAnimationFrame(draw);
    else (globalThis as unknown as { __drawn?: boolean }).__drawn = true;
  };
  requestAnimationFrame(draw);
}

main().catch((error: unknown) => {
  const box = document.getElementById('error');
  if (box !== null)
    box.textContent = error instanceof Error ? (error.stack ?? error.message) : String(error);
});
