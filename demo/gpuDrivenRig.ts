/**
 * The rig three GPU-driven draft scenes share: geometry, materials and the frame loop.
 *
 * **Not a scene, and `demo/scenes.test.ts` knows it by what it exports.** A file here is a scene
 * module if it declares a `DemoScene`, which this one does not — it declares the three things
 * those modules are made of. Three scenes in one file would have been the same code and one
 * module, and the corpus check counts modules for a reason: a file that registers two scenes
 * registers the second one somewhere nobody looks.
 *
 * **What these rigs draw is the second pipeline's subset of the standard material**: vertex
 * colour, one directional term with its highlight and its shadow, a hemispheric ambient, the
 * image-based term where a rig declares a room, metalness, an emissive add, and — since
 * 2026-09-17 — three DriftTexture materials on the materials rig, decoded per pixel on the
 * device. All three stay in `DRAFT_SCENES` until the maintainer says to publish them.
 *
 * **They ask for the pipeline twice, and both are load-bearing.**
 * `createRenderer({ pipeline: 'gpu-driven' })` fails at boot on a backend that cannot run it,
 * which is the message a consumer should get; `registerPass` on the pass itself is what actually
 * draws. A scene that only did the second would fall back to a forward frame with nothing in it
 * on WebGL2, silently.
 */
import {
  Camera,
  GpuDrivenPass,
  StreamingScene,
  streamingScene,
  createEnvironment,
  createRenderer,
  programFromEncoded,
} from '../packages/core/src/index';
import type { MeshHandle } from '../packages/core/src/index';
import type {
  ClusterSource,
  Environment,
  GpuDrivenMaterial,
  GpuDrivenMesh,
  GpuDrivenProgram,
  StreamHandle,
  GpuDrivenTextures,
  GpuDrivenView,
  PassHandle,
  RenderBackend,
  RendererApi,
  RenderQualityOptions,
  SkyColors,
  SurfaceMaterial,
  SurfaceTextureHandle,
} from '../packages/core/src/index';
import { buildClusters, encodeMaterial, latentImageOf } from '@driftengine/assets';
import type { ChannelInput, EncodedMaterial } from '@driftengine/assets';
import { ADDRESS_MODE, DECODE_OP, createDecodeRegisters, decodeCpu } from '@driftengine/texture';

import { OrbitView } from './orbit';
import type { DemoHandle, DemoStats } from './types';

/**
 * Where the sun stands for the two rigs that do not ask for their own.
 *
 * **A rig may override it, and the materials rig does.** A shadow falls away from the light, so a
 * sun on the camera's side of a scene puts every shadow behind the thing casting it — which is
 * what the first capture of the shadow map showed, and it reads exactly like a shadow map that is
 * not working. Overriding it per rig rather than here keeps the other two byte-identical, which is
 * what makes them the control the pixel check needs.
 */
const SUN: [number, number, number] = [0.4, 0.66, 0.35];

const SKY: SkyColors = {
  top: [0.07, 0.11, 0.2],
  horizon: [0.3, 0.36, 0.44],
  deep: [0.02, 0.03, 0.06],
  sunDir: SUN,
  sunColor: [1, 0.96, 0.88],
  sunAngularRadius: 0.005,
  moonDir: [-0.3, 0.6, -0.4],
  moonColor: [0.5, 0.55, 0.7],
  moonAngularRadius: 0.006,
  moonPhase: 0.5,
  nightFactor: 0,
  cloudOffsetX: 0,
  cloudOffsetZ: 0,
};

const ENV = createEnvironment({
  directionalDir: SUN,
  directionalColor: [0.95, 0.9, 0.8],
  ambient: [0.22, 0.26, 0.34],
  ambientGround: [0.07, 0.06, 0.05],
  emissiveGain: 1,
  nightFactor: 0,
  fogColor: [0.3, 0.36, 0.44],
  fogDensity: 0,
  fogHeightFalloff: 0.05,
  fogBaseY: 0,
});

/**
 * Several raw meshes as one, for geometry that is a set of slabs rather than a shape.
 *
 * A room is six walls and `createMesh` takes one mesh, which is the whole of why this exists.
 */
function merge(parts: readonly RawMesh[]): RawMesh {
  let vertices = 0;
  let indices = 0;
  for (const part of parts) {
    vertices += part.positions.length / 3;
    indices += part.indices.length;
  }
  const out: RawMesh = {
    positions: new Float32Array(vertices * 3),
    normals: new Float32Array(vertices * 3),
    colours: new Float32Array(vertices * 3),
    indices: new Uint32Array(indices),
    material: parts[0]?.material ?? 0,
  };
  let vertexBase = 0;
  let indexBase = 0;
  for (const part of parts) {
    out.positions.set(part.positions, vertexBase * 3);
    out.normals.set(part.normals, vertexBase * 3);
    out.colours.set(part.colours, vertexBase * 3);
    for (let i = 0; i < part.indices.length; i += 1) {
      out.indices[indexBase + i] = (part.indices[i] as number) + vertexBase;
    }
    vertexBase += part.positions.length / 3;
    indexBase += part.indices.length;
  }
  return out;
}

/** A mesh under construction, before it is clustered. */
export interface RawMesh {
  positions: Float32Array;
  normals: Float32Array;
  colours: Float32Array;
  indices: Uint32Array;
  material: number;
  /** Two floats a vertex. A box carries them in metres of its own faces; the terrain carries none. */
  uvs?: Float32Array;
  /**
   * Where this mesh stands, sixteen floats column-major. Identity when it says nothing.
   *
   * **A rig that names one is the only thing exercising the transform at all.** The pipeline has
   * always multiplied vertices and normals by `transforms[mesh]`, and until 2026-09-17 its culling
   * read the bake's own untransformed bounds — invisible for as long as every rig here stood at
   * the origin. `clusterWorld.ts` is the fix and `occlusionRig` is what looks at it.
   */
  transform?: Float32Array;
}

/**
 * Sixteen floats, column-major: a quarter turn about y if asked for, then a translation.
 *
 * **The turn is written as 0 and 1 rather than taken from `Math.cos`**, which answers 6.1e-17 for a
 * right angle — a wall leaning by a millionth of a degree, for nothing. Exact entries are what let
 * a mesh built the other way round and turned be the same geometry to the bit.
 */
function placement(x: number, y: number, z: number, turned = false): Float32Array {
  const m = new Float32Array(16);
  if (turned) {
    /* +x goes to -z and +z goes to +x, so a slab built deep comes out wide. */
    m[2] = -1;
    m[5] = 1;
    m[8] = 1;
  } else {
    m[0] = 1;
    m[5] = 1;
    m[10] = 1;
  }
  m[12] = x;
  m[13] = y;
  m[14] = z;
  m[15] = 1;
  return m;
}

/**
 * Turn a raw mesh into what the pipeline reads.
 *
 * **`ownError` is zero and `parentError` is infinite**, which selects every cluster: there is no
 * simplified level under these, so the cut has one level to choose from and chooses it. The pass
 * still runs the cut — what it is being checked for here is that it selects rather than that it
 * discriminates, and a scene with a real level graph is what discriminates. `clusterLod.ts` builds
 * one; these rigs do not, because a million-triangle graph is a bake and not a mount.
 */
export function clustered(mesh: RawMesh): GpuDrivenMesh {
  const set = buildClusters(
    {
      positions: mesh.positions,
      normals: mesh.normals,
      colors: mesh.colours,
      emissive: new Float32Array(mesh.positions.length / 3),
      indices: mesh.indices,
    },
    128,
  );
  const source: ClusterSource = {
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
  };
  return {
    positions: mesh.positions,
    normals: mesh.normals,
    colours: mesh.colours,
    ...(mesh.uvs === undefined ? {} : { uvs: mesh.uvs }),
    clusters: source,
    material: mesh.material,
  };
}

