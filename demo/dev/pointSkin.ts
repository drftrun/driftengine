/**
 * A mesh posed on the device from weighted points in its joints' spaces, against the same pose
 * computed on the CPU and handed over with `updateMesh`.
 *
 *     /pointSkin.html                     WebGPU, posed on the device every frame
 *     /pointSkin.html?mode=cpu            the control: the same pose computed here and uploaded
 *     /pointSkin.html?mode=rest           the arm unposed, which the two posed pictures must not be
 *     /pointSkin.html?recon=1             with DriftTR, whose motion reads last frame's positions
 *     /pointSkin.html?backend=webgl2      the other backend, posed by transform feedback
 *
 * **What it proves.** An arm of three joints, a tube of rings, each vertex a point in the space of
 * each joint it follows, blended across the elbow and the wrist, bends by a fixed clock for sixty
 * frames and is held. Posed on the device it must draw the picture the CPU's own pose draws, on
 * each backend, and not the rest pose's. The CPU sums in doubles where a device sums in singles, so
 * a pixel or two at an edge is rounding; a wrong joint, weight or normal moves the whole arm.
 * Nothing under `src/` may import this.
 */
import { mat4 } from 'gl-matrix';

import { Camera, createEnvironment, createRenderer } from '../../packages/core/src/index';
import type { MeshData, PointSkinData, RendererApi, Vec3 } from '../../packages/core/src/index';
import { DEV_RENDERER, askedQuality } from './askedQuality';

const CLEAR: Vec3 = [0.55, 0.6, 0.7];
const RINGS = 36;
const SIDES = 16;
const LENGTH = 3;
const RADIUS = 0.22;
const FRAMES = 60;

/** Where each joint sits at rest, along x. */
const ORIGINS = [0, 1, 2];

/** The share of a ring at `x` each joint takes: blended across a third of a metre at each joint. */
function sharesAt(x: number): [number, number, number] {
  const elbow = Math.min(1, Math.max(0, (x - 0.85) / 0.3));
  const wrist = Math.min(1, Math.max(0, (x - 1.85) / 0.3));
  return [1 - elbow, elbow - wrist, wrist];
}

function arm(): { mesh: MeshData; skin: PointSkinData } {
  const n = RINGS * SIDES;
  const positions = new Float32Array(n * 3);
  const normals = new Float32Array(n * 3);
  const colors = new Float32Array(n * 3);
  const joints = new Float32Array(n * 4);
  const weights = new Float32Array(n * 4);
  const points = new Float32Array(n * 12);
  for (let r = 0; r < RINGS; r++) {
    const x = (r / (RINGS - 1)) * LENGTH;
    const shares = sharesAt(x);
    /* The joint that takes most goes first: it turns the normal. */
    const order = [0, 1, 2].sort((a, b) => shares[b] - shares[a]);
    for (let s = 0; s < SIDES; s++) {
      const v = r * SIDES + s;
      const a = (s / SIDES) * Math.PI * 2;
      const ny = Math.cos(a);
      const nz = Math.sin(a);
      positions.set([x, ny * RADIUS, nz * RADIUS], v * 3);
      normals.set([0, ny, nz], v * 3);
      colors.set([0.7 + 0.25 * (r % 2), 0.45, 0.3 + 0.3 * (s % 2)], v * 3);
      order.forEach((joint, k) => {
        joints[v * 4 + k] = joint;
        weights[v * 4 + k] = shares[joint];
        points.set([x - ORIGINS[joint], ny * RADIUS, nz * RADIUS], (v * 4 + k) * 3);
      });
    }
  }
  const indices: number[] = [];
  for (let r = 0; r < RINGS - 1; r++) {
    for (let s = 0; s < SIDES; s++) {
      const a = r * SIDES + s;
      const b = r * SIDES + ((s + 1) % SIDES);
      indices.push(a, b, a + SIDES, b, b + SIDES, a + SIDES);
    }
  }
  return {
    mesh: {
      positions,
      normals,
      colors,
      emissive: new Float32Array(n),
      indices: new Uint32Array(indices),
    },
    skin: { joints, weights, points, normals: normals.slice() },
  };
}

/** Each joint's transform into model space at `time`: a shoulder, an elbow and a wrist that bend. */
function poseAt(time: number, out: Float32Array): void {
  const shoulder = mat4.fromZRotation(mat4.create(), 0.4 * Math.sin(time * 2));
  const elbow = mat4.multiply(
    mat4.create(),
    shoulder,
    mat4.multiply(
      mat4.create(),
      mat4.fromTranslation(mat4.create(), [1, 0, 0]),
      mat4.fromYRotation(mat4.create(), 0.9 * Math.sin(time * 3)),
    ),
  );
  const wrist = mat4.multiply(
    mat4.create(),
    elbow,
    mat4.multiply(
      mat4.create(),
      mat4.fromTranslation(mat4.create(), [1, 0, 0]),
      mat4.fromZRotation(mat4.create(), 1.1 * Math.sin(time * 4 + 1)),
    ),
  );
  out.set(shoulder, 0);
  out.set(elbow, 16);
  out.set(wrist, 32);
}

