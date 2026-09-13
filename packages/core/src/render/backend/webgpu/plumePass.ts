import { DEPTH_COMPARE } from '../../depthConvention.ts';
import type { Vec3 } from '../../../math/color.ts';
import { PLUME_VERTS } from '../../plumeGeometry.ts';
import { plumeShaders, type PlumeMaterial } from '../../plumeMaterial.ts';
import { ARCANE_BINDINGS } from '../../shaders/generated/arcane.wgsl.ts';
import { FIRE_BINDINGS } from '../../shaders/generated/fire.wgsl.ts';
import { SMOKE_BINDINGS } from '../../shaders/generated/smoke.wgsl.ts';
import { DEPTH_FORMAT } from './flatPass.ts';
import type { PipelineCache } from './pipelineCache.ts';
import type { UniformFields } from './scatterPass.ts';
import { shaderModule } from './shaderModules.ts';

/**
 * The plume pass: crossed quads per plume, displaced and faded in the shaders.
 *
 * **Two blend modes and one geometry.** A flame adds light and smoke occludes it, which is the
 * `PlumeBlend` the options carry; everything else about the two is the fragment stage. Neither
 * writes depth — a soft quad that did would punch a hole in whatever came after it.
 */

/** The vertex stage is shared by every plume material; only the fragment differs. */
export const PLUME_VERT_FIELDS: UniformFields = FIRE_BINDINGS.PLUME_VERT.fields;
export const PLUME_VERT_SIZE = FIRE_BINDINGS.PLUME_VERT.uniformSize;

/*
 * **The blocks are not all the same shape, and the widest one sizes the binding.**
 *
 * Fire and smoke are 128 bytes over the same fourteen fields. Arcane is 144 over the same
 * fourteen plus `uTint`, at the same offsets for the shared ones — which is asserted below
 * rather than assumed, because a generator that moved one would put a field where this writer
 * does not look.
 *
 * **Sizing this to fire's block is a pipeline that does not build.** Measured on an RX 9070 XT
 * through radv, against the device rather than the specification: *"The shader uses more bytes
 * of the buffer (144) than the layout's minBindingSize (128)"*, raised while validating
 * `@group(0) @binding(1)`. That lands on `createRenderPipeline`, so by the 2026-08-14 rule the
 * cost is not a wrong picture, it is no picture — the arcane plumes simply never draw and the
 * command buffer they were recorded into dies with them. A binding wider than a shader needs is
 * valid in the other direction, so one size serves all three.
 */
export const PLUME_FRAG_FIELDS: UniformFields = ARCANE_BINDINGS.ARCANE_FRAG.fields;
export const PLUME_FRAG_SIZE = Math.max(
  FIRE_BINDINGS.FIRE_FRAG.uniformSize,
  SMOKE_BINDINGS.SMOKE_FRAG.uniformSize,
  ARCANE_BINDINGS.ARCANE_FRAG.uniformSize,
);

const VERT_BINDING = FIRE_BINDINGS.PLUME_VERT.uniforms;
const FRAG_BINDING = FIRE_BINDINGS.FIRE_FRAG.uniforms;

/** Each material's own block, so a change to one and not the others is caught rather than assumed. */
export const FIRE_FRAG_SIZE = FIRE_BINDINGS.FIRE_FRAG.uniformSize;
export const SMOKE_FRAG_SIZE = SMOKE_BINDINGS.SMOKE_FRAG.uniformSize;
export const ARCANE_FRAG_SIZE = ARCANE_BINDINGS.ARCANE_FRAG.uniformSize;

const VISIBILITY_VERTEX = 0x1;
const VISIBILITY_FRAGMENT = 0x2;
const USAGE_VERTEX = 0x0020 | 0x0008;
const USAGE_INDEX = 0x0010 | 0x0008;

/** `aCenter`, `aCorner`, `aSize`, `aSeed`, `aBlade` — one buffer each, as the GL path holds them. */
const ATTRIBUTES: readonly { location: number; floats: number }[] = [
  { location: 0, floats: 3 },
  { location: 1, floats: 2 },
  { location: 2, floats: 2 },
  { location: 3, floats: 1 },
  { location: 4, floats: 1 },
];