/**
 * A displaced grid: `cells * cells * 2` triangles, with a normal computed from the height field.
 *
 * Two sine ridges at different frequencies, so the surface has curvature in both axes — a flat
 * plane gives every cluster the same normal cone and the cone cull then either takes all of them
 * or none, which tests nothing.
 */
function terrain(cells: number, extent: number, height: number, material: number): RawMesh {
  const side = cells + 1;
  const vertices = side * side;
  const positions = new Float32Array(vertices * 3);
  const normals = new Float32Array(vertices * 3);
  const colours = new Float32Array(vertices * 3);
  const at = (x: number, z: number): number =>
    Math.sin(x * 2.1) * Math.cos(z * 1.7) * height + Math.sin((x + z) * 5.3) * height * 0.18;

  for (let z = 0; z < side; z += 1) {
    for (let x = 0; x < side; x += 1) {
      const u = (x / cells - 0.5) * 2;
      const v = (z / cells - 0.5) * 2;
      const y = at(u, v);
      const i = (z * side + x) * 3;
      positions[i] = u * extent;
      positions[i + 1] = y;
      positions[i + 2] = v * extent;

      /* Central differences on the height field, which is exact enough for a lit surface. */
      const step = 2 / cells;
      const dx = (at(u + step, v) - at(u - step, v)) / (2 * step * extent);
      const dz = (at(u, v + step) - at(u, v - step)) / (2 * step * extent);
      const length = Math.hypot(-dx, 1, -dz);
      normals[i] = -dx / length;
      normals[i + 1] = 1 / length;
      normals[i + 2] = -dz / length;

      const tint = 0.45 + 0.35 * (y / Math.max(height, 1e-6)) * 0.5;
      colours[i] = tint * 0.8;
      colours[i + 1] = tint;
      colours[i + 2] = tint * 0.62;
    }
  }

  const indices = new Uint32Array(cells * cells * 6);
  let out = 0;
  for (let z = 0; z < cells; z += 1) {
    for (let x = 0; x < cells; x += 1) {
      const a = z * side + x;
      indices[out] = a;
      indices[out + 1] = a + side;
      indices[out + 2] = a + 1;
      indices[out + 3] = a + 1;
      indices[out + 4] = a + side;
      indices[out + 5] = a + side + 1;
      out += 6;
    }
  }
  return { positions, normals, colours, indices, material };
}

/** An axis-aligned box with flat normals, so its six faces give six distinct cones. */
function box(
  cx: number,
  cy: number,
  cz: number,
  hx: number,
  hy: number,
  hz: number,
  colour: readonly [number, number, number],
  material: number,
): RawMesh {
  const faces: Array<[number[], number[], number[]]> = [
    [
      [1, 0, 0],
      [0, 0, 1],
      [0, 1, 0],
    ],
    [
      [-1, 0, 0],
      [0, 0, -1],
      [0, 1, 0],
    ],
    [
      [0, 1, 0],
      [1, 0, 0],
      [0, 0, 1],
    ],
    [
      [0, -1, 0],
      [-1, 0, 0],
      [0, 0, 1],
    ],
    [
      [0, 0, 1],
      [-1, 0, 0],
      [0, 1, 0],
    ],
    [
      [0, 0, -1],
      [1, 0, 0],
      [0, 1, 0],
    ],
  ];
  const positions = new Float32Array(24 * 3);
  const normals = new Float32Array(24 * 3);
  const colours = new Float32Array(24 * 3);
  const uvs = new Float32Array(24 * 2);
  const indices = new Uint32Array(36);
  const half = [hx, hy, hz];

  for (let f = 0; f < faces.length; f += 1) {
    const [normal, tangent, bitangent] = faces[f] as [number[], number[], number[]];
    /*
     * **A metre of texture a metre of surface**, measured along the face's own tangent and
     * bitangent, so one tiling map lands at one scale on a floor and on a box beside it.
     */
    let across = 0;
    let up = 0;
    for (let axis = 0; axis < 3; axis += 1) {
      across += Math.abs(tangent[axis] as number) * (half[axis] as number) * 2;
      up += Math.abs(bitangent[axis] as number) * (half[axis] as number) * 2;
    }
    for (let corner = 0; corner < 4; corner += 1) {
      const s = corner === 0 || corner === 3 ? -1 : 1;
      const t = corner < 2 ? -1 : 1;
      const at = (f * 4 + corner) * 3;
      for (let axis = 0; axis < 3; axis += 1) {
        const centre = axis === 0 ? cx : axis === 1 ? cy : cz;
        positions[at + axis] =
          centre +
          ((normal[axis] as number) +
            s * (tangent[axis] as number) +
            t * (bitangent[axis] as number)) *
            (half[axis] as number);
        normals[at + axis] = normal[axis] as number;
        colours[at + axis] = colour[axis] as number;
      }
      uvs[(f * 4 + corner) * 2] = ((s + 1) / 2) * across;
      uvs[(f * 4 + corner) * 2 + 1] = ((t + 1) / 2) * up;
    }
    const base = f * 4;
    const out = f * 6;
    /*
     * **Wound so that `(P1 - P0) x (P2 - P0)` points the way the face's normal does**, which is
     * `MeshBuilder`'s convention and the engine's. Built the other way round first, and it drew:
     * a closed box whose faces are all inside out still reads as a box, because what survives the
     * cull is the inside of the far wall and the shading uses the stored normals. What does not
     * survive is a single-sided surface, which is how the terrain rig found it.
     */
    indices[out] = base;
    indices[out + 1] = base + 2;
    indices[out + 2] = base + 1;
    indices[out + 3] = base;
    indices[out + 4] = base + 3;
    indices[out + 5] = base + 2;
  }
  return { positions, normals, colours, uvs, indices, material };
}

/** One rig's geometry, its materials and where the camera should stand. */
interface Rig {
  readonly meshes: RawMesh[];
  readonly materials: readonly GpuDrivenMaterial[];
  readonly distance: number;
  readonly pitch: number;
  readonly target: readonly [number, number, number];
  /** Toward the light. Defaults to `SUN`, which is where the other two rigs keep it. */
  readonly sun?: readonly [number, number, number];
  /**
   * A room to photograph into a reflection probe, drawn into the bake and never into the frame.
   *
   * **A rig that declares one gets an environment and a rig that does not gets nothing**, which is
   * what keeps the other two byte-identical: `reflectionProbeSize` stays at its default of zero
   * there, so no cube is allocated and `bakeReflectionProbe` answers false.
   *
   * The second pipeline reads the probe through `PrepareContext.environment`, which is the seam a
   * contributed pass has to the frame's own resources. It is the same probe the forward path would
   * light this scene with, which is the point: `?pipeline=forward` beside it is then two pipelines
   * reflecting one room.
   */
  readonly room?: RawMesh;
  /**
   * Material index to the encodings its `textures` were built from.
   *
   * **For the forward path, which cannot read a decode program**: `?pipeline=forward` decodes each
   * one to an ordinary image at every texel centre and binds it through `setMaterial`, which is
   * what makes it the reference for a textured frame of the second pipeline.
   */
  readonly textured?: ReadonlyMap<number, TexturedSource>;
}

/**
 * What a rig uploads: its meshes clustered into one scene, and one transform a mesh — a cluster
 * reaches its own through the mesh it came from. Exported so a test can ask what the pass will be
 * handed without a device.
 */
