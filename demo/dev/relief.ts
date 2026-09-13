/**
 * `setSurfaceTextureRelief`, looked at on real hardware, on either backend.
 *
 * **The point of this page is that the difference is visible rather than asserted.** Task E3
 * gave the lit path a way to read relief off the surface texture already bound as colour, so a
 * photograph of a rock lights as a rock instead of as a smooth shape with a picture of a rock
 * on it. A shader that compiles is not a shader that perturbs anything, and a normal term that
 * quietly does nothing is the expensive kind of wrong: nothing fails, the picture is merely flat.
 *
 * Four panels, identical in every respect except the one argument, lit by a source raking across
 * them from the left so a bump catches light on one side and shades on the other:
 *
 *   - **Panel 1, `0`** — the call every textured draw made before this task. The texture's own
 *     low-contrast pattern is visible as colour and nothing else; the panel reads as the flat
 *     plate it is.
 *   - **Panel 2, `0.13`** — the number the homepage's asteroid carries over from three.js's
 *     `bumpScale`, unchanged. Subtle on purpose: this is what the consumer this was built for
 *     actually asks for, and if the middle of the range were the only legible setting the
 *     feature would be mistuned.
 *   - **Panel 3, `1`** — unmistakable, so a capture answers "did anything happen" without a
 *     pixel sampler.
 *   - **Panel 4, `1` with no texture bound** — the same strong scale on an untextured mesh,
 *     which must be indistinguishable from a plain draw. This is the no-texture claim made
 *     visible rather than left to the reader: the shader gates on the same flag
 *     `setSurfaceTexture(null)` clears, so geometry with no image pays nothing and changes
 *     nothing.
 *
 * The texture is deliberately **low contrast in colour and steep in gradient**: a grid of domes
 * painted between two near-identical greys. That separates the two roles one image is playing —
 * if the panels differed because the picture is busy, panel 1 would show it too, and it does not.
 *
 *     /relief.html                 the default backend, which is WebGL2
 *     /relief.html?backend=webgpu  the other one
 *     /relief.html?mips=0          the same, with the sampler's mip chain and anisotropy off
 *
 * **`?mips=0` is what makes the two-backend claim readable, and it is the reason it exists.**
 * With it the two backends agree to the last bit: measured at 1280 by 720, 0, 2 and 14 pixels of
 * 47,000 differ on the three textured panels and none of them by a whole luminance level. With
 * the ordinary mipmapped, anisotropic sampler they disagree by up to 0.79 of 255 on the plain
 * textured panel that uses no relief at all — the two implementations' own filtering, not
 * anything this page added — and the relief panels carry that same disagreement amplified to
 * 2.21 and 13.14, because a slope is a difference of two samples over a short step and a short
 * step magnifies whatever the samples disagree about. Neither number is a defect; without the
 * control, the second one looks like one.
 *
 * Deterministic: one fixed light, one fixed camera, a texture painted from a closed form with no
 * clock and no random anywhere, so a two-capture diff of an unchanged build reads zero.
 *
 * The canvas the texture is painted on goes up as it is, with no flip: the dome grid is mirror
 * symmetric in both axes, so which way round it arrives cannot change what it draws. A consumer
 * whose image is not symmetric owns that question itself; see `orientForUpload` in the two
 * consumers that hit it.
 *
 * Nothing here is engine API and nothing under `src/` may import it. It is a harness instrument,
 * beside `translucent.ts` and `particles.ts`.
 */

import {
  Camera,
  MeshBuilder,
  createEnvironment,
  createRenderer,
} from '../../packages/core/src/index';
import type {
  MeshHandle,
  RendererApi,
  SurfaceTextureHandle,
  Vec3,
} from '../../packages/core/src/index';
import { DEV_RENDERER, askedQuality } from './askedQuality';

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const BACKGROUND: Vec3 = [0.06, 0.07, 0.09];

/** A translation, written fresh each call — every mesh on this page is placed once. */
function at(x: number, y: number, z: number): Float32Array {
  const m = new Float32Array(IDENTITY);
  m[12] = x;
  m[13] = y;
  m[14] = z;
  return m;
}

/**
 * A camera-facing plate, 2.4m square, centred at the origin.
 *
 * `planarUvs` because `addQuad` contributes none of its own, and a mesh with no coordinates
 * samples texel (0,0) everywhere: a flat colour with no gradient in it, which is a relief term
 * reading zero for a reason that has nothing to do with the relief term. The projection is from
 * *local* position, so all four panels carry identical coordinates and differ only in the one
 * argument this page is about.
 */
function buildPanel(color: Vec3): ReturnType<MeshBuilder['build']> {
  return new MeshBuilder()
    .addQuad([-1.2, -1.2, 0], [1.2, -1.2, 0], [1.2, 1.2, 0], [-1.2, 1.2, 0], color)
    .build({ planarUvs: true });
}

/**
 * A grid of domes, painted between two greys a tenth of the range apart.
 *
 * Low contrast in colour so the panels cannot differ merely because the picture is busy, and
 * steep in gradient at each dome's rim so there is a real slope for the shader to read. A
 * radial gradient rather than a photograph because this repository ships and fetches no image
 * assets, which is the same reason `surfaceTexture.ts` documents for its own examples.
 */
