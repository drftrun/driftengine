import { DEPTH_COMPARE } from '../../depthConvention.ts';
import {
  SCATTER_BINDINGS,
  SCATTER_DEPTH_VERT_WGSL,
  SCATTER_FRAG_WGSL,
  SCATTER_VERT_WGSL,
} from '../../shaders/generated/scatter.wgsl.ts';
import type { MeshData } from '../../mesh.ts';
import { DEPTH_FORMAT } from './flatPass.ts';
import type { PipelineCache } from './pipelineCache.ts';
import { shaderModule } from './shaderModules.ts';

/**
 * The scatter pass: one base mesh drawn many times, deformed by wind in the vertex stage.
 *
 * **The first pass here that instances**, and the whole reason it is worth porting early: a
 * field of grass is tens of thousands of copies of a few triangles, and everything else this
 * backend draws is one copy of one mesh. The WebGPU shape of it is `stepMode: 'instance'` on
 * a vertex buffer, which is `vertexAttribDivisor(location, 1)` with the divisor moved from
 * the attribute to the buffer that carries it.
 */

/** One field's place in the block, as the generator recorded it. See `flatPass.StageBindings`. */
export type UniformFields = Readonly<
  Record<
    string,
    {
      readonly offset: number;
      readonly size: number;
      readonly length?: number;
      readonly stride?: number;
    }
  >
>;

/*
 * Widened once here, for the reason `flatPass.ts` gives: the generated file is `as const`, so
 * every field is its own literal type and indexing it by a computed name is an error. Checked
 * against the real object rather than asserted about it — a generator that stopped emitting
 * `offset` would fail on this line.
 */
export const SCATTER_DEPTH_FIELDS: UniformFields = SCATTER_BINDINGS.SCATTER_DEPTH_VERT.fields;
export const SCATTER_DEPTH_SIZE = SCATTER_BINDINGS.SCATTER_DEPTH_VERT.uniformSize;
export const SCATTER_VERT_FIELDS: UniformFields = SCATTER_BINDINGS.SCATTER_VERT.fields;
export const SCATTER_VERT_SIZE = SCATTER_BINDINGS.SCATTER_VERT.uniformSize;
export const SCATTER_FRAG_FIELDS: UniformFields = SCATTER_BINDINGS.SCATTER_FRAG.fields;
export const SCATTER_FRAG_SIZE = SCATTER_BINDINGS.SCATTER_FRAG.uniformSize;

const VERT_BINDING = SCATTER_BINDINGS.SCATTER_VERT.uniforms;
const FRAG_BINDING = SCATTER_BINDINGS.SCATTER_FRAG.uniforms;

const VISIBILITY_VERTEX = 0x1;
const VISIBILITY_FRAGMENT = 0x2;

/** Buffer usage: VERTEX | COPY_DST, and INDEX | COPY_DST. See `buffers.ts`. */
const USAGE_VERTEX = 0x0020 | 0x0008;
const USAGE_INDEX = 0x0010 | 0x0008;

/**
 * How the seven attributes are laid out, one buffer each.
 *
 * **Seven buffers rather than the two `flat` uses, and that is affordable here.**
 * `maxVertexBuffers` is eight; `flat` interleaves because it declares ten attributes and
 * would not fit. Seven does, and one buffer per attribute is what `InstancedMesh` already
 * holds on the other backend, so the upload paths stay the same shape.
 *
 * The last four step per *instance*. That is the entire difference between a field of grass
 * and one blade drawn tens of thousands of times in the same place.
 */
const ATTRIBUTES: readonly {
  readonly location: number;
  readonly floats: number;
  readonly perInstance: boolean;
}[] = [
  { location: 0, floats: 3, perInstance: false },
  { location: 1, floats: 3, perInstance: false },
  { location: 2, floats: 3, perInstance: false },
  { location: 3, floats: 3, perInstance: true },
  { location: 4, floats: 2, perInstance: true },
  { location: 5, floats: 3, perInstance: true },
  { location: 6, floats: 3, perInstance: true },
];

const FORMATS: Readonly<Record<number, GPUVertexFormat>> = {
  2: 'float32x2',
  3: 'float32x3',
};

export function scatterVertexLayouts(): GPUVertexBufferLayout[] {
  return ATTRIBUTES.map((attribute) => ({
    arrayStride: attribute.floats * 4,
    stepMode: attribute.perInstance ? ('instance' as const) : ('vertex' as const),
    attributes: [
      {
        shaderLocation: attribute.location,
        offset: 0,
        format: FORMATS[attribute.floats] as GPUVertexFormat,
      },
    ],
  }));
}

/** Geometry and placement on the device, behind the opaque handle the surface hands out. */
export interface GpuScatter {
  readonly vertexBuffers: readonly GPUBuffer[];
  readonly indexBuffer: GPUBuffer;
  readonly indexCount: number;
  /** How many instances the per-instance buffers were sized for. */
  readonly capacity: number;
  dispose(): void;
}

