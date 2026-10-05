/**
 * A figure walking a circle in a cape, the cape a skinned cloth: simulated on the device where the
 * renderer has compute and on the CPU where it has not, drawn by a finer mesh bound to it, and
 * blown by the scene's one wind.
 *
 * The figure is three joints — hips, chest, shoulders — and the cape hangs from the shoulders: its
 * top row follows the skeleton exactly and the rest is cloth, held off the body by capsules on the
 * hips and the chest and by a backstop, and kept from stretching by a tether from every particle to
 * the top of its column. The mesh drawn is finer than the cloth simulated, and each of its vertices
 * follows a triangle of the simulation; its collar is painted to follow the skeleton and the rest
 * the cloth. Every nine seconds the figure jumps a quarter of the circle ahead, and the cape resets
 * with it: settled at once, then blended back into the simulation.
 */
import {
  MeshBuilder,
  advanceWindField,
  computeLightMatrix,
  createEnvironment,
  createSkinnedCloth,
  createWindField,
} from '@driftengine/core';
import type {
  ClothBindingData,
  MeshData,
  ShadowCasters,
  SkinnedClothSetup,
  SkinnedClothSolver,
  Vec3,
  WindProfile,
} from '@driftengine/core';
import { createReadout } from '../common/readout';
import { controls, flag, openStage } from '../common/stage';

const stage = await openStage({
  directionalShadows: true,
  outputTransform: 'aces',
  sceneSamples: 4,
});
const { renderer, camera } = stage;

// #region matrices
/** `out[at…]` = translate(x, y, z) · rotateY(yaw) · rotateX(pitch), column-major. */
function place(
  out: Float32Array,
  at: number,
  x: number,
  y: number,
  z: number,
  yaw: number,
  pitch: number,
): void {
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  out.set([cy, 0, -sy, 0, sy * sp, cp, cy * sp, 0, sy * cp, -sp, cy * cp, 0, x, y, z, 1], at);
}

/** `out[at…]` = `a[aAt…]` · `b[bAt…]`. `out` may not alias either. */
function multiply(
  a: Float32Array,
  aAt: number,
  b: Float32Array,
  bAt: number,
  out: Float32Array,
  at: number,
): void {
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let sum = 0;
      for (let k = 0; k < 4; k++)
        sum += (a[aAt + k * 4 + r] as number) * (b[bAt + c * 4 + k] as number);
      out[at + c * 4 + r] = sum;
    }
  }
}
// #endregion

// #region rig
/** Hips, chest and shoulders: where each joint stands at rest, in the figure's own space. */
const REST: readonly Vec3[] = [
  [0, 0.95, 0],
  [0, 1.25, 0],
  [0, 1.5, 0],
];
const JOINTS = REST.length;
const inverseBind = new Float32Array(JOINTS * 16);
REST.forEach(([x, y, z], j) => place(inverseBind, j * 16, -x, -y, -z, 0, 0));

const globals = new Float32Array(JOINTS * 16);
const palette = new Float32Array(JOINTS * 16);
const local = new Float32Array(16);

/** The walk at `t` seconds: the hips bob, the chest leans and turns, the shoulders nod. */
function pose(t: number): void {
  const step = t * 2 * Math.PI * 0.9;
  place(globals, 0, 0, 0.95 + 0.03 * Math.cos(step * 2), 0, 0, 0);
  place(local, 0, 0, 0.3, 0, 0.12 * Math.sin(step), 0.1);
  multiply(globals, 0, local, 0, globals, 16);
  place(local, 0, 0, 0.25, 0, -0.08 * Math.sin(step), 0.05 * Math.sin(step * 2));
  multiply(globals, 16, local, 0, globals, 32);
  for (let j = 0; j < JOINTS; j++) multiply(globals, j * 16, inverseBind, j * 16, palette, j * 16);
}

