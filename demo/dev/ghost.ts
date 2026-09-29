/**
 * What a moving object leaves behind, which no screenshot of this repository can show.
 *
 * **Every capture the harness takes is of a frozen scene.** `?hold=N` advances the clock N steps
 * and then stops it, and the page redraws that one state for ever — which is what makes a
 * screenshot repeatable, and which also means an accumulating resolve has converged on it long
 * before the shutter opens. Measured: the one published scene with rigid motion reconstructs to a
 * mean delta of 0.93 from its native frame at every hold tried, *better* than a still scene,
 * because there is nothing left to ghost.
 *
 * So this page takes the two frames a capture never can. A bright box crosses a still camera; each
 * position is drawn once **arriving** — with a history of where the box was — and then again
 * several times until the history is this position's own, and the two are compared here, pixel for
 * pixel. What differs is the ghost.
 *
 *     /ghost.html?backend=webgpu                     the control: no reconstruction, so no history
 *     /ghost.html?backend=webgpu&recon=1.5           the measurement
 *
 * **The control has to be zero.** With no reconstruction there is no history, so the arriving frame
 * and the settled frame are the same draw of the same matrices and must agree to the bit. A control
 * that is not zero means this page is measuring its own noise and nothing it reports is a ghost.
 *
 * `scripts/ghost-check.mjs` reads `__ghostCheck`. Nothing here is engine API and nothing under
 * `packages/*​/src` may import it.
 */

import {
  Camera,
  MeshBuilder,
  createEnvironment,
  createMeshInstances,
  createMover,
  createRenderer,
} from '../../packages/core/src/index';
import type {
  MeshHandle,
  ParticleInstances,
  RendererApi,
  Vec3,
} from '../../packages/core/src/index';
import { DEV_RENDERER, askedQuality } from './askedQuality';

/** Black, so a ghost is the brightest thing in the region it is left in. */
const CLEAR: Vec3 = [0, 0, 0];

/** Positions across the frame. Each costs one arriving frame and `SETTLE` more. */
const STEPS = 24;

/**
 * Frames spent letting the history catch up before the settled picture is read.
 *
 * A tenth of each frame is new, so twelve frames leave about a quarter of the oldest position's
 * weight — which is plenty, because the same residue is in every settled frame and the comparison
 * is between two frames at the *same* position.
 */
const SETTLE = 12;

/**
 * How far the box moves a step, in world units.
 *
 * About eight pixels of a 720-pixel frame at this camera: fast enough that a history reprojected
 * by the camera alone lands well clear of the box, slow enough that the box stays on screen for
 * every one of the steps.
 */
const SPEED = 0.062;

/** Where it starts, so the crossing is centred on the frame. */
const START_X = -0.75;

/**
 * How much brighter the arriving frame has to be for a pixel to count as a trail.
 *
 * The box is drawn at full orange over a floor at about a third of that, so a ghost of it is a
 * hundred or more levels brighter than what belongs there. Thirty-two is well above the few levels
 * an accumulation differs by at the same position and well below what a trail shows.
 */
const TRAIL_MARGIN = 32;

interface Result {
  backend: string;
  /** Per step: pixels that differ between the frame that arrived and the frame that stayed. */
  moving: number[];
  /**
   * Per step: of those, the ones the arriving frame drew **brighter** by a clear margin.
   *
   * **This is the ghost on its own, and `moving` is not.** Even with a perfect motion vector the
   * two frames differ where the box is *now*: the settled one has twelve frames of accumulation
   * there and the arriving one has two, so the count can never reach zero while a reconstruction
   * is running. What only a misplaced history can produce is the box's own brightness *behind* it,
   * over a floor that is much darker — so a pixel the arriving frame drew far brighter than the
   * settled one is a trail, and convergence, which is symmetric and small, is not counted.
   */
  trail: number[];
  /** The brightest single-channel disagreement over the whole run. */
  worst: number;
  error: string | null;
}

function modelAt(out: Float32Array, x: number, y = 0): Float32Array {
  out.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, 0, 1]);
  return out;
}

/**
 * The same box, turned about its own vertical axis and standing still.
 *
 * **This is the motion depth cannot see.** A sliding box vacates ground at a different distance
 * from the camera, so the disocclusion refuses the stale history on depth alone; a turning box
 * keeps every pixel at very nearly the depth it had, while the surface *at* that pixel is a
 * different part of the box. Nothing but a motion vector can tell that apart.
 */
