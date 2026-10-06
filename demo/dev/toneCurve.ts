/**
 * Known light through the output transform, as patches a capture can read back: `setFilmicCurve`.
 *
 *     /toneCurve.html?transform=filmic&hdr=1      the default film curve: mid grey (the fourth
 *                                                 patch, 0.18) reads 0.18 of display linear, which
 *                                                 is 118 of 255 once sRGB-encoded
 *     /toneCurve.html?transform=aces&hdr=1        the reference fit, for the comparison: about 0.11
 *     /toneCurve.html?transform=filmic&hdr=1&curve=0.88:0.3:0.26:0:0.04
 *                                                 the five numbers (slope, toe, shoulder, black and
 *                                                 white clip) through the setter
 *     /toneCurve.html?transform=filmic&hdr=0      no composite to grade: every pass grades with
 *                                                 `aces`, and the renderer says so once
 *     /toneCurve.html?transform=filmic&hdr=1&hdrout=1&forcehigh=1&headroom=4
 *                                                 a high dynamic range canvas, the display said to
 *                                                 have one: the stats name the range and why, and
 *                                                 at `headroom=1` the patches read as above
 *     /toneCurve.html?transform=filmic&hdr=1&fringe=3:0.5
 *                                                 the lens's colour fringe, intensity and start:
 *                                                 the patch edges toward the frame's sides part into
 *                                                 red and green, and nothing inside half the
 *                                                 half-frame moves
 *
 * Top row: grey at 0.005, 0.02, 0.05, 0.18, 0.5, 1, 4 and 16. Bottom row: saturated colours, where
 * the curve's red modifier and desaturation show. Each patch is unlit and unfogged, so what reaches
 * the composite is exactly the number it was given. Nothing under `src/` may import this.
 */
import { Camera, createEnvironment, createRenderer } from '../../packages/core/src/index';
import type { MeshData, RendererApi, Vec3 } from '../../packages/core/src/index';
import { DEV_RENDERER, askedQuality } from './askedQuality';

const ASKED = new URLSearchParams(location.search);
const FOV = 50;
const GREYS = [0.005, 0.02, 0.05, 0.18, 0.5, 1, 4, 16];
const COLOURS: Vec3[] = [
  [4, 0.2, 0.1],
  [0.8, 0.05, 0.02],
  [0.1, 2, 0.1],
  [0.02, 0.1, 0.6],
  [3, 1.5, 0.1],
  [0.3, 0.05, 0.6],
  [0.1, 0.9, 0.9],
  [2, 2, 2],
];

/** Sixteen quads at z = -1 tiling a camera at the origin, eight across and two down. */
function patches(aspect: number): MeshData {
  const h = Math.tan((FOV * Math.PI) / 360);
  const w = h * aspect;
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  for (let row = 0; row < 2; row++) {
    for (let column = 0; column < 8; column++) {
      const x0 = -w + (2 * w * column) / 8;
      const x1 = -w + (2 * w * (column + 1)) / 8;
      const y1 = h - (2 * h * row) / 2;
      const y0 = h - (2 * h * (row + 1)) / 2;
      const base = positions.length / 3;
      positions.push(x0, y0, -1, x1, y0, -1, x1, y1, -1, x0, y1, -1);
      const grey = GREYS[column] ?? 0;
      const colour = row === 0 ? ([grey, grey, grey] as Vec3) : (COLOURS[column] ?? [0, 0, 0]);
      for (let k = 0; k < 4; k++) colors.push(colour[0], colour[1], colour[2]);
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }
  const count = positions.length / 3;
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(count * 3).fill(0).map((_, i) => (i % 3 === 2 ? 1 : 0)),
    colors: new Float32Array(colors),
    emissive: new Float32Array(count),
    indices: new Uint32Array(indices),
  };
}

async function main(): Promise<void> {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const stats = document.getElementById('stats') as HTMLElement;
  const created = await createRenderer(canvas, askedQuality(), {
    ...DEV_RENDERER,
    ...(ASKED.get('forcehigh') === '1' ? { highDynamicRangeDisplay: () => true } : {}),
  });
  const renderer: RendererApi = created.renderer;
  const curve = ASKED.get('curve')?.split(/[,:]/).map(Number);
  if (curve !== undefined && curve.length === 5) {
    const [slope = 0, toe = 0, shoulder = 0, blackClip = 0, whiteClip = 0] = curve;
    renderer.setFilmicCurve({ slope, toe, shoulder, blackClip, whiteClip });
  }
  const fringe = ASKED.get('fringe')?.split(/[,:]/).map(Number);
  if (fringe !== undefined) renderer.setChromaticAberration(fringe[0] ?? 0, fringe[1] ?? 0);
  const headroom = Number(ASKED.get('headroom') ?? '1');
  renderer.setDisplayLuminance(100, 100 * (Number.isFinite(headroom) ? headroom : 1));
  renderer.resize();
  const aspect = canvas.height > 0 ? canvas.width / canvas.height : 1;
  const mesh = renderer.createMesh(patches(aspect));
  const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const camera = new Camera();
  camera.fovYDeg = FOV;
  camera.near = 0.1;
  camera.far = 10;
  camera.updateMatrices(aspect);
  const env = createEnvironment({ fogDensity: 0 });
  const frame = (): void => {
    renderer.beginFrame([0, 0, 0]);
    renderer.bindMeshPass(camera, env);
    renderer.drawTranslucentMesh(mesh, identity, 1, { lit: false, fog: false });
    renderer.endFrame();
    requestAnimationFrame(frame);
  };
  frame();
  stats.textContent =
    `${created.backend} · tone curve · ${renderer.displayRange} (${renderer.displayRangeReason}) · ` +
    location.search;
}

void main();
