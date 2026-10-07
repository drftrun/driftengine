/**
 * A stage drawn as a static list, or the same entries drawn one at a time, with an optional second
 * view of it in the same frame through a scene capture shown on a screen.
 *
 *     /staticDraws.html                    the stage drawn one draw at a time (`drawSceneCasters`)
 *     /staticDraws.html?static=1           the same stage recorded once and replayed (`drawStaticDraws`)
 *     /staticDraws.html?static=1&capture=1 and a capture of it every frame, a second view of the list
 *     /staticDraws.html?static=1&side=20   four hundred batches, each its own material
 *     /staticDraws.html?static=1&ssr=1&hdr=1&reflect=1
 *                                          every surface reflecting the frame, so the list's surface
 *                                          halves are replayed into the reflection pass as well
 *
 * Every pair of `static=0` and `static=1` under one query must be the same picture to the pixel: a
 * list draws what its entries would. Thirty-six instanced batches of nine boxes and twelve boxes of
 * their own, each with a material of its own, under a sun. The stats line reports the
 * processor time the stage's draws took, averaged over the frames since the thirtieth. Held
 * still, so a capture is a function of the query alone; `window.__drawn` turns true at frame thirty.
 * Nothing under `src/` may import this.
 */
import {
  Camera,
  MeshBuilder,
  createEnvironment,
  createMeshInstances,
  createRenderer,
} from '../../packages/core/src/index';
import type {
  MeshInstances,
  RendererApi,
  ShadowCasters,
  SurfaceMaterial,
  SurfaceTextureHandle,
  Vec3,
} from '../../packages/core/src/index';
import { DEV_RENDERER, askedQuality } from './askedQuality';

const ASKED = new URLSearchParams(location.search);
const STATIC = ASKED.get('static') === '1';
const CAPTURE = ASKED.get('capture') === '1';
const REFLECT = ASKED.get('reflect') === '1' ? 1 : 0;
/* `?side=20` for four hundred batches, the size of stage this exists for. */
const BATCHES = Math.max(1, Math.round(Number(ASKED.get('side') ?? '6')) || 6);
const CLEAR: Vec3 = [0.32, 0.36, 0.44];

/** A small swatch: a colour, crossed by a darker band, so a wrong material is a wrong picture. */
function swatch(hue: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = 32;
  canvas.height = 32;
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('staticDraws: no 2D context');
  ctx.fillStyle = `hsl(${hue}, 70%, 55%)`;
  ctx.fillRect(0, 0, 32, 32);
  ctx.fillStyle = `hsl(${hue}, 60%, 30%)`;
  ctx.fillRect(0, 12, 32, 8);
  return canvas;
}

const at = (x: number, y: number, z: number): Float32Array =>
  new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]);