export function rigScene(rig: Rig): { scene: StreamingScene; transforms: Float32Array } {
  const transforms = new Float32Array(rig.meshes.length * 16);
  for (let m = 0; m < rig.meshes.length; m += 1) {
    const mesh = rig.meshes[m] as RawMesh;
    transforms.set(mesh.transform ?? IDENTITY, m * 16);
  }
  /*
   * **A scene filled once, which is what a static rig is.** `streamingScene` sizes its capacity to
   * exactly what these meshes need, so nothing is reserved for a mesh that will never arrive — and
   * the buffers it packs are byte for byte the ones `buildGpuDrivenScene` packed, which
   * `streamScene.test.ts` asserts and these rigs' captures are the picture of.
   */
  return { scene: streamingScene(rig.meshes.map(clustered), transforms), transforms };
}

/**
 * One mesh of a rig, as the three things `StreamingScene.add` wants.
 *
 * **Held rather than recomputed**, because a cycle puts a mesh back and putting it back has to
 * place it exactly where it was: the transform a rig hands out is the one `rigScene` wrote into the
 * transform array, and reading it from anywhere else is a second spelling that can disagree.
 */
export interface StreamEntry {
  readonly mesh: GpuDrivenMesh;
  readonly transform: Float32Array;
  readonly material: number;
}

/** Which third of the field a mesh belongs to, and the group a cycle takes out. */
const STREAM_GROUPS = 3;

/** Every mesh of a rig, clustered once, with the transform `rigScene` placed it by. */
export function streamEntries(rig: Rig, transforms: Float32Array): StreamEntry[] {
  return rig.meshes.map((mesh, at) => ({
    mesh: clustered(mesh),
    transform: transforms.subarray(at * 16, at * 16 + 16) as Float32Array,
    material: mesh.material,
  }));
}

/**
 * A scene with room for exactly these entries, and empty.
 *
 * **Empty rather than filled, because the handles are the point.** `rigScene` builds a scene by
 * calling `streamingScene`, which fills it and keeps its handles to itself — and a handle is where
 * a mesh's ranges are, which only `add` knows. A streamed rig fills its own scene through
 * `cycleStreamed`, so it holds them.
 *
 * **Exact capacity, no headroom.** A cycle only ever removes and re-adds the same meshes, so if
 * best fit cannot refit what it just released then fragmentation has bitten on a workload as gentle
 * as one can get — which is worth finding out rather than papering over, and is what
 * `scripts/stream-fragmentation.mjs` measures at a harder one.
 */
export function streamRoom(entries: readonly StreamEntry[]): StreamingScene {
  let vertices = 0;
  let indices = 0;
  let clusters = 0;
  for (const entry of entries) {
    vertices += entry.mesh.positions.length / 3;
    indices += entry.mesh.clusters.indices.length;
    clusters += entry.mesh.clusters.count;
  }
  return new StreamingScene({ vertices, indices, clusters, meshes: entries.length });
}

/**
 * One step of the cycle: the group this cycle names goes out, and every other group comes back.
 *
 * **A state rather than a step**, so asking for the same cycle twice changes nothing — which is
 * what lets a frame loop call it every frame without counting, and what makes a capture at a held
 * frame reproducible. A cycle below zero puts everything back, which is how a test asks for a full
 * scene.
 */
export function cycleStreamed(
  scene: StreamingScene,
  entries: readonly StreamEntry[],
  handles: (StreamHandle | null)[],
  cycle: number,
): void {
  const out = cycle < 0 ? -1 : cycle % STREAM_GROUPS;
  for (let at = 0; at < entries.length; at += 1) {
    const wanted = at % STREAM_GROUPS !== out;
    const handle = handles[at] ?? null;
    if (wanted && handle === null) {
      const entry = entries[at] as StreamEntry;
      handles[at] = scene.add(entry.mesh, entry.transform, entry.material);
    } else if (!wanted && handle !== null) {
      scene.remove(handle);
      handles[at] = null;
    }
  }
}

export function denseRig(): Rig {
  /* 708 cells is 1,002,528 triangles, which is the plan's "a dense mesh at a million". */
  return {
    meshes: [terrain(708, 20, 2.4, 0)],
    materials: [{ tint: [1, 1, 1], emissive: 0 }],
    distance: 34,
    pitch: 26,
    target: [0, 0, 0],
  };
}

/**
 * **The rig that stands somewhere, and it is the culling one on purpose.**
 *
 * Every box here is modelled at its own origin and placed by `RawMesh.transform`, which is the
 * same geometry as writing the centres into the vertices and is the only rig in the repository
 * that is not the identity. The wall goes further and is *turned*: it is built as a deep slab and
 * a quarter turn about y makes it the wide one, so the cone axis and the normals go through a
 * rotation as well as a translation.
 *
 * Why this rig rather than either of the other two: the bounds the transform fixes are read by the
 * frustum test, the cone test, the LOD cut and the occlusion test, and this is the rig built to
 * make the occlusion test decide something. With the untransformed bounds the pass uploaded until
 * 2026-09-17, every box in the field sits at the origin *inside the wall*, and phase two tests all
 * 196 of them against one rectangle in the middle of the frame.
 *
 * **It is the same picture either way**, which is what makes it a control: re-expressing a placed
 * box as a modelled box and a transform moves no vertex, so a capture of this scene against the
 * build before it is the measurement that says the transform is right.
 */
export function occlusionRig(): Rig {
  const meshes: RawMesh[] = [];
  /* The wall: one slab across the view, close to the eye and covering most of it. */
  meshes.push({
    ...box(0, 0, 0, 0.6, 5, 14, [0.42, 0.4, 0.44], 0),
    transform: placement(0, 4, 6, true),
  });
  /* The field: what the wall hides, and what phase two must decide about. */
  for (let z = 0; z < 14; z += 1) {
    for (let x = 0; x < 14; x += 1) {
      const height = 0.6 + ((x * 7 + z * 13) % 9) * 0.35;
      meshes.push({
        ...box(0, 0, 0, 0.7, height, 0.7, [0.55 + (x % 3) * 0.12, 0.42, 0.3 + (z % 4) * 0.1], 1),
        transform: placement((x - 6.5) * 2, height, -z * 2.2 - 2),
      });
    }
  }
  return {
    meshes,
    materials: [
      { tint: [1, 1, 1], emissive: 0 },
      { tint: [1, 1, 1], emissive: 0 },
    ],
    distance: 26,
    pitch: 12,
    target: [0, 3, 0],
  };
}

const MATERIAL_COUNT = 16;

/** Texels a side of every generated texture: a power of two, as the device array requires. */
const TEXTURE_SIZE = 64;

/** What the forward path decodes to images: the encodings a material's programs were built from. */
interface TexturedSource {
  readonly baseColour?: EncodedMaterial;
  readonly normal?: EncodedMaterial;
  readonly orm?: EncodedMaterial;
  /**
   * Tiles a metre, on both axes and both pipelines. A box's UVs are in metres, so this is how
   * much of the image one metre of surface shows — the rig is seen from thirty metres, where a
   * tile a metre is a pattern too fine to judge.
   */
  readonly scale: number;
}

function channel(
  semantic: ChannelInput['spec']['semantic'],
  component: number,
  value: (x: number, y: number) => number,
): ChannelInput {
  const data = new Float32Array(TEXTURE_SIZE * TEXTURE_SIZE);
  for (let y = 0; y < TEXTURE_SIZE; y += 1) {
    for (let x = 0; x < TEXTURE_SIZE; x += 1) data[y * TEXTURE_SIZE + x] = value(x, y);
  }
  return { spec: { semantic, component }, data };
}

/** Tiling, full resolution, centre-addressed: what a surface texture on the device wants. */
function encode(channels: readonly ChannelInput[]): EncodedMaterial {
  return encodeMaterial(channels, TEXTURE_SIZE, TEXTURE_SIZE, {
    quality: 1,
    addressMode: ADDRESS_MODE.CENTRE_WRAP,
  });
}