const FORMATS: Readonly<Record<number, GPUVertexFormat>> = {
  1: 'float32',
  2: 'float32x2',
  3: 'float32x3',
};

export function plumeVertexLayouts(): GPUVertexBufferLayout[] {
  return ATTRIBUTES.map((a) => ({
    arrayStride: a.floats * 4,
    stepMode: 'vertex' as const,
    attributes: [
      { shaderLocation: a.location, offset: 0, format: FORMATS[a.floats] as GPUVertexFormat },
    ],
  }));
}

/** Plume geometry on the device, behind the surface's opaque handle. */
export interface GpuPlumes {
  readonly vertexBuffers: readonly GPUBuffer[];
  readonly indexBuffer: GPUBuffer;
  readonly indexCount: number;
  readonly material: PlumeMaterial;
  readonly blend: 'additive' | 'alpha';
  readonly sizePulse: number;
  readonly windResponse: number;
  /**
   * Colour handed to the fragment stage as `uTint`, white when the caller named none.
   *
   * **Held per batch because it is a batch's property, and written on every draw because the
   * block comes out of a ring.** `PlumeRenderer` has carried this since before the second
   * backend and this path dropped it on the floor: `createPlumes` never read `options.tint`,
   * so the one material that reads the uniform would have drawn with a tint of zero — which,
   * being additive, is not a wrong colour but an invisible one.
   */
  readonly tint: Vec3;
  /**
   * Scale one plume, 0 to hide it. See `PlumeRenderer.setScale`, which this mirrors.
   *
   * Writes only that plume's own vertices, so turning a slick's fire on costs a handful of
   * floats rather than a re-upload of the batch.
   */
  setScale(index: number, scale: number): void;
  dispose(): void;
}

/** The five attribute streams a plume batch is built from, already laid out by the caller. */
export interface PlumeGeometry {
  readonly centers: Float32Array;
  readonly corners: Float32Array;
  readonly sizes: Float32Array;
  readonly seeds: Float32Array;
  readonly blades: Float32Array;
  readonly indices: Uint32Array;
}

export function createGpuPlumes(
  device: GPUDevice,
  geometry: PlumeGeometry,
  material: PlumeMaterial,
  blend: 'additive' | 'alpha',
  sizePulse: number,
  windResponse: number,
  tint: Vec3,
): GpuPlumes {
  const buffers: GPUBuffer[] = [];
  const streams: readonly Float32Array[] = [
    geometry.centers,
    geometry.corners,
    geometry.sizes,
    geometry.seeds,
    geometry.blades,
  ];
  for (let i = 0; i < streams.length; i++) {
    const data = streams[i] as Float32Array;
    const buffer = device.createBuffer({
      label: `plume.attr${i}`,
      size: Math.max(4, data.byteLength),
      usage: USAGE_VERTEX,
    });
    device.queue.writeBuffer(buffer, 0, data);
    buffers.push(buffer);
  }
  const indexBuffer = device.createBuffer({
    label: 'plume.indices',
    size: Math.max(4, geometry.indices.byteLength),
    usage: USAGE_INDEX,
  });
  device.queue.writeBuffer(indexBuffer, 0, geometry.indices);

  /*
   * The sizes are kept on the CPU as well as uploaded, and the originals beside them, because
   * `setScale` multiplies the *base* size rather than the current one — scaling a scaled plume
   * would compound, and a slick cycling on and off would shrink to nothing.
   */
  const sizes = Float32Array.from(geometry.sizes);
  const baseSizes = Float32Array.from(geometry.sizes);
  const sizeBuffer = buffers[2] as GPUBuffer;

  return {
    vertexBuffers: buffers,
    indexBuffer,
    indexCount: geometry.indices.length,
    material,
    blend,
    sizePulse,
    windResponse,
    tint,
    setScale(index: number, scale: number): void {
      const span = PLUME_VERTS * 2;
      const base = index * span;
      if (base < 0 || base + span > sizes.length) return;
      const width = baseSizes[index * 2] ?? 0;
      const height = baseSizes[index * 2 + 1] ?? 0;
      for (let c = 0; c < PLUME_VERTS; c++) {
        sizes[base + c * 2] = width * scale;
        sizes[base + c * 2 + 1] = height * scale;
      }
      device.queue.writeBuffer(sizeBuffer, base * 4, sizes, base, span);
    },
    dispose(): void {
      for (const b of buffers) b.destroy();
      indexBuffer.destroy();
    },
  };
}

