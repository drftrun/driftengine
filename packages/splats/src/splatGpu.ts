/** The WebGPU half of the splat pass: the same two integer textures, one pipeline, no vertex state. */

import {
  SPLAT_BINDINGS,
  SPLAT_FRAG_WGSL,
  SPLAT_VERT_WGSL,
} from './shaders/generated/splat.wgsl.ts';
import { SPLAT_STRIDE, splatRowSource, splatRows, splatTexels } from './splatLayout.ts';
import type { SplatData } from './splatData.ts';

/*
 * The usage and stage bits as literals, which is the convention every WebGPU pass in core follows:
 * `GPUTextureUsage` and friends are runtime globals and this package typechecks against a lib that
 * does not declare them, so naming the numbers is the honest form and the comment is the decoder.
 */
const TEXTURE_BINDING_COPY_DST = 0x04 | 0x02;
const UNIFORM_COPY_DST = 0x0040 | 0x0008;
const STAGE_VERTEX = 0x1;
const STAGE_FRAGMENT = 0x2;

const VERT = SPLAT_BINDINGS.SPLAT_VERT;
const FRAG = SPLAT_BINDINGS.SPLAT_FRAG;

export interface GpuSplats {
  readonly pipeline: GPURenderPipeline;
  readonly bindGroup: GPUBindGroup;
  readonly vertexUniforms: GPUBuffer;
  readonly fragmentUniforms: GPUBuffer;
  readonly data: GPUTexture;
  readonly order: GPUTexture;
  readonly rows: number;
  /** Two, or three for a capture with view-dependent colour. See `splatTexels`. */
  readonly texels: number;
  /**
   * Scratch for one uniform write, so a frame allocates nothing — **including the views**.
   *
   * A `new Float32Array(buffer)` is a view rather than a copy and reads as free, and it is not: it
   * is an object allocated in the frame loop, once per uniform block per frame, which is exactly
   * what the house rule forbids. Both views of each block are made here, at construction, and the
   * pass writes through them.
   */
  readonly vertexScratch: ArrayBuffer;
  readonly vertexFloats: Float32Array;
  readonly vertexInts: Int32Array;
  readonly fragmentScratch: ArrayBuffer;
  readonly fragmentFloats: Float32Array;
  readonly fragmentInts: Int32Array;
}

/**
 * Build the pipeline, the two textures and the bind group.
 *
 * **An explicit bind group layout rather than `layout: 'auto'`, and the reason is the samplers.**
 * The GLSL declares `usampler2D`, so the transform splits each into a texture and a sampler and
 * naga emits both — even though the shader only ever calls `textureLoad`. An unused sampler still
 * has to be bound, and `auto` would infer a **filtering** sampler for it. A `u32` texture is not
 * filterable in core WebGPU, and binding a filtering sampler beside one is a validation failure
 * that takes the whole bind group with it — the same trap `AGENTS.md` records against `r32float`.
 * Declaring the layout says `non-filtering` and `uint`, which is what these are.
 */
