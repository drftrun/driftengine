import { DEPTH_COMPARE } from '../../depthConvention.ts';
import {
  WATER_BINDINGS,
  WATER_FRAG_WGSL,
  WATER_VERT_WGSL,
} from '../../shaders/generated/water.wgsl.ts';
import { PATCH_RESOLUTION, buildUnitSheet, buildWaterGrid } from '../../waterGrid.ts';
import { DEPTH_FORMAT } from './flatPass.ts';
import type { PipelineCache } from './pipelineCache.ts';
import type { UniformFields } from './scatterPass.ts';
import { shaderModule } from './shaderModules.ts';

/**
 * The water pass: two sheets and a patch, displaced by a wave field in the vertex stage.
 *
 * **One vertex attribute for the whole surface.** `aGrid` is a `vec2` of grid coordinates and
 * everything else — height, normal, crest, the reflection's clip position — is computed from
 * it. So the geometry here is a buffer of pairs and an index list, and the interesting part is
 * entirely in the shader and the uniforms.
 */

export const WATER_VERT_FIELDS: UniformFields = WATER_BINDINGS.WATER_VERT.fields;
export const WATER_VERT_SIZE = WATER_BINDINGS.WATER_VERT.uniformSize;
export const WATER_FRAG_FIELDS: UniformFields = WATER_BINDINGS.WATER_FRAG.fields;
export const WATER_FRAG_SIZE = WATER_BINDINGS.WATER_FRAG.uniformSize;

const VERT_BINDING = WATER_BINDINGS.WATER_VERT.uniforms;
const FRAG_BINDING = WATER_BINDINGS.WATER_FRAG.uniforms;
const REFLECTION = WATER_BINDINGS.WATER_FRAG.textures.uReflectionMap;

const VISIBILITY_VERTEX = 0x1;
const VISIBILITY_FRAGMENT = 0x2;
const USAGE_VERTEX = 0x0020 | 0x0008;
const USAGE_INDEX = 0x0010 | 0x0008;

/** The two meshes and the numbers the grid decided, behind the surface's opaque handle. */
export interface GpuWater {
  /** The ocean: near sheet and far skirt in one buffer. */
  readonly sheet: { buffer: GPUBuffer; index: GPUBuffer; count: number };
  /** A unit square, scaled per draw: every bounded body shares this one mesh. */
  readonly patch: { buffer: GPUBuffer; index: GPUBuffer; count: number };
  readonly cellSize: number;
  readonly nearHalfExtent: number;
  readonly farHalfExtent: number;
  readonly reflectionFilterTaps: number;
  dispose(): void;
}

export function createGpuWater(
  device: GPUDevice,
  resolution: number,
  nearExtent: number,
  farHalfExtent: number,
  reflectionFilterTaps: number,
): GpuWater {
  const upload = (
    offsets: Float32Array,
    indices: Uint32Array,
    label: string,
  ): { buffer: GPUBuffer; index: GPUBuffer; count: number } => {
    const buffer = device.createBuffer({
      label: `${label}.offsets`,
      size: Math.max(4, offsets.byteLength),
      usage: USAGE_VERTEX,
    });
    device.queue.writeBuffer(buffer, 0, offsets);
    const index = device.createBuffer({
      label: `${label}.indices`,
      size: Math.max(4, indices.byteLength),
      usage: USAGE_INDEX,
    });
    device.queue.writeBuffer(index, 0, indices);
    return { buffer, index, count: indices.length };
  };

  const grid = buildWaterGrid(resolution, nearExtent, farHalfExtent);
  const sheet = upload(grid.offsets, grid.indices, 'water.sheet');
  const unit = buildUnitSheet(PATCH_RESOLUTION);
  const patch = upload(unit.offsets, unit.indices, 'water.patch');

  return {
    sheet,
    patch,
    cellSize: grid.cellSize,
    nearHalfExtent: grid.nearHalfExtent,
    farHalfExtent: grid.farHalfExtent,
    reflectionFilterTaps,
    dispose(): void {
      sheet.buffer.destroy();
      sheet.index.destroy();
      patch.buffer.destroy();
      patch.index.destroy();
    },
  };
}

