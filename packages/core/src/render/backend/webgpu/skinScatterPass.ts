/**
 * Skin's screen-space scattering on this backend: the targets, the kept draws and the two passes
 * that spread them. `skinBlur.ts` is what the blur computes and why; this is where it runs.
 *
 * **What the renderer hands it.** Each skin draw, recorded into the frame with its diffuse taken
 * out, is recorded a second time here with the diffuse alone. When the frame first draws something
 * blended — or ends, if nothing is — the renderer ends its pass and calls `drawDiffuse`, which
 * replays them into a half-float target against the frame's own depth; resolves the depth; and
 * calls `spread`, which blurs across into a second target and then down, adding into the frame.
 *
 * **The draws are commands, not calls**, for the reason `LatePass` keeps its own pool: the frame
 * graph's is spent at every flush, and these are replayed after the flush that ends the frame's
 * pass. Each holds the per-draw ring slot its frame half used, and those stay valid until the
 * encoder is replaced, which is after this has run.
 *
 * **What it costs**: every skin draw twice; two half-float targets the size of the frame, and a
 * third multisampled one under multisampling; a depth resolve; and two full-screen passes that
 * leave at once wherever no skin was drawn.
 */
import { SKIN_PROFILES } from '../../skinBlur.ts';
import { SKINBLUR_BINDINGS, SKIN_BLUR_FRAG_WGSL } from '../../shaders/generated/skinBlur.wgsl.ts';
import { SCENE_ALPHA_KEEPS } from '../../sceneCoverage.ts';
import type { CommandPool, DrawCommand } from './drawCommand.ts';
import { createCommandPool, resetPool, takeCommand } from './drawCommand.ts';
import type { PipelineCache } from './pipelineCache.ts';
import { createPostStageLayout, postPipeline, postPipelineTargets } from './postPass.ts';
import { DYNAMIC_ALIGNMENT } from './uniformRing.ts';

const BINDINGS = SKINBLUR_BINDINGS.SKIN_BLUR_FRAG;
const SLOT = Math.ceil(BINDINGS.uniformSize / DYNAMIC_ALIGNMENT) * DYNAMIC_ALIGNMENT;
const USAGE_TARGET = 0x10 | 0x4; // RENDER_ATTACHMENT | TEXTURE_BINDING
const USAGE_UNIFORM_DST = 0x40 | 0x8; // UNIFORM | COPY_DST

/** The format the diffuse lands in: half floats, because it is linear light before any grade. */
export const SKIN_TARGET_FORMAT: GPUTextureFormat = 'rgba16float';

export class SkinScatterPass {
  private readonly device: GPUDevice;
  private readonly layout: GPUBindGroupLayout;
  private readonly uniforms: GPUBuffer;
  private readonly staging = new Float32Array((SLOT * 2) / 4);
  private readonly linear: GPUSampler;
  private readonly nearest: GPUSampler;
  private readonly commands: CommandPool = createCommandPool(16);
  /** Each profile's scatter distance per channel, in metres: four floats a profile. */
  private readonly profiles = new Float32Array(SKIN_PROFILES * 4);
  private diffuse: GPUTexture | null = null;
  private diffuseMsaa: GPUTexture | null = null;
  private across: GPUTexture | null = null;
  private diffuseView: GPUTextureView | null = null;
  private diffuseMsaaView: GPUTextureView | null = null;
  private acrossView: GPUTextureView | null = null;
  private groupAcross: GPUBindGroup | null = null;
  private groupDown: GPUBindGroup | null = null;
  private groupsDepth: GPUTextureView | null = null;

  constructor(device: GPUDevice) {
    this.device = device;
    this.layout = createPostStageLayout(device, BINDINGS.uniforms, BINDINGS.uniformSize, [
      { binding: BINDINGS.textures.uSkin },
      { binding: BINDINGS.textures.uDepth, filterable: false },
    ]);
    this.uniforms = device.createBuffer({
      label: 'skin.blurUniforms',
      size: SLOT * 2,
      usage: USAGE_UNIFORM_DST,
    });
    this.linear = device.createSampler({
      label: 'skin.linear',
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });
    this.nearest = device.createSampler({
      label: 'skin.nearest',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });
  }

