import { DEPTH_COMPARE } from '../../depthConvention.ts';
import { particleShaders, type ParticleMaterial } from '../../particleMaterial.ts';
import { PARTICLE_BINDINGS } from '../../shaders/generated/particle.wgsl.ts';
import { PARTICLE_BLADES, PARTICLE_INDICES, PARTICLE_VERTS } from '../../shaders/particle.ts';
import type { ParticleInstances } from '../../particlePool.ts';
import type { ParticleBlend, ParticleFacing } from '../../particleBatch.ts';
import { DEPTH_FORMAT } from './flatPass.ts';
import type { PipelineCache } from './pipelineCache.ts';
import type { UniformFields } from './scatterPass.ts';
import { shaderModule } from './shaderModules.ts';

/**
 * The particle pass: a crossed pair of quads per live particle, rebuilt every frame.
 *
 * **The one pass here whose per-instance data changes entirely every frame**, which is what
 * separates it from `scatter`: foliage is placed once and never touched, and a particle system
 * has nothing that survives a tick.
 */

export const PARTICLE_VERT_FIELDS: UniformFields = PARTICLE_BINDINGS.PARTICLE_VERT.fields;
export const PARTICLE_VERT_SIZE = PARTICLE_BINDINGS.PARTICLE_VERT.uniformSize;

const VERT_BINDING = PARTICLE_BINDINGS.PARTICLE_VERT.uniforms;
const FRAG_BINDING = PARTICLE_BINDINGS.PARTICLE_SMOKE_FRAG.uniforms;

/** Each material's own fragment block; the three are very different sizes. */
export function particleFragBindings(material: ParticleMaterial): {
  fields: UniformFields;
  size: number;
} {
  const stage =
    material === 'spark'
      ? PARTICLE_BINDINGS.PARTICLE_SPARK_FRAG
      : material === 'mote'
        ? PARTICLE_BINDINGS.PARTICLE_MOTE_FRAG
        : PARTICLE_BINDINGS.PARTICLE_SMOKE_FRAG;
  return { fields: stage.fields as UniformFields, size: stage.uniformSize };
}

const VISIBILITY_VERTEX = 0x1;
const VISIBILITY_FRAGMENT = 0x2;
const USAGE_VERTEX = 0x0020 | 0x0008;
const USAGE_INDEX = 0x0010 | 0x0008;
const USAGE_UNIFORM_DST = 0x0040 | 0x0008;

/**
 * Ten attributes and eight slots, so the per-instance eight share one buffer.
 *
 * **`maxVertexBuffers` is eight and this shader declares ten inputs**, so something has to
 * interleave. The per-instance streams are the ones that do: the engine holds them as eight
 * separate arrays and they are packed into one interleaved buffer per frame, which is a copy
 * the upload was already paying per stream rather than new work.
 *
 * Floats per instance, in the order they are packed: position 3, size 1, spin 1, colour 3,
 * alpha 1, age 1, seed 1, velocity 3.
 */
const INSTANCE_FLOATS = 14;

const INSTANCE_ATTRIBUTES: GPUVertexAttribute[] = [
  { shaderLocation: 2, offset: 0, format: 'float32x3' },
  { shaderLocation: 3, offset: 12, format: 'float32' },
  { shaderLocation: 4, offset: 16, format: 'float32' },
  { shaderLocation: 5, offset: 20, format: 'float32x3' },
  { shaderLocation: 6, offset: 32, format: 'float32' },
  { shaderLocation: 7, offset: 36, format: 'float32' },
  { shaderLocation: 8, offset: 40, format: 'float32' },
  { shaderLocation: 9, offset: 44, format: 'float32x3' },
];

export function particleVertexLayouts(): GPUVertexBufferLayout[] {
  return [
    {
      /* The cross itself: two floats of corner and one of blade index, built once. */
      arrayStride: 12,
      stepMode: 'vertex',
      attributes: [
        { shaderLocation: 0, offset: 0, format: 'float32x2' },
        { shaderLocation: 1, offset: 8, format: 'float32' },
      ],
    },
    {
      arrayStride: INSTANCE_FLOATS * 4,
      stepMode: 'instance',
      attributes: INSTANCE_ATTRIBUTES,
    },
  ];
}

