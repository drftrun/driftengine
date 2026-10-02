/**
 * Two thousand five hundred rocks, each its own mesh, drawn by the GPU-driven pipeline: culled,
 * chosen and drawn on the device with one indirect draw, shaded with one dispatch per material.
 *
 * Nothing here is a draw call per rock. The CPU uploads the scene once and, each frame, says where
 * the camera is. WebGPU only: on a browser without it, this page says so.
 */
import { buildClusters } from '@driftengine/assets';
import {
  GpuDrivenPass,
  MeshBuilder,
  createEnvironment,
  hashToUnit,
  mulberry32,
  streamingScene,
} from '@driftengine/core';
import type { GpuDrivenMaterial, GpuDrivenMesh, GpuDrivenView, Vec3 } from '@driftengine/core';
import type { MeshData } from '@driftengine/drft';
import { openStage } from '../common/stage';

// #region renderer
/** The pipeline is a renderer option, and asking for it where it cannot run throws. */
const stage = await openStage(
  { outputTransform: 'aces', hdrScene: true, directionalShadows: false },
  { pipeline: 'gpu-driven' },
).catch((error: unknown) => {
  const readout = document.querySelector('#backend');
  if (readout !== null) readout.textContent = 'This example needs WebGPU, and this page has none.';
  console.info(error);
  return null;
});
// #endregion

// #region clusters
/** A mesh, split into clusters of about 128 triangles: the unit the device culls and draws. */
function clustered(mesh: MeshData, material: number): GpuDrivenMesh {
  const set = buildClusters(mesh, 128);
  return {
    positions: mesh.positions,
    normals: mesh.normals,
    colours: mesh.colors,
    clusters: {
      count: set.count,
      triangleOffsets: set.triangleOffsets,
      triangleCounts: set.triangleCounts,
      boundsCentre: set.boundsCentre,
      boundsRadius: set.boundsRadius,
      coneAxis: set.coneAxis,
      coneCutoff: set.coneCutoff,
      /* One level of detail: every cluster is its own finest and coarsest. */
      ownError: new Float32Array(set.count),
      parentError: new Float32Array(set.count).fill(Infinity),
      indices: set.indices,
    },
    material,
  };
}
// #endregion

// #region scene
/** Every rock a mesh of its own, placed by a transform; the ground is material 1. */
const random = mulberry32(11);
const meshes: GpuDrivenMesh[] = [];
const ROCKS = 2500;
for (let i = 0; i < ROCKS; i += 1) {
  const shade = 0.4 + random() * 0.25;
  const rock = new MeshBuilder().addBlob(
    [0, 0.3, 0],
    (u, v) => 0.5 + hashToUnit(i * 977 + Math.floor(u * 7) * 31 + Math.floor(v * 5)) * 0.2,
    [shade, shade * 0.97, shade * 0.92],
  );
  meshes.push(clustered(rock.build(), 0));
}
meshes.push(
  clustered(new MeshBuilder().addBox([0, -0.1, 0], [80, 0.1, 80], [0.3, 0.34, 0.26]).build(), 1),
);

const transforms = new Float32Array(meshes.length * 16);
for (let i = 0; i < meshes.length; i += 1) {
  const s = i < ROCKS ? 0.4 + random() * 1.4 : 1;
  const x = i < ROCKS ? (random() - 0.5) * 150 : 0;
  const z = i < ROCKS ? (random() - 0.5) * 150 : 0;
  transforms.set([s, 0, 0, 0, 0, s, 0, 0, 0, 0, s, 0, x, 0, z, 1], i * 16);
}
const scene = streamingScene(meshes, transforms);

const materials: GpuDrivenMaterial[] = [
  { tint: [1, 1, 1], emissive: 0, roughness: 0.8 },
  { tint: [1, 1, 1], emissive: 0, roughness: 0.95 },
];
// #endregion

if (stage !== null) {
  const { renderer, camera } = stage;

  // #region pass
  /** The pipeline is a pass like any other: registered once, drawn where the frame says. */
  const pass = new GpuDrivenPass(scene, materials);
  const handle = renderer.registerPass(pass);
  // #endregion

  const env = createEnvironment({
    directionalDir: [0.4, 0.7, 0.3],
    directionalColor: [1.5, 1.4, 1.25],
    ambient: [0.3, 0.34, 0.42],
    ambientGround: [0.1, 0.09, 0.08],
  });
  const eye: Vec3 = [0, 0, 0];
  // #region view
  /** What the pass needs of the camera and the light, refreshed in place every frame. */
  const view: GpuDrivenView = {
    viewProj: camera.viewProjection,
    eye,
    lightDir: env.directionalDir,
    lightColour: env.directionalColor,
    ambient: env.ambient,
    ambientGround: env.ambientGround ?? env.ambient,
    lodThreshold: 1.5,
    fovY: (55 * Math.PI) / 180,
  };
  // #endregion

  let time = 0;
  stage.run({
    simulate(dt) {
      time += dt;
    },
    render() {
      camera.fovYDeg = 55;
      camera.far = 400;
      camera.position[0] = Math.sin(time * 0.05) * 50;
      camera.position[1] = 6;
      camera.position[2] = Math.cos(time * 0.05) * 50;
      camera.lookAt(0, 0, 0);
      eye[0] = camera.position[0];
      eye[1] = camera.position[1];
      eye[2] = camera.position[2];

      // #region frame
      /* Before the frame opens: the pass records its culling and drawing against this view. */
      pass.resize(renderer.sceneWidth, renderer.sceneHeight);
      pass.setView(view);

      renderer.beginFrame([0.55, 0.62, 0.72]);
      renderer.bindMeshPass(camera, env);
      renderer.drawPass(handle);
      renderer.endFrame();
      // #endregion
    },
  });
}
