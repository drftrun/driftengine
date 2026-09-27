/**
 * What a probe bake draws into and reads from, made once and kept rather than made per bake.
 *
 * **A bake is a per-frame path now, and it was written as a one-off.** It created a depth and a
 * multisampled colour texture per call and destroyed them after, a view per face, and for each
 * probe it completed a view and a bind group per level and face of the blur and the convolution.
 * That was a load-time cost while a scene baked its probes once. Since a bake can be spread a few
 * faces a frame (`ProbeBakeOptions.faces`) and a crossfading grid re-bakes as the light moves, it
 * is every frame, and on the native host, where each object costs most, a courtyard with the sun
 * moving spent a third of its CPU in bakes. The capture cube lives as long as the renderer, so
 * every view of it can too; the array is replaced only when the grid is, and `forgetArray` drops
 * what was made against the old one.
 *
 * What it gives up is holding the attachments between bakes: a depth and a colour texture the size
 * of one face, at the scene's sample count, kept for as long as the renderer is.
 */

import { DEPTH_FORMAT } from '../../depthConvention.ts';
import {
  PREFILTER_SAMPLER_BINDING,
  PREFILTER_TEXTURE_BINDING,
  PREFILTER_UNIFORM_BINDING,
  PROBE_FACE_BASIS,
  PROBE_MIP_UNIFORM_SIZE,
  probeLevels,
} from './probePass.ts';

export class ProbeTargets {
  private readonly device: GPUDevice;
  private readonly probe: GPUTexture;
  private readonly size: number;
  /** Level 0 of each face, which the bake's passes resolve into. */
  readonly faceViews: readonly GPUTextureView[];
  /** The whole chain as a cube, which the convolution samples. */
  readonly wholeCube: GPUTextureView;
  /** Level `l - 1` as a cube, which the blur into level `l` samples; index 0 unused. */
  private readonly chainSources: GPUTextureView[] = [];
  /** Level `l` of face `f`, at `l * faces + f`, which the blur writes. */
  private readonly chainTargets: GPUTextureView[] = [];
  private depth: GPUTexture | null = null;
  private depthView: GPUTextureView | null = null;
  private colorMsaa: GPUTexture | null = null;
  private colorMsaaView: GPUTextureView | null = null;
  private attachmentKey = '';
  /* The array's level-and-layer views and the groups over this ring's buffer, each made once. */
  private readonly arrayViews = new Map<number, GPUTextureView>();
  private chainGroups: GPUBindGroup[] = [];
  private prefilterGroup: GPUBindGroup | null = null;
  private groupsBuffer: GPUBuffer | null = null;

  constructor(device: GPUDevice, probe: GPUTexture, size: number) {
    this.device = device;
    this.probe = probe;
    this.size = size;
    const faces: GPUTextureView[] = [];
    for (let face = 0; face < PROBE_FACE_BASIS.length; face++) {
      faces.push(this.faceLevel(face, 0));
    }
    this.faceViews = faces;
    this.wholeCube = probe.createView({ dimension: 'cube' });
    const levels = probeLevels(size);
    for (let level = 1; level < levels; level++) {
      this.chainSources[level] = probe.createView({
        dimension: 'cube',
        baseMipLevel: level - 1,
        mipLevelCount: 1,
      });
      for (let face = 0; face < PROBE_FACE_BASIS.length; face++) {
        this.chainTargets[level * PROBE_FACE_BASIS.length + face] = this.faceLevel(face, level);
      }
    }
  }