const SKIN: Vec3 = [0.78, 0.62, 0.5];
const COAT: Vec3 = [0.22, 0.25, 0.32];
const body = renderer.createMesh(
  new MeshBuilder()
    .setJoint(0)
    .addCapsule([0.1, 0.48, 0], 0.08, 0.38, COAT)
    .addCapsule([-0.1, 0.48, 0], 0.08, 0.38, COAT)
    .setJoint(1)
    .addCapsule([0, 1.22, 0], 0.17, 0.2, COAT)
    .setJoint(2)
    .addCapsule([0, 1.5, 0], 0.07, 0.17, COAT)
    .addSphere([0, 1.72, 0], 0.12, SKIN)
    .build(),
);
// #endregion

// #region cape
/** The simulation, 16 by 20 particles; the mesh drawn, 40 by 50 vertices a side. */
const SX = 16;
const SY = 20;
const RX = 40;
const RY = 50;
const TOP = 1.5;
const HEIGHT = 1.1;
const WIDTH = 0.66;
const BACK = -0.2;

/** Where grid point (u across, w down) is at rest, in the figure's space. */
function capeAt(u: number, w: number, out: Float32Array, at: number): void {
  out[at] = (u - 0.5) * WIDTH;
  out[at + 1] = TOP - w * HEIGHT;
  out[at + 2] = BACK;
}