/** Squares of eight texels, two tones, and grout the ORM map darkens and roughens differently. */
function checker(): TexturedSource {
  const tone = (x: number, y: number): number => ((x >> 3) + (y >> 3)) & 1;
  return {
    /* A tile every eight metres, so a square is a metre. */
    scale: 0.125,
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
}

/** Courses of bricks with bevelled joints, so the normal map has somewhere to turn. */
function bricks(): TexturedSource {
  const inMortar = (x: number, y: number): boolean =>
    y % 16 < 2 || (x + ((y >> 4) & 1) * 16) % 32 < 2;
  const bevel = (offset: number): number => (offset === 2 ? 0.55 : offset === 31 ? -0.55 : 0);
  const nx = (x: number, y: number): number => bevel((x + ((y >> 4) & 1) * 16) % 32);
  const ny = (_x: number, y: number): number => bevel(y % 16 === 2 ? 2 : y % 16 === 15 ? 31 : 0);
  return {
    /* A tile every two metres, so a brick is a metre long and half a metre high. */
    scale: 0.5,
    baseColour: encode([
      channel('albedo-linear', 0, (x, y) => (inMortar(x, y) ? 0.7 : 0.55)),
      channel('albedo-linear', 1, (x, y) => (inMortar(x, y) ? 0.68 : 0.22)),
      channel('albedo-linear', 2, (x, y) => (inMortar(x, y) ? 0.64 : 0.15)),
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
}

/** A deterministic speckle, so the rig's pixels do not depend on a random seed. */
function speckle(): TexturedSource {
  const grain = (x: number, y: number): number => {
    let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1);
    h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
    return ((h ^ (h >>> 12)) >>> 0) / 0xffffffff;
  };
  return {
    /* A tile every two metres, so a grain is about three centimetres. */
    scale: 0.5,
    baseColour: encode([
      channel('albedo-linear', 0, (x, y) => 0.35 + 0.5 * grain(x, y)),
      channel('albedo-linear', 1, (x, y) => 0.4 + 0.4 * grain(x, y)),
      channel('albedo-linear', 2, (x, y) => 0.3 + 0.3 * grain(x, y)),
    ]),
  };
}

/**
 * An ordinary picture as a decode program: one instruction, and the picture is the operand.
 *
 * **This is the whole of what §6 of the design meant by "no second texture kind".** `SAMPLE_BLOCK`
 * is the decode vocabulary's passthrough — the slot a program reaches for when a network does not
 * help — and a block is raw bytes rather than a latent, so a program whose only node is one of
 * these *is* an image sampler. `scripts/gpu-parity.mjs` checks it against `decodeCpu` over 256
 * points on a 64 by 64 picture, corners and texel centres alike; this is the same thing in a frame.
 *
 * The mip chain is built here because the device's texture array wants every level: a picture with
 * only level 0 reads black wherever the pipeline asks for a coarser one, which on a surface seen
 * from thirty metres is most of it.
 */
function imageProgram(
  edge: number,
  texel: (x: number, y: number) => readonly [number, number, number, number],
): GpuDrivenProgram {
  const levels: Uint8Array[] = [new Uint8Array(edge * edge * 4)];
  for (let y = 0; y < edge; y += 1) {
    for (let x = 0; x < edge; x += 1) {
      const rgba = texel(x, y);
      for (let k = 0; k < 4; k += 1) {
        levels[0][(y * edge + x) * 4 + k] = Math.max(0, Math.min(255, Math.round(rgba[k] * 255)));
      }
    }
  }
  for (let size = edge >> 1; size >= 1; size >>= 1) {
    const from = levels[levels.length - 1] as Uint8Array;
    const wide = size * 2;
    const next = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        for (let k = 0; k < 4; k += 1) {
          let sum = 0;
          for (let dy = 0; dy < 2; dy += 1) {
            for (let dx = 0; dx < 2; dx += 1) {
              sum += from[((y * 2 + dy) * wide + (x * 2 + dx)) * 4 + k] as number;
            }
          }
          next[(y * size + x) * 4 + k] = Math.round(sum / 4);
        }
      }
    }
    levels.push(next);
  }
  return {
    graph: {
      nodes: Uint32Array.from([DECODE_OP.SAMPLE_BLOCK, 0, 0, 0]),
      count: 1,
      result: 0,
      addressMode: ADDRESS_MODE.CENTRE_WRAP,
    },
    latents: [],
    blocks: [{ width: edge, height: edge, components: 4, levels }],
    networks: [],
  };
}

function texturesOf(source: TexturedSource): GpuDrivenTextures {
  return {
    ...(source.baseColour === undefined
      ? {}
      : { baseColour: programFromEncoded(source.baseColour) }),
    ...(source.normal === undefined ? {} : { normal: programFromEncoded(source.normal) }),
    ...(source.orm === undefined ? {} : { orm: programFromEncoded(source.orm) }),
    uScale: source.scale,
    vScale: source.scale,
  };
}

export function materialsRig(): Rig {
  const meshes: RawMesh[] = [];
  /*
   * **The ground, and it is here because of what a shadow needs rather than what a material
   * shows.** Sixty-four boxes standing in the air is a fine rig for sixteen dispatches and a
   * useless one for a shadow map: the term was wired, checked against its reference on the device
   * and measured at **1,184 pixels of 921,600** — the slivers where one box clips another — which
   * is a picture nobody could tell from a bug. The boxes already stand at y = 0; this is the floor
   * they were standing on.
   *
   * Material 1, which is matte and does not glow: the emissive every fourth material carries would
   * light the floor from inside and the highlight every other one carries would put the sun's
   * reflection where the shadow is meant to be read.
   */
  meshes.push(box(0, -0.06, 0, 11, 0.06, 11, [0.52, 0.54, 0.56], 1));
  for (let i = 0; i < 64; i += 1) {
    const column = i % 8;
    const row = Math.floor(i / 8);
    meshes.push(
      box(
        (column - 3.5) * 2.4,
        1.2 + (row % 3) * 0.6,
        (row - 3.5) * 2.4,
        0.9,
        1.2 + (row % 3) * 0.6,
        0.9,
        [0.8, 0.8, 0.8],
        i % MATERIAL_COUNT,
      ),
    );
  }
  const materials: GpuDrivenMaterial[] = [];
  for (let m = 0; m < MATERIAL_COUNT; m += 1) {
    const angle = (m / MATERIAL_COUNT) * Math.PI * 2;
    materials.push({
      tint: [
        0.35 + 0.65 * (0.5 + 0.5 * Math.cos(angle)),
        0.35 + 0.65 * (0.5 + 0.5 * Math.cos(angle - 2.1)),
        0.35 + 0.65 * (0.5 + 0.5 * Math.cos(angle + 2.1)),
      ],
      /* Every fourth one glows, so the emissive term is read by something. */
      emissive: m % 4 === 0 ? 0.55 : 0,
      /*
       * **And every other one is shiny, so the highlight is read by something too.** Roughness runs
       * across the range the lobe is well behaved over — `lit.ts` records that below 0.1 the
       * forward path's own lobe gets *dimmer* as it gets smoother — so what this shows is a row of
       * surfaces from satin to matte with the sun in the same place on each.
       */
      roughness: 0.15 + (m % 8) * 0.1,
      specular: m % 2 === 0 ? 0.45 : 0,
      /*
       * **Every fourth material reflects the room, and the other three do not**, so one capture
       * carries both branches of the environment weight: a reflecting surface reads the probe and
       * a matte one is arithmetically the frame that shipped before the term existed.
       */
      reflectivity: m % 4 === 1 ? 0.9 : 0,
      /*
       * **And every fourth is a metal, with a reflectivity of zero, which is the point.** A metal's
       * environment weight is exactly 1 however the material is set — `max(reflectivity, metal)` —
       * so these reflect the room without ever asking to, which is the repair `gpudriven/ibl.ts`
       * records `flat/main.ts` paying for: a chromed subject came out near black with a baked probe
       * sitting unread because the block was gated on `reflectivity` alone.
       *
       * They are also the only surfaces in any rig whose highlight is their own colour rather than
       * the sun's, and the only ones that carry a `specular` and a reflection at once — which is
       * what makes them the first thing in the repository to exercise both sides of the
       * environment blend. §3 row 85.
       */
      metalness: m % 4 === 2 ? 1 : 0,
    });
  }
  /*
   * **Three textured materials, generated here and encoded when the rig is built**, so the
   * repository carries no images for it. The floor's material takes a checker with an ORM map,
   * one column of boxes takes bricks with a normal map, and one takes a speckle.
   *
   * **The bricks are glazed**: a specular of 0.45 where their material had none. A normal map
   * turns the highlight and widens the roughness it is read with — flat/main.ts's
   * `uNormalStrength * RELIEF_ROUGHNESS` — and on a surface with no highlight, no reflection and
   * no metal, neither of those is in the picture for the forward comparison to check.
   */
  const textured = new Map<number, TexturedSource>([
    [1, checker()],
    [3, bricks()],
    [7, speckle()],
  ]);
  for (const [m, source] of textured) {
    materials[m] = {
      ...(materials[m] as GpuDrivenMaterial),
      ...(m === 3 ? { specular: 0.45 } : {}),
      textures: texturesOf(source),
    };
  }

  /*
   * **Three more materials and three panels along the front of the rig, which are the only things
   * in the repository that exercise the cutout, the blend and a plain image.**
   *
   * They stand in front of the grid rather than among it, because each of the three is only legible
   * against something: a cutout has to have a hole you can see through, a blend has to have
   * something behind it, and a picture has to be big enough on screen to read as a picture. The
   * grid is what they stand against.
   */
  const CUTOUT = MATERIAL_COUNT;
  const BLEND = MATERIAL_COUNT + 1;
  const IMAGE = MATERIAL_COUNT + 2;
  const PANEL_EDGE = 64;

  /*
   * **A ring, because a hole is the thing a cutout has that a texture cannot fake.** Alpha is one
   * inside the band and zero outside it, and the `alphaCutoff` below is what turns that into
   * geometry the frame does not hold — so the boxes behind this panel are visible through it.
   */
  materials.push({
    tint: [1, 1, 1],
    emissive: 0,
    roughness: 0.6,
    specular: 0,
    alphaCutoff: 0.5,
    textures: {
      baseColour: imageProgram(PANEL_EDGE, (x, y) => {
        const dx = (x + 0.5) / PANEL_EDGE - 0.5;
        const dy = (y + 0.5) / PANEL_EDGE - 0.5;
        const r = Math.hypot(dx, dy);
        const inside = r > 0.18 && r < 0.42;
        return [0.95, 0.75, 0.25, inside ? 1 : 0];
      }),
      /*
       * **One tile across the whole panel**, because a box's UVs are in metres and the panel is
       * 5.2 by 6. At the default of one the ring repeats thirty times and reads as a mesh screen
       * rather than as a hole you can see the scene through, which is the thing being shown.
       */
      uScale: 1 / 5.2,
      vScale: 1 / 6,
    },
  });

  /*
   * **A pane at four tenths, standing in front of an opaque box.** Put anywhere else it would be
   * indistinguishable from transparency that draws nothing at all, which is the failure this rig
   * exists to make visible — the box behind it is the measurement.
   */
  materials.push({
    tint: [0.35, 0.65, 0.95],
    /*
     * **It glows a little, so it reads as glass rather than as absence.** The sun in this rig is on
     * the far side and the pane faces away from it, so at four tenths of a lit-by-ambient colour
     * the difference between a working blend and a pane that drew nothing at all is a few levels of
     * grey. A faint emission puts the surface in the picture while what is behind it still shows.
     */
    emissive: 0.35,
    roughness: 0.25,
    specular: 0.5,
    blend: true,
    opacity: 0.45,
  });

  /* An ordinary picture, as one `SAMPLE_BLOCK` instruction. See `imageProgram`. */
  materials.push({
    tint: [1, 1, 1],
    emissive: 0,
    roughness: 0.8,
    specular: 0,
    textures: {
      baseColour: imageProgram(PANEL_EDGE, (x, y) => {
        /* Concentric rings and a quadrant tint: wrong orientation and wrong scale both show. */
        const u = (x + 0.5) / PANEL_EDGE;
        const v = (y + 0.5) / PANEL_EDGE;
        const rings = 0.5 + 0.5 * Math.cos(Math.hypot(u - 0.5, v - 0.5) * 38);
        return [rings, u < 0.5 ? rings * 0.35 : rings, v < 0.5 ? rings : rings * 0.3, 1];
      }),
      /* One tile across the panel, as above, so a reader sees a picture rather than a pattern. */
      uScale: 1 / 5.2,
      vScale: 1 / 6,
    },
  });

  /*
   * **Thin slabs standing upright between the grid and the camera, spread across the frame.**
   *
   * The still eye of this rig stands at roughly x 17, y 15.6, z 20 looking at the origin — `RIG_YAW`
   * and the pitch put it in the corner where both axes are positive — so *nearer the camera* is
   * larger x and larger z, and **behind** a surface is smaller. The first placement of these got
   * that backwards and stood the solid box in front of the pane rather than behind it, which is a
   * blend with nothing to blend with and looks exactly like transparency that does not work.
   */
  meshes.push(box(-9, 3.4, 10, 2.6, 3, 0.1, [1, 1, 1], CUTOUT));
  meshes.push(box(-1, 3.4, 10, 2.6, 3, 0.1, [1, 1, 1], BLEND));
  meshes.push(box(7, 3.4, 10, 2.6, 3, 0.1, [1, 1, 1], IMAGE));
  /*
   * **Four metres further from the camera than the pane, and glowing**, so the blend has a colour
   * to blend with and that colour is unmistakable. Material 0 is the one that emits — the rig
   * already gives every fourth material an emissive gain — which is what carries it through a pane
   * at four tenths against a scene lit by one low sun.
   */
  meshes.push(box(-1, 3.4, 6, 1.8, 2, 0.6, [1, 1, 1], 0));

  return {
    meshes,
    materials,
    distance: 30,
    pitch: 28,
    target: [0, 1.5, 0],
    /*
     * **The sun on the far side, which is the difference between a shadow and no picture.** The
     * shared `SUN` stands behind the camera here, so every shadow falls behind the box that casts
     * it and the rig shows a working shadow map as an unchanged frame. Mirrored, the same sixty-four
     * boxes lay their shadows across the floor toward the viewer.
     */
    sun: [-0.4, 0.66, -0.35],
    textured,
    /*
     * **A room with four differently coloured walls, and the colours are the measurement.** A
     * reflection of a grey room is a grey surface, which is what the hemispheric gradient already
     * gives — so a probe that is working and a probe that is not look the same. Walls that differ
     * from each other mean a reflection carries *which way the surface faces*, which nothing else
     * in this pipeline can produce.
     *
     * Six slabs rather than an inverted box: `box` winds its faces outward, and back-face culling
     * means what a camera inside sees is the inner face of each slab. Only the probe's cameras are
     * ever inside it — the frame never draws this.
     */
    room: merge([
      box(0, 6, -14, 14, 8, 0.5, [0.85, 0.2, 0.15], 0),
      box(0, 6, 14, 14, 8, 0.5, [0.15, 0.3, 0.85], 0),
      box(-14, 6, 0, 0.5, 8, 14, [0.95, 0.85, 0.25], 0),
      box(14, 6, 0, 0.5, 8, 14, [0.2, 0.75, 0.35], 0),
      box(0, 14, 0, 14, 0.5, 14, [0.9, 0.9, 0.95], 0),
      box(0, -0.5, 0, 14, 0.5, 14, [0.25, 0.24, 0.23], 0),
    ]),
  };
}

/** Where the eye stands around the target, so all three rigs are photographed alike. */
/** Where the rigs' camera stands round the target, before any spin: exported for the tests. */
export const RIG_YAW = 0.7;

/** What a mesh that says nothing about where it stands is drawn with. */
const IDENTITY = placement(0, 0, 0);

/**
 * `?pipeline=forward` draws the same geometry through the engine's own verbs instead.
 *
 * **The comparison the plan asks for, and the only place it can be made.** The two pipelines draw
 * different frames — different rasterisation, a shading subset while this one is a draft — so the
 * number is a bound rather than an identity, and it is measured with `shots.mjs diff` across the
 * two spellings of one URL rather than asserted by a test that has no device. What a *test* can
 * hold is the part that can silently drift, and `gpudriven/parity.test.ts` holds it: the
 * reconstruction is the value the surface carries where the pixel looks.
 *
 * Read from the address bar for the reason `demo/dev/askedQuality.ts` gives about every other
 * knob: a control that needs a code change to move is a control nobody uses.
 */
function forwardAsked(search = typeof location === 'undefined' ? '' : location.search): boolean {
  return new URLSearchParams(search).get('pipeline') === 'forward';
}

/**
 * `?pitch=` moves the eye above or below the rig's own, in degrees.
 *
 * **It exists because "go under it and parts disappear" is a question no fixed capture can answer.**
 * Every shot of these rigs is taken from one place, so anything that only happens from another
 * place is outside the gate entirely — and the two pipelines can only be compared where both can
 * be photographed. A negative pitch puts the eye beneath the terrain, which is where a single-sided
 * surface stops being drawn and where a cull that dropped more than it should would show.
 *
 * Returns the rig's own pitch where the query says nothing or says something that is not a number.
 */
function pitchAsked(
  fallback: number,
  search = typeof location === 'undefined' ? '' : location.search,
): number {
  const asked = new URLSearchParams(search).get('pitch');
  if (asked === null) return fallback;
  const value = Number(asked);
  return Number.isFinite(value) ? value : fallback;
}

/**
 * `?spin=` turns the eye about the target, in degrees a second of the page's clock.
 *
 * **Every other capture of these rigs is taken from a camera that has not moved**, and the
 * two-phase cull is the part of this pipeline that only behaves differently when it has: phase one
 * trusts last frame's visibility, and a mistake there is a cluster missing for one frame. Under
 * `?hold=N` the clock advances exactly a sixtieth a frame, so frame N of a turn is the same frame in
 * every build, and two builds' captures of it are a comparison of what each drew in motion.
 *
 * Zero where the query says nothing or something that is not a number, which is the still eye.
 */
export function spinAsked(search = typeof location === 'undefined' ? '' : location.search): number {
  const asked = new URLSearchParams(search).get('spin');
  if (asked === null) return 0;
  const value = Number(asked);
  return Number.isFinite(value) ? value : 0;
}

/**
 * `?plain=1` strips reflectivity and metalness from every material on **both** pipelines.
 *
 * **What the forward comparison cannot hold, and nothing else.** The forward mesh carries a
 * material's specular and roughness per vertex, and its reflectivity per draw, so those stay in.
 * What goes is the metal scalar, which `drawMesh` has no way to carry, and the reflection both
 * would feed, whose forward footprint term this pipeline does not have — `shade.wgsl.ts` says so
 * where the level is picked. What is left is every term a texture enters, compared whole.
 */
function plainAsked(search = typeof location === 'undefined' ? '' : location.search): boolean {
  return new URLSearchParams(search).get('plain') === '1';
}

/**
 * `?stream=1` takes a third of the rig's meshes out and puts them back, on a cycle.
 *
 * **Add, remove and reuse are three code paths a unit test exercises over a stub and nothing
 * exercises over a driver**, which is what this is for: the buffers are really written, the cull
 * really rejects a released cluster, and the frame is really drawn. `streamScene.test.ts` holds the
 * arithmetic; this holds that a device agrees.
 *
 * Off by default, so every existing capture of these rigs is the frame it was.
 */
function streamAsked(search = typeof location === 'undefined' ? '' : location.search): boolean {
  return new URLSearchParams(search).get('stream') === '1';
}

/** Frames between one group going out and the next. Slow enough to see, fast enough to capture. */
const STREAM_PERIOD = 30;

/**
 * Which stream cycle a frame draws, counted in frames that moved the clock.
 *
 * **Counted in clock steps and not in calls, because a held capture keeps calling.** `?hold=N`
 * advances the clock N steps and stops it, and the harness goes on drawing — about five hundred
 * and seventy frames in the two and a half seconds a capture waits. Counted in calls, the cycle
 * went on turning through all of them, so a capture at `hold=121` photographed whichever cycle
 * the shutter happened to find, and two captures of one build differed by 119,157 pixels. A
 * running page steps the clock every frame, so there nothing changes.
 */
export class StreamCycle {
  private frames = 0;

  /** The cycle this frame draws; the frame is counted after it, if the clock moved. */
  step(dtSec: number): number {
    const cycle = Math.floor(this.frames / STREAM_PERIOD);
    if (dtSec > 0) this.frames += 1;
    return cycle;
  }
}

/**
 * A program decoded at every texel centre of level 0, as an image the forward path can bind.
 *
 * Level 0 only: the forward texture builds its own chain from this, and the bake's decode is
 * linear, so filtering decoded texels is decoding filtered latents up to the eight bits each
 * side rounds to.
 */
function decodedImage(encoded: EncodedMaterial): ImageData {
  const size = encoded.latentWidth;
  const image = new ImageData(size, size);
  const resources = {
    latents: [latentImageOf(encoded)],
    blocks: [],
    networks: [{ shape: encoded.shape, weights: encoded.weights }],
  };
  const value = new Float32Array(4);
  const registers = createDecodeRegisters();
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      registers.fill(0);
      decodeCpu(
        encoded.graph,
        resources,
        (x + 0.5) / size,
        (y + 0.5) / size,
        0,
        value,
        registers,
        0,
      );
      for (let c = 0; c < 4; c += 1) {
        image.data[(y * size + x) * 4 + c] =
          c === 3 ? 255 : Math.round(Math.min(1, Math.max(0, value[c] as number)) * 255);
      }
    }
  }
  return image;
}

