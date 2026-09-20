/**
 * What a moving camera does to a reconstruction, which no capture of a published scene isolates.
 *
 * **The ghost page moves an object under a still camera; this moves the camera over a still
 * world**, which is the other half of a resolve's reprojection and the half every published scene
 * leans on. It draws one flight through two renderers on one page — the one asked for, and the same
 * without reconstruction — and at the last frame compares them tile by tile: the shift that best
 * lines each tile of the reconstructed picture up with the native one. A history reprojected
 * correctly lands where the frame is, and the shift is a fraction of a pixel; a history that is
 * not moved trails the motion, and the shift is the distance it trails by.
 *
 *     /pan.html?backend=webgpu&pan=slide                          the control: both native
 *     /pan.html?backend=webgpu&pan=slide&recon=1.5&samples=1      the measurement
 *
 * **Two motions, because they separate two faults.** `slide` translates the eye, so every surface
 * moves by an amount its depth decides; `turn` turns it in place, so every surface moves alike. A
 * resolve reading the wrong depth reprojects a turn correctly and a slide not at all — which is
 * the defect this page found: the depth it reprojected through had been discarded, and read as
 * the far plane everywhere.
 *
 * **The control has to be zero**, as the ghost page's does: with reconstruction off the two
 * renderers draw the same frames and must agree to the bit. `scripts/pan-check.mjs` reads
 * `__panCheck`. Nothing here is engine API.
 */
import {
  Camera,
  MeshBuilder,
  createEnvironment,
  createRenderer,
} from '../../packages/core/src/index';
import type { RendererApi } from '../../packages/core/src/index';
import { DEV_RENDERER, askedQuality } from './askedQuality';

/** Tiles across and down the frame, each measured on its own. */
const TILES_X = 8;
const TILES_Y = 4;
/** The largest shift searched, in pixels, and the step it is searched in. */
const REACH = 3;
const STEP = 0.25;

interface Result {
  backend: string;
  /** Per tile, row by row: the best shift in pixels, x then y. */
  shifts: number[];
  /** The largest shift of any tile, in either axis. */
  worst: number;
  /** Pixels the two frames differ in at all. Zero is the control's only passing value. */
  differing: number;
  error: string | null;
}

function luma(pixels: Uint8ClampedArray, width: number, x: number, y: number): number {
  const at = (y * width + x) * 4;
  return (
    0.2126 * (pixels[at] as number) +
    0.7152 * (pixels[at + 1] as number) +
    0.0722 * (pixels[at + 2] as number)
  );
}

/** A bilinear read, so a shift can be scored between pixel centres. */
function lumaAt(pixels: Uint8ClampedArray, width: number, x: number, y: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const top = luma(pixels, width, x0, y0) * (1 - fx) + luma(pixels, width, x0 + 1, y0) * fx;
  const bottom =
    luma(pixels, width, x0, y0 + 1) * (1 - fx) + luma(pixels, width, x0 + 1, y0 + 1) * fx;
  return top * (1 - fy) + bottom * fy;
}

/** The shift that best lines each tile of `moved` up with `still`, by least squared difference. */
function tileShifts(
  moved: Uint8ClampedArray,
  still: Uint8ClampedArray,
  width: number,
  height: number,
): number[] {
  const shifts: number[] = [];
  const margin = REACH + 2;
  const tileWidth = Math.floor(width / TILES_X);
  const tileHeight = Math.floor(height / TILES_Y);
  for (let ty = 0; ty < TILES_Y; ty += 1) {
    for (let tx = 0; tx < TILES_X; tx += 1) {
      const x0 = Math.max(margin, tx * tileWidth);
      const x1 = Math.min(width - margin, (tx + 1) * tileWidth);
      const y0 = Math.max(margin, ty * tileHeight);
      const y1 = Math.min(height - margin, (ty + 1) * tileHeight);
      let best = Infinity;
      let bestX = 0;
      let bestY = 0;
      for (let dy = -REACH; dy <= REACH; dy += STEP) {
        for (let dx = -REACH; dx <= REACH; dx += STEP) {
          let sum = 0;
          for (let y = y0; y < y1; y += 2) {
            for (let x = x0; x < x1; x += 2) {
              const d = lumaAt(moved, width, x + dx, y + dy) - luma(still, width, x, y);
              sum += d * d;
            }
          }
          if (sum < best) {
            best = sum;
            bestX = dx;
            bestY = dy;
          }
        }
      }
      shifts.push(bestX, bestY);
    }
  }
  return shifts;
}

