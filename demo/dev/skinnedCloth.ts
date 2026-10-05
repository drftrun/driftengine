/**
 * A skinned cloth on a moving rig, drawn by its binding, on either backend.
 *
 *     /skinnedCloth.html                  WebGPU, solved on the device, the binding on
 *     /skinnedCloth.html?cloth=0          the control: the same cape skinned alone, rigid on its joint
 *     /skinnedCloth.html?solver=cpu       solved by @driftengine/physics on the CPU and uploaded
 *     /skinnedCloth.html?parity=1         both solvers on one pose sequence, compared every ten frames
 *     /skinnedCloth.html?bench=1          then the solver alone, steps back to back, timed
 *     /skinnedCloth.html?sim=60x75&mesh=200x200   a garment of 4,500 particles and 40,000 vertices
 *     /skinnedCloth.html?recon=1          with DriftTR, whose motion reads last frame's particles
 *     /skinnedCloth.html?backend=webgl2   the other backend, which solves on the CPU
 *     /skinnedCloth.html?frames=90        held at another frame
 *
 * A body on joint 0 swaying and turning, and a cape hanging from joint 1 — its shoulders — which
 * nods. The cape is a coarse simulation, 14 by 18 particles by default with its top row kinematic,
 * against a capsule collider on the body, solved by `createSkinnedCloth` — compute on
 * WebGPU, `SkinnedCloth` under WebGL2; and a finer render mesh, 40 by 52 vertices, skinned to
 * joint 1 and bound to the simulation's triangles, its collar painted to follow the skeleton and
 * its hem the cloth. The vertex stage places the render vertices; nothing on the CPU touches them
 * after the binding is made.
 *
 * **What is measured**: with the binding on, the cape hangs and swings behind the body and its
 * shadow on the ground moves with it — the caster places by the same binding as the colour pass;
 * with `?cloth=0` it is a rigid board. The two backends draw the same particles, so they must
 * agree. Deterministic: a fixed step a frame for `?frames=` frames (150 by default), then held, so
 * two captures of one build are the same picture. Nothing under `src/` may import this.
 */
import { mat4 } from 'gl-matrix';

import {
  Camera,
  MeshBuilder,
  computeLightMatrix,
  createEnvironment,
  createMover,
  createRenderer,
  createSkinnedCloth,
} from '../../packages/core/src/index';
import type {
  ClothBindingData,
  MeshData,
  RendererApi,
  ShadowCasters,
  Vec3,
} from '../../packages/core/src/index';
import { SkinnedCloth } from '../../packages/physics/src/index';
import type { SkinnedClothSetup } from '../../packages/physics/src/index';
import { DEV_RENDERER, askedQuality } from './askedQuality';

const CLEAR: Vec3 = [0.55, 0.6, 0.7];
/** The simulation grid, and the render grid bound to it. */
const ASKED = new URLSearchParams(location.search);
/** `WxH` from the query, or the default. */
function gridOf(name: string, w: number, h: number): [number, number] {
  const match = /^(\d+)x(\d+)$/.exec(ASKED.get(name) ?? '');
  return match === null ? [w, h] : [Number(match[1]), Number(match[2])];
}
const [SX, SY] = gridOf('sim', 14, 18);
const [RX, RY] = gridOf('mesh', 40, 52);
/** The cape: its top edge at the shoulders, behind the body. */
const TOP = 1.58;
const HEIGHT = 1.3;
const WIDTH = 0.9;
const BACK = -0.36;
const SHOULDERS = 1.55;

const IDENTITY = mat4.create() as Float32Array;

/** Where the cape's grid point (u across, w down, both 0 to 1) is at rest, model space. */
function capeAt(u: number, w: number, into: Float32Array, at: number): void {
  into[at] = (u - 0.5) * WIDTH;
  into[at + 1] = TOP - w * HEIGHT;
  into[at + 2] = BACK;
}

/** The two triangles of grid cell `a` (its top-left index) in a grid `width` wide. */
function cell(a: number, width: number): [number, number, number, number, number, number] {
  return [a, a + 1, a + width, a + 1, a + width + 1, a + width];
}

