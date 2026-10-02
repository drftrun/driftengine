/**
 * A figure shoved down a flight of stairs every six seconds, a flag on a pole in a gusting wind, and
 * a sheet dropped over a crate.
 *
 * The figure is a ragdoll built from a skeleton's joints: a capsule for every bone and a cone-twist
 * joint at every joint. Each shove puts its bodies back on the standing pose, pushes, and lets the
 * ragdoll go: limp, or driven back toward the pose so it staggers and tries to stand. The flag and
 * the sheet are cloth; the sheet hands the crate the momentum it loses on it, so it pushes it.
 */
import { MeshBuilder, computeLightMatrix, createEnvironment, hashToUnit } from '@driftengine/core';
import type { MeshData, MeshHandle, Vec3 } from '@driftengine/core';
import {
  BODY_DYNAMIC,
  BODY_STATIC,
  ClothBody,
  PhysicsWorld,
  boxShape,
  makeClothGrid,
  ragdollFromBones,
} from '@driftengine/physics';
import { createReadout } from '../common/readout';
import { controls, flag, openStage } from '../common/stage';

const stage = await openStage({
  directionalShadows: true,
  outputTransform: 'aces',
  sceneSamples: 4,
});
const { renderer, camera } = stage;

const world = new PhysicsWorld({ substeps: 6 });
world.addBody({ type: BODY_STATIC, shape: boxShape(20, 0.5, 20), y: -0.5 });
/* A platform and eight steps down from it toward +x. */
world.addBody({ type: BODY_STATIC, shape: boxShape(1.5, 1.5, 1.5), x: -4, y: 1.5 });
const steps: [number, number][] = [];
for (let i = 0; i < 8; i += 1) {
  const top = 3 - (i + 1) * 0.375;
  steps.push([-2.25 + i * 0.5, top]);
  world.addBody({
    type: BODY_STATIC,
    shape: boxShape(0.25, top / 2, 1.5),
    x: -2.25 + i * 0.5,
    y: top / 2,
  });
}

// #region skeleton
/** A standing figure as joints: where each is, and which joint it hangs from. */
const JOINTS: [number, number, number, number][] = [
  [-1, 0, 1.0, 0], // hips
  [0, 0, 1.3, 0], // spine
  [1, 0, 1.55, 0], // chest
  [2, 0, 1.72, 0], // neck
  [3, 0, 1.95, 0], // head
  [2, 0.2, 1.6, 0], // left shoulder
  [5, 0.45, 1.6, 0], // left elbow
  [6, 0.7, 1.6, 0], // left hand
  [2, -0.2, 1.6, 0], // right shoulder
  [8, -0.45, 1.6, 0], // right elbow
  [9, -0.7, 1.6, 0], // right hand
  [0, 0.1, 0.95, 0], // left hip
  [11, 0.1, 0.5, 0], // left knee
  [12, 0.1, 0.06, 0], // left foot
  [0, -0.1, 0.95, 0], // right hip
  [14, -0.1, 0.5, 0], // right knee
  [15, -0.1, 0.06, 0], // right foot
];
const parents = JOINTS.map(([parent]) => parent);

/** The standing pose as world matrices, sixteen floats a joint, placed on the platform. */
function standing(x: number, y: number, z: number): Float32Array {
  const matrices = new Float32Array(JOINTS.length * 16);
  JOINTS.forEach(([, jx, jy, jz], j) => {
    matrices.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x + jx, y + jy, z + jz, 1], j * 16);
  });
  return matrices;
}

/** The same pose as each joint relative to its parent, which is what `drive` steers toward. */
const pose = {
  translation: new Float32Array(JOINTS.length * 3),
  rotation: new Float32Array(JOINTS.length * 4),
  scale: new Float32Array(JOINTS.length * 3).fill(1),
};
JOINTS.forEach(([parent, jx, jy, jz], j) => {
  const [, px, py, pz] = JOINTS[parent] ?? [0, 0, 0, 0];
  pose.translation.set(parent < 0 ? [jx, jy, jz] : [jx - px, jy - py, jz - pz], j * 3);
  pose.rotation[j * 4 + 3] = 1;
});
// #endregion

