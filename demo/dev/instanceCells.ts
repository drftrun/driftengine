/**
 * Eight cards, each wearing its own cell of one strip of eight, drawn two ways that must agree.
 *
 *     /instanceCells.html                   one instanced draw, each card's cell its own instance's
 *     /instanceCells.html?mode=each         eight draws, each card's cell its material's offset: the
 *                                           control
 *     /instanceCells.html?mode=whole        the instanced draw with no cells given: every card wears
 *                                           the whole strip, which is what a batch did before 4.8.7
 *     ...&blend=1                           all of it translucent, at half opacity
 *
 * **The control is the claim.** `MeshInstances.uvRegions` is the material's scale and offset moved
 * into the instance, so the instanced frame and the eight-draw frame are the same frame or the
 * feature is wrong. The cards do not overlap, so the order they blend in cannot matter.
 *
 * Deterministic: a fixed camera, a closed form, and no clock. Nothing under `src/` may import this.
 */
import {
  Camera,
  createEnvironment,
  createMeshInstances,
  createRenderer,
} from '../../packages/core/src/index';
import type { MeshData, RendererApi, Vec3 } from '../../packages/core/src/index';
import { DEV_RENDERER, askedQuality } from './askedQuality';

const BACKGROUND: Vec3 = [0.03, 0.035, 0.04];
const CARDS = 8;
const ASKED = new URLSearchParams(location.search);
const mode = ASKED.get('mode') ?? 'instanced';
const blend = ASKED.get('blend') === '1';

/** A strip of eight cells, each its own colour and a bar at its own height, so a wrong cell shows. */
function strip(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = 8 * 32;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  if (ctx === null) return canvas;
  for (let cell = 0; cell < CARDS; cell++) {
    ctx.fillStyle = `hsl(${cell * 45}, 70%, 45%)`;
    ctx.fillRect(cell * 32, 0, 32, 64);
    ctx.fillStyle = '#f2f2f2';
    ctx.fillRect(cell * 32 + 6, 4 + cell * 7, 20, 6);
  }
  return canvas;
}

/** One card, 0.8 by 2, its coordinates the whole texture. */
function card(): MeshData {
  return {
    positions: new Float32Array([-0.4, -1, 0, 0.4, -1, 0, 0.4, 1, 0, -0.4, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
    colors: new Float32Array(12).fill(1),
    emissive: new Float32Array(4),
    uvs: new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  };
}

async function main(): Promise<void> {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const stats = document.getElementById('stats') as HTMLElement;
  const created = await createRenderer(canvas, askedQuality(), DEV_RENDERER);
  const renderer: RendererApi = created.renderer;
  const env = createEnvironment({
    directionalDir: [0, 0, 1],
    directionalColor: [0.5, 0.5, 0.5],
    ambient: [0.5, 0.5, 0.5],
    ambientGround: [0.5, 0.5, 0.5],
    fogDensity: 0,
  });
  const camera = new Camera();
  camera.fovYDeg = 40;
  camera.position[2] = 12;
  camera.lookAt(0, 0, 0);
  renderer.resize();
  camera.updateMatrices(canvas.height > 0 ? canvas.width / canvas.height : 1);

  const albedo = renderer.createSurfaceTexture(strip(), { colorSpace: 'srgb', wrap: 'clamp' });
  const mesh = renderer.createMesh(card());
  const batch = renderer.createInstanced(mesh, CARDS);
  const instances = { ...createMeshInstances(CARDS), uvRegions: new Float32Array(CARDS * 4) };
  const models: Float32Array[] = [];
  for (let i = 0; i < CARDS; i++) {
    const model = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, (i - 3.5) * 1.6, 0, 0, 1]);
    models.push(model);
    instances.models.set(model, i * 16);
    instances.tints.set([1, 1, 1], i * 3);
    /* Card i wears cell 7 − i, so a batch that ignored its cells would show the strip in order. */
    instances.uvRegions.set([1 / CARDS, 1, (CARDS - 1 - i) / CARDS, 0], i * 4);
  }
  instances.count = CARDS;
  const whole = { ...instances, uvRegions: undefined };
  renderer.uploadInstanced(batch, mode === 'whole' ? whole : instances);
  const plain = { albedo };
  /* The control's materials: each card's cell as the material's own scale and offset. */
  const cells = models.map((_, i) => ({
    albedo,
    uScale: 1 / CARDS,
    uOffset: (CARDS - 1 - i) / CARDS,
  }));

  const frame = (): void => {
    renderer.beginFrame(BACKGROUND);
    renderer.bindMeshPass(camera, env);
    if (mode === 'each') {
      for (let i = 0; i < CARDS; i++) {
        renderer.setMaterial(cells[i] ?? null);
        if (blend) renderer.drawTranslucentMesh(mesh, models[i] as Float32Array, 0.5);
        else renderer.drawMesh(mesh, models[i] as Float32Array);
      }
    } else {
      renderer.setMaterial(plain);
      if (blend)
        renderer.drawTranslucentInstanced(batch, mode === 'whole' ? whole : instances, 0.5);
      else renderer.drawInstanced(batch, mode === 'whole' ? whole : instances);
    }
    renderer.setMaterial(null);
    renderer.endFrame();
    requestAnimationFrame(frame);
  };
  frame();
  stats.textContent = `${created.backend} · ${CARDS} cards · ${mode}${blend ? ' · blended' : ''}`;
}

void main();