/** The simulation: particles, structural and shear links, bending across every inner edge. */
function capeCloth(): SkinnedClothSetup {
  const count = SX * SY;
  const positions = new Float32Array(count * 3);
  const inverseMass = new Float32Array(count);
  const maxDistance = new Float32Array(count);
  const normals = new Float32Array(count * 3);
  const joints = new Float32Array(count * 4);
  const weights = new Float32Array(count * 4);
  for (let y = 0; y < SY; y++) {
    for (let x = 0; x < SX; x++) {
      const p = y * SX + x;
      capeAt(x / (SX - 1), y / (SY - 1), positions, p * 3);
      inverseMass[p] = y === 0 ? 0 : 1;
      maxDistance[p] = y === 0 ? 0 : Infinity;
      normals[p * 3 + 2] = -1;
      joints[p * 4] = 1;
      weights[p * 4] = 1;
    }
  }
  const pairs: number[] = [];
  const link = (a: number, b: number): void => {
    pairs.push(a, b);
  };
  const triangles: number[] = [];
  for (let y = 0; y < SY; y++) {
    for (let x = 0; x < SX; x++) {
      const p = y * SX + x;
      if (x + 1 < SX) link(p, p + 1);
      if (y + 1 < SY) link(p, p + SX);
      if (x + 1 < SX && y + 1 < SY) {
        link(p, p + SX + 1);
        link(p + 1, p + SX);
        triangles.push(...cell(p, SX));
      }
    }
  }
  const rest = new Float32Array(pairs.length / 2);
  for (let k = 0; k < rest.length; k++) {
    const a = (pairs[k * 2] as number) * 3;
    const b = (pairs[k * 2 + 1] as number) * 3;
    rest[k] = Math.hypot(
      (positions[a] as number) - (positions[b] as number),
      (positions[a + 1] as number) - (positions[b + 1] as number),
      (positions[a + 2] as number) - (positions[b + 2] as number),
    );
  }
  /* Every edge two triangles share: the edge, then each triangle's far corner. */
  const edges = new Map<string, number[]>();
  for (let t = 0; t < triangles.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const a = triangles[t + e] as number;
      const b = triangles[t + ((e + 1) % 3)] as number;
      const far = triangles[t + ((e + 2) % 3)] as number;
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      const seen = edges.get(key);
      if (seen === undefined) edges.set(key, [Math.min(a, b), Math.max(a, b), far]);
      else seen.push(far);
    }
  }
  const quads: number[] = [];
  for (const edge of edges.values()) if (edge.length === 4) quads.push(...edge);
  const inverseBind = new Float32Array(32);
  inverseBind.set(IDENTITY, 0);
  inverseBind.set(mat4.fromTranslation(mat4.create(), [0, -SHOULDERS, 0]), 16);
  /* The body's capsule, on joint 0: its frame turns +Z up and starts at the hips. */
  const frame = mat4.fromTranslation(mat4.create(), [0, 0.35, 0]);
  mat4.rotateX(frame, frame, -Math.PI / 2);
  return {
    positions,
    inverseMass,
    distance: {
      pairs: new Uint32Array(pairs),
      rest,
      compliance: new Float32Array(rest.length),
    },
    bending: {
      quads: new Uint32Array(quads),
      rest: new Float32Array(quads.length / 4).fill(Math.PI),
      compliance: new Float32Array(quads.length / 4).fill(0.02),
    },
    parameters: {
      substeps: 4,
      iterations: 2,
      damping: Math.log(0.4),
      drag: Math.log(0.6),
      wind: [0.6, 0, -0.4],
    },
    normals,
    joints,
    weights,
    inverseBind,
    tethers: capeTethers(positions),
    limits: {
      maxDistance,
      backstop: capeBackstop(),
      thickness: new Float32Array(count).fill(0.02),
    },
    colliders: [{ joint: 0, radius: 0.3, length: 1.1, frame: frame as Float32Array }],
  };
}

/**
 * Every free particle held to the pinned particle atop its column, no further than it hangs at
 * rest: what keeps a fine garment from stretching under gravity, which two iterations a substep
 * across 75 rows do not — measured, a 60 by 75 cape without them hung 20 centimetres long.
 */
function capeTethers(positions: Float32Array): {
  particles: Uint32Array;
  anchors: Uint32Array;
  lengths: Float32Array;
} {
  const particles: number[] = [];
  const anchors: number[] = [];
  const lengths: number[] = [];
  for (let y = 1; y < SY; y++) {
    for (let x = 0; x < SX; x++) {
      const p = y * SX + x;
      particles.push(p);
      anchors.push(x);
      lengths.push(Math.abs((positions[x * 3 + 1] as number) - (positions[p * 3 + 1] as number)));
    }
  }
  return {
    particles: new Uint32Array(particles),
    anchors: new Uint32Array(anchors),
    lengths: new Float32Array(lengths),
  };
}

