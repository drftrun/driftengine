import { DEPTH_COMPARE } from '../../depthConvention.ts';
import {
  SDFTEXT_BINDINGS,
  SDF_TEXT_FRAG_WGSL,
  SDF_TEXT_VERT_WGSL,
} from '../../shaders/generated/sdfText.wgsl.ts';
import type { UniformFields } from './scatterPass.ts';
import { DEPTH_FORMAT } from './flatPass.ts';
import type { PipelineCache } from './pipelineCache.ts';
import type { SdfFont } from '../../sdfFont.ts';
import { SdfTextLayout, type SdfTextStyle } from '../../sdfTextLayout.ts';
import type { GpuSurfaceTexture } from './surfaceTexturePass.ts';
import { shaderModule } from './shaderModules.ts';

/**
 * The SDF text pass: a string as flat, textured quads, drawn into the scene.
 *
 * Same job as `textPass.ts` for the engine's pixel font, and `sdfTextRenderer.ts`'s own class
 * comment gives the reason this shape differs from that one: a distance field is sampled by
 * the fragment shader, so a quad per glyph is the whole glyph — one indexed draw per string,
 * no per-instance stepping. The layout is `sdfTextLayout.ts`'s and is shared with WebGL2; this
 * owns only the buffers, the bind group and the pipeline.
 *
 * **World geometry, not a screen overlay — unlike `GpuText`.** It draws against the frame's
 * own view-projection inside whatever pass is already open, the same one `drawMesh` uses, so
 * it needs neither a pass of its own nor `openTextPass`'s depth clear. See `drawSdfText` in
 * `webgpu/renderer.ts` for what that means for where this is called from.
 */

export const SDF_TEXT_VERT_FIELDS: UniformFields = SDFTEXT_BINDINGS.SDF_TEXT_VERT.fields;
export const SDF_TEXT_VERT_SIZE = SDFTEXT_BINDINGS.SDF_TEXT_VERT.uniformSize;
export const SDF_TEXT_FRAG_FIELDS: UniformFields = SDFTEXT_BINDINGS.SDF_TEXT_FRAG.fields;
export const SDF_TEXT_FRAG_SIZE = SDFTEXT_BINDINGS.SDF_TEXT_FRAG.uniformSize;

const VERT_BINDING = SDFTEXT_BINDINGS.SDF_TEXT_VERT.uniforms;
const FRAG_BINDING = SDFTEXT_BINDINGS.SDF_TEXT_FRAG.uniforms;
const ATLAS = SDFTEXT_BINDINGS.SDF_TEXT_FRAG.textures.uAtlas;

const VISIBILITY_VERTEX = 0x1;
const VISIBILITY_FRAGMENT = 0x2;
const USAGE_VERTEX = 0x0020 | 0x0008; // VERTEX | COPY_DST
const USAGE_INDEX = 0x0010 | 0x0008; // INDEX | COPY_DST

/**
 * One SDF text object on the device: the layout, and the three buffers it fills.
 *
 * **A plain indexed quad list, not `GpuText`'s instanced cube** — see this file's own doc
 * comment. `positions`/`uvs` are re-uploaded only when `layout.set` says something moved,
 * matching `SdfTextRenderer.upload`'s skip on the other backend; `indices` never changes after
 * construction, matching `SdfTextLayout`'s own fixed `0,1,2,0,2,3` pattern.
 */
export class GpuSdfText {
  readonly layout = new SdfTextLayout();
  readonly positions: GPUBuffer;
  readonly uvs: GPUBuffer;
  readonly indices: GPUBuffer;

  /** Set by `setText`; `drawSdfText` reads neither this class nor the atlas from anywhere else. */
  font: SdfFont | null = null;
  atlas: GpuSurfaceTexture | null = null;

  constructor(private readonly device: GPUDevice) {
    this.positions = device.createBuffer({
      label: 'sdfText.positions',
      size: this.layout.positions.byteLength,
      usage: USAGE_VERTEX,
    });
    this.uvs = device.createBuffer({
      label: 'sdfText.uvs',
      size: this.layout.uvs.byteLength,
      usage: USAGE_VERTEX,
    });
    this.indices = device.createBuffer({
      label: 'sdfText.indices',
      size: this.layout.indices.byteLength,
      usage: USAGE_INDEX,
    });
    device.queue.writeBuffer(this.indices, 0, this.layout.indices);
  }

  /**
   * Lay a string out against a font, and retain the atlas `drawSdfText` will sample.
   *
   * The engine fetches nothing: `font` was parsed from a metrics document the caller already
   * had, and `atlas` is a `GpuSurfaceTexture` the caller already uploaded. A no-op, and no
   * re-upload, when neither the text nor the style moved — see `SdfTextLayout.set`.
   */
  setText(font: SdfFont, atlas: GpuSurfaceTexture, text: string, style: SdfTextStyle): void {
    this.font = font;
    this.atlas = atlas;
    if (this.layout.set(font, text, style)) this.upload();
  }

