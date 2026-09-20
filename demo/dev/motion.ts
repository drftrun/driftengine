/**
 * Does the second pipeline draw the same picture whether or not the camera has just moved?
 *
 * **It has to, and nothing else in the repository can see whether it does.** The two-phase cull
 * reads last frame's visibility to decide which half judges a cluster, and a mistake in that half
 * is a cluster missing for exactly one frame — after which the history has caught up and every
 * capture the harness takes, all of them from a camera at rest, is correct. So this page takes the
 * two frames a capture never can: each position of a turn is drawn once arriving from the last
 * position and once again from where it already is, and the two are compared here, pixel for pixel.
 *
 *     /motion.html?backend=webgpu&rig=occlusion&spin=240
 *
 * `rig` is `occlusion`, `dense` or `materials`, and `spin` is `gpuDrivenRig.ts`'s knob, in degrees
 * a second of the sixtieths this page steps by — so 240 is four degrees a frame. `scripts/motion-check.mjs`
 * reads `__motionCheck`.
 *
 * **What a failure looks like:** `moving` above zero at some step. The picture a moving camera saw
 * lacked something the settled one had, and the step says where in the turn.
 *
 * Nothing here is engine API and nothing under `packages/*​/src` may import it.
 */
import type { RenderQualityOptions } from '../../packages/core/src/index';
import { denseRig, materialsRig, mountRig, occlusionRig } from '../gpuDrivenRig';
import { askedQuality } from './askedQuality';

/** Positions along the turn. Each costs three frames and two readbacks. */
const STEPS = 48;

/** The page's own clock, a sixtieth a frame, like `?hold=`. */
const STEP_SECONDS = 1 / 60;

interface Result {
  backend: string;
  rig: string;
  /** Per step: pixels that differ between the frame that arrived and the frame that stayed. */
  moving: number[];
  /** Per step: pixels that differ between this step's settled frame and the last one's. */
  turned: number[];
  error: string | null;
}

const RIGS = { occlusion: occlusionRig, dense: denseRig, materials: materialsRig };

/** The canvas as it stands, read through a 2D canvas the same size. */
function grab(source: HTMLCanvasElement, into: CanvasRenderingContext2D): Uint8ClampedArray {
  into.clearRect(0, 0, source.width, source.height);
  into.drawImage(source, 0, 0);
  return into.getImageData(0, 0, source.width, source.height).data;
}

function differing(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  let count = 0;
  for (let i = 0; i < a.length; i += 4) {
    if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) count += 1;
  }
  return count;
}

async function main(): Promise<void> {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const stats = document.getElementById('stats') as HTMLElement;
  const asked = new URLSearchParams(location.search);
  const name = (asked.get('rig') ?? 'occlusion') as keyof typeof RIGS;
  const build = RIGS[name] ?? occlusionRig;
  const overrides: RenderQualityOptions = askedQuality();
  /* Sized by the mount, which resizes the renderer to the canvas it was given. */
  const handle = await mountRig(canvas, overrides, build);

  const scratch = document.createElement('canvas');
  scratch.width = canvas.width;
  scratch.height = canvas.height;
  const context = scratch.getContext('2d', { willReadFrequently: true });
  if (context === null) throw new Error('no 2d context to read the frame through');

  const result: Result = {
    backend: new URLSearchParams(location.search).get('backend') ?? 'webgpu',
    rig: name,
    moving: [],
    turned: [],
    error: null,
  };

  /* Settled at the first position before anything is measured: an empty history is its own case. */
  for (let i = 0; i < 4; i += 1) handle.frame(0);

  let previous: Uint8ClampedArray | null = null;
  for (let step = 0; step < STEPS; step += 1) {
    /* Drawn where the eye already is, and then the eye moves on. */
    handle.frame(STEP_SECONDS);
    /* The first frame at the new position, with last frame's history and pyramid. */
    handle.frame(0);
    const arrived = grab(canvas, context).slice();
    /* The same position again, now that the history is this position's own. */
    handle.frame(0);
    const settled = grab(canvas, context).slice();
    result.moving.push(differing(arrived, settled));
    result.turned.push(previous === null ? 0 : differing(previous, settled));
    previous = settled;
  }

  (globalThis as unknown as { __motionCheck: Result }).__motionCheck = result;
  const lost = result.moving.reduce((sum, value) => sum + value, 0);
  stats.textContent = `${result.rig} · ${STEPS} steps · ${lost} pixels differ in motion`;
  (window as unknown as { __heldFrame?: number }).__heldFrame = STEPS;
}

void main().catch((error: unknown) => {
  const box = document.getElementById('error');
  if (box !== null) box.textContent = `motion failed:\n${String(error)}`;
  (globalThis as unknown as { __motionCheck: Result }).__motionCheck = {
    backend: 'none',
    rig: 'none',
    moving: [],
    turned: [],
    error: error instanceof Error ? error.message : String(error),
  };
});