/** A sphere behind each particle below the collar, toward the body: the cape does not swing in. */
function capeBackstop(): Float32Array {
  const stops = new Float32Array(SX * SY * 2);
  for (let p = SX; p < SX * SY; p++) stops.set([0.08, 0.6], p * 2);
  return stops;
}

/** The render mesh: a finer grid on the same rest plane, skinned wholly to the shoulders. */
function capeMesh(): MeshData {
  const n = RX * RY;
  const positions = new Float32Array(n * 3);
  const normals = new Float32Array(n * 3);
  const colors = new Float32Array(n * 3);
  const joints = new Float32Array(n * 4);
  const weights = new Float32Array(n * 4);
  for (let y = 0; y < RY; y++) {
    for (let x = 0; x < RX; x++) {
      const v = y * RX + x;
      const u = x / (RX - 1);
      const w = y / (RY - 1);
      capeAt(u, w, positions, v * 3);
      normals[v * 3 + 2] = -1;
      /* A stripe every few rows, so a fold reads as a fold and not as shading. */
      const stripe = Math.floor(w * 9) % 2 === 0 ? 1 : 0.82;
      colors.set([0.62 * stripe, 0.12 * stripe, 0.14 * stripe], v * 3);
      joints[v * 4] = 1;
      weights[v * 4] = 1;
    }
  }
  const indices: number[] = [];
  for (let y = 0; y + 1 < RY; y++) {
    for (let x = 0; x + 1 < RX; x++) indices.push(...cell(y * RX + x, RX));
  }
  return {
    positions,
    normals,
    colors,
    emissive: new Float32Array(n),
    joints,
    weights,
    indices: new Uint32Array(indices),
  };
}

/**
 * Each render vertex on the simulation triangle under it, by barycentrics; the collar follows the
 * skeleton and the cape below it the cloth, over a band so the seam does not show.
 */
function capeBinding(rest: Float32Array): ClothBindingData {
  const n = RX * RY;
  const triangles = new Uint32Array(n * 3);
  const coordinates = new Float32Array(n * 2);
  const follow = new Float32Array(n);
  for (let y = 0; y < RY; y++) {
    for (let x = 0; x < RX; x++) {
      const v = y * RX + x;
      const fx = (x / (RX - 1)) * (SX - 1);
      const fy = (y / (RY - 1)) * (SY - 1);
      const i = Math.min(Math.floor(fx), SX - 2);
      const j = Math.min(Math.floor(fy), SY - 2);
      const s = fx - i;
      const t = fy - j;
      const [a, b, c, b2, c2, a2] = cell(j * SX + i, SX);
      if (s + t <= 1) {
        triangles.set([a, b, c], v * 3);
        coordinates.set([s, t], v * 2);
      } else {
        /* The second triangle starts at the cell's top right: (1, 0) + α(0, 1) + β(−1, 1). */
        triangles.set([b2, c2, a2], v * 3);
        coordinates.set([s + t - 1, 1 - s], v * 2);
      }
      const w = y / (RY - 1);
      const k = Math.min(1, Math.max(0, (w - 0.04) / 0.16));
      follow[v] = k * k * (3 - 2 * k);
    }
  }
  return { triangles, coordinates, offsets: new Float32Array(n), weights: follow, rest };
}

/** The rig at time `t`: joint 0 sways and turns, joint 1 at the shoulders nods. */
function pose(t: number, globals: Float32Array): void {
  const root = mat4.fromTranslation(mat4.create(), [0.55 * Math.sin(0.9 * t), 0, 0]);
  mat4.rotateY(root, root, 0.5 * Math.sin(0.6 * t));
  const shoulders = mat4.translate(mat4.create(), root, [0, SHOULDERS, 0]);
  mat4.rotateX(shoulders, shoulders, 0.25 * Math.sin(1.7 * t));
  globals.set(root, 0);
  globals.set(shoulders, 16);
}

/** Each joint's skinning matrix: its global times its inverse bind, as `Skeleton.palette` gives. */
function palette(globals: Float32Array, inverseBind: Float32Array, out: Float32Array): void {
  for (let j = 0; j < 2; j++) {
    const m = mat4.multiply(
      mat4.create(),
      globals.subarray(j * 16, j * 16 + 16),
      inverseBind.subarray(j * 16, j * 16 + 16),
    );
    out.set(m, j * 16);
  }
}

