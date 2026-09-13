import { DEPTH_COMPARE_EQUAL } from '../../depthConvention.ts';
import {
  TEXT_BINDINGS,
  TEXT_FRAG_WGSL,
  TEXT_VERT_WGSL,
} from '../../shaders/generated/text.wgsl.ts';
import { MAX_CELLS, TEXT_CUBE, TextLayout } from '../../textLayout.ts';
import type { UniformFields } from './scatterPass.ts';
import { DEPTH_FORMAT } from './flatPass.ts';
import type { PipelineCache } from './pipelineCache.ts';
import { shaderModule } from './shaderModules.ts';

/**
 * The text pass: a string as instanced glyph cubes, drawn over the scene.
 *
 * The layout is `textLayout.ts`'s and is shared with WebGL2 — this owns four buffers and the
 * pipeline. Two of the buffers are the cube, uploaded once and shared by every text object; two
 * are per object and re-uploaded only when the string changes.
 */

export const TEXT_VERT_FIELDS: UniformFields = TEXT_BINDINGS.TEXT_VERT.fields;
export const TEXT_VERT_SIZE = TEXT_BINDINGS.TEXT_VERT.uniformSize;
export const TEXT_FRAG_FIELDS: UniformFields = TEXT_BINDINGS.TEXT_FRAG.fields;
export const TEXT_FRAG_SIZE = TEXT_BINDINGS.TEXT_FRAG.uniformSize;

const VERT_BINDING = TEXT_BINDINGS.TEXT_VERT.uniforms;
const FRAG_BINDING = TEXT_BINDINGS.TEXT_FRAG.uniforms;

const VISIBILITY_VERTEX = 0x1;
const VISIBILITY_FRAGMENT = 0x2;
const USAGE_VERTEX = 0x0020 | 0x0008; // VERTEX | COPY_DST

/** The cube every text object instances, built once for the device rather than per object. */
export interface GpuTextCube {
  readonly positions: GPUBuffer;
  readonly normals: GPUBuffer;
  readonly vertexCount: number;
  dispose(): void;
}

export function createGpuTextCube(device: GPUDevice): GpuTextCube {
  const upload = (data: Float32Array, label: string): GPUBuffer => {
    const buffer = device.createBuffer({ label, size: data.byteLength, usage: USAGE_VERTEX });
    device.queue.writeBuffer(buffer, 0, data);
    return buffer;
  };
  const positions = upload(TEXT_CUBE.positions, 'text.positions');
  const normals = upload(TEXT_CUBE.normals, 'text.normals');
  return {
    positions,
    normals,
    vertexCount: TEXT_CUBE.vertexCount,
    dispose(): void {
      positions.destroy();
      normals.destroy();
    },
  };
}

/**
 * One text object on the device: the layout, and the two instance buffers it fills.
 *
 * `setText` uploads only when the layout says something moved, which is the skip the whole
 * design exists for — most frames show the message the frame before did.
 */
export class GpuText {
  readonly layout = new TextLayout();
  readonly cells: GPUBuffer;
  readonly chars: GPUBuffer;

  constructor(private readonly device: GPUDevice) {
    this.cells = device.createBuffer({
      label: 'text.cells',
      size: MAX_CELLS * 2 * 4,
      usage: USAGE_VERTEX,
    });
    this.chars = device.createBuffer({
      label: 'text.chars',
      size: MAX_CELLS * 4,
      usage: USAGE_VERTEX,
    });
  }

  setText(content: string): void {
    if (this.layout.setText(content)) this.upload();
  }

  setPlate(widthCells: number, heightCells: number, bottomCell: number): void {
    if (this.layout.setPlate(widthCells, heightCells, bottomCell)) this.upload();
  }

  dispose(): void {
    this.cells.destroy();
    this.chars.destroy();
  }

  /**
   * Whole slots rather than the used prefix.
   *
   * `writeBuffer` takes a byte length that must be a multiple of four, and the count of cells
   * is arbitrary — so this writes what the layout holds and lets the instance count decide
   * what is drawn. The arrays are reused in place, so the tail is last frame's and unread.
   */
  private upload(): void {
    this.device.queue.writeBuffer(this.cells, 0, this.layout.cells);
    this.device.queue.writeBuffer(this.chars, 0, this.layout.chars);
  }
}