/** The control: the same pose computed here, in doubles. */
function poseOnCpu(
  skin: PointSkinData,
  matrices: Float32Array,
  positions: Float32Array,
  normals: Float32Array,
): void {
  const n = skin.weights.length / 4;
  for (let v = 0; v < n; v++) {
    let x = 0;
    let y = 0;
    let z = 0;
    for (let k = 0; k < 4; k++) {
      const w = skin.weights[v * 4 + k];
      if (w === 0) continue;
      const m = skin.joints[v * 4 + k] * 16;
      const p = (v * 4 + k) * 3;
      const px = skin.points[p];
      const py = skin.points[p + 1];
      const pz = skin.points[p + 2];
      x += w * (matrices[m] * px + matrices[m + 4] * py + matrices[m + 8] * pz + matrices[m + 12]);
      y +=
        w * (matrices[m + 1] * px + matrices[m + 5] * py + matrices[m + 9] * pz + matrices[m + 13]);
      z +=
        w *
        (matrices[m + 2] * px + matrices[m + 6] * py + matrices[m + 10] * pz + matrices[m + 14]);
    }
    positions[v * 3] = x;
    positions[v * 3 + 1] = y;
    positions[v * 3 + 2] = z;
    const m = skin.joints[v * 4] * 16;
    const nx = skin.normals[v * 3];
    const ny = skin.normals[v * 3 + 1];
    const nz = skin.normals[v * 3 + 2];
    const tx = matrices[m] * nx + matrices[m + 4] * ny + matrices[m + 8] * nz;
    const ty = matrices[m + 1] * nx + matrices[m + 5] * ny + matrices[m + 9] * nz;
    const tz = matrices[m + 2] * nx + matrices[m + 6] * ny + matrices[m + 10] * nz;
    const l = Math.hypot(tx, ty, tz) || 1;
    normals[v * 3] = tx / l;
    normals[v * 3 + 1] = ty / l;
    normals[v * 3 + 2] = tz / l;
  }
}

async function main(): Promise<void> {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const stats = document.getElementById('stats') as HTMLElement;
  const mode = new URLSearchParams(location.search).get('mode') ?? 'device';
  const created = await createRenderer(canvas, askedQuality(), DEV_RENDERER);
  await created.renderer.ready();
  const renderer: RendererApi = created.renderer;

  const env = createEnvironment();
  env.directionalDir = [-0.4, 0.7, 0.6];
  env.directionalColor = [1, 0.97, 0.9];
  env.ambient = [0.3, 0.32, 0.36];
  env.shadowStrength = 0;
  env.fogDensity = 0;

  const camera = new Camera();
  camera.fovYDeg = 40;
  camera.near = 0.3;
  camera.far = 100;
  renderer.resize();
  const aspect = canvas.height > 0 ? canvas.width / canvas.height : 1;
  camera.position[0] = 1.4;
  camera.position[1] = 1.2;
  camera.position[2] = 5.5;
  camera.lookAt(1.4, 0, 0);
  camera.updateMatrices(aspect);

  const { mesh: data, skin } = arm();
  const mesh = renderer.createMesh(data, { dynamic: true });
  const posed = mode === 'device' ? renderer.createPointSkin(mesh, skin) : null;
  const matrices = new Float32Array(48);
  const positions = new Float32Array(data.positions.length);
  const normals = new Float32Array(data.normals.length);
  const model = mat4.create();

  let frames = 0;
  const frame = (): void => {
    poseAt(frames / 60, matrices);
    if (posed !== null) renderer.posePointSkin(posed, matrices);
    if (mode === 'cpu') {
      poseOnCpu(skin, matrices, positions, normals);
      renderer.updateMesh(mesh, positions, normals);
    }
    renderer.beginFrame(CLEAR);
    renderer.bindMeshPass(camera, env);
    renderer.drawMesh(mesh, model);
    renderer.endFrame();
    frames += 1;
    if (frames === FRAMES) {
      stats.textContent = `${renderer.backend} ${mode}`;
      (window as unknown as { __pointSkinReady: boolean }).__pointSkinReady = true;
      return;
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

main().catch((error: unknown) => {
  const box = document.getElementById('error');
  if (box !== null) {
    box.textContent = error instanceof Error ? (error.stack ?? error.message) : String(error);
  }
});
