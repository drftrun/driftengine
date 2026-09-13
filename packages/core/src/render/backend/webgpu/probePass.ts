import { FULLSCREEN_VERT_WGSL } from '../../shaders/generated/fullscreen.wgsl.ts';
import { PREFILTER_BINDINGS, PREFILTER_FRAG_WGSL } from '../../shaders/generated/prefilter.wgsl.ts';
import type { PipelineCache } from './pipelineCache.ts';
import { shaderModule } from './shaderModules.ts';

/**
 * The room, captured into a cubemap so reflective surfaces can mirror it.
 *
 * `reflectionProbe.ts` carries the argument for the feature: a reflection is an improvement to
 * an appearance rather than a requirement, the scene still renders without one, and a device
 * that cannot afford six faces keeps everything else.
 *
 * **Two things differ from the other backend and both are the same difference.** WebGPU has no
 * `generateMipmap`, and the chain here *is* the roughness — a polished surface samples level 0
 * and a satin one samples further up, which is a blur that costs a fetch rather than a pass. So
 * the chain is built by rendering each level from the one above it, six faces at a time, with a
 * blit that samples a **cube** rather than a 2D texture.
 */

/** Where each face looks, in the order a cubemap's layers are indexed. */
export const PROBE_FACES: readonly { readonly yaw: number; readonly pitch: number }[] = [
  { yaw: Math.PI / 2, pitch: 0 },
  { yaw: -Math.PI / 2, pitch: 0 },
  { yaw: 0, pitch: Math.PI / 2 },
  { yaw: 0, pitch: -Math.PI / 2 },
  /*
   * **`+Z` is yaw `PI`, not yaw 0, and these two were the wrong way round.**
   *
   * `Camera`'s convention is that yaw 0 looks toward **-Z** and positive yaw turns toward +X, so
   * cubemap layer 4, which the hardware reads as +Z, has to be rendered from yaw `PI`. This table
   * had layer 4 at yaw 0, which put the -Z view in the +Z slot and the +Z view in the -Z slot —
   * and it contradicted `PROBE_FACE_BASIS` in this same file, which has always said layer 4 is
   * `forward: [0, 0, 1]`. `reflectionProbe.ts`'s table on the other backend has always been right.
   *
   * **It survived because a reflection of a swapped pair still looks like a reflection.** What
   * finally separated them was projecting both backends' cubes onto spherical harmonics with one
   * shared basis: every coefficient agreed except the linear Z, which came back +0.005 on one and
   * -0.003 on the other. A sign, on the one axis these two faces span.
   */
  { yaw: Math.PI, pitch: 0 },
  { yaw: 0, pitch: 0 },
];

export const PROBE_FOV_DEG = 90;
export const PROBE_NEAR_M = 0.1;
export const PROBE_FAR_M = 200;

/**
 * The blur that fills one mip level of one face from the level above.
 *
 * **Directions, not texture coordinates.** A cube level cannot be filled by sampling the 2D
 * face above it: the neighbouring texels across an edge belong to a different face, and taking
 * them from the same face is exactly how a seam appears along every edge. So the fragment
 * rebuilds the direction its texel stands for and samples the cube, which crosses edges the way
 * the hardware does when the shader reads it later.
 */
const PROBE_MIP_WGSL = `
struct Face { basisX: vec4<f32>, basisY: vec4<f32>, forward: vec4<f32>, level: vec4<f32> }
@group(0) @binding(0) var<uniform> face: Face;
@group(0) @binding(1) var source: texture_cube<f32>;
@group(0) @binding(2) var samp: sampler;

struct Varying {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
}

@vertex
fn vertexMain(@builtin(vertex_index) index: u32) -> Varying {
  var out: Varying;
  let x = f32((index << 1u) & 2u);
  let y = f32(index & 2u);
  out.uv = vec2<f32>(x, y);
  out.position = vec4<f32>(x * 2.0 - 1.0, 1.0 - y * 2.0, 0.0, 1.0);
  return out;
}

@fragment
fn fragmentMain(in: Varying) -> @location(0) vec4<f32> {
  // The texel's place on the face, in [-1, 1], and the direction it stands for.
  let plane = in.uv * 2.0 - 1.0;
  let dir = normalize(face.forward.xyz + face.basisX.xyz * plane.x + face.basisY.xyz * plane.y);
  return textureSampleLevel(source, samp, dir, face.level.x);
}
`;

/** `basisX`, `basisY`, `forward`, `level` — four vec4s, so one aligned block. */
export const PROBE_MIP_UNIFORM_SIZE = 64;

/**
 * The axes of each cube face, as the direction of its centre and its two in-plane steps.
 *
 * Written out rather than derived from the yaw and pitch above, because a cube's face basis has
 * a handedness convention that a camera does not: getting one sign wrong mirrors a single face
 * of the blur and shows up as one edge of a reflection that does not line up.
 */