  /** Whether any skin was kept for this frame. */
  get pending(): boolean {
    return this.commands.taken > 0;
  }

  /** A command for one skin draw's diffuse half, filled by the caller. */
  take(): DrawCommand {
    return this.commands.commands[takeCommand(this.commands)] as DrawCommand;
  }

  /** What one profile scatters, per channel, in metres: the last material to name it says. */
  setProfile(index: number, r: number, g: number, b: number): void {
    const at = Math.min(Math.max(Math.round(index), 0), SKIN_PROFILES - 1) * 4;
    this.profiles[at] = r;
    this.profiles[at + 1] = g;
    this.profiles[at + 2] = b;
  }

  /** The targets at the frame's size and sample count, made again only when either changes. */
  size(width: number, height: number, samples: number): void {
    if (
      this.diffuse !== null &&
      this.diffuse.width === width &&
      this.diffuse.height === height &&
      samples > 1 === (this.diffuseMsaa !== null) &&
      (this.diffuseMsaa === null || this.diffuseMsaa.sampleCount === samples)
    ) {
      return;
    }
    this.releaseTargets();
    const make = (label: string, count: number): GPUTexture =>
      this.device.createTexture({
        label,
        size: [width, height],
        format: SKIN_TARGET_FORMAT,
        sampleCount: count,
        usage: count > 1 ? 0x10 : USAGE_TARGET,
      });
    this.diffuse = make('skin.diffuse', 1);
    this.across = make('skin.across', 1);
    this.diffuseMsaa = samples > 1 ? make('skin.diffuseMsaa', samples) : null;
    this.diffuseView = this.diffuse.createView();
    this.acrossView = this.across.createView();
    this.diffuseMsaaView = this.diffuseMsaa?.createView() ?? null;
    this.groupAcross = null;
    this.groupDown = null;
  }

  /**
   * Every kept draw's diffuse into the target, against the frame's own depth, which it reads and
   * does not write. Called with no pass open on `encoder`.
   */
  drawDiffuse(
    encoder: GPUCommandEncoder,
    depth: GPUTextureView,
    issue: (pass: GPURenderPassEncoder, command: DrawCommand) => void,
    timestampWrites: GPURenderPassTimestampWrites | undefined,
  ): void {
    const target = this.diffuseView;
    if (target === null) return;
    const pass = encoder.beginRenderPass({
      label: 'skin.diffuse',
      timestampWrites,
      colorAttachments: [
        {
          view: this.diffuseMsaaView ?? target,
          resolveTarget: this.diffuseMsaaView === null ? undefined : target,
          clearValue: [0, 0, 0, 0],
          loadOp: 'clear',
          storeOp: this.diffuseMsaaView === null ? 'store' : 'discard',
        },
      ],
      depthStencilAttachment: { view: depth, depthLoadOp: 'load', depthStoreOp: 'store' },
    });
    for (let i = 0; i < this.commands.taken; i += 1) {
      issue(pass, this.commands.commands[i] as DrawCommand);
    }
    pass.end();
  }