/**
 * Four buffers: the cube's two, and the object's two at one step per instance.
 *
 * Not interleaved, matching what `TextRenderer` binds on the other backend and for the same
 * reason: they are four separate arrays on both sides, and four of eight slots is nothing.
 */
export function textVertexLayouts(): GPUVertexBufferLayout[] {
  return [
    {
      arrayStride: 12,
      attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' as GPUVertexFormat }],
    },
    {
      arrayStride: 12,
      attributes: [{ shaderLocation: 1, offset: 0, format: 'float32x3' as GPUVertexFormat }],
    },
    {
      arrayStride: 8,
      stepMode: 'instance' as GPUVertexStepMode,
      attributes: [{ shaderLocation: 2, offset: 0, format: 'float32x2' as GPUVertexFormat }],
    },
    {
      arrayStride: 4,
      stepMode: 'instance' as GPUVertexStepMode,
      attributes: [{ shaderLocation: 3, offset: 0, format: 'float32' as GPUVertexFormat }],
    },
  ];
}

export function createTextBindGroupLayout(device: GPUDevice): GPUBindGroupLayout {
  return device.createBindGroupLayout({
    label: 'text.layout',
    entries: [
      {
        binding: VERT_BINDING,
        visibility: VISIBILITY_VERTEX,
        buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: TEXT_VERT_SIZE },
      },
      {
        binding: FRAG_BINDING,
        visibility: VISIBILITY_FRAGMENT,
        buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: TEXT_FRAG_SIZE },
      },
    ],
  });
}

/** Bound once against both rings; a dynamic offset per string. See `createPanelBindGroup`. */
export function createTextBindGroup(
  device: GPUDevice,
  layout: GPUBindGroupLayout,
  vertices: GPUBuffer,
  fragments: GPUBuffer,
): GPUBindGroup {
  return device.createBindGroup({
    label: 'text.bindGroup',
    layout,
    entries: [
      { binding: VERT_BINDING, resource: { buffer: vertices, size: TEXT_VERT_SIZE } },
      { binding: FRAG_BINDING, resource: { buffer: fragments, size: TEXT_FRAG_SIZE } },
    ],
  });
}

/**
 * The pipeline.
 *
 * **Depth tested and depth written, against a buffer the caller has just cleared.** Turning
 * depth off is the obvious move and is wrong: the cubes are solid, so with nothing sorting them
 * the last face drawn wins and every letter renders as one flat facet. A cleared buffer puts
 * the message in front of the scene while still letting its own geometry sort against itself,
 * which is what gives the glyphs their edges. WebGL2 calls `gl.clear` mid-frame for this;
 * WebGPU cannot, so the renderer opens a pass whose `depthLoadOp` is `clear` instead.
 *
 * **Back faces culled, and the cube is wound backwards on purpose so that means the right
 * thing.** `textLayout.ts` explains: the shader flips Y, a mirror reverses winding, so faces
 * authored the usual way come out back-facing and every one of them is culled. On this backend
 * the toolchain's own Y negation and `uClipCorrection` cancel, so the winding that reaches the
 * rasteriser is the one WebGL2 sees and this matches it.
 */
export function textPipeline(
  cache: PipelineCache,
  device: GPUDevice,
  layout: GPUBindGroupLayout,
): GPURenderPipeline {
  return cache.get('text', () => ({
    label: 'text',
    layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
    vertex: {
      module: shaderModule(device, { label: 'text.vert', code: TEXT_VERT_WGSL }),
      entryPoint: 'main',
      buffers: textVertexLayouts(),
    },
    fragment: {
      module: shaderModule(device, { label: 'text.frag', code: TEXT_FRAG_WGSL }),
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
    primitive: { topology: 'triangle-list', cullMode: 'back' },
    multisample: { count: cache.sampleCount },
    depthStencil: {
      format: DEPTH_FORMAT,
      depthWriteEnabled: true,
      depthCompare: DEPTH_COMPARE_EQUAL,
    },
  }));
}