// #region ragdoll
/** A capsule a bone and a joint between each bone and its parent's, with knees nearly hinges. */
const swing = new Float32Array(JOINTS.length).fill(Math.SQRT1_2);
for (const knee of [12, 13, 15, 16]) swing[knee] = 0.9;
const doll = ragdollFromBones(world, parents, standing(-4, 3, 0), {
  density: 600,
  swingCos: swing,
});

/** Put the doll back on its feet at the top of the stairs and push it toward them. */
function shove(count: number): void {
  doll.sync(world, standing(-4, 3, 0));
  for (const body of doll.bodyOf) {
    if (body < 0) continue;
    world.setVelocity(body, 3.5, 0.5, (hashToUnit(count) - 0.5) * 1.5);
  }
}
// #endregion

// #region cloth
/** A flag twenty cells by twelve, hanging from a pole: the cells along the pole are pinned. */
const FLAG_COLUMNS = 20;
const FLAG_ROWS = 12;
const flagGrid = makeClothGrid(FLAG_COLUMNS, FLAG_ROWS, 0.08);
for (let i = 0; i < flagGrid.positions.length; i += 3) {
  /* Turned to hang: columns run out from the pole along +z, rows run down. */
  const along = flagGrid.positions[i] ?? 0;
  const down = flagGrid.positions[i + 2] ?? 0;
  flagGrid.positions.set([5, 4.5 - down, along - 0.8], i);
}
const flagCloth = new ClothBody(flagGrid.positions, flagGrid.links, flagGrid.bendLinks, {
  damping: 0.05,
});
for (let row = 0; row < FLAG_ROWS; row += 1) flagCloth.pin(row * FLAG_COLUMNS);

/** A sheet dropped over a crate, handing it back the momentum it loses on it. */
const crates = [
  world.addBody({
    type: BODY_DYNAMIC,
    shape: boxShape(0.5, 0.5, 0.5),
    x: 3,
    y: 0.5,
    z: 3.2,
    density: 40,
  }),
];
const SHEET = 18;
let sheet = dropSheet();
function dropSheet(): ClothBody {
  const grid = makeClothGrid(SHEET, SHEET, 0.12);
  for (let i = 0; i < grid.positions.length; i += 3) {
    grid.positions[i] = (grid.positions[i] ?? 0) + 2;
    grid.positions[i + 1] = 2.5;
    grid.positions[i + 2] = (grid.positions[i + 2] ?? 0) + 2.2;
  }
  return new ClothBody(grid.positions, grid.links, grid.bendLinks, {
    /* Cloth contacts carry no friction, so air and floor alike are this damping: enough that a
       sheet settles where it lands and falls the way a sheet falls. */
    damping: 2,
    coupling: 1,
    particleMass: 0.2,
    selfDistance: 0.1,
    thickness: 0.05,
  });
}
// #endregion

let weight = Number(flag('drive', '0'));
controls([
  {
    key: 'drive',
    label: 'after the shove',
    value: String(weight),
    options: [
      { text: 'limp', value: '0' },
      { text: 'staggers', value: '0.25' },
      { text: 'holds the pose', value: '1' },
    ],
    change: (value) => {
      weight = Number(value);
    },
  },
]);