export function createPlumeBindGroupLayout(device: GPUDevice): GPUBindGroupLayout {
  return device.createBindGroupLayout({
    label: 'plume.layout',
    entries: [
      /*
       * **Both blocks are per draw, and that is a bug fix rather than a precaution.**
       * `sizePulse` and `windResponse` belong to the batch, not the frame — a flame is
       * `0.12` and the smoke above it `1.35` — and a scene draws both in one pass. With one
       * buffer per block the second `writeBuffer` won for both draws, so the flame was bent
       * by the smoke's wind response: a fire leaning forty degrees in still air, on a scene
       * whose every other surface matched to the byte. See `UniformRing`.
       */
      {
        binding: VERT_BINDING,
        visibility: VISIBILITY_VERTEX,
        buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: PLUME_VERT_SIZE },
      },
      {
        binding: FRAG_BINDING,
        visibility: VISIBILITY_FRAGMENT,
        buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: PLUME_FRAG_SIZE },
      },
    ],
  });
}

/** Both buffers are rings; the slot each draw takes arrives as a dynamic offset. */
export function createPlumeBindGroup(
  device: GPUDevice,
  layout: GPUBindGroupLayout,
  vertices: GPUBuffer,
  fragments: GPUBuffer,
): GPUBindGroup {
  return device.createBindGroup({
    label: 'plume.bindGroup',
    layout,
    entries: [
      { binding: VERT_BINDING, resource: { buffer: vertices, size: PLUME_VERT_SIZE } },
      { binding: FRAG_BINDING, resource: { buffer: fragments, size: PLUME_FRAG_SIZE } },
    ],
  });
}

/**
 * The blend each material wants.
 *
 * **Additive keeps the source alpha out of the destination factor** — a flame is light added
 * to what is behind it, and multiplying that by one-minus-alpha would make a bright flame
 * darken the wall behind it. Alpha is the ordinary over-operator smoke wants.
 */
function blendState(blend: 'additive' | 'alpha'): GPUBlendState {
  return blend === 'additive'
    ? {
        color: { srcFactor: 'src-alpha', dstFactor: 'one', operation: 'add' },
        alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' },
      }
    : {
        color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
        alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
      };
}

/**
 * The pipeline for one material and blend.
 *
 * **Depth tested, never written.** These are soft quads drawn after the opaque scene; writing
 * depth would let a puff occlude something behind it that should have shown through.
 */
export function plumePipeline(
  cache: PipelineCache,
  device: GPUDevice,
  layout: GPUBindGroupLayout,
  material: PlumeMaterial,
  blend: 'additive' | 'alpha',
): GPURenderPipeline {
  const shaders = plumeShaders(material);
  return cache.get(`plume:${material}:${blend}`, () => ({
    label: `plume:${material}`,
    layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
    vertex: {
      module: shaderModule(device, { label: 'plume.vert', code: shaders.vertexWgsl }),
      entryPoint: 'main',
      buffers: plumeVertexLayouts(),
    },
    fragment: {
      module: shaderModule(device, {
        label: `plume.frag:${material}`,
        code: shaders.fragmentWgsl,
      }),
      entryPoint: 'main',
      targets: [{ format: cache.format, blend: blendState(blend) }],
    },
    primitive: { topology: 'triangle-list', cullMode: 'none' },
    multisample: { count: cache.sampleCount },
    depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: false, depthCompare: DEPTH_COMPARE },
  }));
}