async function main(): Promise<void> {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const stats = document.getElementById('stats') as HTMLElement;
  const created = await createRenderer(canvas, askedQuality(), DEV_RENDERER);
  const renderer: RendererApi = created.renderer;
  renderer.resize();
  const aspect = canvas.height > 0 ? canvas.width / canvas.height : 1;

  const box = renderer.createMesh(
    new MeshBuilder().addBox([0, 0.5, 0], [0.45, 0.5, 0.45], [1, 1, 1]).build({ planarUvs: true }),
  );
  const floor = renderer.createMesh(
    new MeshBuilder()
      .addBox([0, -0.05, 0], [16, 0.05, 16], [0.42, 0.44, 0.46])
      .build({ planarUvs: true }),
  );
  const swatches: SurfaceTextureHandle[] = [];
  for (let i = 0; i < 6; i++) swatches.push(renderer.createSurfaceTexture(swatch(i * 60)));
  const materials: SurfaceMaterial<SurfaceTextureHandle>[] = [];
  for (let i = 0; i < BATCHES * BATCHES + 12; i++) {
    materials.push({
      albedo: swatches[i % 6] ?? null,
      uScale: 1 + (i % 3),
      vScale: 1 + (i % 2),
      roughnessScale: 0.3 + (i % 5) * 0.15,
    });
  }

  const batches: { batch: ReturnType<RendererApi['createInstanced']>; data: MeshInstances }[] = [];
  for (let b = 0; b < BATCHES * BATCHES; b++) {
    const data = createMeshInstances(9);
    const ox = ((b % BATCHES) - (BATCHES - 1) / 2) * (24 / BATCHES);
    const oz = (Math.floor(b / BATCHES) - (BATCHES - 1) / 2) * (24 / BATCHES);
    for (let i = 0; i < 9; i++) {
      data.models.set(at(ox + ((i % 3) - 1) * 1.1, 0, oz + (Math.floor(i / 3) - 1) * 1.1), i * 16);
      data.tints.set([1, 1 - 0.05 * i, 1], i * 3);
    }
    data.count = 9;
    const batch = renderer.createInstanced(box, data.capacity);
    renderer.uploadInstanced(batch, data);
    batches.push({ batch, data });
  }
  const loose: Float32Array[] = [];
  for (let i = 0; i < 12; i++) {
    const angle = (i / 12) * Math.PI * 2;
    loose.push(at(Math.cos(angle) * 15, 0, Math.sin(angle) * 15));
  }

  /* The stage: the floor, every batch and every loose box, each with its own material. */
  const stage: ShadowCasters = (sink) => {
    sink.mesh(floor, at(0, 0, 0), null);
    batches.forEach(({ batch, data }, b) => sink.instanced?.(batch, data, materials[b] ?? null));
    loose.forEach((model, i) => sink.mesh(box, model, materials[BATCHES * BATCHES + i] ?? null));
  };
  const list = STATIC ? renderer.createStaticDraws(stage) : null;

  const env = createEnvironment({
    directionalDir: [0.4, 0.8, 0.3],
    directionalColor: [1.2, 1.12, 1.0],
    ambient: [0.32, 0.36, 0.42],
    ambientGround: [0.1, 0.09, 0.08],
    fogDensity: 0,
  });
  const camera = new Camera();
  camera.fovYDeg = 50;
  camera.near = 0.1;
  camera.far = 120;
  camera.position[0] = 0;
  camera.position[1] = 14;
  camera.position[2] = 26;
  camera.lookAt(0, 0, 0);
  camera.updateMatrices(aspect);

  const capture = CAPTURE ? renderer.createSceneCapture(256, 160) : null;
  const second = new Camera();
  second.fovYDeg = 40;
  second.near = 0.1;
  second.far = 120;
  second.position[0] = 18;
  second.position[1] = 6;
  second.position[2] = -4;
  second.lookAt(0, 0, 0);
  const screen = renderer.createMesh(
    new MeshBuilder()
      .addQuad([-4, 3, -14], [4, 3, -14], [4, 8, -14], [-4, 8, -14], [1, 1, 1])
      .build({ planarUvs: true }),
  );

  const drawStage = (): void => {
    renderer.setSurfaceReflectivity(REFLECT);
    if (list !== null) renderer.drawStaticDraws(list);
    else renderer.drawSceneCasters(stage);
    renderer.setSurfaceReflectivity(0);
  };

  let frames = 0;
  /* Measured from frame thirty on, so a list's recording is not in the average. */
  let spent = 0;
  let measured = 0;
  const draw = (): void => {
    renderer.beginFrame(CLEAR);
    const started = performance.now();
    if (capture !== null) {
      renderer.captureScene(capture, second, CLEAR, (view) => {
        renderer.bindMeshPass(view, env);
        drawStage();
      });
    }
    renderer.bindMeshPass(camera, env);
    drawStage();
    if (frames >= 30) {
      spent += performance.now() - started;
      measured += 1;
    }
    if (capture !== null) {
      renderer.setMaterial({ albedo: capture });
      renderer.drawMesh(screen, at(0, 0, 0));
      renderer.setMaterial(null);
    }
    renderer.endFrame();
    frames += 1;
    if (frames === 30) (window as unknown as { __drawn: boolean }).__drawn = true;
    if (frames % 30 === 0) {
      stats.textContent =
        `${created.backend} · ${STATIC ? 'static list' : 'one draw at a time'}` +
        `${CAPTURE ? ' · and a capture' : ''} · ${(spent / Math.max(measured, 1)).toFixed(3)} ms a frame`;
    }
    requestAnimationFrame(draw);
  };
  draw();
}

void main();
