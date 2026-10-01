/**
 * What a pane lets through, drawn into a shadow's tint layer on this device: the layouts, the
 * per-draw block, the bind groups and the pipelines for the five tint programs (`depth.ts`).
 *
 * **The vertex half is the depth pass's**, block for block — the tint's vertex stages are the depth
 * ones with the world position handed on — so a draw's vertex slot comes from the shadow pass's own
 * ring and only the pane's 32 bytes are this file's. **The fragment half multiplies**: an
 * `rgba8unorm` target cleared to white, `dst × src` for colour and `dst-alpha × src` for clarity, and
 * no depth, so every pane on a ray counts in any order. Built the first time glass casts, so a scene
 * with no glass builds none of it.
 */
import { DEPTH_BINDINGS } from '../../shaders/generated/depth.wgsl.ts';
import {
  GLASS_TINT_CUTOUT_FRAG_WGSL,
  GLASS_TINT_CUTOUT_VERT_WGSL,
  GLASS_TINT_FRAG_WGSL,
  GLASS_TINT_INSTANCED_CUTOUT_VERT_WGSL,
  GLASS_TINT_INSTANCED_VERT_WGSL,
  GLASS_TINT_SKINNED_VERT_WGSL,
  GLASS_TINT_VERT_WGSL,
} from '../../shaders/generated/depth.wgsl.ts';
import type { ResolvedGlass } from '../../glass.ts';
import { vertexBufferLayouts } from './buffers.ts';
import type { PipelineCache } from './pipelineCache.ts';
import { shaderModule } from './shaderModules.ts';
import { UniformRing } from './uniformRing.ts';

const VISIBILITY_VERTEX = 0x1;
const VISIBILITY_FRAGMENT = 0x2;
const USAGE_UNIFORM_DST = 0x40 | 0x8; // UNIFORM | COPY_DST

const VERT = DEPTH_BINDINGS.GLASS_TINT_VERT;
const CUTOUT_VERT = DEPTH_BINDINGS.GLASS_TINT_CUTOUT_VERT;
const FRAG = DEPTH_BINDINGS.GLASS_TINT_FRAG;
const CUTOUT_MAP = DEPTH_BINDINGS.GLASS_TINT_CUTOUT_FRAG.textures.uCutoutMap;
const PALETTE = DEPTH_BINDINGS.GLASS_TINT_SKINNED_VERT.textures.uJointPalette;
const PANE = FRAG.fields.uGlassPane.offset;
const LIGHT = FRAG.fields.uGlassLight.offset;

/** Panes a frame can tint: a pane is a draw per shadow it reaches, and panes are few. */
const MAX_TINT_DRAWS = 512;

export type GlassTintKind = 'rigid' | 'instanced' | 'skinned' | 'cutout' | 'instancedCutout';

/** The multiplying state: colour times what passes, clarity times clarity, order-free. */
export const GLASS_TINT_BLEND: GPUBlendState = {
  color: { operation: 'add', srcFactor: 'dst', dstFactor: 'zero' },
  alpha: { operation: 'add', srcFactor: 'dst-alpha', dstFactor: 'zero' },
};

export class GpuGlassTint {
  readonly frag: UniformRing;
  private readonly layouts: Record<'plain' | 'cutout' | 'skinned', GPUBindGroupLayout>;
  private plainGroup: GPUBindGroup | null = null;
  private groupVertBuffer: GPUBuffer | null = null;
  private groupFragBuffer: GPUBuffer | null = null;
  private readonly cutoutGroups = new Map<GPUTextureView, GPUBindGroup>();
  private readonly skinnedGroups = new Map<GPUTextureView, GPUBindGroup>();
  private readonly device: GPUDevice;