/** A device solver's particles read back, for the parity check: see `gpuSkinnedCloth.ts`. */
interface Readable {
  read(): Promise<Float32Array>;
}

/** The largest and the root-mean-square distance between two sets of particles. */
function deviation(a: Float32Array, b: Float32Array): { max: number; rms: number } {
  let max = 0;
  let sum = 0;
  for (let i = 0; i < a.length; i += 3) {
    const d = Math.hypot(
      (a[i] as number) - (b[i] as number),
      (a[i + 1] as number) - (b[i + 1] as number),
      (a[i + 2] as number) - (b[i + 2] as number),
    );
    max = Math.max(max, d);
    sum += d * d;
  }
  return { max, rms: Math.sqrt(sum / (a.length / 3)) };
}

async function main(): Promise<void> {
  const clothOn = ASKED.get('cloth') !== '0';
  const onCpu = ASKED.get('solver') === 'cpu';
  const parity = ASKED.get('parity') === '1';
  const bench = ASKED.get('bench') === '1';
  const frames = Number(ASKED.get('frames') ?? 150);
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const stats = document.getElementById('stats') as HTMLElement;
  const created = await createRenderer(canvas, askedQuality(), DEV_RENDERER);
  await created.renderer.ready();
  const renderer: RendererApi = created.renderer;

  const lightMatrix = new Float32Array(16);
  const env = createEnvironment();
  env.directionalDir = [-0.45, 0.75, -0.5];
  env.directionalColor = [1, 0.96, 0.9];
  env.ambient = [0.3, 0.32, 0.36];
  env.fogDensity = 0;
  env.shadowStrength = 0.85;
  env.lightViewProj = lightMatrix;

  const camera = new Camera();
  camera.fovYDeg = 38;
  camera.near = 0.2;
  camera.far = 60;
  renderer.resize();
  const aspect = canvas.height > 0 ? canvas.width / canvas.height : 1;
  camera.position[0] = 2.3;
  camera.position[1] = 1.5;
  camera.position[2] = -3.4;
  camera.lookAt(0, 0.9, 0);
  camera.updateMatrices(aspect);

  const setup = capeCloth();
  const count = SX * SY;
  /* The CPU solver: the cloth itself under ?solver=cpu, the reference beside it under ?parity=1. */
  const reference = onCpu || parity ? new SkinnedCloth(setup) : null;
  /*
   * The control the parity check is read against: the CPU solver again, every free particle nudged
   * a tenth of a micrometre every frame, one way or the other — single precision's rounding at a
   * metre, as the device rounds every step. How far the two then part is how far this cloth carries
   * a rounding difference, which is all single precision on the device is.
   */
  const nudged = parity ? new SkinnedCloth(setup) : null;
  const solved = onCpu ? null : createSkinnedCloth(renderer, setup);
  const cape = renderer.createMesh(capeMesh());
  const binding = renderer.createClothBinding(cape, capeBinding(setup.positions));
  const particles = solved?.particles ?? renderer.createClothParticles(count);
  const body = renderer.createMesh(
    new MeshBuilder().addCapsule([0, 0.9, 0], 0.28, 0.55, [0.7, 0.68, 0.62]).build(),
  );
  const ground = renderer.createMesh(
    new MeshBuilder()
      .addGroundQuad([-3, 0, -3], [3, 0, -3], [3, 0, 3], [-3, 0, 3], [0.46, 0.5, 0.44])
      .build(),
  );
  const capeMover = createMover();
  const bodyMover = createMover();

  const globals = new Float32Array(32);
  const skin = new Float32Array(32);
  const placed = new Float32Array(count * 3);
  const inverseBind = setup.inverseBind as Float32Array;
  const garment = { binding, particles };
  const casters: ShadowCasters = (sink) => {
    sink.mesh(body, globals.subarray(0, 16));
    sink.skinnedMesh(cape, IDENTITY, skin, undefined, clothOn ? garment : undefined);
  };

  const parityLines: string[] = [];
  let frame = 0;
  let solving = 0;
  const draw = async (): Promise<void> => {
    pose(frame / 60, globals);
    palette(globals, inverseBind, skin);
    /* The frame's wind, gusting: what a scene's WindField would hand every solver alike. */
    const t = frame / 60;
    const windX = 0.6 + 0.9 * Math.sin(0.8 * t);
    const windZ = -0.4 + 0.3 * Math.sin(1.9 * t);
    const started = performance.now();
    if (solved !== null) {
      solved.setWind(windX, 0, windZ);
      solved.step(globals, IDENTITY, 1 / 60);
    }
    if (reference !== null) {
      reference.setWind(windX, 0, windZ);
      reference.setPose(globals, IDENTITY);
      reference.advance(1 / 60);
    }
    if (nudged !== null) {
      nudged.setWind(windX, 0, windZ);
      nudged.setPose(globals, IDENTITY);
      for (let i = 0; i < count; i++) {
        if ((setup.inverseMass[i] as number) > 0) {
          nudged.positions[i * 3] += (((i * 7 + frame * 13) % 2) * 2 - 1) * 1e-7;
        }
      }
      nudged.advance(1 / 60);
    }
    if (onCpu && reference !== null) {
      reference.interpolate(reference.alpha, placed);
      renderer.updateClothParticles(particles, placed);
    }
    solving += performance.now() - started;
    if (parity && solved !== null && reference !== null && (frame + 1) % 10 === 0) {
      const { max, rms } = deviation(
        await (solved as unknown as Readable).read(),
        reference.positions,
      );
      const control = deviation((nudged as SkinnedCloth).positions, reference.positions);
      parityLines.push(
        `${frame + 1}: device max ${(max * 1000).toFixed(3)} mm, rms ${(rms * 1000).toFixed(3)} mm` +
          ` · CPU nudged 0.1 µm a frame max ${(control.max * 1000).toFixed(3)} mm, rms ${(control.rms * 1000).toFixed(3)} mm`,
      );
    }

    env.shadowDepthSpan = computeLightMatrix(
      env.directionalDir,
      0,
      0.8,
      0,
      3,
      renderer.shadowMapSize,
      lightMatrix,
    );
    renderer.beginShadowPass(lightMatrix, 'dynamic');
    renderer.drawShadowCasters(casters);
    renderer.endShadowPass();

    renderer.beginFrame(CLEAR);
    renderer.bindMeshPass(camera, env);
    renderer.drawMesh(ground, IDENTITY);
    renderer.drawMesh(body, globals.subarray(0, 16), 0, null, bodyMover);
    renderer.setSkinPalette(skin);
    if (clothOn) renderer.setCloth(binding, particles);
    renderer.drawMesh(cape, IDENTITY, 0, null, capeMover);
    renderer.setCloth(null);
    renderer.setSkinPalette(null);
    renderer.endFrame();
    frame += 1;
    if (frame < frames) {
      requestAnimationFrame(() => void draw().catch(fail));
      return;
    }
    let timing = '';
    if (bench && solved !== null) {
      /*
       * Frames of cloth submitted back to back and waited for once: the device works while the next
       * is recorded, so the time a frame is the slower of the two — and the one read's round trip,
       * a few milliseconds, is spread over all of them. Waiting on each instead measures that round
       * trip: it read 3 ms a frame for 252 particles and for 4,500 alike.
       */
      const steps = 600;
      let recording = 0;
      await (solved as unknown as Readable).read();
      const begun = performance.now();
      for (let k = 0; k < steps; k++) {
        pose((frame + k) / 60, globals);
        const at = performance.now();
        solved.step(globals, IDENTITY, 1 / 60);
        recording += performance.now() - at;
      }
      await (solved as unknown as Readable).read();
      const total = (performance.now() - begun) / steps;
      timing = ` · bench: ${total.toFixed(3)} ms a frame pipelined, ${(recording / steps).toFixed(3)} ms of it recording`;
    }
    stats.textContent =
      `${renderer.backend} · ${count} particles, ${RX * RY} bound vertices · ` +
      `cloth ${clothOn ? 'on' : 'off'} · ${solved === null ? 'CPU' : solved.runsOn} solve ` +
      `${(solving / frames).toFixed(3)} ms a frame${timing}` +
      (parityLines.length > 0 ? `\n${parityLines.join('\n')}` : '');
    (window as unknown as { __skinnedClothReady: boolean }).__skinnedClothReady = true;
  };
  requestAnimationFrame(() => void draw().catch(fail));
}

function fail(error: unknown): void {
  const box = document.getElementById('error');
  if (box !== null) {
    box.textContent = error instanceof Error ? (error.stack ?? error.message) : String(error);
  }
}

main().catch(fail);
