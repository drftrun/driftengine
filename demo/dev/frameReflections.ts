/**
 * Reflections through the frame's own materials: a floor striped glossy and rough by one ORM map,
 * coloured blocks standing on it, and a low camera that sees the floor at a grazing angle.
 *
 *     /frameReflections.html                the glossy stripes mirror the blocks; the rough do not
 *     /frameReflections.html?ssr=0          the same frame with no trace: the probe's gradient alone
 *     /frameReflections.html?ceiling=0.03   a ceiling under every stripe: nothing traces, as ?ssr=0
 *     /frameReflections.html?smear=0        the glossy stripes' reflections unblurred
 *     /frameReflections.html?gloss=0.4      the glossy stripes rougher: the reflection softens
 *
 * The floor is one mesh with one material: its ORM map alone decides which stripe reflects, which
 * is what a reflection weighed by a box could not do. Held still, so a capture is a function of the
 * query alone; `window.__drawn` turns true once the pipelines have compiled. Nothing under `src/`
 * may import this.
 */
import {
  Camera,
  MeshBuilder,
  createEnvironment,
  createRenderer,
} from '../../packages/core/src/index';
import type { RendererApi, Vec3 } from '../../packages/core/src/index';
import { DEV_RENDERER, askedQuality } from './askedQuality';

const ASKED = new URLSearchParams(location.search);
const number = (name: string, fallback: number): number => {
  const value = Number(ASKED.get(name) ?? 'NaN');
  return Number.isFinite(value) ? value : fallback;
};

/** Stripes across u, eight to the map: occlusion 1, roughness glossy or rough, no metal. */
function paintOrm(gloss: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('frameReflections: no 2D context');
  for (let stripe = 0; stripe < 8; stripe++) {
    const rough = stripe % 2 === 0 ? gloss : 0.9;
    ctx.fillStyle = `rgb(255, ${Math.round(rough * 255)}, 0)`;
    ctx.fillRect(stripe * 32, 0, 32, 256);
  }
  return canvas;
}

const at = (x: number, y: number, z: number): Float32Array =>
  new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]);

async function main(): Promise<void> {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const stats = document.getElementById('stats') as HTMLElement;
  const traced = ASKED.get('ssr') !== '0';
  const created = await createRenderer(
    canvas,
    {
      ...askedQuality(),
      screenEffects: true,
      hdrScene: true,
      outputTransform: 'aces',
      screenSpaceReflections: traced
        ? { maxRoughness: number('ceiling', 0.6), blur: number('smear', 0.03) }
        : false,
    },
    DEV_RENDERER,
  );
  const renderer: RendererApi = created.renderer;
  renderer.resize();
  const aspect = canvas.height > 0 ? canvas.width / canvas.height : 1;

  const floor = renderer.createMesh(
    new MeshBuilder()
      .addQuad([-8, 0, 6], [8, 0, 6], [8, 0, -10], [-8, 0, -10], [0.12, 0.12, 0.13])
      .build({ planarUvs: true }),
  );
  const blocks = new MeshBuilder();
  const colours: Vec3[] = [
    [0.9, 0.15, 0.1],
    [0.1, 0.7, 0.2],
    [0.15, 0.3, 0.95],
    [0.95, 0.8, 0.1],
  ];
  colours.forEach((colour, i) => blocks.addBox([-4.5 + i * 3, 1.2, -4], [0.7, 1.2, 0.7], colour));
  const blockMesh = renderer.createMesh(blocks.build());
  const orm = renderer.createSurfaceTexture(paintOrm(number('gloss', 0.05)), {
    colorSpace: 'linear',
  });

  const env = createEnvironment({
    directionalDir: [0.3, 0.8, 0.5],
    directionalColor: [1.2, 1.15, 1.05],
    ambient: [0.35, 0.4, 0.5],
    ambientGround: [0.08, 0.07, 0.06],
    fogDensity: 0,
  });
  const camera = new Camera();
  camera.fovYDeg = 50;
  camera.near = 0.1;
  camera.far = 60;
  camera.position[0] = 0;
  camera.position[1] = 1.1;
  camera.position[2] = 6;
  camera.lookAt(0, 0.6, -4);
  camera.updateMatrices(aspect);
  const identity = at(0, 0, 0);

  let frames = 0;
  const draw = (): void => {
    renderer.beginFrame([0.3, 0.35, 0.45]);
    renderer.bindMeshPass(camera, env);
    renderer.drawMesh(blockMesh, identity);
    /* The floor reflects as a varnished dielectric would, and its map says where it is glossy. */
    renderer.setMaterial({ orm, uScale: 0.25, vScale: 0.25 });
    renderer.setSurfaceReflectivity(1);
    renderer.drawMesh(floor, identity);
    renderer.setSurfaceReflectivity(0);
    renderer.setMaterial(null);
    renderer.endFrame();
    frames += 1;
    if (frames === 30) (window as unknown as { __drawn: boolean }).__drawn = true;
    requestAnimationFrame(draw);
  };
  draw();
  stats.textContent = `${created.backend} · frame reflections · ${location.search}`;
}

void main();
