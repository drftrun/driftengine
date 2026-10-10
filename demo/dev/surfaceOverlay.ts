/**
 * A draw's surface overlay, looked at on either backend: a rim on a sphere, a panel dissolving and a
 * panel wearing wrinkles, every image a region of one atlas painted here from closed forms.
 *
 *     /surfaceOverlay.html                 all three, at the default threshold and weights
 *     /surfaceOverlay.html?overlay=0       the same draws with no overlay set: the control
 *     /surfaceOverlay.html?maps=0          the overlay without its atlas: a smooth rim, nothing cut,
 *                                          nothing wrinkled
 *     /surfaceOverlay.html?dissolve=0.6    more of the middle panel cut away, its band following
 *     /surfaceOverlay.html?wrinkle=0       the right panel's weights at zero: no wrinkle
 *     /surfaceOverlay.html?t=2             another moment of the rim's pulse and its scrolling noise
 *     /surfaceOverlay.html?rim=blend       the rim pulling the base colour toward a red held at one,
 *                                          then lit: red where the light reaches, dark where it does not
 *
 * The atlas's four quarters: the noise (top left), the rim's mask (top right, white on its left
 * half), the wrinkle normal (bottom left, ridges along u) and the wrinkle masks (bottom right: red
 * on the upper half of v, green on the lower). The clock is held at `t`, and every frame draws the
 * same picture, so a capture is a function of the query alone. `window.__drawn` turns true once the
 * pipelines carrying the overlay have had time to compile. Nothing under `src/` may import this.
 */
import {
  Camera,
  MeshBuilder,
  createEnvironment,
  createRenderer,
} from '../../packages/core/src/index';
import type { RendererApi, SurfaceOverlay, Vec3 } from '../../packages/core/src/index';
import { DEV_RENDERER, askedQuality } from './askedQuality';

const ASKED = new URLSearchParams(location.search);
const BACKGROUND: Vec3 = [0.04, 0.045, 0.055];
const SIZE = 256;