/** A particle pool on the device, behind the surface's opaque handle. */
export interface GpuParticles {
  readonly corners: GPUBuffer;
  readonly instances: GPUBuffer;
  readonly indexBuffer: GPUBuffer;
  readonly capacity: number;
  readonly material: ParticleMaterial;
  readonly blend: ParticleBlend;
  readonly stretchSec: number;
  /** One camera-facing quad, or the world-fixed cross. See `ParticleBatchOptions.facing`. */
  readonly facing: ParticleFacing;
  readonly erosion: number;
  readonly coreGain: number;
  /** Whether the mote fragment stage mixes toward the medium. Ignored by the other materials. */
  readonly fog: boolean;
  /** Reused every frame; see `packInstances`. */
  readonly staging: Float32Array;
  /**
   * This batch's own uniform buffers, staging and bind group — never shared with another
   * batch of the same material. See the note on `createGpuParticles` for why: two pools of one
   * material legitimately want different `fog`/`erosion`/`coreGain`, and a buffer shared
   * between them would let one draw's `writeBuffer` overwrite what the other's draw call reads.
   */
  readonly vertUniforms: GPUBuffer;
  readonly fragUniforms: GPUBuffer;
  readonly vertStaging: ArrayBuffer;
  readonly vertFloats: Float32Array;
  readonly fragStaging: ArrayBuffer;
  readonly fragFloats: Float32Array;
  readonly fragInts: Int32Array;
  readonly fields: UniformFields;
  readonly bindGroup: GPUBindGroup;
  dispose(): void;
}

/**
 * **Every batch gets its own uniform buffers and bind group, not one shared per material.**
 *
 * They used to be shared, cached once per material and reused by every batch that named it —
 * fine on WebGL2, where `gl.uniform*` and `gl.draw*` run synchronously in call order, so a
 * shared uniform location always holds the value the draw right after it wrote. WebGPU's
 * queue has no such guarantee across *two draws in one frame*: every `drawParticles` call here
 * records into the same open encoder and calls `device.queue.writeBuffer` immediately, but the
 * encoder is not submitted until `endFrame`, so every `writeBuffer` targeting one shared buffer
 * completes before the submitted command buffer runs at all — by the time any of that buffer's
 * draws execute on the GPU, the buffer holds only the *last* JS-side write, not the value each
 * draw call thought it was setting. Two `'mote'` batches in one frame — a near field left
 * `fog` unset and a far one at `{ fog: true }`, exactly what this material exists to let a
 * caller ask for — drew identically, both taking whichever batch's uniforms happened to be
 * written last. `layout` still comes from the caller and is shared per material: it is
 * structural, not data, so nothing about sharing it can go stale mid-frame.
 */
export function createGpuParticles(
  device: GPUDevice,
  capacity: number,
  material: ParticleMaterial,
  blend: ParticleBlend,
  stretchSec: number,
  facing: ParticleFacing,
  erosion: number,
  coreGain: number,
  fog: boolean,
  layout: GPUBindGroupLayout,
  fragFields: UniformFields,
  fragSize: number,
): GpuParticles {
  /* The cross, built once: two blades of four corners, interleaved with the blade index. */
  const corners = new Float32Array(PARTICLE_VERTS * 3);
  const CORNERS = [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ] as const;
  const indices = new Uint32Array(PARTICLE_INDICES);
  for (let b = 0; b < PARTICLE_BLADES; b++) {
    for (let c = 0; c < 4; c++) {
      const v = b * 4 + c;
      const corner = CORNERS[c] as readonly [number, number];
      corners[v * 3] = corner[0];
      corners[v * 3 + 1] = corner[1];
      corners[v * 3 + 2] = b;
    }
    const base = b * 4;
    const i = b * 6;
    indices[i] = base;
    indices[i + 1] = base + 1;
    indices[i + 2] = base + 2;
    indices[i + 3] = base;
    indices[i + 4] = base + 2;
    indices[i + 5] = base + 3;
  }

  const cornerBuffer = device.createBuffer({
    label: 'particle.corners',
    size: corners.byteLength,
    usage: USAGE_VERTEX,
  });
  device.queue.writeBuffer(cornerBuffer, 0, corners);

  const instances = device.createBuffer({
    label: 'particle.instances',
    size: Math.max(4, capacity * INSTANCE_FLOATS * 4),
    usage: USAGE_VERTEX,
  });

  const indexBuffer = device.createBuffer({
    label: 'particle.indices',
    size: indices.byteLength,
    usage: USAGE_INDEX,
  });
  device.queue.writeBuffer(indexBuffer, 0, indices);

  /* This batch's own uniform buffers and bind group — see the doc comment above for why they
     may not be shared with any other batch, including another one of the same material. */
  const vertUniforms = device.createBuffer({
    label: `particle.vert:${material}`,
    size: PARTICLE_VERT_SIZE,
    usage: USAGE_UNIFORM_DST,
  });
  const fragUniforms = device.createBuffer({
    label: `particle.frag:${material}`,
    size: fragSize,
    usage: USAGE_UNIFORM_DST,
  });
  const vertStaging = new ArrayBuffer(PARTICLE_VERT_SIZE);
  const fragStaging = new ArrayBuffer(fragSize);

  return {
    corners: cornerBuffer,
    instances,
    indexBuffer,
    capacity,
    material,
    blend,
    stretchSec,
    facing,
    erosion,
    coreGain,
    fog,
    staging: new Float32Array(capacity * INSTANCE_FLOATS),
    vertUniforms,
    fragUniforms,
    vertStaging,
    vertFloats: new Float32Array(vertStaging),
    fragStaging,
    fragFloats: new Float32Array(fragStaging),
    fragInts: new Int32Array(fragStaging),
    fields: fragFields,
    bindGroup: createParticleBindGroup(device, layout, vertUniforms, fragUniforms, fragSize),
    dispose(): void {
      cornerBuffer.destroy();
      instances.destroy();
      indexBuffer.destroy();
      vertUniforms.destroy();
      fragUniforms.destroy();
    },
  };
}