  constructor(device: GPUDevice) {
    this.device = device;
    this.frag = new UniformRing(
      device,
      FRAG.uniformSize,
      MAX_TINT_DRAWS,
      USAGE_UNIFORM_DST,
      'glassTint.ring',
    );
    const vert = (size: number): GPUBindGroupLayoutEntry => ({
      binding: VERT.uniforms,
      visibility: VISIBILITY_VERTEX,
      buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: size },
    });
    const frag: GPUBindGroupLayoutEntry = {
      binding: FRAG.uniforms,
      visibility: VISIBILITY_FRAGMENT,
      buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: FRAG.uniformSize },
    };
    this.layouts = {
      plain: device.createBindGroupLayout({
        label: 'glassTint.layout',
        entries: [vert(VERT.uniformSize), frag],
      }),
      cutout: device.createBindGroupLayout({
        label: 'glassTint.layout.cutout',
        entries: [
          vert(CUTOUT_VERT.uniformSize),
          frag,
          {
            binding: CUTOUT_MAP.texture,
            visibility: VISIBILITY_FRAGMENT,
            /* A surface texture, and every surface texture is a `2d-array` view. */
            texture: { sampleType: 'float', viewDimension: '2d-array' },
          },
          {
            binding: CUTOUT_MAP.sampler,
            visibility: VISIBILITY_FRAGMENT,
            sampler: { type: 'filtering' },
          },
        ],
      }),
      skinned: device.createBindGroupLayout({
        label: 'glassTint.layout.skinned',
        entries: [
          {
            binding: PALETTE.texture,
            visibility: VISIBILITY_VERTEX,
            texture: { sampleType: 'unfilterable-float' },
          },
          vert(VERT.uniformSize),
          frag,
        ],
      }),
    };
  }

  /** One pane's block: what it lets through, how clear it is, and the light it is drawn for. */
  writePane(slot: number, glass: ResolvedGlass, light: Float32Array): void {
    const pane = paneScratch;
    pane[0] = glass.transmission * glass.tint[0];
    pane[1] = glass.transmission * glass.tint[1];
    pane[2] = glass.transmission * glass.tint[2];
    pane[3] = 1 - glass.frost;
    this.frag.writeFloats(slot, PANE, pane);
    this.frag.writeFloats(slot, LIGHT, light);
  }

  /** The plain group, rebuilt only when a ring has grown a new buffer under it. */
  group(vertBuffer: GPUBuffer): GPUBindGroup {
    if (
      this.plainGroup === null ||
      this.groupVertBuffer !== vertBuffer ||
      this.groupFragBuffer !== this.frag.buffer
    ) {
      this.cutoutGroups.clear();
      this.skinnedGroups.clear();
      this.groupVertBuffer = vertBuffer;
      this.groupFragBuffer = this.frag.buffer;
      this.plainGroup = this.device.createBindGroup({
        label: 'glassTint.group',
        layout: this.layouts.plain,
        entries: [
          { binding: VERT.uniforms, resource: { buffer: vertBuffer, size: VERT.uniformSize } },
          {
            binding: FRAG.uniforms,
            resource: { buffer: this.frag.buffer, size: FRAG.uniformSize },
          },
        ],
      });
    }
    return this.plainGroup;
  }

  /** A cutout pane's group, one per map, built the first time that map casts colour. */
  cutoutGroup(vertBuffer: GPUBuffer, view: GPUTextureView, sampler: GPUSampler): GPUBindGroup {
    this.group(vertBuffer);
    const held = this.cutoutGroups.get(view);
    if (held !== undefined) return held;
    const made = this.device.createBindGroup({
      label: 'glassTint.group.cutout',
      layout: this.layouts.cutout,
      entries: [
        {
          binding: CUTOUT_VERT.uniforms,
          resource: { buffer: vertBuffer, size: CUTOUT_VERT.uniformSize },
        },
        { binding: FRAG.uniforms, resource: { buffer: this.frag.buffer, size: FRAG.uniformSize } },
        { binding: CUTOUT_MAP.texture, resource: view },
        { binding: CUTOUT_MAP.sampler, resource: sampler },
      ],
    });
    this.cutoutGroups.set(view, made);
    return made;
  }

  /** A skinned pane's group, one per palette view. */
  skinnedGroup(vertBuffer: GPUBuffer, palette: GPUTextureView): GPUBindGroup {
    this.group(vertBuffer);
    const held = this.skinnedGroups.get(palette);
    if (held !== undefined) return held;
    const made = this.device.createBindGroup({
      label: 'glassTint.group.skinned',
      layout: this.layouts.skinned,
      entries: [
        { binding: PALETTE.texture, resource: palette },
        { binding: VERT.uniforms, resource: { buffer: vertBuffer, size: VERT.uniformSize } },
        { binding: FRAG.uniforms, resource: { buffer: this.frag.buffer, size: FRAG.uniformSize } },
      ],
    });
    this.skinnedGroups.set(palette, made);
    return made;
  }

  /** The pipeline for one kind of caster, cull mode and vertex layout, cached by key. */
  pipeline(
    cache: PipelineCache,
    kind: GlassTintKind,
    key: string,
    present: Readonly<Record<string, boolean>>,
    cullMode: GPUCullMode,
  ): GPURenderPipeline {
    const cutout = kind === 'cutout' || kind === 'instancedCutout';
    const instanced = kind === 'instanced' || kind === 'instancedCutout';
    const layout =
      kind === 'skinned' ? this.layouts.skinned : cutout ? this.layouts.cutout : this.layouts.plain;
    const vertex =
      kind === 'rigid'
        ? GLASS_TINT_VERT_WGSL
        : kind === 'instanced'
          ? GLASS_TINT_INSTANCED_VERT_WGSL
          : kind === 'skinned'
            ? GLASS_TINT_SKINNED_VERT_WGSL
            : kind === 'cutout'
              ? GLASS_TINT_CUTOUT_VERT_WGSL
              : GLASS_TINT_INSTANCED_CUTOUT_VERT_WGSL;
    const label = `glass-tint|${kind}|${cullMode}|${key}`;
    return cache.get(label, () => ({
      label,
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [layout] }),
      vertex: {
        module: shaderModule(this.device, { label: `glassTint.${kind}.vert`, code: vertex }),
        entryPoint: 'main',
        buffers: vertexBufferLayouts(present, instanced),
      },
      fragment: {
        module: shaderModule(this.device, {
          label: cutout ? 'glassTint.cutout.frag' : 'glassTint.frag',
          code: cutout ? GLASS_TINT_CUTOUT_FRAG_WGSL : GLASS_TINT_FRAG_WGSL,
        }),
        entryPoint: 'main',
        targets: [{ format: 'rgba8unorm', blend: GLASS_TINT_BLEND }],
      },
      /* The depth pass's primitive state exactly — its winding included, for the reason
         `depthPipeline` gives: this map is sampled, not presented. */
      primitive: { topology: 'triangle-list', cullMode, frontFace: 'cw' },
    }));
  }

  dispose(): void {
    this.frag.dispose();
  }
}

const paneScratch = new Float32Array(4);