/** The four quarters of the atlas, painted from closed forms: see the header. */
function paintAtlas(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('surfaceOverlay: no 2D context');
  const image = ctx.createImageData(SIZE, SIZE);
  const half = SIZE / 2;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const u = (x % half) / half;
      const v = (y % half) / half;
      let r = 0;
      let g = 0;
      let b = 0;
      if (x < half && y < half) {
        /* Noise: a few incommensurate waves, 0 to 1. */
        const n =
          0.5 +
          0.22 * Math.sin(u * 23.1 + 1.3) * Math.cos(v * 17.7 + 0.4) +
          0.18 * Math.sin((u + v) * 31.3) +
          0.1 * Math.cos((u - v) * 47.9 + 2.1);
        r = g = b = Math.min(1, Math.max(0, n));
      } else if (y < half) {
        /* The rim's mask: erased on the left half of the mesh's u. */
        r = g = b = u < 0.5 ? 1 : 0;
      } else if (x < half) {
        /* Ridges along u: the normal leans in x by a sine, eight to the region. */
        const lean = 0.7 * Math.sin(u * Math.PI * 16);
        const z = Math.sqrt(1 - lean * lean);
        r = lean * 0.5 + 0.5;
        g = 0.5;
        b = z * 0.5 + 0.5;
      } else {
        /* Mask A: red on the upper half of v, green on the lower. */
        r = v < 0.5 ? 1 : 0;
        g = v < 0.5 ? 0 : 1;
      }
      const at = (y * SIZE + x) * 4;
      image.data[at] = Math.round(r * 255);
      image.data[at + 1] = Math.round(g * 255);
      image.data[at + 2] = Math.round(b * 255);
      image.data[at + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
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

  const sphere = renderer.createMesh(
    new MeshBuilder().addSphere([0, 0, 0], 1.1, [0.5, 0.5, 0.52], 0, 48, 24).build({
      planarUvs: true,
    }),
  );
  const panel = (): ReturnType<MeshBuilder['build']> =>
    new MeshBuilder()
      .addQuad([-1.1, -1.1, 0], [1.1, -1.1, 0], [1.1, 1.1, 0], [-1.1, 1.1, 0], [0.8, 0.78, 0.74])
      .build({ planarUvs: true });
  const dissolving = renderer.createMesh(panel());
  const wrinkled = renderer.createMesh(panel());
  const backdrop = renderer.createMesh(
    new MeshBuilder()
      .addQuad([-8, -4, -2], [8, -4, -2], [8, 4, -2], [-8, 4, -2], [0.16, 0.2, 0.3])
      .build(),
  );
  const atlas = renderer.createSurfaceTexture(paintAtlas(), {
    colorSpace: 'linear',
    mipmap: false,
  });

  const number = (name: string, fallback: number): number => {
    const value = Number(ASKED.get(name) ?? 'NaN');
    return Number.isFinite(value) ? value : fallback;
  };
  const on = ASKED.get('overlay') !== '0';
  const maps = ASKED.get('maps') === '0' ? undefined : atlas;
  const noise = { scale: [0.5, 0.5], offset: [0, 0] } as const;
  const blend = ASKED.get('rim') === 'blend';
  const rim: SurfaceOverlay = {
    maps,
    rim: {
      colour: blend ? [8, 0.2, 0.1] : [1, 0.45, 0.1],
      intensity: blend ? 1 : 3,
      alpha: blend ? 1.5 : 1,
      mode: blend ? 'blend' : 'add',
      falloff: 1.5,
      upward: 0.4,
      contrast: 1,
      noise: { region: noise, scroll: [0, 0.2], tiling: 3 },
      pulse: { rate: 1.257, low: 0.6, high: 1 },
      mask: { region: { scale: [0.5, 0.5], offset: [0.5, 0] }, weight: 1 },
    },
  };
  const dissolve: SurfaceOverlay = {
    maps,
    dissolve: {
      noise: { region: noise, tiling: [1, 1] },
      threshold: number('dissolve', 0.45),
      edge: 0.06,
      edgeColour: [0.3, 0.8, 1],
      edgeIntensity: 4,
      overlay: { colour: [0.2, 0.05, 0.4], amount: 0.5 },
    },
  };
  const weight = number('wrinkle', 1);
  const wrinkle: SurfaceOverlay = {
    maps,
    wrinkle: {
      normal: { scale: [0.5, 0.5], offset: [0, 0.5] },
      masks: [
        { scale: [0.5, 0.5], offset: [0.5, 0.5] },
        { scale: [0.5, 0.5], offset: [0.5, 0.5] },
      ],
      /* Mask A's red carries region 1, so only the upper half wrinkles. */
      weights: [weight, 0, 0, 0, 0, 0],
    },
  };

  const env = createEnvironment({
    directionalDir: [0.55, 0.35, 0.76],
    fogDensity: 0,
    fogColor: BACKGROUND,
    surfaceTime: number('t', 0.75),
  });
  const camera = new Camera();
  camera.fovYDeg = 45;
  camera.near = 0.1;
  camera.far = 50;
  camera.position[2] = 8;
  camera.lookAt(0, 0, 0);
  camera.updateMatrices(aspect);

  let frames = 0;
  const draw = (): void => {
    renderer.beginFrame(BACKGROUND);
    renderer.bindMeshPass(camera, env);
    renderer.drawMesh(backdrop, at(0, 0, 0));
    if (on) renderer.setSurfaceOverlay(rim);
    renderer.drawMesh(sphere, at(-2.8, 0, 0));
    if (on) renderer.setSurfaceOverlay(dissolve);
    renderer.drawMesh(dissolving, at(0, 0, 0));
    if (on) renderer.setSurfaceOverlay(wrinkle);
    renderer.drawMesh(wrinkled, at(2.8, 0, 0));
    renderer.setSurfaceOverlay(null);
    renderer.endFrame();
    frames += 1;
    if (frames === 30) (window as unknown as { __drawn: boolean }).__drawn = true;
    requestAnimationFrame(draw);
  };
  draw();
  stats.textContent = `${created.backend} · surface overlay · ${location.search}`;
}

void main();