class GpuDrivenHandle implements DemoHandle {
  private readonly renderer: RendererApi;
  private readonly canvas: HTMLCanvasElement;
  private readonly camera = new Camera();
  readonly view: OrbitView;
  private readonly pass: GpuDrivenPass | null;
  private readonly handle: PassHandle;
  /** One handle a mesh when `?pipeline=forward` asked for the engine's own verbs. */
  private readonly forward: MeshHandle[] = [];
  /** The matrix each of those is drawn with, so `?pipeline=forward` places what the pass places. */
  private readonly models: Float32Array[] = [];
  private readonly tints: Array<[number, number, number]> = [];
  /** Each forward mesh's reflectivity, which the forward path takes per draw rather than per vertex. */
  private readonly reflectivities: number[] = [];
  /** Each forward mesh's maps, or null, decoded from the programs its material names. */
  private readonly forwardMaterials: Array<SurfaceMaterial<SurfaceTextureHandle> | null> = [];
  /** One set of uploaded maps a textured material, so a map shared by many meshes is one image. */
  private readonly forwardByMaterial = new Map<number, SurfaceMaterial<SurfaceTextureHandle>>();
  private readonly forwardTextures: SurfaceTextureHandle[] = [];
  private readonly model = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  private readonly target: readonly [number, number, number];
  /** The eye's height above the target and its distance from it across the ground. */
  private readonly eyeY: number;
  private readonly eyeFlat: number;
  /** Radians a second, from `?spin=`, and the seconds this rig has been drawing. */
  private readonly spin: number;
  private elapsed = 0;
  private readonly stats: DemoStats;
  private readonly frameView: GpuDrivenView;
  /** The rig's own sky and light, which is `SKY` and `ENV` unless the rig moved the sun. */
  private readonly sky: SkyColors;
  private readonly env: Environment;
  /** The room this rig photographs into a probe, or null where it declared none. */
  private readonly room: MeshHandle | null = null;
  private probeBaked = false;
  private readonly matrix = new Float32Array(16);
  private disposed = false;
  /** `?stream=1`, and what it needs: the entries, their handles, and the frame counter. */
  private readonly streaming: boolean;
  private readonly scene: StreamingScene;
  private streamed: StreamEntry[] = [];
  private streamHandles: (StreamHandle | null)[] = [];
  private readonly cycle = new StreamCycle();

