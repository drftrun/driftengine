/**
 * A fire in a ring of stones at night: sparks that streak as they fly and fall, smoke that rises and
 * thins as it drifts, and motes of light floating in the dark around it.
 *
 * Three pools, three particle materials. Every particle is emitted from the fixed simulation step
 * with the tick as its seed, so the same run makes the same fire.
 */
import {
  MeshBuilder,
  ParticlePool,
  SceneNode,
  createEnvironment,
  createPointLightBuffer,
  hashToUnit,
  selectPointLights,
} from '@driftengine/core';
import type { PointLightSource } from '@driftengine/core';
import { openStage } from '../common/stage';

const stage = await openStage({
  outputTransform: 'aces',
  hdrScene: true,
  bloom: 0.5,
  bloomThreshold: 1.2,
  sceneSamples: 4,
});
const { renderer, camera } = stage;

// #region pools
/** Each pool is the simulation: where its particles are, how old, how big and what colour. */
const sparks = new ParticlePool({
  capacity: 600,
  lifeSec: 1.4,
  sizeStart: 0.05,
  sizeEnd: 0.01,
  colorStart: [4, 2.2, 0.8],
  colorEnd: [1.4, 0.3, 0.05],
  gravity: 4,
  drag: 0.6,
  rise: 0,
});
const smoke = new ParticlePool({
  capacity: 300,
  lifeSec: 6,
  sizeStart: 0.5,
  sizeEnd: 2.4,
  colorStart: [0.18, 0.17, 0.17],
  colorEnd: [0.3, 0.3, 0.32],
  gravity: 0,
  drag: 0.4,
  rise: 0.7,
  alphaStart: 0.3,
  alphaEnd: 0,
});
const motes = new ParticlePool({
  capacity: 200,
  lifeSec: 8,
  sizeStart: 0.04,
  sizeEnd: 0.04,
  colorStart: [1.6, 1.4, 0.8],
  colorEnd: [0.6, 0.5, 0.3],
  gravity: 0,
  drag: 0.2,
  rise: 0.05,
  alphaStart: 1,
  alphaEnd: 0,
});
// #endregion

// #region batches
/** Each batch is how its pool is drawn: which material, how it blends, which way it faces. */
const sparkBatch = renderer.createParticles(600, {
  material: 'spark',
  blend: 'additive',
  stretchSec: 0.05,
  coreGain: 2,
});
const smokeBatch = renderer.createParticles(300, {
  material: 'smoke',
  blend: 'alpha',
  erosion: 0.6,
});
const moteBatch = renderer.createParticles(200, { material: 'mote', blend: 'additive' });
// #endregion

const env = createEnvironment({
  directionalColor: [0.05, 0.06, 0.1],
  directionalDir: [0.2, 0.8, 0.3],
  ambient: [0.02, 0.025, 0.04],
  ambientGround: [0.01, 0.01, 0.012],
  fogColor: [0.02, 0.025, 0.04],
  fogDensity: 0.02,
  nightFactor: 1,
  emissiveGain: 2,
});

const ground = new MeshBuilder();
ground.addBox([0, -0.1, 0], [30, 0.1, 30], [0.25, 0.24, 0.22]);
for (let i = 0; i < 9; i += 1) {
  const a = (i / 9) * Math.PI * 2;
  ground.addBlob([Math.cos(a) * 0.9, 0.12, Math.sin(a) * 0.9], () => 0.2, [0.4, 0.38, 0.36]);
}
ground.addBox([0, 0.08, 0], [0.45, 0.06, 0.45], [1, 0.4, 0.1], 1.5);
const groundMesh = renderer.createMesh(ground.build());
const still = new SceneNode();
still.updateWorld();

const fireLight: PointLightSource[] = [
  {
    x: 0,
    y: 0.8,
    z: 0,
    r: 4,
    g: 1.8,
    b: 0.6,
    radius: 9,
    flicker: 0.35,
    shadowNear: 0.3,
    sourceRadius: 0.3,
    castsShadow: false,
  },
];
const chosen = createPointLightBuffer(renderer.shadedLights);

let tick = 0;
let time = 0;

stage.run({
  // #region simulate
  simulate(dt) {
    tick += 1;
    time += dt;
    /* A few sparks every tick, a puff of smoke every other one, and a mote now and then. */
    for (let i = 0; i < 4; i += 1) {
      const seed = tick * 8 + i;
      const a = hashToUnit(seed) * Math.PI * 2;
      const out = hashToUnit(seed + 1) * 1.2;
      sparks.emit(
        0,
        0.3,
        0,
        Math.cos(a) * out,
        2.5 + hashToUnit(seed + 2) * 3,
        Math.sin(a) * out,
        seed,
      );
    }
    if (tick % 2 === 0) {
      const seed = tick;
      smoke.emit(
        (hashToUnit(seed) - 0.5) * 0.4,
        0.6,
        (hashToUnit(seed + 5) - 0.5) * 0.4,
        0.15,
        0.6,
        0,
        seed,
      );
    }
    if (tick % 12 === 0) {
      const seed = tick;
      const a = hashToUnit(seed) * Math.PI * 2;
      const r = 1.5 + hashToUnit(seed + 3) * 3;
      motes.emit(
        Math.cos(a) * r,
        0.3 + hashToUnit(seed + 4) * 2,
        Math.sin(a) * r,
        0,
        0.05,
        0,
        seed,
      );
    }
    sparks.update(dt);
    smoke.update(dt);
    motes.update(dt);
  },
  // #endregion
  render() {
    camera.fovYDeg = 50;
    camera.position[0] = Math.sin(time * 0.1) * 6;
    camera.position[1] = 2.2;
    camera.position[2] = Math.cos(time * 0.1) * 6;
    camera.lookAt(0, 1.2, 0);

    selectPointLights(fireLight, camera.position[0], 2, camera.position[2], chosen, time);
    env.lightCount = chosen.count;
    env.lightPositions = chosen.positions;
    env.lightColors = chosen.colors;
    env.lightRadii = chosen.radii;
    env.lightSourceRadii = chosen.sourceRadii;
    env.lightWeights = chosen.weights;

    renderer.beginFrame([0.02, 0.025, 0.04]);
    renderer.bindMeshPass(camera, env);
    renderer.drawMesh(groundMesh, still.worldMatrix);
    // #region draw
    /* After the opaque scene: what covers first, then what adds light. */
    renderer.drawParticles(smokeBatch, smoke.particles, camera, env, time);
    renderer.drawParticles(sparkBatch, sparks.particles, camera, env, time);
    renderer.drawParticles(moteBatch, motes.particles, camera, env, time);
    // #endregion
    renderer.endFrame();
  },
});
