/**
 * The mip chain of the frame's refraction copy, recorded into the frame's own encoder.
 *
 * **Frosted glass reads a blurrier level of what is behind it** (`glass.ts`), so on a frame that draws
 * glass the copy needs every level filled from the one above. `generateMipChain` does that for an
 * upload, on an encoder of its own that it submits at once — which here would run before the frame's
 * encoder had even made the copy, and would build views and bind groups on every call. So this
 * makes them once per copy texture and records one pass per level wherever the copy was taken.
 *
 * What it costs is a render pass per level on every frame that takes the copy — about a dozen for a
 * 1080p copy, each a quarter of the one before, together about a third of the copy itself — and
 * nothing on a frame that shows nothing through anything. **A frame that refracts and draws no glass
 * pays it too**, and that is the trade: the copy is taken at the first draw that asks and shared by
 * every later one, so a glass pane drawn after a refracting one would otherwise read levels nothing
 * filled. WebGL2 fills its chain on the first glass draw instead, because a `generateMipmap` there
 * ends no pass. What would change it is knowing at the copy whether glass follows in the frame.
 */
import type { MipPipelines } from './surfaceTexturePass.ts';
import { mipBlitPipeline } from './surfaceTexturePass.ts';

export class SnapshotMips {
  private readonly pipeline: GPURenderPipeline;
  private readonly targets: GPUTextureView[] = [];
  private readonly groups: GPUBindGroup[] = [];

  constructor(
    device: GPUDevice,
    pipelines: MipPipelines,
    texture: GPUTexture,
    format: GPUTextureFormat,
    /** One layer of an array texture, where the chain is a layer's rather than the texture's. */
    layer: number | null = null,
    private readonly label = 'refract.mips',
  ) {
    this.pipeline = mipBlitPipeline(device, pipelines, format);
    const sampler = device.createSampler({
      label: 'refract.mips.sampler',
      magFilter: 'linear',
      minFilter: 'linear',
    });
    const layout = this.pipeline.getBindGroupLayout(0);
    const at =
      layer === null ? {} : { dimension: '2d' as const, baseArrayLayer: layer, arrayLayerCount: 1 };
    for (let level = 1; level < texture.mipLevelCount; level++) {
      const source = texture.createView({ ...at, baseMipLevel: level - 1, mipLevelCount: 1 });
      this.targets.push(texture.createView({ ...at, baseMipLevel: level, mipLevelCount: 1 }));
      this.groups.push(
        device.createBindGroup({
          label: `refract.mips.${String(level)}`,
          layout,
          entries: [
            { binding: 0, resource: source },
            { binding: 1, resource: sampler },
          ],
        }),
      );
    }
  }

  /** Fill every level from level 0, in `encoder`, after whatever wrote level 0 there. */
  record(encoder: GPUCommandEncoder): void {
    for (let i = 0; i < this.targets.length; i++) {
      const pass = encoder.beginRenderPass({
        label: this.label,
        colorAttachments: [
          {
            view: this.targets[i] as GPUTextureView,
            loadOp: 'clear',
            storeOp: 'store',
            clearValue: [0, 0, 0, 0],
          },
        ],
      });
      pass.setPipeline(this.pipeline);
      pass.setBindGroup(0, this.groups[i] as GPUBindGroup);
      pass.draw(3);
      pass.end();
    }
  }
}