  dispose(): void {
    this.positions.destroy();
    this.uvs.destroy();
    this.indices.destroy();
  }

  /** Both vertex buffers, from the arrays `layout.set` filled in place — the live prefix only. */
  private upload(): void {
    const vertexCount = this.layout.quadCount * 4;
    this.device.queue.writeBuffer(this.positions, 0, this.layout.positions, 0, vertexCount * 3);
    this.device.queue.writeBuffer(this.uvs, 0, this.layout.uvs, 0, vertexCount * 2);
  }
}

/**
 * `aPosition` at location 0, `aUv` at location 1 — pinned in `sdfText.ts` and read verbatim
 * here rather than guessed, for the reason `sdfTextRenderer.ts`'s class comment gives. Neither
 * is instanced: every vertex is its own quad corner, unlike `textVertexLayouts`'s per-instance
 * cell and character.
 */
export function sdfTextVertexLayouts(): GPUVertexBufferLayout[] {
  return [
    {
      arrayStride: 12,
      attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' as GPUVertexFormat }],
    },
    {
      arrayStride: 8,
      attributes: [{ shaderLocation: 1, offset: 0, format: 'float32x2' as GPUVertexFormat }],
    },
  ];
}

/**
 * Built from `SDFTEXT_BINDINGS`, not hand-numbered — the generator emits bindings per shader
 * precisely so this always binds the numbers the shader actually declared.
 */
export function createSdfTextBindGroupLayout(device: GPUDevice): GPUBindGroupLayout {
  return device.createBindGroupLayout({
    label: 'sdfText.layout',
    entries: [
      {
        binding: VERT_BINDING,
        visibility: VISIBILITY_VERTEX,
        buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: SDF_TEXT_VERT_SIZE },
      },
      {
        binding: FRAG_BINDING,
        visibility: VISIBILITY_FRAGMENT,
        buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: SDF_TEXT_FRAG_SIZE },
      },
      { binding: ATLAS.texture, visibility: VISIBILITY_FRAGMENT, texture: {} },
      { binding: ATLAS.sampler, visibility: VISIBILITY_FRAGMENT, sampler: {} },
    ],
  });
}

/**
 * Bound once per atlas against both rings; a dynamic offset per string. See
 * `createTextBindGroup` and, for why one bind group serves every draw against the same atlas,
 * `webgpu/renderer.ts`'s `albedoBindGroups`.
 */
export function createSdfTextBindGroup(
  device: GPUDevice,
  layout: GPUBindGroupLayout,
  vertices: GPUBuffer,
  fragments: GPUBuffer,
  atlasView: GPUTextureView,
  atlasSampler: GPUSampler,
): GPUBindGroup {
  return device.createBindGroup({
    label: 'sdfText.bindGroup',
    layout,
    entries: [
      { binding: VERT_BINDING, resource: { buffer: vertices, size: SDF_TEXT_VERT_SIZE } },
      { binding: FRAG_BINDING, resource: { buffer: fragments, size: SDF_TEXT_FRAG_SIZE } },
      { binding: ATLAS.texture, resource: atlasView },
      { binding: ATLAS.sampler, resource: atlasSampler },
    ],
  });
}

/**
 * The pipeline.
 *
 * **Alpha over, depth tested, depth not written — matching `filmPipeline`, not `textPipeline`.**
 * `sdfTextRenderer.ts`'s own comment gives the reason: an SDF glyph's antialiased edge is
 * coverage, not a solid surface, and writing depth from it punches a hole in whatever sits
 * behind that edge. Depth *testing* is left at the pass's own ambient state rather than
 * reasserted, the same assumption `drawTranslucentMesh` makes for the same reason — this draws
 * inside the mesh pass, not a pass of its own.
 *
 * **Back faces culled**, matching the ambient state `bindMeshPass` sets for the whole mesh
 * pass on the other backend (`gl.enable(CULL_FACE); gl.cullFace(BACK)`) and the convention
 * `filmPipeline` already uses for ordinary world geometry drawn the same way.
 */
export function sdfTextPipeline(
  cache: PipelineCache,
  device: GPUDevice,
  layout: GPUBindGroupLayout,
): GPURenderPipeline {
  return cache.get('sdfText', () => ({
    label: 'sdfText',
    layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
    vertex: {
      module: shaderModule(device, { label: 'sdfText.vert', code: SDF_TEXT_VERT_WGSL }),
      entryPoint: 'main',
      buffers: sdfTextVertexLayouts(),
    },
    fragment: {
      module: shaderModule(device, { label: 'sdfText.frag', code: SDF_TEXT_FRAG_WGSL }),
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
    depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: false, depthCompare: DEPTH_COMPARE },
  }));
}