  get backend(): RenderBackend {
    return this.renderer.backend;
  }

  get lost(): boolean {
    return this.renderer.contextLost;
  }

  constructor(
    renderer: RendererApi,
    canvas: HTMLCanvasElement,
    rig: Rig,
    triangles: number,
    forward: boolean,
    shadows: boolean,
  ) {
    this.renderer = renderer;
    this.canvas = canvas;
    /*
     * **`OrbitView` takes bounds, not a placement**, which is the trap this rig fell into: the
     * constructor is `(minDistance, maxDistance, minHeight)` and `follow` *reads* the camera to
     * start a handover where the eye already is. Neither moves it. A scene that calls only those
     * two draws from wherever `new Camera()` left the eye — the origin — which for a field of
     * boxes standing around the origin is a strip of enormous faces and looks like a broken
     * projection rather than a camera nobody placed.
     */
    this.view = new OrbitView(rig.distance * 0.35, rig.distance * 3, 1);
    this.target = rig.target;

    const pitch = (pitchAsked(rig.pitch) * Math.PI) / 180;
    this.eyeFlat = Math.cos(pitch) * rig.distance;
    this.eyeY = rig.target[1] + Math.sin(pitch) * rig.distance;
    this.spin = (spinAsked() * Math.PI) / 180;

    const { scene: packed, transforms } = rigScene(rig);
    /*
     * **A streamed rig fills its own scene, because it needs the handles.** `rigScene` calls
     * `streamingScene`, which fills a scene and keeps its handles to itself — and a handle is where
     * a mesh's ranges are. `cycleStreamed(..., -1)` is "everything in", so the scene it produces
     * holds exactly what the packed one holds and the capture is unchanged with the flag off.
     */
    this.streaming = streamAsked();
    if (this.streaming) {
      this.streamed = streamEntries(rig, transforms);
      this.streamHandles = this.streamed.map(() => null);
      const room = streamRoom(this.streamed);
      cycleStreamed(room, this.streamed, this.streamHandles, -1);
      this.scene = room;
    } else {
      this.scene = packed;
    }
    const scene = this.scene;
    const materials = plainAsked()
      ? rig.materials.map((material) => ({ ...material, reflectivity: 0, metalness: 0 }))
      : rig.materials;
    if (forward) {
      /*
       * The same geometry through `createMesh`/`drawMesh`, with the material's tint, and its
       * emissive, specular and roughness as per-vertex constants — the lit expression's inputs the
       * forward mesh can carry — its reflectivity per draw, and its maps decoded to images. What
       * this cannot match is a metal scalar, which `?plain=1` removes from both.
       */
      for (const mesh of rig.meshes) {
        const material = materials[mesh.material] as GpuDrivenMaterial;
        const count = mesh.positions.length / 3;
        this.models.push(mesh.transform ?? IDENTITY);
        this.forward.push(
          renderer.createMesh({
            positions: mesh.positions,
            normals: mesh.normals,
            colors: mesh.colours,
            emissive: new Float32Array(count).fill(material.emissive),
            specular: new Float32Array(count).fill(material.specular ?? 0),
            roughness: new Float32Array(count).fill(material.roughness ?? 1),
            ...(mesh.uvs === undefined ? {} : { uvs: mesh.uvs }),
            indices: mesh.indices,
          }),
        );
        this.tints.push([material.tint[0], material.tint[1], material.tint[2]]);
        this.reflectivities.push(material.reflectivity ?? 0);
        const source = rig.textured?.get(mesh.material);
        this.forwardMaterials.push(
          source === undefined ? null : this.forwardMaterialOf(renderer, source, mesh.material),
        );
      }
      this.pass = null;
      this.handle = 0;
    } else {
      this.pass = new GpuDrivenPass(scene, materials);
      this.handle = renderer.registerPass(this.pass);
    }
    this.renderer.resize();

    if (rig.room !== undefined) {
      this.room = renderer.createMesh({
        positions: rig.room.positions,
        normals: rig.room.normals,
        colors: rig.room.colours,
        /* Lit by the scene's own ambient rather than emitting: a room that glows would put its
           own light into the bake and the surfaces reflecting it would read as sources. */
        emissive: new Float32Array(rig.room.positions.length / 3),
        indices: rig.room.indices,
      });
    }

    const sun = (rig.sun ?? SUN) as [number, number, number];
    this.sky = rig.sun === undefined ? SKY : { ...SKY, sunDir: sun };
    this.env =
      rig.sun === undefined
        ? ENV
        : createEnvironment({
            directionalDir: sun,
            directionalColor: [0.95, 0.9, 0.8],
            ambient: [0.22, 0.26, 0.34],
            ambientGround: [0.07, 0.06, 0.05],
            emissiveGain: 1,
            /*
             * **One, so the materials rig's glowing boxes glow on both pipelines.** The forward
             * path scales every emission by this, and at the shared `ENV`'s zero it lit nothing
             * while the second pipeline, which did not read it until 2026-09-17, lit all sixteen.
             * It gates nothing else in the flat shader; the sky reads its own.
             */
            nightFactor: 1,
            fogColor: [0.3, 0.36, 0.44],
            fogDensity: 0,
            fogHeightFalloff: 0.05,
            fogBaseY: 0,
          });

    this.frameView = {
      viewProj: this.matrix,
      eye: [0, 0, 0],
      /* No `time`: nothing this rig textures is animated, and the default is 0. */
      lightDir: sun,
      lightColour: [0.95, 0.9, 0.8],
      ambient: [0.22, 0.26, 0.34],
      ambientGround: [0.07, 0.06, 0.05],
      lodThreshold: 1.5,
      fovY: (this.camera.fovYDeg * Math.PI) / 180,
      /*
       * **`?dirshadows=0` turns it off here as it does on the forward path**, which is what makes
       * the two comparable in a capture: the same knob, the same scene, one pipeline each. Off is
       * exact rather than nearly — the lookup returns 1 before any arithmetic — so a frame with it
       * at zero is the frame these rigs drew before the map existed.
       */
      shadowStrength: shadows ? 1 : 0,
      /* The same two numbers the forward path scales every glow by, from the same environment. */
      emissiveGain: this.env.emissiveGain,
      nightFactor: this.env.nightFactor,
    } as GpuDrivenView;

    this.stats = {
      draws: 2,
      /* Filled from the pass's own timestamps each frame, or left at zero where the device was
         not asked for `timestamp-query` — which is `gpuTimer.ts`'s rule about unmeasured. */
      gpuMs: 0,
      /* The figure this rig exists to report, per `DemoStats.note`. */
      note: `${triangles.toLocaleString('en')} triangles in ${this.scene.liveClusters.toLocaleString('en')} clusters, ${rig.materials.length} material${rig.materials.length === 1 ? '' : 's'}`,
    } as DemoStats;
  }