async function main(): Promise<void> {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const referenceCanvas = document.getElementById('reference') as HTMLCanvasElement;
  const stats = document.getElementById('stats') as HTMLElement;
  const asked = new URLSearchParams(location.search);
  const turning = asked.get('pan') === 'turn';
  const frames = Number(asked.get('frames') ?? '60');

  const quality = askedQuality();
  const made = await createRenderer(canvas, quality, DEV_RENDERER);
  const reference = await createRenderer(
    referenceCanvas,
    { ...quality, reconstruction: 0 },
    DEV_RENDERER,
  );
  await made.renderer.ready();
  await reference.renderer.ready();
  const renderers: RendererApi[] = [made.renderer, reference.renderer];

  /*
   * A checkered floor and rows of posts: corners in every tile, at every depth the camera sees.
   * **Corners and not only edges**, because a tile holding one long edge can be slid along it at
   * no cost, and the search then reports whichever shift the stair-steps of the native frame's
   * edge happen to favour. Quarter-metre squares put several corners in the nearest tile.
   */
  const SQUARE = 0.25;
  const builder = new MeshBuilder();
  for (let z = -12; z < 6; z += SQUARE) {
    for (let x = -10; x < 10; x += SQUARE) {
      const light = (Math.round(x / SQUARE) + Math.round(z / SQUARE)) & 1 ? 0.75 : 0.25;
      builder.addBox(
        [x + SQUARE / 2, -1, z + SQUARE / 2],
        [SQUARE / 2, 0.02, SQUARE / 2],
        [light, light * 0.9, light * 0.8],
      );
    }
  }
  for (let z = -24; z <= 0; z += 4) {
    for (let x = -12; x <= 12; x += 3)
      builder.addBox([x, -0.5, z], [0.1, 0.5, 0.1], [0.9, 0.5, 0.2]);
  }
  const geometry = builder.build();
  const worlds = renderers.map((renderer) => renderer.createMesh(geometry));
  const model = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

  const env = createEnvironment();
  env.ambient = [0.4, 0.4, 0.42];
  env.directionalColor = [1, 0.97, 0.9];
  env.directionalDir = [0.3, 0.8, 0.5];

  const camera = new Camera();
  camera.fovYDeg = 50;
  camera.near = 0.1;
  camera.far = 200;
  for (const renderer of renderers) renderer.resize();
  const aspect = canvas.height > 0 ? canvas.width / canvas.height : 1;

  const mirror = document.createElement('canvas');
  mirror.width = canvas.width;
  mirror.height = canvas.height;
  const context = mirror.getContext('2d', { willReadFrequently: true });
  if (context === null) throw new Error('no 2d context to read the frame through');
  /* Inside the animation frame that drew it: a WebGPU canvas is black once the frame ends. */
  const grab = (from: HTMLCanvasElement): Uint8ClampedArray => {
    context.clearRect(0, 0, mirror.width, mirror.height);
    context.drawImage(from, 0, 0);
    return context.getImageData(0, 0, mirror.width, mirror.height).data.slice();
  };

  let frame = 0;
  const draw = (): void => {
    /* Looking down at the floor, so every tile is textured and none of them is sky. */
    if (turning) {
      const yaw = frame * 0.003;
      camera.position[0] = 0;
      camera.position[1] = 2;
      camera.position[2] = 4;
      camera.lookAt(Math.sin(yaw) * -6, -1, 4 - Math.cos(yaw) * 6);
    } else {
      camera.position[0] = -2 + frame * 0.02;
      camera.position[1] = 2;
      camera.position[2] = 4;
      camera.lookAt(camera.position[0], -1, -2);
    }
    camera.updateMatrices(aspect);
    for (let i = 0; i < renderers.length; i += 1) {
      const renderer = renderers[i] as RendererApi;
      renderer.beginFrame([0.5, 0.6, 0.75]);
      renderer.bindMeshPass(camera, env);
      renderer.drawMesh(worlds[i] as NonNullable<(typeof worlds)[number]>, model, 0, [1, 1, 1]);
      renderer.endFrame();
    }
    frame += 1;
    if (frame < frames) {
      requestAnimationFrame(draw);
      return;
    }
    const moved = grab(canvas);
    const still = grab(referenceCanvas);
    let differing = 0;
    for (let i = 0; i < moved.length; i += 4) {
      if (moved[i] !== still[i] || moved[i + 1] !== still[i + 1] || moved[i + 2] !== still[i + 2]) {
        differing += 1;
      }
    }
    const shifts = tileShifts(moved, still, mirror.width, mirror.height);
    let worst = 0;
    for (const shift of shifts) worst = Math.max(worst, Math.abs(shift));
    const result: Result = { backend: made.backend, shifts, worst, differing, error: null };
    (globalThis as unknown as { __panCheck: Result }).__panCheck = result;
    stats.textContent = `${made.backend} · ${turning ? 'turn' : 'slide'} · worst shift ${worst} px · ${differing} differ`;
  };
  requestAnimationFrame(draw);
}

void main().catch((error: unknown) => {
  const box = document.getElementById('error');
  if (box !== null) {
    box.textContent = error instanceof Error ? (error.stack ?? error.message) : String(error);
  }
  (globalThis as unknown as { __panCheck: Result }).__panCheck = {
    backend: 'none',
    shifts: [],
    worst: 0,
    differing: 0,
    error: error instanceof Error ? error.message : String(error),
  };
});
