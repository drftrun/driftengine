/**
 * Four materials as DriftTexture programs, decoded on the device for every shaded pixel: bricks and
 * a metal chequer encoded from channels written in code, a marble that is noise and a colour, and a
 * panel whose glow is animated by the simulation's clock.
 *
 * A DriftTexture is a small program over a latent image, not a picture: the same four-word
 * instructions run in the GPU-driven pass's shading and in `decodeCpu`, the reference on the CPU,
 * which the readout samples at the centre of the glowing panel. Hold the clock and the panel stops
 * while the camera carries on, because its time is an argument the page passes, never a wall clock.
 *
 * WebGPU only, as the GPU-driven pipeline is: on a browser without it, this page says so.
 */
import { buildClusters, encodeMaterial } from '@driftengine/assets';
import type { ChannelInput, EncodedMaterial } from '@driftengine/assets';
import {
  GpuDrivenPass,
  createEnvironment,
  programFromEncoded,
  solidBox,
  solidToMesh,
  srgbColor,
  streamingScene,
  transformSolid,
} from '@driftengine/core';
import type {
  GpuDrivenMaterial,
  GpuDrivenMesh,
  GpuDrivenProgram,
  GpuDrivenView,
  Vec3,
} from '@driftengine/core';
import type { MeshData } from '@driftengine/drft';
import {
  ADDRESS_MODE,
  DECODE_OP,
  addDecodeNode,
  createDecodeGraph,
  createDecodeRegisters,
  decodeCpu,
} from '@driftengine/texture';
import type { DecodeGraph } from '@driftengine/texture';
import { createReadout } from '../common/readout';
import { controls, flag, openStage } from '../common/stage';

/** The background, picked by eye and so stated through `srgbColor`: the renderer grades a clear. */
const CLEAR = srgbColor(0.55, 0.6, 0.68);

const stage = await openStage(
  { outputTransform: 'aces', hdrScene: true, directionalShadows: false },
  { pipeline: 'gpu-driven' },
).catch((error: unknown) => {
  const readout = document.querySelector('#backend');
  if (readout !== null) readout.textContent = 'This example needs WebGPU, and this page has none.';
  console.info(error);
  return null;
});

// #region encode
/** Channels written in code, 64 texels square, then encoded jointly into one latent. */
const SIZE = 64;
function channel(
  semantic: ChannelInput['spec']['semantic'],
  component: number,
  value: (x: number, y: number) => number,
): ChannelInput {
  const data = new Float32Array(SIZE * SIZE);
  for (let y = 0; y < SIZE; y += 1)
    for (let x = 0; x < SIZE; x += 1) data[y * SIZE + x] = value(x, y);
  return { spec: { semantic, component }, data };
}

/** Tiling, full resolution, addressed at texel centres: what a surface texture wants. */
const encode = (channels: readonly ChannelInput[]): EncodedMaterial =>
  encodeMaterial(channels, SIZE, SIZE, { quality: 1, addressMode: ADDRESS_MODE.CENTRE_WRAP });

/** Courses of bricks: their colour, and a normal that turns at the mortar. */
const mortar = (x: number, y: number): boolean => y % 16 < 2 || (x + ((y >> 4) & 1) * 16) % 32 < 2;
const bevel = (offset: number): number => (offset === 2 ? 0.55 : offset === 31 ? -0.55 : 0);
const nx = (x: number, y: number): number => bevel((x + ((y >> 4) & 1) * 16) % 32);
const ny = (_x: number, y: number): number => bevel(y % 16 === 2 ? 2 : y % 16 === 15 ? 31 : 0);
const bricks = {
  baseColour: encode([
    channel('albedo-linear', 0, (x, y) => (mortar(x, y) ? 0.7 : 0.55)),
    channel('albedo-linear', 1, (x, y) => (mortar(x, y) ? 0.68 : 0.22)),
    channel('albedo-linear', 2, (x, y) => (mortar(x, y) ? 0.64 : 0.15)),
  ]),
  normal: encode([
    channel('normal-tangent-yup', 0, (x, y) => nx(x, y) * 0.5 + 0.5),
    channel('normal-tangent-yup', 1, (x, y) => ny(x, y) * 0.5 + 0.5),
    channel(
      'normal-tangent-yup',
      2,
      (x, y) => Math.sqrt(Math.max(0, 1 - nx(x, y) ** 2 - ny(x, y) ** 2)) * 0.5 + 0.5,
    ),
  ]),
};