function capeSetup(inertia: number): SkinnedClothSetup {
  const count = SX * SY;
  const positions = new Float32Array(count * 3);
  const inverseMass = new Float32Array(count);
  const normals = new Float32Array(count * 3);
  const joints = new Float32Array(count * 4).fill(0);
  const weights = new Float32Array(count * 4);
  const backstop = new Float32Array(count * 2);
  for (let p = 0; p < count; p++) {
    capeAt((p % SX) / (SX - 1), Math.floor(p / SX) / (SY - 1), positions, p * 3);
    inverseMass[p] = p < SX ? 0 : 1;
    normals[p * 3 + 2] = -1;
    joints[p * 4] = 2;
    weights[p * 4] = 1;
    /* Not more than eight centimetres toward the body from where the shoulders carry it. */
    if (p >= SX) backstop.set([0.08, 0.6], p * 2);
  }
  const pairs: number[] = [];
  const quads: number[] = [];
  for (let p = 0; p < count; p++) {
    const x = p % SX;
    const y = Math.floor(p / SX);
    if (x + 1 < SX) pairs.push(p, p + 1);
    if (y + 1 < SY) pairs.push(p, p + SX);
    if (x + 1 < SX && y + 1 < SY) pairs.push(p, p + SX + 1, p + 1, p + SX);
    /* Bending across each cell's diagonal, the shared edge first and each triangle's far corner. */
    if (x + 1 < SX && y + 1 < SY) quads.push(p + 1, p + SX, p, p + SX + 1);
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
  const tethered = count - SX;
  const tethers = {
    particles: Uint32Array.from({ length: tethered }, (_, k) => SX + k),
    anchors: Uint32Array.from({ length: tethered }, (_, k) => (SX + k) % SX),
    lengths: Float32Array.from(
      { length: tethered },
      (_, k) => (Math.floor((SX + k) / SX) / (SY - 1)) * HEIGHT,
    ),
  };
  /* A capsule's frame turns +Z up the body: the hips' from the feet, the chest's from the waist. */
  const upright = (y: number): Float32Array => {
    const frame = new Float32Array(16);
    place(frame, 0, 0, y, 0, 0, -Math.PI / 2);
    return frame;
  };
  return {
    positions,
    inverseMass,
    normals,
    joints,
    weights,
    inverseBind,
    distance: { pairs: new Uint32Array(pairs), rest, compliance: new Float32Array(rest.length) },
    bending: {
      quads: new Uint32Array(quads),
      rest: new Float32Array(quads.length / 4).fill(Math.PI),
      compliance: new Float32Array(quads.length / 4).fill(0.05),
    },
    tethers,
    limits: { backstop, thickness: new Float32Array(count).fill(0.015) },
    colliders: [
      { joint: 0, radius: 0.24, length: 0.9, frame: upright(-0.95) },
      { joint: 1, radius: 0.2, radius2: 0.17, length: 0.55, frame: upright(-0.3) },
    ],
    parameters: {
      substeps: 4,
      iterations: 2,
      damping: Math.log(0.5),
      drag: Math.log(0.4),
      linearInertia: inertia,
      angularInertia: inertia,
      teleportDistance: 1,
      settleSteps: 20,
      blendSteps: 20,
    },
  };
}

/**
 * The mesh drawn: two layers of a finer grid, the outside facing away from the body and the
 * lining facing it, a couple of millimetres apart along the cloth's own normal. Each vertex is
 * skinned to the shoulders and bound to the simulation triangle under it.
 */
function capeMesh(): { data: MeshData; binding: ClothBindingData } {
  const n = RX * RY;
  const positions = new Float32Array(n * 6);
  const normals = new Float32Array(n * 6);
  const colors = new Float32Array(n * 6);
  const joints = new Float32Array(n * 8);
  const weights = new Float32Array(n * 8);
  const triangles = new Uint32Array(n * 6);
  const coordinates = new Float32Array(n * 4);
  const offsets = new Float32Array(n * 2);
  const follow = new Float32Array(n * 2);
  const indices: number[] = [];
  for (let layer = 0; layer < 2; layer++) {
    const lining = layer === 1;
    for (let y = 0; y < RY; y++) {
      for (let x = 0; x < RX; x++) {
        const v = layer * n + y * RX + x;
        const w = y / (RY - 1);
        capeAt(x / (RX - 1), w, positions, v * 3);
        normals[v * 3 + 2] = lining ? 1 : -1;
        /* A band every few rows, so a fold reads as a fold rather than as shading. */
        const band = Math.floor(w * 11) % 2 === 0 ? 1 : 0.78;
        colors.set(lining ? [0.55, 0.42, 0.18] : [0.46 * band, 0.07 * band, 0.09 * band], v * 3);
        joints[v * 4] = 2;
        weights[v * 4] = 1;
        const fx = (x / (RX - 1)) * (SX - 1);
        const fy = w * (SY - 1);
        const i = Math.min(Math.floor(fx), SX - 2);
        const j = Math.min(Math.floor(fy), SY - 2);
        const s = fx - i;
        const t = fy - j;
        const a = j * SX + i;
        if (s + t <= 1) {
          triangles.set([a, a + 1, a + SX], v * 3);
          coordinates.set([s, t], v * 2);
        } else {
          triangles.set([a + 1, a + SX + 1, a + SX], v * 3);
          coordinates.set([s + t - 1, 1 - s], v * 2);
        }
        offsets[v] = lining ? -0.002 : 0.002;
        const k = Math.min(1, Math.max(0, (w - 0.04) / 0.16));
        follow[v] = k * k * (3 - 2 * k);
        if (x + 1 < RX && y + 1 < RY) {
          const q = v;
          if (lining) indices.push(q, q + RX, q + 1, q + 1, q + RX, q + RX + 1);
          else indices.push(q, q + 1, q + RX, q + 1, q + RX + 1, q + RX);
        }
      }
    }
  }
  return {
    data: {
      positions,
      normals,
      colors,
      emissive: new Float32Array(n * 2),
      joints,
      weights,
      indices: new Uint32Array(indices),
    },
    binding: { triangles, coordinates, offsets, weights: follow, rest: capeSetup(1).positions },
  };
}

const cape = capeMesh();
const capeHandle = renderer.createMesh(cape.data);
const binding = renderer.createClothBinding(capeHandle, cape.binding);
let cloth: SkinnedClothSolver = createSkinnedCloth(renderer, capeSetup(Number(flag('carry', '1'))));
let bound = flag('cape', 'cloth') === 'cloth';
// #endregion

const ground = renderer.createMesh(
  new MeshBuilder()
    .addGroundQuad([-8, 0, -8], [8, 0, -8], [8, 0, 8], [-8, 0, 8], [0.42, 0.46, 0.38])
    .build(),
);

const wind = createWindField();
const profile: WindProfile = {
  directionX: 1,
  directionZ: 0.35,
  baseSpeed: 1.2,
  gustSpeed: 1.6,
  directionWander: 0.4,
  cycleSeconds: 40,
  phase: 0,
};
let blowing = flag('air', 'gusts') === 'gusts';

controls([
  {
    key: 'cape',
    label: 'cape',
    value: bound ? 'cloth' : 'skinned',
    options: [
      { text: 'cloth', value: 'cloth' },
      { text: 'skinned only', value: 'skinned' },
    ],
    change: (value) => {
      bound = value === 'cloth';
    },
  },
  {
    key: 'air',
    label: 'air',
    value: blowing ? 'gusts' : 'still',
    options: [
      { text: 'gusts', value: 'gusts' },
      { text: 'still', value: 'still' },
    ],
    change: (value) => {
      blowing = value === 'gusts';
    },
  },
  {
    key: 'carry',
    label: 'the walk carries',
    value: flag('carry', '1'),
    options: [
      { text: 'none of it', value: '1' },
      { text: 'half', value: '0.5' },
    ],
    change: (value) => {
      cloth.dispose();
      cloth = createSkinnedCloth(renderer, capeSetup(Number(value)));
      describe();
    },
  },
]);

const env = createEnvironment({
  directionalDir: [0.45, 0.75, 0.3],
  directionalColor: [1, 0.95, 0.86],
  ambient: [0.26, 0.28, 0.33],
  shadowStrength: 0.8,
  fogDensity: 0.01,
});
const lightMatrix = new Float32Array(16);
env.lightViewProj = lightMatrix;

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const model = new Float32Array(16);
const casters: ShadowCasters = (sink) => {
  sink.skinnedMesh(body, model, palette);
  sink.skinnedMesh(
    capeHandle,
    model,
    palette,
    undefined,
    bound ? { binding, particles: cloth.particles } : undefined,
  );
};
const readout = createReadout(renderer, 1);
/* Said once, and again when the cloth is rebuilt: a string built every frame is an allocation. */
const describe = (): void => {
  readout.set(
    0,
    `cloth on the ${cloth.runsOn} · ${SX * SY} particles · ${RX * RY * 2} vertices drawn`,
  );
};
describe();

const RADIUS = 2;
let time = 0;
let last = -1;
stage.run({
  render() {
    const now = performance.now();
    const dt = last < 0 ? 1 / 60 : Math.min(0.1, (now - last) / 1000);
    last = now;
    time += dt;

    /* Round the circle, a quarter of it further on every nine seconds: a jump the cape resets for. */
    const angle = (time * 1.1) / RADIUS + Math.floor(time / 9) * (Math.PI / 2);
    const x = RADIUS * Math.cos(angle);
    const z = RADIUS * Math.sin(angle);
    place(model, 0, x, 0, z, -angle, 0);
    /* Behind the figure and out to its side, so the cape is between the camera and the walk. */
    camera.position[0] = x + 2.6 * Math.sin(angle) + 1.5 * Math.cos(angle);
    camera.position[1] = 1.7;
    camera.position[2] = z - 2.6 * Math.cos(angle) + 1.5 * Math.sin(angle);
    camera.lookAt(x, 1.05, z);
    camera.updateMatrices(stage.canvas.height > 0 ? stage.canvas.width / stage.canvas.height : 1);
    pose(time);
    profile.baseSpeed = blowing ? 1.2 : 0;
    profile.gustSpeed = blowing ? 1.6 : 0;
    // #region step
    advanceWindField(wind, profile, time, dt, 1);
    cloth.setWind(wind.velocityX, 0, wind.velocityZ);
    cloth.step(globals, model, dt);
    // #endregion

    env.shadowDepthSpan = computeLightMatrix(
      env.directionalDir,
      model[12] as number,
      0.9,
      model[14] as number,
      3,
      renderer.shadowMapSize,
      lightMatrix,
    );
    renderer.beginShadowPass(lightMatrix, 'dynamic');
    renderer.drawShadowCasters(casters);
    renderer.endShadowPass();

    renderer.beginFrame([0.6, 0.66, 0.74]);
    renderer.bindMeshPass(camera, env);
    renderer.drawMesh(ground, IDENTITY);
    // #region draw
    renderer.setSkinPalette(palette);
    renderer.drawMesh(body, model);
    if (bound) renderer.setCloth(binding, cloth.particles);
    renderer.drawMesh(capeHandle, model);
    renderer.setCloth(null);
    renderer.setSkinPalette(null);
    // #endregion
    readout.draw(time);
    renderer.endFrame();
  },
});
