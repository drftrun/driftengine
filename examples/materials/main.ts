/**
 * Physically based materials: metalness and roughness from an ORM map, and a ground with an albedo
 * image, a normal map and the tangent frame normal maps need.
 *
 * Every image here is painted into a canvas at load, so the example needs no files. A game's own
 * images arrive the same way, as anything `createSurfaceTexture` accepts: an image element, a
 * bitmap or a canvas.
 */
import { MeshBuilder, SceneNode, createEnvironment, generateTangents } from '@driftengine/core';
import type { SurfaceTextureHandle } from '@driftengine/core';
import { openStage } from '../common/stage';

const stage = await openStage({
  screenEffects: true,
  sceneSamples: 4,
  outputTransform: 'aces',
  outputExposure: 1.3,
});
const { renderer, camera } = stage;

const ENV = createEnvironment({
  directionalDir: [0.55, 0.65, 0.5],
  directionalColor: [1.4, 1.32, 1.2],
  ambient: [0.32, 0.36, 0.44],
  ambientGround: [0.14, 0.12, 0.1],
  fogColor: [0.62, 0.68, 0.76],
  fogDensity: 0.01,
});

// #region canvas
/** A small canvas of one colour: the whole of an ORM map whose value does not vary. */
function solid(r: number, g: number, b: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = 4;
  canvas.height = 4;
  const ctx = canvas.getContext('2d');
  if (ctx !== null) {
    ctx.fillStyle = `rgb(${r * 255}, ${g * 255}, ${b * 255})`;
    ctx.fillRect(0, 0, 4, 4);
  }
  return canvas;
}
// #endregion

// #region orm
/**
 * Occlusion in red, roughness in green, metalness in blue. These are data, not colours, so they
 * are uploaded as linear: read as sRGB they would bend toward zero and every surface would look
 * like glass.
 */
function orm(roughness: number, metal: number): SurfaceTextureHandle {
  return renderer.createSurfaceTexture(solid(1, roughness, metal), { colorSpace: 'linear' });
}

const STEPS = 6;
/** Top row: metalness from 0 to 1 at middling roughness. Bottom row: roughness at full metal. */
const metals = Array.from({ length: STEPS }, (_, i) => orm(0.35, i / (STEPS - 1)));
const roughs = Array.from({ length: STEPS }, (_, i) => orm(0.05 + (i / (STEPS - 1)) * 0.9, 1));
// #endregion

const sphere = renderer.createMesh(
  new MeshBuilder().addSphere([0, 0, 0], 0.6, [0.9, 0.62, 0.32], 0, 40, 24).build(),
);

// #region ground
/** A tile pattern for the albedo, which is a picture and so is sRGB. */
function tiles(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  if (ctx !== null) {
    ctx.fillStyle = '#6b6560';
    ctx.fillRect(0, 0, 256, 256);
    ctx.fillStyle = '#8a837b';
    ctx.fillRect(4, 4, 120, 120);
    ctx.fillRect(132, 132, 120, 120);
    ctx.fillStyle = '#7a736b';
    ctx.fillRect(132, 4, 120, 120);
    ctx.fillRect(4, 132, 120, 120);
  }
  return canvas;
}

/** A normal map from the same tile layout: grooves between tiles, and a gentle bevel. */
function tileNormals(): HTMLCanvasElement {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx === null) return canvas;
  const image = ctx.createImageData(size, size);
  const height = (x: number, y: number): number => {
    const u = ((x % 128) + 128) % 128;
    const v = ((y % 128) + 128) % 128;
    const edge = Math.min(u, 127 - u, v, 127 - v);
    return Math.min(1, edge / 6);
  };
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = height(x + 1, y) - height(x - 1, y);
      const dy = height(x, y + 1) - height(x, y - 1);
      const length = Math.hypot(dx, dy, 1);
      const i = (y * size + x) * 4;
      image.data[i] = ((-dx / length) * 0.5 + 0.5) * 255;
      image.data[i + 1] = ((-dy / length) * 0.5 + 0.5) * 255;
      image.data[i + 2] = ((1 / length) * 0.5 + 0.5) * 255;
      image.data[i + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

/** `planarUvs` gives the ground texture coordinates; a normal map also needs tangents. */
const groundData = new MeshBuilder()
  .addBox([0, -0.1, 0], [8, 0.1, 6], [1, 1, 1])
  .build({ planarUvs: true });
if (groundData.uvs !== undefined) {
  groundData.tangents = generateTangents(
    groundData.positions,
    groundData.normals,
    groundData.uvs,
    groundData.indices,
  );
}
const ground = renderer.createMesh(groundData);

const groundMaterial = {
  albedo: renderer.createSurfaceTexture(tiles(), { colorSpace: 'srgb' }),
  normal: renderer.createSurfaceTexture(tileNormals(), { colorSpace: 'linear' }),
  orm: orm(0.75, 0),
  uScale: 0.5,
  vScale: 0.5,
};
// #endregion

const still = new SceneNode();
still.updateWorld();
const place = new SceneNode();
let time = 0;

camera.fovYDeg = 45;

stage.run({
  simulate(dt) {
    time += dt;
  },
  // #region draw
  render() {
    const angle = Math.sin(time * 0.15) * 0.35;
    camera.position[0] = Math.sin(angle) * 9;
    camera.position[1] = 3.2;
    camera.position[2] = Math.cos(angle) * 9;
    camera.lookAt(0, 1.2, 0);

    renderer.beginFrame([0.62, 0.68, 0.76]);
    renderer.bindMeshPass(camera, ENV);

    renderer.setMaterial(groundMaterial);
    renderer.drawMesh(ground, still.worldMatrix);

    for (let i = 0; i < STEPS; i += 1) {
      const x = (i - (STEPS - 1) / 2) * 1.5;
      renderer.setMaterial({ orm: metals[i] });
      place.setPosition(x, 2.2, 0);
      place.updateWorld();
      renderer.drawMesh(sphere, place.worldMatrix);

      renderer.setMaterial({ orm: roughs[i] });
      place.setPosition(x, 0.7, 0);
      place.updateWorld();
      renderer.drawMesh(sphere, place.worldMatrix);
    }
    renderer.setMaterial(null);
    renderer.endFrame();
  },
  // #endregion
});