/**
 * Interleave the live prefix of eight streams into the batch's own staging array.
 *
 * Only `data.count` particles, which is what the pool's compaction guarantees is live, and
 * into an array allocated with the batch — the frame loop may not allocate.
 */
export function packInstances(batch: GpuParticles, data: ParticleInstances): number {
  const n = Math.min(data.count, batch.capacity);
  const out = batch.staging;
  for (let i = 0; i < n; i++) {
    const o = i * INSTANCE_FLOATS;
    const p = i * 3;
    out[o] = data.positions[p] as number;
    out[o + 1] = data.positions[p + 1] as number;
    out[o + 2] = data.positions[p + 2] as number;
    out[o + 3] = data.sizes[i] as number;
    out[o + 4] = data.spins[i] as number;
    out[o + 5] = data.colors[p] as number;
    out[o + 6] = data.colors[p + 1] as number;
    out[o + 7] = data.colors[p + 2] as number;
    out[o + 8] = data.alphas[i] as number;
    out[o + 9] = data.ages[i] as number;
    out[o + 10] = data.seeds[i] as number;
    out[o + 11] = data.velocities[p] as number;
    out[o + 12] = data.velocities[p + 1] as number;
    out[o + 13] = data.velocities[p + 2] as number;
  }
  return n;
}

export function createParticleBindGroupLayout(
  device: GPUDevice,
  fragSize: number,
): GPUBindGroupLayout {
  return device.createBindGroupLayout({
    label: 'particle.layout',
    entries: [
      {
        binding: VERT_BINDING,
        visibility: VISIBILITY_VERTEX,
        buffer: { type: 'uniform', minBindingSize: PARTICLE_VERT_SIZE },
      },
      {
        binding: FRAG_BINDING,
        visibility: VISIBILITY_FRAGMENT,
        buffer: { type: 'uniform', minBindingSize: fragSize },
      },
    ],
  });
}

export function createParticleBindGroup(
  device: GPUDevice,
  layout: GPUBindGroupLayout,
  perDraw: GPUBuffer,
  perFrame: GPUBuffer,
  fragSize: number,
): GPUBindGroup {
  return device.createBindGroup({
    label: 'particle.bindGroup',
    layout,
    entries: [
      { binding: VERT_BINDING, resource: { buffer: perDraw, size: PARTICLE_VERT_SIZE } },
      { binding: FRAG_BINDING, resource: { buffer: perFrame, size: fragSize } },
    ],
  });
}

/**
 * The pipeline for one material and blend.
 *
 * **Neither material writes depth**, which `particleBatch.ts` explains: a soft particle that
 * did would punch a hole in everything drawn after it. Additive for sparks, over for smoke,
 * the same pairing the plume pass makes.
 */
export function particlePipeline(
  cache: PipelineCache,
  device: GPUDevice,
  layout: GPUBindGroupLayout,
  material: ParticleMaterial,
  blend: ParticleBlend,
): GPURenderPipeline {
  const shaders = particleShaders(material);
  return cache.get(`particle:${material}:${blend}`, () => ({
    label: `particle:${material}`,
    layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
    vertex: {
      module: shaderModule(device, { label: 'particle.vert', code: shaders.vertexWgsl }),
      entryPoint: 'main',
      buffers: particleVertexLayouts(),
    },
    fragment: {
      module: shaderModule(device, {
        label: `particle.frag:${material}`,
        code: shaders.fragmentWgsl,
      }),
      entryPoint: 'main',
      targets: [
        {
          format: cache.format,
          blend:
            blend === 'additive'
              ? {
                  color: { srcFactor: 'src-alpha', dstFactor: 'one', operation: 'add' },
                  alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' },
                }
              : {
                  color: {
                    srcFactor: 'src-alpha',
                    dstFactor: 'one-minus-src-alpha',
                    operation: 'add',
                  },
                  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
                },
        },
      ],
    },
    primitive: { topology: 'triangle-list', cullMode: 'none' },
    multisample: { count: cache.sampleCount },
    depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: false, depthCompare: DEPTH_COMPARE },
  }));
}