/**
 * Upload a base mesh and size the per-instance buffers.
 *
 * **Sized to capacity now and rewritten later**, matching `InstancedMesh`: growing a buffer
 * mid-frame is a stall, and a scatter's capacity is known when it is built.
 */
export function createGpuScatter(device: GPUDevice, base: MeshData, capacity: number): GpuScatter {
  const buffers: GPUBuffer[] = [];
  const upload = (data: Float32Array, label: string): GPUBuffer => {
    const buffer = device.createBuffer({
      label,
      size: Math.max(4, data.byteLength),
      usage: USAGE_VERTEX,
    });
    device.queue.writeBuffer(buffer, 0, data);
    buffers.push(buffer);
    return buffer;
  };
  upload(base.positions, 'scatter.positions');
  upload(base.normals, 'scatter.normals');
  upload(base.colors, 'scatter.colors');

  for (const attribute of ATTRIBUTES.filter((a) => a.perInstance)) {
    const buffer = device.createBuffer({
      label: `scatter.instance${attribute.location}`,
      size: Math.max(4, capacity * attribute.floats * 4),
      usage: USAGE_VERTEX,
    });
    buffers.push(buffer);
  }

  const indexBuffer = device.createBuffer({
    label: 'scatter.indices',
    size: Math.max(4, base.indices.byteLength),
    usage: USAGE_INDEX,
  });
  device.queue.writeBuffer(indexBuffer, 0, base.indices);

  return {
    vertexBuffers: buffers,
    indexBuffer,
    indexCount: base.indices.length,
    capacity,
    dispose(): void {
      for (const buffer of buffers) buffer.destroy();
      indexBuffer.destroy();
    },
  };
}

export function createScatterBindGroupLayout(device: GPUDevice): GPUBindGroupLayout {
  return device.createBindGroupLayout({
    label: 'scatter.layout',
    entries: [
      /*
       * **The vertex block is per draw and the fragment block is not.**
       *
       * The vertex block carries the gust and the trample field, and both arrive as arguments
       * to `drawScatter` — so a scene bending its grass by one press field and its canopy by
       * another gets whichever was written last for both, from a single buffer. That is not
       * hypothetical elsewhere: the plume pass had exactly this and drew a flame bent by the
       * smoke's wind response. The demo that exercises this today happens to pass both
       * batches the same wind and no trample, which is luck rather than a guarantee.
       *
       * The fragment block holds the camera, the sun, the point lights and the medium, which
       * are settled per pass rather than per batch. It stops being safe the day something
       * per-batch is added to it, and that is what would make this a ring too.
       */
      {
        binding: VERT_BINDING,
        visibility: VISIBILITY_VERTEX,
        buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: SCATTER_VERT_SIZE },
      },
      {
        binding: FRAG_BINDING,
        visibility: VISIBILITY_FRAGMENT,
        buffer: { type: 'uniform', minBindingSize: SCATTER_FRAG_SIZE },
      },
    ],
  });
}

export function createScatterBindGroup(
  device: GPUDevice,
  layout: GPUBindGroupLayout,
  perPass: GPUBuffer,
  perFrame: GPUBuffer,
): GPUBindGroup {
  return device.createBindGroup({
    label: 'scatter.bindGroup',
    layout,
    entries: [
      { binding: VERT_BINDING, resource: { buffer: perPass, size: SCATTER_VERT_SIZE } },
      { binding: FRAG_BINDING, resource: { buffer: perFrame, size: SCATTER_FRAG_SIZE } },
    ],
  });
}

/**
 * The scatter *depth* pipeline: the same blades, bent the same way, into the shadow map.
 *
 * **It has to be the same deformation or the shadow comes loose from its caster.** The
 * vertex stage is `SCATTER_DEPTH_VERT` rather than the frame's, but it reads the same wind
 * block at the same offsets, so the two are fed from one `resolveScatterDeform`. A blade
 * bent by one gust and shadowed by another is the failure this pairing exists to prevent —
 * and it is why `ShadowCasterSink.scatter` takes the gust rather than looking it up.
 *
 * Paired with `DEPTH_FRAG`, exactly as `renderer.ts` pairs `scatterDepthProgram`.
 *
 * Single-sampled and no colour target: the shadow map is neither multisampled nor presented.
 */