  /**
   * A textured material's maps, decoded to images and uploaded once.
   *
   * **Isotropic, because the second pipeline is.** A forward surface texture takes four
   * anisotropic samples by default, and this pipeline's footprint is one level for both axes — a
   * reference that filtered better would measure the filter rather than the textures. The
   * difference is real and stated: at a grazing angle the forward default is sharper.
   */
  private forwardMaterialOf(
    renderer: RendererApi,
    source: TexturedSource,
    material: number,
  ): SurfaceMaterial<SurfaceTextureHandle> {
    const known = this.forwardByMaterial.get(material);
    if (known !== undefined) return known;
    const upload = (encoded: EncodedMaterial | undefined): SurfaceTextureHandle | null => {
      if (encoded === undefined) return null;
      const texture = renderer.createSurfaceTexture(decodedImage(encoded), {
        wrap: 'repeat',
        colorSpace: 'linear',
        anisotropy: 1,
      });
      this.forwardTextures.push(texture);
      return texture;
    };
    const built: SurfaceMaterial<SurfaceTextureHandle> = {
      albedo: upload(source.baseColour),
      normal: upload(source.normal),
      orm: upload(source.orm),
      uScale: source.scale,
      vScale: source.scale,
    };
    this.forwardByMaterial.set(material, built);
    return built;
  }

