/**
 * Probe layers filled from images: another engine's reflection captures, one a lattice point.
 *
 *     /probeLayers.html               a grid of two probes, a warm image in the left one and a cool
 *                                     one in the right, a mirror sphere at each: each mirrors its own
 *     /probeLayers.html?one=layer     a single probe filled by setProbeLayerImage(0, …)
 *     /probeLayers.html?one=env       the same image by setEnvironmentImage: the control, which must
 *                                     draw the line above to the pixel
 *
 * The images are closed forms, so nothing is fetched and two runs differ in no pixel.
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
const BACKGROUND: Vec3 = [0.02, 0.02, 0.03];

/** An equirectangular sky: a gradient in `top` and `bottom` and a bright band at the horizon. */
function sky(
  top: Vec3,
  bottom: Vec3,
  band: Vec3,
): { width: number; height: number; data: Float32Array } {
  const width = 128;
  const height = 64;
  const data = new Float32Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    const t = y / (height - 1);
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 3;
      const near = Math.abs(t - 0.5) < 0.06 && (x / width) % 0.25 < 0.12 ? 1 : 0;
      for (let c = 0; c < 3; c++) {
        data[at + c] =
          (top[c] as number) * (1 - t) + (bottom[c] as number) * t + (band[c] as number) * near;
      }
    }
  }
  return { width, height, data };
}

/** Each texel the colour of its own direction, `d / 2 + 1 / 2`, by `equirectToCubeFaces`' convention. */
function directions(): { width: number; height: number; data: Float32Array } {
  const width = 256;
  const height = 128;
  const data = new Float32Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    const theta = ((y + 0.5) / height) * Math.PI;
    for (let x = 0; x < width; x++) {
      const phi = ((x + 0.5) / width - 0.5) * 2 * Math.PI;
      const dx = Math.sin(theta) * Math.sin(phi);
      const dy = Math.cos(theta);
      const dz = -Math.sin(theta) * Math.cos(phi);
      data.set([dx * 0.5 + 0.5, dy * 0.5 + 0.5, dz * 0.5 + 0.5], (y * width + x) * 3);
    }
  }
  return { width, height, data };
}

function metalOrm(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext('2d');
  if (ctx === null) return canvas;
  const image = ctx.createImageData(1, 1);
  image.data.set([255, Number(ASKED.get('rough') ?? 20), 255, 255]);
  ctx.putImageData(image, 0, 0);
  return canvas;
}

async function main(): Promise<void> {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const stats = document.getElementById('stats') as HTMLElement;
  const created = await createRenderer(
    canvas,
    { ...askedQuality(), reflectionProbeSize: 128 },
    DEV_RENDERER,
  );
  const renderer: RendererApi = created.renderer;
  const env = createEnvironment({
    directionalDir: [0.3, 0.8, 0.5],
    directionalColor: ASKED.get('sun') === '0' ? [0, 0, 0] : [0.2, 0.2, 0.2],
    ambient: [0.05, 0.05, 0.05],
    fogDensity: 0,
  });
  /* `?env=axes`: every direction coloured by itself, so a mapping error is a colour error. */
  const axes = ASKED.get('env') === 'axes';
  const warm = axes ? directions() : sky([1.2, 0.6, 0.2], [0.2, 0.08, 0.02], [3, 2, 1]);
  /* `?ormfirst=1`: the map made before any probe exists, an order the bisection asks about. */
  const early =
    ASKED.get('ormfirst') === '1'
      ? renderer.createSurfaceTexture(metalOrm(), { colorSpace: 'linear' })
      : null;
  const cool = sky([0.2, 0.5, 1.2], [0.02, 0.05, 0.2], [1, 2, 3]);
  const one = ASKED.get('one');
  let ok: boolean;
  if (one === 'env') {
    ok = renderer.setEnvironmentImage(warm);
  } else if (one === 'layer') {
    ok = renderer.setProbeGrid({ origin: [0, 0, 0], spacing: [1, 1, 1], counts: [1, 1, 1] });
    ok = ok && renderer.setProbeLayerImage(0, warm);
  } else {
    ok = renderer.setProbeGrid({ origin: [-2, 0, 0], spacing: [4, 4, 4], counts: [2, 1, 1] });
    ok = ok && renderer.setProbeLayerImage(0, warm) && renderer.setProbeLayerImage(1, cool);
  }

  const camera = new Camera();
  camera.fovYDeg = 40;
  camera.position[2] = 9;
  camera.lookAt(0, 0, 0);
  renderer.resize();
  camera.updateMatrices(canvas.height > 0 ? canvas.width / canvas.height : 1);
  const ball = renderer.createMesh(
    new MeshBuilder()
      .addSphere([0, 0, 0], 1.3, [0.9, 0.9, 0.9], 0, 48, 24)
      .build({ planarUvs: ASKED.get('uvs') === '1' }),
  );
  const orm = early ?? renderer.createSurfaceTexture(metalOrm(), { colorSpace: 'linear' });
  const left = new Float32Array([
    1,
    0,
    0,
    0,
    0,
    1,
    0,
    0,
    0,
    0,
    1,
    0,
    one === null ? -2 : 0,
    0,
    0,
    1,
  ]);
  const far = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -50, 1]);
  const right = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 2, 0, 0, 1]);

  /* For a probe from outside: the renderer and the map, which a readback inspects. */
  (globalThis as unknown as { __probeLayers: unknown }).__probeLayers = { renderer, orm };
  const frame = (): void => {
    renderer.beginFrame(BACKGROUND);
    renderer.bindMeshPass(camera, env);
    /* `?dummy=1`: a draw with no material first, the IBL page's own order. */
    if (ASKED.get('dummy') === '1') {
      renderer.setMaterial(null);
      renderer.drawMesh(ball, far);
    }
    if (ASKED.get('order') === 'flip') {
      renderer.setSurfaceReflectivity(1);
      renderer.setMaterial({ orm });
    } else {
      renderer.setMaterial(
        ASKED.get('orm') === '0' ? null : { orm, roughnessScale: Number(ASKED.get('rscale') ?? 1) },
      );
      renderer.setSurfaceReflectivity(1);
    }
    renderer.drawMesh(ball, left);
    if (one === null) renderer.drawMesh(ball, right);
    renderer.endFrame();
    requestAnimationFrame(frame);
  };
  frame();
  stats.textContent = `${created.backend} · ${ok ? 'filled' : 'REFUSED'} · ${location.search || 'two'}`;
}

void main();