export function createGpuSplats(
  device: GPUDevice,
  format: GPUTextureFormat,
  depthFormat: GPUTextureFormat,
  samples: number,
  splats: SplatData,
  label: string,
): GpuSplats {
  const rows = splatRows(splats.count);
  const texels = splatTexels(splats.wordsPerSplat);

  const data = device.createTexture({
    label: `${label}.data`,
    size: { width: SPLAT_STRIDE * texels, height: rows },
    format: 'rgba32uint',
    usage: TEXTURE_BINDING_COPY_DST,
  });
  const order = device.createTexture({
    label: `${label}.order`,
    size: { width: SPLAT_STRIDE, height: rows },
    format: 'r32uint',
    usage: TEXTURE_BINDING_COPY_DST,
  });

  /*
   * `bytesPerRow` is the **source** stride, and `writeTexture` does not convert: handing it data
   * of a different width than the row it is filling is a legal layout that reinterprets bytes.
   * `AGENTS.md` records that costing a session, so the upload is padded to the full rectangle and
   * the stride is stated from the format's own texel size.
   */
  const padded = new Uint32Array(SPLAT_STRIDE * texels * rows * 4);
  padded.set(splats.packed.subarray(0, Math.min(splats.packed.length, padded.length)));
  device.queue.writeTexture(
    { texture: data },
    padded,
    { bytesPerRow: SPLAT_STRIDE * texels * 16, rowsPerImage: rows },
    { width: SPLAT_STRIDE * texels, height: rows },
  );

  const vertexUniforms = device.createBuffer({
    label: `${label}.vertexUniforms`,
    size: VERT.uniformSize,
    usage: UNIFORM_COPY_DST,
  });
  const fragmentUniforms = device.createBuffer({
    label: `${label}.fragmentUniforms`,
    size: FRAG.uniformSize,
    usage: UNIFORM_COPY_DST,
  });

  const sampler = device.createSampler({
    label: `${label}.sampler`,
    /* Never sampled — declared because the GLSL said `usampler2D`. Non-filtering because a `u32`
       texture cannot be filtered, and saying otherwise is the validation failure above. */
    magFilter: 'nearest',
    minFilter: 'nearest',
  });

  const layout = device.createBindGroupLayout({
    label: `${label}.layout`,
    entries: [
      { binding: VERT.uniforms, visibility: STAGE_VERTEX, buffer: { type: 'uniform' } },
      { binding: FRAG.uniforms, visibility: STAGE_FRAGMENT, buffer: { type: 'uniform' } },
      {
        binding: VERT.textures.uSplatData.texture,
        visibility: STAGE_VERTEX,
        texture: { sampleType: 'uint' },
      },
      {
        binding: VERT.textures.uSplatData.sampler,
        visibility: STAGE_VERTEX,
        sampler: { type: 'non-filtering' },
      },
      {
        binding: VERT.textures.uSplatOrder.texture,
        visibility: STAGE_VERTEX,
        texture: { sampleType: 'uint' },
      },
      {
        binding: VERT.textures.uSplatOrder.sampler,
        visibility: STAGE_VERTEX,
        sampler: { type: 'non-filtering' },
      },
    ],
  });

  const bindGroup = device.createBindGroup({
    label: `${label}.bindGroup`,
    layout,
    entries: [
      { binding: VERT.uniforms, resource: { buffer: vertexUniforms } },
      { binding: FRAG.uniforms, resource: { buffer: fragmentUniforms } },
      { binding: VERT.textures.uSplatData.texture, resource: data.createView() },
      { binding: VERT.textures.uSplatData.sampler, resource: sampler },
      { binding: VERT.textures.uSplatOrder.texture, resource: order.createView() },
      { binding: VERT.textures.uSplatOrder.sampler, resource: sampler },
    ],
  });

  const pipeline = device.createRenderPipeline({
    label,
    layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
    vertex: {
      module: device.createShaderModule({ label: `${label}.vert`, code: SPLAT_VERT_WGSL }),
      entryPoint: 'main',
    },
    fragment: {
      module: device.createShaderModule({ label: `${label}.frag`, code: SPLAT_FRAG_WGSL }),
      entryPoint: 'main',
      targets: [
        {
          format,
          /* Premultiplied `over`, matching the WebGL2 half exactly. */
          blend: {
            color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          },
        },
      ],
    },
    primitive: { topology: 'triangle-list' },
    multisample: { count: samples },
    /* Tested, never written: a wall in front occludes the capture, and a Gaussian has no surface
       to occlude with, so a cloud that wrote depth would cull its own tail. */
    depthStencil: { format: depthFormat, depthWriteEnabled: false, depthCompare: 'less' },
  });

  const vertexScratch = new ArrayBuffer(VERT.uniformSize);
  const fragmentScratch = new ArrayBuffer(FRAG.uniformSize);

  return {
    pipeline,
    bindGroup,
    vertexUniforms,
    fragmentUniforms,
    data,
    order,
    rows,
    texels,
    vertexScratch,
    vertexFloats: new Float32Array(vertexScratch),
    vertexInts: new Int32Array(vertexScratch),
    fragmentScratch,
    fragmentFloats: new Float32Array(fragmentScratch),
    fragmentInts: new Int32Array(fragmentScratch),
  };
}

/**
 * Upload a run of splats that has just arrived, and nothing else.
 *
 * Whole rows, for the reason `uploadWebgl2SplatRange` gives at length: `writeTexture` takes a
 * rectangle, a row is 1,024 splats, and rounding out to row boundaries costs at most 32 KB
 * re-sent per block against a second code path for partial rows.
 */
export function uploadGpuSplatRange(
  device: GPUDevice,
  splats: GpuSplats,
  packed: Uint32Array,
  from: number,
  count: number,
): void {
  if (count <= 0) return;
  const firstRow = Math.floor(from / SPLAT_STRIDE);
  const lastRow = Math.floor((from + count - 1) / SPLAT_STRIDE);
  const rows = lastRow - firstRow + 1;
  /* Shared with the WebGL2 half rather than written twice: a short tail is a validation failure
     on this backend and a silently skipped upload on that one, and one of them had the guard. */
  const source = splatRowSource(packed, firstRow, rows, splats.texels * 4);
  device.queue.writeTexture(
    { texture: splats.data, origin: { x: 0, y: firstRow } },
    source,
    { bytesPerRow: SPLAT_STRIDE * splats.texels * 16, rowsPerImage: rows },
    { width: SPLAT_STRIDE * splats.texels, height: rows },
  );
}

/** Upload a new draw order. Four bytes a splat, into storage allocated once. */
export function uploadGpuOrder(
  device: GPUDevice,
  splats: GpuSplats,
  order: Uint32Array,
  padded: Uint32Array,
): void {
  padded.set(order.subarray(0, Math.min(order.length, padded.length)));
  device.queue.writeTexture(
    { texture: splats.order },
    padded,
    { bytesPerRow: SPLAT_STRIDE * 4, rowsPerImage: splats.rows },
    { width: SPLAT_STRIDE, height: splats.rows },
  );
}

export function disposeGpuSplats(splats: GpuSplats): void {
  splats.data.destroy();
  splats.order.destroy();
  splats.vertexUniforms.destroy();
  splats.fragmentUniforms.destroy();
}