/** A mesh of a cloth's triangles, both sides, rewritten from its particles every frame. */
function clothMesh(
  columns: number,
  rows: number,
  colour: Vec3,
): { mesh: MeshHandle; data: MeshData } {
  const count = columns * rows;
  const indices: number[] = [];
  for (let r = 0; r + 1 < rows; r += 1) {
    for (let c = 0; c + 1 < columns; c += 1) {
      const a = r * columns + c;
      indices.push(a, a + columns, a + 1, a + 1, a + columns, a + columns + 1);
      indices.push(a, a + 1, a + columns, a + 1, a + columns + 1, a + columns);
    }
  }
  const data: MeshData = {
    positions: new Float32Array(count * 3),
    normals: new Float32Array(count * 3),
    colors: new Float32Array(count * 3).map((_, i) => colour[i % 3] ?? 1),
    emissive: new Float32Array(count),
    indices: Uint32Array.from(indices),
  };
  return { mesh: renderer.createMesh(data, { dynamic: true }), data };
}
function refresh(
  target: { mesh: MeshHandle; data: MeshData },
  cloth: ClothBody,
  columns: number,
  rows: number,
): void {
  const { positions, normals } = target.data;
  positions.set(cloth.position);
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < columns; c += 1) {
      const at = (i: number): number => i * 3;
      const left = at(r * columns + Math.max(0, c - 1));
      const right = at(r * columns + Math.min(columns - 1, c + 1));
      const up = at(Math.max(0, r - 1) * columns + c);
      const down = at(Math.min(rows - 1, r + 1) * columns + c);
      const ux = (positions[right] ?? 0) - (positions[left] ?? 0);
      const uy = (positions[right + 1] ?? 0) - (positions[left + 1] ?? 0);
      const uz = (positions[right + 2] ?? 0) - (positions[left + 2] ?? 0);
      const vx = (positions[down] ?? 0) - (positions[up] ?? 0);
      const vy = (positions[down + 1] ?? 0) - (positions[up + 1] ?? 0);
      const vz = (positions[down + 2] ?? 0) - (positions[up + 2] ?? 0);
      /* Down the rows across the columns, so a sheet lying flat faces up. */
      const nx = vy * uz - vz * uy;
      const ny = vz * ux - vx * uz;
      const nz = vx * uy - vy * ux;
      const length = Math.hypot(nx, ny, nz) || 1;
      normals.set([nx / length, ny / length, nz / length], at(r * columns + c));
    }
  }
  renderer.updateMesh(target.mesh, positions, normals);
}

const flagMesh = clothMesh(FLAG_COLUMNS, FLAG_ROWS, [0.85, 0.2, 0.18]);
const sheetMesh = clothMesh(SHEET, SHEET, [0.9, 0.88, 0.8]);

/** Each bone as the capsule its body is: along y, as long as the bone and as wide as the doll made it. */
const boneMeshes: { body: number; mesh: MeshHandle }[] = [];
JOINTS.forEach(([parent, jx, jy, jz], j) => {
  const body = doll.bodyOf[j] ?? -1;
  if (body < 0 || parent < 0) return;
  const [, px, py, pz] = JOINTS[parent] ?? [0, 0, 0, 0];
  const length = Math.hypot(jx - px, jy - py, jz - pz);
  const radius = Math.max(0.03, length * 0.22);
  boneMeshes.push({
    body,
    mesh: renderer.createMesh(
      new MeshBuilder()
        .addCapsule([0, 0, 0], radius, Math.max(0.02, length / 2), [0.35, 0.55, 0.85])
        .build(),
    ),
  });
});
const scenery = renderer.createMesh(
  steps
    .reduce(
      (b, [x, top]) => b.addBox([x, top / 2, 0], [0.25, top / 2, 1.5], [0.6, 0.58, 0.55]),
      new MeshBuilder()
        .addBox([0, -0.5, 0], [20, 0.5, 20], [0.38, 0.42, 0.34])
        .addBox([-4, 1.5, 0], [1.5, 1.5, 1.5], [0.55, 0.53, 0.5])
        .addCylinder([5, 2.4, -0.8], 0.05, 2.4, 'y', [0.3, 0.3, 0.32]),
    )
    .build(),
);
const crateMesh = renderer.createMesh(
  new MeshBuilder().addBox([0, 0, 0], [0.5, 0.5, 0.5], [0.7, 0.55, 0.36]).build(),
);

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const model = new Float32Array(16);
function placed(body: number): Float32Array {
  const b = world.bodies;
  const x = b.rotX[body] ?? 0;
  const y = b.rotY[body] ?? 0;
  const z = b.rotZ[body] ?? 0;
  const w = b.rotW[body] ?? 1;
  model.set([
    1 - 2 * (y * y + z * z),
    2 * (x * y + z * w),
    2 * (x * z - y * w),
    0,
    2 * (x * y - z * w),
    1 - 2 * (x * x + z * z),
    2 * (y * z + x * w),
    0,
    2 * (x * z + y * w),
    2 * (y * z - x * w),
    1 - 2 * (x * x + y * y),
    0,
    b.posX[body] ?? 0,
    b.posY[body] ?? 0,
    b.posZ[body] ?? 0,
    1,
  ]);
  return model;
}