/** A chequer of polished metal and rough stone: colour, and occlusion, roughness and metal. */
const tone = (x: number, y: number): number => ((x >> 3) + (y >> 3)) & 1;
const chequer = {
  baseColour: encode([
    channel('albedo-linear', 0, (x, y) => (tone(x, y) ? 0.85 : 0.25)),
    channel('albedo-linear', 1, (x, y) => (tone(x, y) ? 0.8 : 0.3)),
    channel('albedo-linear', 2, (x, y) => (tone(x, y) ? 0.7 : 0.35)),
  ]),
  orm: encode([
    channel('occlusion-linear', 0, (x, y) => (x % 8 === 0 || y % 8 === 0 ? 0.45 : 1)),
    channel('roughness-linear', 1, (x, y) => (tone(x, y) ? 0.25 : 0.85)),
    channel('metallic-linear', 2, (x, y) => (tone(x, y) ? 0.6 : 0)),
  ]),
};
// #endregion

// #region programs
/** A marble: five octaves of noise, with a warm white laid over it at half strength. */
const marbleGraph = createDecodeGraph(3);
addDecodeNode(marbleGraph, DECODE_OP.PROCEDURAL_FBM, 7, 5, 0);
addDecodeNode(marbleGraph, DECODE_OP.CONSTANT, 0, 0, 1);
addDecodeNode(marbleGraph, DECODE_OP.COMPOSITE, 1, 0, 2);
marbleGraph.result = 2;
marbleGraph.addressMode = ADDRESS_MODE.CENTRE_WRAP;
const marbleConstants = Float32Array.of(0.95, 0.9, 0.82, 0.55);

/** A glow that sweeps from amber to blue once a second of the time it is given. */
const glowGraph = createDecodeGraph(3);
addDecodeNode(glowGraph, DECODE_OP.CONSTANT, 0, 0, 0);
addDecodeNode(glowGraph, DECODE_OP.CONSTANT, 1, 0, 1);
addDecodeNode(glowGraph, DECODE_OP.LATENT_LERP, 0, 1, 2);
glowGraph.result = 2;
const glowConstants = Float32Array.of(1, 0.55, 0.15, 1, 0.2, 0.45, 1, 1);

/** A graph and its constants, as the device's program: no latent and no network to carry. */
const procedural = (graph: DecodeGraph, constants: Float32Array): GpuDrivenProgram => ({
  graph,
  latents: [],
  networks: [],
  constants,
});
// #endregion