export function waterVertexLayouts(): GPUVertexBufferLayout[] {
  return [
    {
      arrayStride: 2 * 4,
      stepMode: 'vertex',
      attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }],
    },
  ];
}

/**
 * The water bind group's layout, whose two buffers are addressed by a dynamic offset.
 *
 * **A frame draws more than one body of water and this is what makes that true here.** A ditch at
 * its own level, a fountain in a courtyard and the sea beyond them are three draws, and with one
 * buffer rewritten between them all three read whatever was written last: `queue.write*` calls are
 * ordered on the queue timeline and the encoder is submitted after every one of them, so the
 * picture is every body wearing the last one's extents, level and colour. That is the hazard
 * `UniformRing` exists for, recorded in `AGENTS.md` on 2026-08-27, and water was the pass still
 * carrying it — invisible for as long as no scene drew two, which is exactly how the joint palette
 * survived eight releases.
 *
 * WebGL2 needs none of this: it sets uniforms and draws in one stream. Per the 2026-08-13 rule
 * that makes it a binder's problem here and not a decision anybody has to take twice.
 */
export function createWaterBindGroupLayout(device: GPUDevice): GPUBindGroupLayout {
  return device.createBindGroupLayout({
    label: 'water.layout',
    entries: [
      {
        binding: VERT_BINDING,
        visibility: VISIBILITY_VERTEX,
        buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: WATER_VERT_SIZE },
      },
      {
        binding: FRAG_BINDING,
        visibility: VISIBILITY_FRAGMENT,
        buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: WATER_FRAG_SIZE },
      },
      { binding: REFLECTION.texture, visibility: VISIBILITY_FRAGMENT, texture: {} },
      { binding: REFLECTION.sampler, visibility: VISIBILITY_FRAGMENT, sampler: {} },
    ],
  });
}

/**
 * The bind group over both rings and the mirror.
 *
 * **One mirror serves every body, and that is correct rather than a limit worked around.** The
 * frame renders at most one planar reflection, at one plane height; `reflectionFor` hands it to the
 * body whose level matches and hands nothing to the rest, which then draw with
 * `uReflectionEnabled` at zero and never sample the view this group still holds.
 */
export function createWaterBindGroup(
  device: GPUDevice,
  layout: GPUBindGroupLayout,
  perDraw: GPUBuffer,
  perFrame: GPUBuffer,
  reflection: GPUTextureView,
  sampler: GPUSampler,
): GPUBindGroup {
  return device.createBindGroup({
    label: 'water.bindGroup',
    layout,
    entries: [
      { binding: VERT_BINDING, resource: { buffer: perDraw, size: WATER_VERT_SIZE } },
      { binding: FRAG_BINDING, resource: { buffer: perFrame, size: WATER_FRAG_SIZE } },
      { binding: REFLECTION.texture, resource: reflection },
      { binding: REFLECTION.sampler, resource: sampler },
    ],
  });
}

/**
 * The water pipeline.
 *
 * **Blended, and culling off.** `renderer.ts` brackets the draw with
 * `SRC_ALPHA, ONE_MINUS_SRC_ALPHA` and `gl.disable(gl.CULL_FACE)` — the second because waves
 * are displaced far enough that back faces show at grazing angles, which is a surface you can
 * see the underside of rather than a winding mistake.
 *
 * **Depth tested and not written**, which is what a transparent surface wants: it must not
 * occlude what comes after it, and it must still be occluded by what came before.
 */
export function waterPipeline(
  cache: PipelineCache,
  device: GPUDevice,
  layout: GPUBindGroupLayout,
): GPURenderPipeline {
  return cache.get('water', () => ({
    label: 'water',
    layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
    vertex: {
      module: shaderModule(device, { label: 'water.vert', code: WATER_VERT_WGSL }),
      entryPoint: 'main',
      buffers: waterVertexLayouts(),
    },
    fragment: {
      module: shaderModule(device, { label: 'water.frag', code: WATER_FRAG_WGSL }),
      entryPoint: 'main',
      targets: [
        {
          format: cache.format,
          blend: {
            color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            alpha: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          },
        },
      ],
    },
    primitive: { topology: 'triangle-list', cullMode: 'none' },
    multisample: { count: cache.sampleCount },
    depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: false, depthCompare: DEPTH_COMPARE },
  }));
}