const env = createEnvironment({
  directionalDir: [-0.4, 0.75, 0.55],
  directionalColor: [1.7, 1.6, 1.45],
  ambient: [0.32, 0.35, 0.42],
  ambientGround: [0.13, 0.12, 0.11],
});
const lightMatrix = new Float32Array(16);
env.lightViewProj = lightMatrix;
env.shadowStrength = 0.8;
env.shadowDepthSpan = computeLightMatrix(
  env.directionalDir,
  0,
  1.5,
  1,
  9,
  renderer.shadowMapSize,
  lightMatrix,
);
const readout = createReadout(renderer, 1);
let time = 0;
let tick = 0;
let shoves = 0;

stage.run({
  simulate(dt) {
    time += dt;
    tick += 1;
    if (tick % 360 === 60) shove((shoves += 1));
    if (tick % 600 === 0) sheet = dropSheet();
    doll.drive(world, pose, weight);
    /* The wind: gusting along x, pushing every free particle of the flag. */
    const gust = 6 + Math.sin(time * 0.7) * 3 + Math.sin(time * 2.3) * 1.5;
    for (let i = 0; i < flagCloth.count; i += 1) {
      if (flagCloth.invMass[i] === 0) continue;
      flagCloth.velocity[i * 3] =
        (flagCloth.velocity[i * 3] ?? 0) + gust * dt * (0.8 + hashToUnit(i + tick) * 0.4);
    }
    world.step(dt);
    flagCloth.step(world, dt);
    sheet.step(world, dt);
  },
  render() {
    camera.fovYDeg = 50;
    camera.position[0] = 1 + Math.sin(time * 0.1) * 2;
    camera.position[1] = 4;
    camera.position[2] = 10;
    camera.lookAt(0.5, 1.5, 0.5);
    refresh(flagMesh, flagCloth, FLAG_COLUMNS, FLAG_ROWS);
    refresh(sheetMesh, sheet, SHEET, SHEET);
    const drawAll = (draw: (mesh: MeshHandle, matrix: Float32Array) => void): void => {
      draw(scenery, IDENTITY);
      draw(flagMesh.mesh, IDENTITY);
      draw(sheetMesh.mesh, IDENTITY);
      for (const crate of crates) draw(crateMesh, placed(crate));
      for (const bone of boneMeshes) draw(bone.mesh, placed(bone.body));
    };
    renderer.beginShadowPass(lightMatrix, 'static');
    renderer.drawShadowCasters((sink) => drawAll((mesh, matrix) => sink.mesh(mesh, matrix)));
    renderer.endShadowPass();
    renderer.beginFrame([0.58, 0.64, 0.72]);
    renderer.bindMeshPass(camera, env);
    drawAll((mesh, matrix) => renderer.drawMesh(mesh, matrix));
    readout.set(0, `${doll.boneCount} BONES  SHOVE ${shoves}`);
    readout.draw(time);
    renderer.endFrame();
  },
});