export function scatterDepthPipeline(
  cache: PipelineCache,
  device: GPUDevice,
  layout: GPUBindGroupLayout,
  shadowFormat: GPUTextureFormat,
  depthFragment: string,
): GPURenderPipeline {
  return cache.get('scatter.depth', () => ({
    label: 'scatter.depth',
    layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
    vertex: {
      module: shaderModule(device, {
        label: 'scatter.depthVert',
        code: SCATTER_DEPTH_VERT_WGSL,
      }),
      entryPoint: 'main',
      buffers: scatterVertexLayouts(),
    },
    fragment: {
      module: shaderModule(device, { label: 'depth.frag', code: depthFragment }),
      entryPoint: 'main',
      targets: [],
    },
    primitive: { topology: 'triangle-list', cullMode: 'none' },
    /*
     * **`less`, not the frame's `DEPTH_COMPARE`, because a shadow map is not reversed.**
     * `depthConvention.ts` says so in as many words: the cascades are orthographic, where depth
     * is already linear and a float buffer gains nothing, so `SHADOW_DEPTH_CLEAR` is 1 and
     * `beginShadowPass` clears to 1. This pipeline took the scene's compare, which under
     * `REVERSED_DEPTH` is `greater` — and a fragment at depth 0.3 tested with `greater` against a
     * map cleared to 1 fails. **Nothing was ever written**, so a scatter batch cast no shadow at
     * all on this backend: no error, no warning, an ordinary-looking frame.
     *
     * `depthPass.ts` has had `'less'` for the mesh path all along, which is why meshes cast and
     * scatter did not, and why it took a scene whose only caster is a scatter batch to show it.
     * `demo/windField.ts` is that scene — turning directional shadows off there changed 2,628
     * pixels on WebGL2 and 0 on WebGPU.
     */
    depthStencil: { format: shadowFormat, depthWriteEnabled: true, depthCompare: 'less' },
  }));
}

/**
 * The scatter pipeline.
 *
 * **Culling off, matching `renderer.ts`.** It brackets the scatter draw with
 * `gl.disable(gl.CULL_FACE)`, because a blade of grass is a flat card with no back: cull it
 * and half the field vanishes depending on which way the wind turned it.
 */
export function scatterPipeline(
  cache: PipelineCache,
  device: GPUDevice,
  layout: GPUBindGroupLayout,
): GPURenderPipeline {
  return cache.get('scatter', () => ({
    label: 'scatter',
    layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
    vertex: {
      module: shaderModule(device, { label: 'scatter.vert', code: SCATTER_VERT_WGSL }),
      entryPoint: 'main',
      buffers: scatterVertexLayouts(),
    },
    fragment: {
      module: shaderModule(device, { label: 'scatter.frag', code: SCATTER_FRAG_WGSL }),
      entryPoint: 'main',
      targets: [{ format: cache.format }],
    },
    primitive: { topology: 'triangle-list', cullMode: 'none' },
    multisample: { count: cache.sampleCount },
    depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: true, depthCompare: DEPTH_COMPARE },
  }));
}

/**
 * The layout the scatter depth pass binds against.
 *
 * The vertex block is the scatter one — wind and trample — and the fragment block and its
 * previous-map sampler are the depth pass's own, unchanged, because the peel layer works the
 * same way whatever geometry is filling it.
 *
 * **`hasDynamicOffset` on the vertex block, and it is a bug fix rather than a shape.** That
 * block used to be one buffer rewritten before every batch, which is the failure `UniformRing`
 * exists for: writes are ordered on the queue timeline and the encoder is submitted afterwards,
 * so every scatter draw recorded before that submit reads the *last* write. Inside one
 * directional layer that costs a batch the wrong gust. Inside a point light's bake it costs the
 * wrong `uLightViewProj`, because six cube faces share one encoder — so a field of grass was
 * rasterised into all six faces under the last face's projection, and five sixths of it landed
 * in the octahedral map at directions nothing occupies. What that draws is a hard-edged patch of
 * shadow on the ground beside a lamp with nothing above it to cast one.
 */
export function createScatterDepthBindGroupLayout(
  device: GPUDevice,
  fragBinding: number,
  fragSize: number,
  previous: { texture: number; sampler: number },
): GPUBindGroupLayout {
  return device.createBindGroupLayout({
    label: 'scatter.depthLayout',
    entries: [
      {
        binding: VERT_BINDING,
        visibility: VISIBILITY_VERTEX,
        buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: SCATTER_DEPTH_SIZE },
      },
      {
        binding: fragBinding,
        visibility: VISIBILITY_FRAGMENT,
        buffer: { type: 'uniform', minBindingSize: fragSize },
      },
      /* A depth format, for the reason `depthPass.ts` spells out over its own copy of this. */
      {
        binding: previous.texture,
        visibility: VISIBILITY_FRAGMENT,
        texture: { sampleType: 'unfilterable-float' },
      },
      {
        binding: previous.sampler,
        visibility: VISIBILITY_FRAGMENT,
        sampler: { type: 'non-filtering' },
      },
    ],
  });
}

/** `perDraw` is a `UniformRing`'s buffer now, bound one slot at a time. See the layout above. */
export function createScatterDepthBindGroup(
  device: GPUDevice,
  layout: GPUBindGroupLayout,
  perDraw: GPUBuffer,
  frag: { binding: number; buffer: GPUBuffer; size: number },
  previous: { texture: number; sampler: number },
  view: GPUTextureView,
  sampler: GPUSampler,
): GPUBindGroup {
  return device.createBindGroup({
    label: 'scatter.depthBindGroup',
    layout,
    entries: [
      { binding: VERT_BINDING, resource: { buffer: perDraw, size: SCATTER_DEPTH_SIZE } },
      { binding: frag.binding, resource: { buffer: frag.buffer, size: frag.size } },
      { binding: previous.texture, resource: view },
      { binding: previous.sampler, resource: sampler },
    ],
  });
}
