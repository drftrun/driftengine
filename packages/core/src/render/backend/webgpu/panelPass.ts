import {
  PANEL_BINDINGS,
  PANEL_FRAG_WGSL,
  PANEL_VERT_WGSL,
} from '../../shaders/generated/panel.wgsl.ts';
import type { UniformFields } from './scatterPass.ts';
import { DEPTH_FORMAT } from './flatPass.ts';
import type { PipelineCache } from './pipelineCache.ts';
import { shaderModule } from './shaderModules.ts';

/**
 * The panel pass: two triangles in screen space, one colour, one alpha.
 *
 * The plain surface an overlay is read against — what `renderer.ts` says about `fillPanel`
 * applies here unchanged, including why neither `beginInset` nor a plate of glyph cubes can
 * stand in for it.
 *
 * **The corners are a vertex buffer rather than `vertex_index` arithmetic**, because the GLSL
 * is the source of truth and it declares `aCorner`. Six vertices, uploaded once.
 */

export const PANEL_VERT_FIELDS: UniformFields = PANEL_BINDINGS.PANEL_VERT.fields;
export const PANEL_VERT_SIZE = PANEL_BINDINGS.PANEL_VERT.uniformSize;
export const PANEL_FRAG_FIELDS: UniformFields = PANEL_BINDINGS.PANEL_FRAG.fields;
export const PANEL_FRAG_SIZE = PANEL_BINDINGS.PANEL_FRAG.uniformSize;

const VERT_BINDING = PANEL_BINDINGS.PANEL_VERT.uniforms;
const FRAG_BINDING = PANEL_BINDINGS.PANEL_FRAG.uniforms;

const VISIBILITY_VERTEX = 0x1;
const VISIBILITY_FRAGMENT = 0x2;
const USAGE_VERTEX = 0x0020 | 0x0008; // VERTEX | COPY_DST

/** The unit quad, as two triangles. The rect and the viewport turn it into pixels. */
const CORNERS = new Float32Array([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1]);
export const PANEL_VERTEX_COUNT = CORNERS.length / 2;

export function createPanelCorners(device: GPUDevice): GPUBuffer {
  const buffer = device.createBuffer({
    label: 'panel.corners',
    size: CORNERS.byteLength,
    usage: USAGE_VERTEX,
  });
  device.queue.writeBuffer(buffer, 0, CORNERS);
  return buffer;
}

export function createPanelBindGroupLayout(device: GPUDevice): GPUBindGroupLayout {
  return device.createBindGroupLayout({
    label: 'panel.layout',
    entries: [
      {
        binding: VERT_BINDING,
        visibility: VISIBILITY_VERTEX,
        buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: PANEL_VERT_SIZE },
      },
      {
        binding: FRAG_BINDING,
        visibility: VISIBILITY_FRAGMENT,
        buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: PANEL_FRAG_SIZE },
      },
    ],
  });
}

/**
 * Bound once against both rings, and addressed by dynamic offset per panel.
 *
 * **A ring rather than one buffer, because a frame draws more than one.** The loader alone
 * draws a track and a fill, and `queue.writeBuffer` does not interleave with recorded commands
 * — so a single block written twice would give both panels the second colour. That is the bug
 * that left a flame leaning forty degrees in still air, one pass higher up.
 */
export function createPanelBindGroup(
  device: GPUDevice,
  layout: GPUBindGroupLayout,
  vertices: GPUBuffer,
  fragments: GPUBuffer,
): GPUBindGroup {
  return device.createBindGroup({
    label: 'panel.bindGroup',
    layout,
    entries: [
      { binding: VERT_BINDING, resource: { buffer: vertices, size: PANEL_VERT_SIZE } },
      { binding: FRAG_BINDING, resource: { buffer: fragments, size: PANEL_FRAG_SIZE } },
    ],
  });
}

/**
 * The pipeline.
 *
 * **Nothing culled, nothing depth-tested, nothing written to depth.** This is furniture drawn
 * over a finished frame: it must neither be occluded by the scene nor occlude what comes after
 * it. `renderer.ts` disables all three by hand for the same draw, and records that leaving
 * culling on drew nothing at all, silently — a screen-space quad has no meaningful facing.
 */
export function panelPipeline(
  cache: PipelineCache,
  device: GPUDevice,
  layout: GPUBindGroupLayout,
): GPURenderPipeline {
  return cache.get('panel', () => ({
    label: 'panel',
    layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
    vertex: {
      module: shaderModule(device, { label: 'panel.vert', code: PANEL_VERT_WGSL }),
      entryPoint: 'main',
      buffers: [
        {
          arrayStride: 8,
          attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' as GPUVertexFormat }],
        },
      ],
    },
    fragment: {
      module: shaderModule(device, { label: 'panel.frag', code: PANEL_FRAG_WGSL }),
      entryPoint: 'main',
      targets: [
        {
          format: cache.format,
          blend: {
            color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          },
        },
      ],
    },
    primitive: { topology: 'triangle-list', cullMode: 'none' },
    multisample: { count: cache.sampleCount },
    /*
     * `always` is how a WebGPU pipeline says what `gl.disable(DEPTH_TEST)` says. The attachment
     * is still declared because the frame's pass has one, and a pipeline that omits it cannot
     * be used in a pass that has one.
     */
    depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: false, depthCompare: 'always' },
  }));
}
