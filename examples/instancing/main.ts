/**
 * Ten thousand rocks in sixteen batches, each culled as a whole and then rock by rock, and a ring of
 * crystals whose batch is rewritten every frame.
 *
 * Instancing draws many copies of one mesh in one call with one material. The rocks never move, so
 * they are uploaded once; the crystals move, so theirs are uploaded each frame, which allocates
 * nothing because the arrays were sized once.
 */
import {
  MeshBuilder,
  SceneNode,
  createEnvironment,
  createMeshInstances,
  hashToUnit,
  mulberry32,
  srgbColor,
} from '@driftengine/core';
import type { InstancedHandle, MeshInstances } from '@driftengine/core';
import { openStage } from '../common/stage';

/** The background, picked by eye and so stated through `srgbColor`: the renderer grades a clear. */
const CLEAR = srgbColor(0.6, 0.66, 0.74);

const stage = await openStage({
  screenEffects: true,
  sceneSamples: 4,
  outputTransform: 'aces',
  outputExposure: 1.3,
});
const { renderer, camera } = stage;

const ENV = createEnvironment({
  directionalDir: [0.4, 0.75, 0.3],
  directionalColor: [1.3, 1.2, 1.05],
  ambient: [0.3, 0.34, 0.42],
  ambientGround: [0.16, 0.13, 0.1],
  nightFactor: 1,
  emissiveGain: 1.5,
  fogColor: [0.6, 0.66, 0.74],
  fogDensity: 0.012,
});

// #region matrix
/** Write a model matrix that scales, turns about Y and moves, into slot `i` of a batch. */
function place(
  out: Float32Array,
  i: number,
  x: number,
  y: number,
  z: number,
  yaw: number,
  s: number,
): void {
  const o = i * 16;
  const c = Math.cos(yaw) * s;
  const n = Math.sin(yaw) * s;
  out[o] = c;
  out[o + 1] = 0;
  out[o + 2] = -n;
  out[o + 3] = 0;
  out[o + 4] = 0;
  out[o + 5] = s;
  out[o + 6] = 0;
  out[o + 7] = 0;
  out[o + 8] = n;
  out[o + 9] = 0;
  out[o + 10] = c;
  out[o + 11] = 0;
  out[o + 12] = x;
  out[o + 13] = y;
  out[o + 14] = z;
  out[o + 15] = 1;
}
// #endregion

// #region rocks
/** A lumpy rock: a sphere whose radius varies by a hash of where on it you are. */
const rock = renderer.createMesh(
  new MeshBuilder()
    .addBlob(
      [0, 0.35, 0],
      (u, v) => 0.5 + hashToUnit(Math.floor(u * 7) * 31 + Math.floor(v * 5)) * 0.18,
      [0.55, 0.52, 0.48],
    )
    .build(),
);

const REGIONS = 4;
const PER_REGION = 625;
const SPAN = 120;
const random = mulberry32(7);

/** One batch per region, so a region out of view is skipped in one test. */
const fields: { batch: InstancedHandle; data: MeshInstances }[] = [];
for (let rx = 0; rx < REGIONS; rx += 1) {
  for (let rz = 0; rz < REGIONS; rz += 1) {
    const data = createMeshInstances(PER_REGION);
    for (let i = 0; i < PER_REGION; i += 1) {
      const x = (rx + random()) * (SPAN / REGIONS) - SPAN / 2;
      const z = (rz + random()) * (SPAN / REGIONS) - SPAN / 2;
      place(data.models, i, x, 0, z, random() * Math.PI * 2, 0.2 + random() * 0.8);
      const shade = 0.42 + random() * 0.3;
      data.tints.set([shade, shade * (0.95 + random() * 0.1), shade * 0.95], i * 3);
    }
    data.count = PER_REGION;
    const batch = renderer.createInstanced(rock, PER_REGION, { cull: true });
    renderer.uploadInstanced(batch, data);
    fields.push({ batch, data });
  }
}
// #endregion

// #region crystals
/** Crystals circling the middle: the same batch, rewritten in place every frame. */
const CRYSTALS = 240;
const crystal = renderer.createMesh(
  new MeshBuilder().addCylinder([0, 0.6, 0], 0.18, 0.6, 'y', [0.55, 0.85, 1], 1.2, 6).build(),
);
const ring = createMeshInstances(CRYSTALS);
ring.count = CRYSTALS;
for (let i = 0; i < CRYSTALS; i += 1) ring.tints.set([1, 1, 1], i * 3);
const ringBatch = renderer.createInstanced(crystal, CRYSTALS);

function moveCrystals(time: number): void {
  for (let i = 0; i < CRYSTALS; i += 1) {
    const a = (i / CRYSTALS) * Math.PI * 2 + time * 0.2;
    const r = 14 + Math.sin(i * 1.7 + time) * 2;
    place(
      ring.models,
      i,
      Math.cos(a) * r,
      1 + Math.sin(time * 1.5 + i) * 0.8,
      Math.sin(a) * r,
      time + i,
      1,
    );
  }
  renderer.uploadInstanced(ringBatch, ring);
}
// #endregion

const ground = renderer.createMesh(
  new MeshBuilder()
    .addBox([0, -0.1, 0], [SPAN / 2 + 10, 0.1, SPAN / 2 + 10], [0.42, 0.45, 0.36])
    .build(),
);
const still = new SceneNode();
still.updateWorld();
camera.fovYDeg = 55;
camera.far = 400;
let time = 0;

stage.run({
  simulate(dt) {
    time += dt;
  },
  // #region draw
  render() {
    camera.position[0] = Math.sin(time * 0.05) * 40;
    camera.position[1] = 9;
    camera.position[2] = Math.cos(time * 0.05) * 40;
    camera.lookAt(0, 1, 0);
    moveCrystals(time);

    renderer.beginFrame(CLEAR);
    renderer.bindMeshPass(camera, ENV);
    renderer.drawMesh(ground, still.worldMatrix);
    for (let i = 0; i < fields.length; i += 1)
      renderer.drawInstanced(fields[i].batch, fields[i].data);
    renderer.drawInstanced(ringBatch, ring);
    renderer.endFrame();
  },
  // #endregion
});