  /**
   * The depth and, above one sample, the multisampled colour a face is drawn into: made on the first
   * bake and again only if the sample count or the format has changed since.
   */
  attachments(
    samples: number,
    format: GPUTextureFormat,
  ): { depth: GPUTextureView; colorMsaa: GPUTextureView | null } {
    const key = `${samples}:${format}`;
    if (this.depthView === null || key !== this.attachmentKey) {
      this.destroyAttachments();
      this.attachmentKey = key;
      this.depth = this.device.createTexture({
        label: 'probe.depth',
        size: [this.size, this.size],
        format: DEPTH_FORMAT,
        /* The world's sample count, because a bake draws the world with the world's pipelines. */
        sampleCount: samples,
        usage: 0x10, // RENDER_ATTACHMENT
      });
      this.depthView = this.depth.createView();
      this.colorMsaa =
        samples > 1
          ? this.device.createTexture({
              label: 'probe.colorMsaa',
              size: [this.size, this.size],
              format,
              sampleCount: samples,
              usage: 0x10, // RENDER_ATTACHMENT
            })
          : null;
      this.colorMsaaView = this.colorMsaa?.createView() ?? null;
    }
    return { depth: this.depthView as GPUTextureView, colorMsaa: this.colorMsaaView };
  }

  /** The blur's target for `level` of `face`. */
  chainTarget(level: number, face: number): GPUTextureView {
    return this.chainTargets[level * PROBE_FACE_BASIS.length + face] as GPUTextureView;
  }

  /**
   * The blur's group for `level`, over `buffer`: the uniforms, the level above as a cube, the
   * sampler. Remade only if the ring's buffer has been replaced.
   */
  chainGroup(
    layout: GPUBindGroupLayout,
    buffer: GPUBuffer,
    sampler: GPUSampler,
    level: number,
  ): GPUBindGroup {
    this.forBuffer(buffer);
    let group = this.chainGroups[level];
    if (group === undefined) {
      group = this.device.createBindGroup({
        layout,
        entries: [
          { binding: 0, resource: { buffer, size: PROBE_MIP_UNIFORM_SIZE } },
          { binding: 1, resource: this.chainSources[level] as GPUTextureView },
          { binding: 2, resource: sampler },
        ],
      });
      this.chainGroups[level] = group;
    }
    return group;
  }

  /** The convolution's group over `buffer`: the uniforms, the whole chain, the sampler. */
  prefilterGroupFor(
    layout: GPUBindGroupLayout,
    buffer: GPUBuffer,
    sampler: GPUSampler,
  ): GPUBindGroup {
    this.forBuffer(buffer);
    this.prefilterGroup ??= this.device.createBindGroup({
      layout,
      entries: [
        { binding: PREFILTER_UNIFORM_BINDING, resource: { buffer, size: PROBE_MIP_UNIFORM_SIZE } },
        { binding: PREFILTER_TEXTURE_BINDING, resource: this.wholeCube },
        { binding: PREFILTER_SAMPLER_BINDING, resource: sampler },
      ],
    });
    return this.prefilterGroup;
  }

  /** `level` of `layer` of the grid's array, which the convolution writes. */
  arrayView(array: GPUTexture, layer: number, level: number): GPUTextureView {
    const key = layer * 32 + level;
    let view = this.arrayViews.get(key);
    if (view === undefined) {
      view = array.createView({
        dimension: '2d',
        baseArrayLayer: layer,
        arrayLayerCount: 1,
        baseMipLevel: level,
        mipLevelCount: 1,
      });
      this.arrayViews.set(key, view);
    }
    return view;
  }

  /** The grid's array has been replaced: nothing made against the old one may be handed out. */
  forgetArray(): void {
    this.arrayViews.clear();
  }

  dispose(): void {
    this.destroyAttachments();
  }

  private faceLevel(face: number, level: number): GPUTextureView {
    return this.probe.createView({
      dimension: '2d',
      baseArrayLayer: face,
      arrayLayerCount: 1,
      baseMipLevel: level,
      mipLevelCount: 1,
    });
  }

  /** Groups hold the ring's buffer, so a replaced buffer makes every one of them stale. */
  private forBuffer(buffer: GPUBuffer): void {
    if (buffer === this.groupsBuffer) return;
    this.groupsBuffer = buffer;
    this.chainGroups = [];
    this.prefilterGroup = null;
  }

  private destroyAttachments(): void {
    this.depth?.destroy();
    this.colorMsaa?.destroy();
    this.depth = null;
    this.depthView = null;
    this.colorMsaa = null;
    this.colorMsaaView = null;
  }
}