function paintDomeGrid(): HTMLCanvasElement {
  const size = 512;
  const cells = 8;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('relief: no 2D context');

  ctx.fillStyle = '#a8a8a8';
  ctx.fillRect(0, 0, size, size);

  const cell = size / cells;
  const radius = cell * 0.46;
  for (let row = 0; row < cells; row++) {
    for (let column = 0; column < cells; column++) {
      const cx = (column + 0.5) * cell;
      const cy = (row + 0.5) * cell;
      const dome = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
      dome.addColorStop(0, '#c8c8c8');
      dome.addColorStop(0.72, '#bebebe');
      dome.addColorStop(1, '#a8a8a8');
      ctx.fillStyle = dome;
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  return canvas;
}

async function main(): Promise<void> {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const stats = document.getElementById('stats') as HTMLElement;

  const created = await createRenderer(canvas, askedQuality(), DEV_RENDERER);
  /* Pipelines compiled before the first frame rather than inside it; on WebGPU
     `createRenderPipeline` defers the shader to the first draw. Engine 1.4.2. */
  await created.renderer.ready();
  const renderer: RendererApi = created.renderer;
  /* Read this back rather than trusting `?backend=`: a browser with no usable WebGPU adapter
     falls back to WebGL2 silently, and this page's whole point is a same-backend comparison. */
  console.log(`[relief] backend: ${created.backend} · ${created.reason}`);

  const env = createEnvironment({
    /*
     * Dim ambient and a bright, raking directional. Relief is a change in the *direction* light
     * leaves a point, so it shows in the difference between the two sides of a bump and is
     * invisible under a source that arrives along the view. Mostly +X, slightly toward the
     * camera, so every dome is lit on its left and shaded on its right.
     */
    ambient: [0.05, 0.055, 0.07],
    directionalColor: [1, 0.96, 0.9],
    directionalDir: [0.94, 0.12, 0.32],
    fogColor: BACKGROUND,
    fogDensity: 0,
  });

  const camera = new Camera();
  camera.fovYDeg = 46;
  camera.near = 0.3;
  camera.far = 60;
  camera.position[0] = 0;
  camera.position[1] = 0;
  camera.position[2] = 9.4;
  camera.lookAt(0, 0, 0);

  renderer.resize();
  const aspect = (): number => {
    const height = canvas.height;
    return height > 0 ? canvas.width / height : 1;
  };
  camera.updateMatrices(aspect());

  /* Near white, so what reaches the eye is the texture's own value rather than a tint over it:
     the shader multiplies the image into the vertex colour. */
  const PANEL_COLOR: Vec3 = [0.92, 0.9, 0.88];
  const panels: MeshHandle[] = [
    renderer.createMesh(buildPanel(PANEL_COLOR)),
    renderer.createMesh(buildPanel(PANEL_COLOR)),
    renderer.createMesh(buildPanel(PANEL_COLOR)),
    renderer.createMesh(buildPanel(PANEL_COLOR)),
  ];
  const models = [at(-4.2, 0, 0), at(-1.4, 0, 0), at(1.4, 0, 0), at(4.2, 0, 0)];

  /* Mipmapped by default: eight domes across a panel this size is a texel or two per pixel at
     the far edge, and a grid is exactly the pattern that shimmers without a mip chain. `?mips=0`
     turns the chain and the anisotropy off together, which is the control the header describes:
     it is the one setting under which the two backends' samplers cannot disagree. */
  const mipped = new URLSearchParams(location.search).get('mips') !== '0';
  const texture: SurfaceTextureHandle = renderer.createSurfaceTexture(paintDomeGrid(), {
    mipmap: mipped,
    anisotropy: mipped ? 4 : 1,
    wrap: 'repeat',
  });

  function renderFrame(): void {
    renderer.beginFrame(BACKGROUND);
    renderer.bindMeshPass(camera, env);

    /* Half a tile to the metre, so a dome lands about twenty pixels across at this camera:
       wide enough to read as a dome, tight enough that its rim is a real slope rather than a
       ramp spread over half the panel. */
    renderer.setSurfaceTexture(texture, 0.5, 0.5);
    /* Panel 1: the plain textured draw, exactly as every one before this task. `bindMeshPass`
       already reset the scale to 0; set it anyway, so the four calls read as one comparison
       rather than three settings and an omission. */
    renderer.setSurfaceTextureRelief(0);
    renderer.drawMesh(panels[0] as MeshHandle, models[0] as Float32Array);

    renderer.setSurfaceTextureRelief(0.13);
    renderer.drawMesh(panels[1] as MeshHandle, models[1] as Float32Array);

    renderer.setSurfaceTextureRelief(1);
    renderer.drawMesh(panels[2] as MeshHandle, models[2] as Float32Array);

    /* Panel 4: the scale left at its strongest and the texture taken away. The shader gates the
       whole term on the texture flag, so this has to be a plain lit plate. */
    renderer.setSurfaceTexture(null);
    renderer.drawMesh(panels[3] as MeshHandle, models[3] as Float32Array);

    renderer.endFrame();
  }

  renderFrame();
  stats.textContent = `${created.backend} · ${created.reason}`;

  addEventListener('resize', () => {
    renderer.resize();
    camera.updateMatrices(aspect());
    renderFrame();
  });

  (globalThis as unknown as { __drawn?: boolean }).__drawn = true;
}

main().catch((error: unknown) => {
  const box = document.getElementById('error');
  if (box !== null)
    box.textContent = error instanceof Error ? (error.stack ?? error.message) : String(error);
});