  /**
   * Across into the second target, then down and added into the frame's colour — `frame` the
   * attachment its pass draws into, `resolve` where a multisampled one resolves, `samples` its
   * count. `projection` is the frame's, `height` the frame's height in pixels.
   */
  spread(
    encoder: GPUCommandEncoder,
    pipelines: PipelineCache,
    depth: GPUTextureView,
    frame: GPUTextureView,
    resolve: GPUTextureView | null,
    samples: number,
    projection: ArrayLike<number>,
    inverseProjection: ArrayLike<number>,
    timestampWrites: () => GPURenderPassTimestampWrites | undefined,
  ): void {
    const diffuse = this.diffuse;
    if (diffuse === null || this.diffuseView === null || this.acrossView === null) return;
    if (this.groupAcross === null || this.groupDown === null || this.groupsDepth !== depth) {
      this.groupAcross = this.group('skin.blurAcross', this.diffuseView, depth);
      this.groupDown = this.group('skin.blurDown', this.acrossView, depth);
      this.groupsDepth = depth;
    }
    this.writeUniforms(diffuse.width, diffuse.height, projection, inverseProjection);

    const across = postPipeline(
      pipelines,
      this.device,
      this.layout,
      'skin.blurAcross',
      SKIN_BLUR_FRAG_WGSL,
      SKIN_TARGET_FORMAT,
    );
    const down = postPipelineTargets(
      pipelines,
      this.device,
      this.layout,
      `skin.blurDown:${pipelines.format}:${samples}`,
      SKIN_BLUR_FRAG_WGSL,
      [
        {
          format: pipelines.format,
          /* Added: its colour onto the frame's, the frame's alpha kept. */
          blend: {
            color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
            alpha: SCENE_ALPHA_KEEPS,
          },
        },
      ],
      samples,
    );

    const first = encoder.beginRenderPass({
      label: 'skin.blurAcross',
      timestampWrites: timestampWrites(),
      colorAttachments: [
        { view: this.acrossView, clearValue: [0, 0, 0, 0], loadOp: 'clear', storeOp: 'store' },
      ],
    });
    first.setPipeline(across);
    first.setBindGroup(0, this.groupAcross, [0]);
    first.draw(3);
    first.end();

    const second = encoder.beginRenderPass({
      label: 'skin.blurDown',
      timestampWrites: timestampWrites(),
      colorAttachments: [
        {
          view: frame,
          resolveTarget: resolve ?? undefined,
          loadOp: 'load',
          storeOp: 'store',
        },
      ],
    });
    second.setPipeline(down);
    second.setBindGroup(0, this.groupDown, [SLOT]);
    second.draw(3);
    second.end();
  }

  /** Spent at the frame's start: the kept draws were this frame's. */
  reset(): void {
    resetPool(this.commands);
  }

  dispose(): void {
    this.releaseTargets();
    this.uniforms.destroy();
  }

  private group(label: string, skin: GPUTextureView, depth: GPUTextureView): GPUBindGroup {
    return this.device.createBindGroup({
      label,
      layout: this.layout,
      entries: [
        {
          binding: BINDINGS.uniforms,
          resource: { buffer: this.uniforms, size: BINDINGS.uniformSize },
        },
        { binding: BINDINGS.textures.uSkin.texture, resource: skin },
        { binding: BINDINGS.textures.uSkin.sampler, resource: this.linear },
        { binding: BINDINGS.textures.uDepth.texture, resource: depth },
        { binding: BINDINGS.textures.uDepth.sampler, resource: this.nearest },
      ],
    });
  }

  /** Both axes' blocks: the step along each, and what they share. Column-major matrices. */
  private writeUniforms(
    width: number,
    height: number,
    projection: ArrayLike<number>,
    inverse: ArrayLike<number>,
  ): void {
    const f = this.staging;
    const fields = BINDINGS.fields;
    for (let axis = 0; axis < 2; axis += 1) {
      const base = (axis * SLOT) / 4;
      f[base + fields.uStep.offset / 4] = axis === 0 ? 1 / width : 0;
      f[base + fields.uStep.offset / 4 + 1] = axis === 0 ? 0 : 1 / height;
      /* The four terms that carry a depth back to view-space metres: the occlusion blur's own. */
      const toZ = base + fields.uDepthToViewZ.offset / 4;
      f[toZ] = (inverse[10] as number) ?? 0;
      f[toZ + 1] = (inverse[14] as number) ?? 0;
      f[toZ + 2] = (inverse[11] as number) ?? 0;
      f[toZ + 3] = (inverse[15] as number) ?? 1;
      /* Pixels a metre spans at a metre: the vertical focal length, which is the horizontal one
         too wherever a pixel is square. */
      f[base + fields.uFocal.offset / 4] = ((projection[5] as number) * height) / 2;
      f.set(this.profiles, base + fields.uProfiles.offset / 4);
    }
    this.device.queue.writeBuffer(this.uniforms, 0, f);
  }

  private releaseTargets(): void {
    this.diffuse?.destroy();
    this.diffuseMsaa?.destroy();
    this.across?.destroy();
    this.diffuse = null;
    this.diffuseMsaa = null;
    this.across = null;
    this.diffuseView = null;
    this.diffuseMsaaView = null;
    this.acrossView = null;
  }
}