  frame(dtSec: number): DemoStats {
    if (this.disposed || this.renderer.contextLost) return this.stats;
    /*
     * **The cycle is a state rather than a step**, so calling it every frame with the same number
     * changes nothing — which is what makes a capture at a held frame reproducible.
     */
    if (this.streaming) {
      cycleStreamed(this.scene, this.streamed, this.streamHandles, this.cycle.step(dtSec));
    }
    if (this.view.taken) {
      this.view.place(this.camera);
    } else {
      const yaw = RIG_YAW + this.spin * this.elapsed;
      this.camera.position[0] = this.target[0] + Math.sin(yaw) * this.eyeFlat;
      this.camera.position[1] = this.eyeY;
      this.camera.position[2] = this.target[2] + Math.cos(yaw) * this.eyeFlat;
      this.camera.lookAt(this.target[0], this.target[1], this.target[2]);
      this.view.follow(this.camera, this.target[0], this.target[1], this.target[2]);
    }
    this.camera.updateMatrices(this.canvas.height > 0 ? this.canvas.width / this.canvas.height : 1);
    this.matrix.set(this.camera.viewProjection);
    const eye = this.frameView.eye as [number, number, number];
    eye[0] = this.camera.position[0] as number;
    eye[1] = this.camera.position[1] as number;
    eye[2] = this.camera.position[2] as number;

    /*
     * **Once, and before `beginFrame`, because a bake is six passes over the room.** The probe is
     * the frame's, not the pass's: `PrepareContext.environment` is how the second pipeline reaches
     * it, and the forward comparison beside it reads the same one through its own lit shader.
     */
    if (!this.probeBaked && this.room !== null) {
      this.probeBaked = true;
      this.renderer.bakeReflectionProbe(
        [0, 3, 0],
        [0.05, 0.07, 0.1],
        (probeCamera: Camera): void => {
          this.renderer.bindMeshPass(probeCamera, this.env);
          this.renderer.drawMesh(this.room as MeshHandle, this.model);
        },
      );
    }

    /*
     * Before `beginFrame`, because that is when `prepare` records the whole pipeline.
     *
     * **The scene's size and not the canvas's**, which are the same number until a reconstruction
     * is enlarging the frame. A pass that fills its own target at the drawing buffer's size and
     * presents it into a smaller scene target has the frame pass clip it to the corner, and the
     * composite then magnifies that corner over the whole screen — a plausible picture of the
     * wrong part of the world, which no device raises anything about.
     */
    if (this.pass !== null) {
      this.pass.resize(this.renderer.sceneWidth, this.renderer.sceneHeight);
      this.pass.setView(this.frameView);
    }

    this.renderer.beginFrame([0.05, 0.07, 0.1]);
    this.renderer.bindMeshPass(this.camera, this.env);
    this.renderer.drawSky(this.camera, this.sky, this.env);
    if (this.pass === null) {
      for (let i = 0; i < this.forward.length; i += 1) {
        this.renderer.setSurfaceReflectivity(this.reflectivities[i] as number);
        this.renderer.setMaterial(this.forwardMaterials[i] ?? null);
        this.renderer.drawMesh(
          this.forward[i] as MeshHandle,
          this.models[i] as Float32Array,
          0,
          this.tints[i],
        );
      }
      this.renderer.setMaterial(null);
      this.renderer.setSurfaceReflectivity(0);
    } else {
      this.renderer.drawPass(this.handle);
    }
    this.renderer.endFrame();
    this.elapsed += dtSec;
    this.stats.gpuMs = this.pass?.totalMs ?? 0;
    /*
     * The shading stage alone, under ?gputiming=1 where the device reports stages at all. It is
     * the number the textured pipeline's cost is judged by, so it is on the line a capture prints.
     */
    const shade = this.pass?.stageTime('shade') ?? null;
    /* And the culling, which is what an instance cull is judged by: all three stages that cull. */
    let cull = 0;
    for (const stage of ['instanceCull', 'cut', 'phaseTwoCull'] as const) {
      cull += this.pass?.stageTime(stage) ?? 0;
    }
    /*
     * **And the transparent half, which is the wave's own cost claim.** Three stages: the cut's
     * second run, the blended draw and the resolve. A scene with no blended material records none
     * of them and every one reads zero, which is the reading to expect on the other two rigs.
     */
    let blend = 0;
    for (const stage of ['blendCull', 'blendDraw', 'blendResolve'] as const) {
      blend += this.pass?.stageTime(stage) ?? 0;
    }
    this.stats.extra =
      shade === null
        ? undefined
        : `shade ${shade.toFixed(2)} ms · cull ${cull.toFixed(3)} ms · blend ${blend.toFixed(3)} ms`;
    return this.stats;
  }

  resize(): void {
    this.renderer.resize();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.pass !== null) this.renderer.unregisterPass(this.handle);
    if (this.room !== null) this.renderer.disposeMesh(this.room);
    for (const mesh of this.forward) this.renderer.disposeMesh(mesh);
    for (const texture of this.forwardTextures) this.renderer.disposeSurfaceTexture(texture);
    this.renderer.dispose();
  }
}

export async function mountRig(
  canvas: HTMLCanvasElement,
  overrides: RenderQualityOptions,
  build: () => Rig,
): Promise<DemoHandle> {
  const rig = build();
  let triangles = 0;
  for (const mesh of rig.meshes) triangles += mesh.indices.length / 3;
  /*
   * **Both halves of the request.** The option fails at boot where the backend cannot run this,
   * which is the message a consumer should get rather than a forward frame with nothing in it;
   * the pass is what draws. `preferWebGpu` is implicit — it is the default — and `splash: false`
   * is here for the reason `demo/backend.ts` gives.
   */
  const forward = forwardAsked();
  const { renderer } = await createRenderer(
    canvas,
    /*
     * **`reflectionProbeSize` only where a rig declared a room**, so the two that did not are
     * untouched: at its default of zero no cube is allocated at all and `bakeReflectionProbe`
     * answers false. 256 is what `showroom` bakes at.
     */
    { ...overrides, ...(rig.room === undefined ? {} : { reflectionProbeSize: 256 }) },
    /* No `pipeline` where the comparison asked for the first one: selecting `gpu-driven` and then
       drawing with the engine's verbs would be a scene claiming a pipeline it is not using. */
    forward ? { splash: false } : { splash: false, pipeline: 'gpu-driven' },
  );
  await renderer.ready();
  /*
   * `directionalShadows` is the forward path's own knob and `?dirshadows=0` is what sets it, so
   * the second pipeline reads the same one rather than inventing a second spelling of one switch.
   */
  return new GpuDrivenHandle(
    renderer,
    canvas,
    rig,
    triangles,
    forward,
    overrides.directionalShadows ?? true,
  );
}