function turnedAt(out: Float32Array, radians: number, y: number): Float32Array {
  const c = Math.cos(radians);
  const s = Math.sin(radians);
  out.set([c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, y, 0, 1]);
  return out;
}

async function main(): Promise<void> {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const stats = document.getElementById('stats') as HTMLElement;

  const asked = new URLSearchParams(location.search);
  /*
   * What moves, and how. `slide` crosses the frame and `spin` turns on the spot — see `turnedAt`
   * for why both exist — and the rest are one rig per kind of motion a reconstruction must follow:
   * `skin` bends a limb by its palette, `dynamic` rewrites a mesh through `updateMesh`, `instanced`
   * moves an instanced batch, and `translucent` and `particles` are the blended draws that are
   * drawn after the upscale.
   */
  const kind = asked.get('motion') ?? 'slide';
  const spinning = kind === 'spin';
  /*
   * How a draw says which object it is: `none` (the control: every pixel takes the camera's
   * motion), `matrix` (last frame's model) or `mover` (a `Mover`). `motion0=1` is the old spelling
   * of `none`. The dynamic and instanced rigs need neither: the mesh and the batch are their own.
   */
  const ident = asked.get('motion0') === '1' ? 'none' : (asked.get('ident') ?? 'matrix');

  const created = await createRenderer(canvas, askedQuality(), DEV_RENDERER);
  await created.renderer.ready();
  const renderer: RendererApi = created.renderer;

  /* One bright box on black: a ghost of it is unambiguous, and a shading gradient is not. */
  const box: MeshHandle = renderer.createMesh(
    new MeshBuilder().addBox([0, 0, 0], [0.22, 0.22, 0.22], [1, 1, 1]).build(),
  );
  /* A floor behind it, so the region the box vacates is a surface rather than the clear colour —
     a ghost over black is a brightness and a ghost over a surface is what a game would see. */
  const floor: MeshHandle = renderer.createMesh(
    new MeshBuilder().addBox([0, -0.6, 0], [3, 0.05, 2], [0.35, 0.37, 0.4]).build(),
  );

  const mover = createMover();

  /* A bar skinned to two joints, its upper half bending about z at the elbow. */
  const barData = new MeshBuilder().addBox([0, 0.25, 0], [0.12, 0.5, 0.12], [1, 1, 1]).build();
  const barVertices = barData.positions.length / 3;
  const joints = new Float32Array(barVertices * 4);
  const weights = new Float32Array(barVertices * 4);
  for (let v = 0; v < barVertices; v += 1) {
    const upper = (barData.positions[v * 3 + 1] as number) > 0.25 ? 1 : 0;
    joints[v * 4 + 1] = 1;
    weights[v * 4] = 1 - upper;
    weights[v * 4 + 1] = upper;
  }
  const bar: MeshHandle = renderer.createMesh({ ...barData, joints, weights });
  const palette = new Float32Array(32);
  /** Joint 0 at rest; joint 1 turned about z through the elbow at y = 0.25. */
  function bend(out: Float32Array, radians: number): void {
    const c = Math.cos(radians);
    const s = Math.sin(radians);
    out.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], 0);
    out.set([c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0.25 * s, 0.25 - 0.25 * c, 0, 1], 16);
  }

  /* The box again, moved by rewriting its vertices rather than by its matrix. */
  const dynamicData = new MeshBuilder().addBox([0, 0, 0], [0.22, 0.22, 0.22], [1, 1, 1]).build();
  const dynamicBox: MeshHandle = renderer.createMesh(dynamicData, { dynamic: true });
  const dynamicPositions = new Float32Array(dynamicData.positions.length);

  /* Five boxes in one instanced batch, crossing together. */
  const batch = renderer.createInstanced(box, 5);
  const instances = createMeshInstances(5);
  instances.count = 5;

  /* Sparks: the blended draw that is not a mesh. */
  const sparks = renderer.createParticles(16, {
    material: 'spark',
    blend: 'additive',
    coreGain: 1.8,
  });
  const sparkData: ParticleInstances = {
    positions: new Float32Array(48),
    sizes: new Float32Array(16),
    spins: new Float32Array(16),
    colors: new Float32Array(48),
    alphas: new Float32Array(16),
    ages: new Float32Array(16),
    seeds: new Float32Array(16),
    velocities: new Float32Array(48),
    count: 16,
    capacity: 16,
  };
  for (let i = 0; i < 16; i += 1) {
    sparkData.sizes[i] = 0.08;
    sparkData.alphas[i] = 1;
    sparkData.ages[i] = 0.5;
    sparkData.seeds[i] = i / 16;
    sparkData.colors.set([1, 0.55, 0.2], i * 3);
  }

  const env = createEnvironment();
  env.ambient = [0.35, 0.37, 0.4];
  env.directionalColor = [1, 0.97, 0.9];
  env.directionalDir = [0.3, 0.8, 0.5];

  const camera = new Camera();
  camera.fovYDeg = 50;
  camera.near = 0.4;
  camera.far = 100;
  camera.position[0] = 0;
  camera.position[1] = 0.1;
  camera.position[2] = 3.2;
  camera.lookAt(0, -0.3, 0);

  renderer.resize();
  camera.updateMatrices(canvas.height > 0 ? canvas.width / canvas.height : 1);

  const boxModel = new Float32Array(16);
  const floorModel = modelAt(new Float32Array(16), 0);

  const mirror = document.createElement('canvas');
  mirror.width = canvas.width;
  mirror.height = canvas.height;
  const maybeContext = mirror.getContext('2d', { willReadFrequently: true });
  if (maybeContext === null) throw new Error('no 2d context to read the frame through');
  const context: CanvasRenderingContext2D = maybeContext;

  /**
   * The canvas as it stands.
   *
   * **Read inside the animation frame that drew it**, because a WebGPU canvas has a current
   * texture only until the frame ends and a copy taken afterwards is black — which `taa.ts`
   * records having been measured on this harness.
   */
  function grab(): Uint8ClampedArray {
    context.clearRect(0, 0, mirror.width, mirror.height);
    context.drawImage(canvas, 0, 0);
    return context.getImageData(0, 0, mirror.width, mirror.height).data.slice();
  }

  const previousBoxModel = new Float32Array(16);

  /**
   * `at` is a distance along the crossing, or an angle in radians when the box is turning.
   *
   * `was` is where the box stood on the frame before, handed to `drawMesh` so the motion pass has
   * something to draw. `?motion0=1` withholds it, which is the control this page is measured
   * against: the same frames with the resolve deriving every pixel's motion from the camera alone.
   */
  function drawAt(at: number, was: number): void {
    renderer.beginFrame(CLEAR);
    renderer.bindMeshPass(camera, env);
    renderer.drawMesh(floor, floorModel, 0, [1, 1, 1]);
    const previous = spinning
      ? turnedAt(previousBoxModel, was, -0.33)
      : modelAt(previousBoxModel, was, -0.33);
    const identity = ident === 'mover' ? mover : ident === 'matrix' ? previous : null;
    if (kind === 'skin') {
      /*
       * A swing of 0.8 radians either way, about nine degrees a frame at its fastest, so the limb
       * stays above the floor for every step. A steady bend of four radians a metre folded it into
       * the floor by the ninth step and measured an object that was no longer there.
       */
      bend(palette, 0.8 * Math.sin((at - START_X) * 3));
      renderer.setSkinPalette(palette);
      renderer.drawMesh(
        bar,
        modelAt(boxModel, 0, -0.5),
        0,
        [1, 0.55, 0.2],
        ident === 'mover' ? mover : null,
      );
      renderer.setSkinPalette(null);
    } else if (kind === 'dynamic') {
      for (let v = 0; v < dynamicPositions.length; v += 3) {
        dynamicPositions[v] = (dynamicData.positions[v] as number) + at;
        dynamicPositions[v + 1] = (dynamicData.positions[v + 1] as number) - 0.33;
        dynamicPositions[v + 2] = dynamicData.positions[v + 2] as number;
      }
      renderer.updateMesh(dynamicBox, dynamicPositions);
      renderer.drawMesh(dynamicBox, modelAt(boxModel, 0), 0, [1, 0.55, 0.2]);
    } else if (kind === 'instanced') {
      for (let i = 0; i < 5; i += 1) {
        instances.models.set(modelAt(boxModel, at, -0.33 + (i - 2) * 0.12), i * 16);
        instances.tints.set([1, 0.55, 0.2], i * 3);
      }
      renderer.uploadInstanced(batch, instances);
      renderer.drawInstanced(batch, instances);
    } else if (kind === 'translucent') {
      renderer.drawTranslucentMesh(box, modelAt(boxModel, at, -0.33), 0.85, {
        tint: [1, 0.55, 0.2],
      });
    } else if (kind === 'particles') {
      for (let i = 0; i < 16; i += 1) {
        sparkData.positions.set([at + (i % 4) * 0.05, -0.33 + Math.floor(i / 4) * 0.05, 0], i * 3);
      }
      renderer.drawParticles(sparks, sparkData, camera, env, 1);
    } else {
      const model = spinning ? turnedAt(boxModel, at, -0.33) : modelAt(boxModel, at, -0.33);
      renderer.drawMesh(box, model, 0, [1, 0.55, 0.2], identity);
    }
    renderer.endFrame();
  }

  const result: Result = {
    backend: created.backend,
    moving: [],
    trail: [],
    worst: 0,
    error: null,
  };

  /** One frame, drawn and optionally read, on its own animation frame. */
  const tick = (x: number, was: number, read: boolean): Promise<Uint8ClampedArray | null> =>
    new Promise((done) => {
      requestAnimationFrame(() => {
        drawAt(x, was);
        done(read ? grab() : null);
      });
    });

  /*
   * A turn of six degrees a frame, which moves a corner of this box about as far across the frame
   * as the crossing does — so the two cases are the same speed and differ only in what depth can
   * see about them.
   */
  const SPIN = (6 * Math.PI) / 180;
  const start = spinning ? 0 : START_X;

  /* Settled at the first position before anything is measured: an empty history is its own case. */
  for (let i = 0; i < SETTLE; i += 1) await tick(start, start, false);

  if (asked.get('stepper') === '1') {
    /*
     * One arriving draw of step `i`, from step `i - 1`, and nothing after it, so a capture taken
     * then reads what the arriving frame showed. `scripts/ghost-check.mjs --edges=1` drives this
     * and compares each capture with the same step drawn at no reconstruction.
     */
    (globalThis as unknown as { __ghostStep: (i: number) => Promise<void> }).__ghostStep = (i) =>
      new Promise((done) => {
        requestAnimationFrame(() => {
          const x = spinning ? (i + 1) * SPIN : START_X + (i + 1) * SPEED;
          const before = spinning ? i * SPIN : START_X + i * SPEED;
          drawAt(x, before);
          done();
        });
      });
    stats.textContent = 'stepper ready';
    return;
  }

  for (let step = 0; step < STEPS; step += 1) {
    const x = spinning ? (step + 1) * SPIN : START_X + (step + 1) * SPEED;
    const before = spinning ? step * SPIN : START_X + step * SPEED;
    /* The first frame at the new position, carrying a history of the position before it. */
    const arrived = (await tick(x, before, true)) as Uint8ClampedArray;
    /* Settling: the box has not moved, so where it was is where it is. */
    for (let i = 0; i < SETTLE - 1; i += 1) await tick(x, x, false);
    const settled = (await tick(x, x, true)) as Uint8ClampedArray;

    let differing = 0;
    let trailing = 0;
    for (let i = 0; i < arrived.length; i += 4) {
      let off = 0;
      let brighter = 0;
      for (let c = 0; c < 3; c += 1) {
        const a = arrived[i + c] ?? 0;
        const b = settled[i + c] ?? 0;
        off = Math.max(off, Math.abs(a - b));
        brighter = Math.max(brighter, a - b);
      }
      if (off > 0) differing += 1;
      if (brighter > TRAIL_MARGIN) trailing += 1;
      result.worst = Math.max(result.worst, off);
    }
    result.moving.push(differing);
    result.trail.push(trailing);
  }

  (globalThis as unknown as { __ghostCheck: Result }).__ghostCheck = result;
  const total = result.moving.reduce((sum, value) => sum + value, 0);
  const trail = result.trail.reduce((sum, value) => sum + value, 0);
  stats.textContent =
    `${created.backend} · ${kind} · ${ident} · ${String(STEPS)} steps · ${String(total)} differ · ` +
    `${String(trail)} trailing · worst ${String(result.worst)}`;
}

void main().catch((error: unknown) => {
  const box = document.getElementById('error');
  if (box !== null)
    box.textContent = error instanceof Error ? (error.stack ?? error.message) : String(error);
  (globalThis as unknown as { __ghostCheck: Result }).__ghostCheck = {
    backend: 'none',
    moving: [],
    trail: [],
    worst: 0,
    error: error instanceof Error ? error.message : String(error),
  };
});
