/**
 * Eight panes over a striped wall, each at its own opacity, drawn two ways that must agree.
 *
 *     /instanceAlpha.html               one instanced draw, each pane's opacity its own instance's
 *     /instanceAlpha.html?mode=each     eight translucent draws, one opacity each: the control
 *     /instanceAlpha.html?mode=flat     the instanced draw with no opacities given: every pane at
 *                                       the batch's own, which is what a batch was before 4.8.6
 *
 * **The control is the claim.** `MeshInstances.alphas` is the per-draw opacity moved into the
 * instance, so the instanced frame and the eight-draw frame are the same frame or the feature is
 * wrong. The panes do not overlap, so the order they blend in cannot matter.
 *
 * Deterministic: a fixed camera, a closed form, and no clock. Nothing under `src/` may import this.
 */
import {
  Camera,
  MeshBuilder,
  createEnvironment,
  createMeshInstances,
  createRenderer,
} from '../../packages/core/src/index';
import type { RendererApi, Vec3 } from '../../packages/core/src/index';
import { DEV_RENDERER, askedQuality } from './askedQuality';

const BACKGROUND: Vec3 = [0.03, 0.035, 0.04];
const PANES = 8;
const mode = new URLSearchParams(location.search).get('mode') ?? 'instanced';

function wall(): ReturnType<MeshBuilder['build']> {
  const builder = new MeshBuilder();
  for (let stripe = 0; stripe < 16; stripe++) {
    const x = -8 + stripe;
    const shade: Vec3 = stripe % 2 === 0 ? [0.9, 0.9, 0.9] : [0.1, 0.1, 0.12];
    builder.addQuad([x, -2, -1], [x + 1, -2, -1], [x + 1, 2, -1], [x, 2, -1], shade);
  }
  return builder.build();
}

function pane(): ReturnType<MeshBuilder['build']> {
  return new MeshBuilder()
    .addQuad([-0.4, -1, 0], [0.4, -1, 0], [0.4, 1, 0], [-0.4, 1, 0], [0.9, 0.2, 0.15])
    .build();
}

async function main(): Promise<void> {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const stats = document.getElementById('stats') as HTMLElement;
  const created = await createRenderer(canvas, askedQuality(), DEV_RENDERER);
  const renderer: RendererApi = created.renderer;
  const env = createEnvironment({
    directionalDir: [0.2, 0.4, 1],
    directionalColor: [0.6, 0.6, 0.6],
    ambient: [0.5, 0.5, 0.5],
    fogDensity: 0,
  });
  const camera = new Camera();
  camera.fovYDeg = 40;
  camera.position[2] = 12;
  camera.lookAt(0, 0, 0);
  renderer.resize();
  camera.updateMatrices(canvas.height > 0 ? canvas.width / canvas.height : 1);

  const backdrop = renderer.createMesh(wall());
  const glass = renderer.createMesh(pane());
  const batch = renderer.createInstanced(glass, PANES);
  const instances = createMeshInstances(PANES);
  const models: Float32Array[] = [];
  const opacities: number[] = [];
  for (let i = 0; i < PANES; i++) {
    const model = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, (i - 3.5) * 1.6, 0, 0, 1]);
    models.push(model);
    instances.models.set(model, i * 16);
    instances.tints.set([1, 1, 1], i * 3);
    opacities.push((i + 1) / PANES);
  }
  instances.alphas?.set(mode === 'flat' ? new Array<number>(PANES).fill(1) : opacities);
  instances.count = PANES;
  renderer.uploadInstanced(batch, instances);
  const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

  const frame = (): void => {
    renderer.beginFrame(BACKGROUND);
    renderer.bindMeshPass(camera, env);
    renderer.drawMesh(backdrop, identity);
    if (mode === 'each') {
      for (let i = 0; i < PANES; i++) {
        renderer.drawTranslucentMesh(glass, models[i] as Float32Array, opacities[i] as number);
      }
    } else {
      renderer.drawTranslucentInstanced(batch, instances, mode === 'flat' ? 0.5 : 1);
    }
    renderer.endFrame();
    requestAnimationFrame(frame);
  };
  frame();
  stats.textContent = `${created.backend} · ${PANES} panes · ${mode}`;
}

void main();