if (stage !== null) {
  const { renderer, camera } = stage;

  // #region materials
  /** Material 0 is the ground; the rest wear DriftTexture programs. A cube's faces span 0 to 1, so
      a scale of three tiles the bricks three times across each face. */
  const materials: GpuDrivenMaterial[] = [
    { tint: [0.4, 0.42, 0.38], emissive: 0, roughness: 0.9 },
    {
      tint: [1, 1, 1],
      emissive: 0,
      roughness: 0.85,
      textures: {
        baseColour: programFromEncoded(bricks.baseColour),
        normal: programFromEncoded(bricks.normal),
        uScale: 3,
        vScale: 3,
      },
    },
    {
      tint: [1, 1, 1],
      emissive: 0,
      roughness: 1,
      textures: {
        baseColour: programFromEncoded(chequer.baseColour),
        orm: programFromEncoded(chequer.orm),
        uScale: 1,
        vScale: 1,
      },
    },
    {
      tint: [1, 1, 1],
      emissive: 0,
      roughness: 0.3,
      textures: { baseColour: procedural(marbleGraph, marbleConstants), uScale: 1, vScale: 1 },
    },
    {
      tint: [0.8, 0.8, 0.8],
      emissive: 1.2,
      roughness: 0.5,
      textures: { emissive: procedural(glowGraph, glowConstants) },
    },
  ];
  // #endregion

  /** A cube three metres a side for each textured material, in a row, on the ground. */
  const clustered = (mesh: MeshData, material: number): GpuDrivenMesh => {
    const set = buildClusters(mesh, 128);
    return {
      positions: mesh.positions,
      normals: mesh.normals,
      colours: mesh.colors,
      ...(mesh.uvs === undefined ? {} : { uvs: mesh.uvs }),
      clusters: {
        count: set.count,
        triangleOffsets: set.triangleOffsets,
        triangleCounts: set.triangleCounts,
        boundsCentre: set.boundsCentre,
        boundsRadius: set.boundsRadius,
        coneAxis: set.coneAxis,
        coneCutoff: set.coneCutoff,
        ownError: new Float32Array(set.count),
        parentError: new Float32Array(set.count).fill(Infinity),
        indices: set.indices,
      },
      material,
    };
  };
  const at = (x: number, y: number, z: number): number[] => [
    1,
    0,
    0,
    0,
    0,
    1,
    0,
    0,
    0,
    0,
    1,
    0,
    x,
    y,
    z,
    1,
  ];
  const meshes: GpuDrivenMesh[] = [
    clustered(solidToMesh(transformSolid(solidBox(40, 0.2, 40), at(0, -0.1, 0)), [1, 1, 1]), 0),
  ];
  for (let m = 1; m < materials.length; m += 1) {
    const cube = transformSolid(solidBox(3, 3, 3), at((m - 2.5) * 4.5, 1.5, 0));
    meshes.push(clustered(solidToMesh(cube, [1, 1, 1]), m));
  }
  const transforms = new Float32Array(meshes.length * 16);
  for (let i = 0; i < meshes.length; i += 1) transforms.set(at(0, 0, 0), i * 16);
  const pass = new GpuDrivenPass(streamingScene(meshes, transforms), materials);
  const handle = renderer.registerPass(pass);

  const env = createEnvironment({
    directionalDir: [0.45, 0.6, 0.55],
    directionalColor: [1.6, 1.5, 1.35],
    ambient: [0.3, 0.33, 0.4],
    ambientGround: [0.12, 0.11, 0.1],
  });
  const eye: Vec3 = [0, 0, 0];
  let time = 0;
  let decodeTime = 0;
  let held = flag('clock', 'running') === 'held';
  const view = {
    viewProj: camera.viewProjection,
    eye,
    lightDir: env.directionalDir,
    lightColour: env.directionalColor,
    ambient: env.ambient,
    ambientGround: env.ambientGround ?? env.ambient,
    lodThreshold: 1.5,
    fovY: (50 * Math.PI) / 180,
    time: 0,
  } satisfies GpuDrivenView;

  controls([
    {
      key: 'clock',
      label: 'texture clock',
      value: held ? 'held' : 'running',
      options: [
        { text: "the simulation's", value: 'running' },
        { text: 'held', value: 'held' },
      ],
      change: (value) => {
        held = value === 'held';
      },
    },
  ]);

  // #region reference
  /** The same glow, decoded on the CPU at the panel's centre with the time the device is given. */
  const registers = createDecodeRegisters();
  const sampled = new Float32Array(4);
  const glowResources = { latents: [], blocks: [], networks: [], constants: glowConstants };
  const readout = createReadout(renderer, 1);
  // #endregion

  stage.run({
    simulate(dt) {
      time += dt;
      if (!held) decodeTime += dt;
    },
    render() {
      camera.fovYDeg = 50;
      camera.far = 200;
      camera.position[0] = Math.sin(time * 0.15) * 7;
      camera.position[1] = 4;
      camera.position[2] = 14;
      camera.lookAt(0, 1.5, 0);
      eye[0] = camera.position[0];
      eye[1] = camera.position[1];
      eye[2] = camera.position[2];
      // #region time
      /* The decode reads this, never a clock of its own, so a held or replayed time decodes alike. */
      view.time = decodeTime;
      decodeCpu(glowGraph, glowResources, 0.5, 0.5, decodeTime, sampled, registers);
      // #endregion
      readout.set(
        0,
        `GLOW AT T ${decodeTime.toFixed(2)}  ${[0, 1, 2].map((c) => (sampled[c] ?? 0).toFixed(2)).join(' ')}`,
      );
      pass.resize(renderer.sceneWidth, renderer.sceneHeight);
      pass.setView(view);
      renderer.beginFrame(CLEAR);
      renderer.bindMeshPass(camera, env);
      renderer.drawPass(handle);
      readout.draw(time);
      renderer.endFrame();
    },
  });
}