export const PROBE_FACE_BASIS: readonly {
  readonly forward: readonly [number, number, number];
  readonly basisX: readonly [number, number, number];
  readonly basisY: readonly [number, number, number];
}[] = [
  { forward: [1, 0, 0], basisX: [0, 0, -1], basisY: [0, -1, 0] },
  { forward: [-1, 0, 0], basisX: [0, 0, 1], basisY: [0, -1, 0] },
  { forward: [0, 1, 0], basisX: [1, 0, 0], basisY: [0, 0, 1] },
  { forward: [0, -1, 0], basisX: [1, 0, 0], basisY: [0, 0, -1] },
  { forward: [0, 0, 1], basisX: [1, 0, 0], basisY: [0, -1, 0] },
  { forward: [0, 0, -1], basisX: [-1, 0, 0], basisY: [0, -1, 0] },
];

export function createProbeMipBindGroupLayout(device: GPUDevice): GPUBindGroupLayout {
  return device.createBindGroupLayout({
    label: 'probe.mipLayout',
    entries: [
      {
        binding: 0,
        visibility: 0x1 | 0x2,
        buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: PROBE_MIP_UNIFORM_SIZE },
      },
      { binding: 1, visibility: 0x2, texture: { viewDimension: 'cube' } },
      { binding: 2, visibility: 0x2, sampler: {} },
    ],
  });
}

export function probeMipPipeline(
  cache: PipelineCache,
  device: GPUDevice,
  layout: GPUBindGroupLayout,
  format: GPUTextureFormat,
): GPURenderPipeline {
  return cache.get(`probe.mip:${format}`, () => {
    const module = shaderModule(device, { label: 'probe.mip', code: PROBE_MIP_WGSL });
    return {
      label: `probe.mip:${format}`,
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
      vertex: { module, entryPoint: 'vertexMain' },
      fragment: { module, entryPoint: 'fragmentMain', targets: [{ format }] },
      primitive: { topology: 'triangle-list' as const },
    };
  });
}

/** How many levels a cube of this size has, counting the one the bake fills. */
export function probeLevels(size: number): number {
  return Math.floor(Math.log2(size)) + 1;
}

/**
 * The convolution's bind group, whose numbering is the generator's rather than this file's.
 *
 * **It cannot share `probe.mipLayout` and the reason is worth stating.** That layout was written
 * by hand and numbered 0, 1, 2. The prefilter's WGSL is generated from GLSL, and the transform
 * assigns its own numbers — the uniform block at 1 and a combined sampler split into a texture at
 * 32 and a sampler at 33. Reusing the hand-written layout would be a pipeline whose bind group
 * does not match its shader, which WebGPU reports at `finish` rather than at the call that caused
 * it, as no picture from a frame that recorded correctly.
 *
 * The numbers are read from `PREFILTER_BINDINGS` rather than written again here, so the generator
 * moving one cannot leave this silently wrong.
 */
export function createProbePrefilterBindGroupLayout(device: GPUDevice): GPUBindGroupLayout {
  const bindings = PREFILTER_BINDINGS.PREFILTER_FRAG;
  const source = bindings.textures.uPrefilterSource;
  return device.createBindGroupLayout({
    label: 'probe.prefilterLayout',
    entries: [
      {
        binding: bindings.uniforms,
        visibility: 0x1 | 0x2,
        buffer: {
          type: 'uniform',
          hasDynamicOffset: true,
          minBindingSize: PROBE_MIP_UNIFORM_SIZE,
        },
      },
      { binding: source.texture, visibility: 0x2, texture: { viewDimension: 'cube' } },
      { binding: source.sampler, visibility: 0x2, sampler: {} },
    ],
  });
}

/**
 * Where each field lands in the convolution's uniform block, from the generator's own table.
 *
 * Restating these as literals at the write site is how a struct layout and its writer drift, and
 * the drift is invisible: a roughness written at the wrong offset is a level convolved for some
 * other roughness, which looks like a plausible reflection.
 */
export const PREFILTER_UNIFORM_OFFSETS = PREFILTER_BINDINGS.PREFILTER_FRAG.fields;

/** The generator's binding numbers, named once so a bind group and its layout cannot disagree. */
export const PREFILTER_UNIFORM_BINDING = PREFILTER_BINDINGS.PREFILTER_FRAG.uniforms;
export const PREFILTER_TEXTURE_BINDING =
  PREFILTER_BINDINGS.PREFILTER_FRAG.textures.uPrefilterSource.texture;
export const PREFILTER_SAMPLER_BINDING =
  PREFILTER_BINDINGS.PREFILTER_FRAG.textures.uPrefilterSource.sampler;

export function probePrefilterPipeline(
  cache: PipelineCache,
  device: GPUDevice,
  layout: GPUBindGroupLayout,
  format: GPUTextureFormat,
): GPURenderPipeline {
  return cache.get(`probe.prefilter:${format}`, () => ({
    label: `probe.prefilter:${format}`,
    layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
    vertex: {
      module: shaderModule(device, { label: 'probe.prefilter.vert', code: FULLSCREEN_VERT_WGSL }),
      entryPoint: 'main',
    },
    fragment: {
      module: shaderModule(device, { label: 'probe.prefilter', code: PREFILTER_FRAG_WGSL }),
      entryPoint: 'main',
      targets: [{ format }],
    },
    primitive: { topology: 'triangle-list' as const, cullMode: 'none' as const },
  }));
}
