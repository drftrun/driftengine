import { DEPTH_FORMAT } from '../../depthConvention.ts';

/**
 * A scene capture's attachments on WebGPU: the depth and, above one sample, the multisampled colour
 * its pass draws into and resolves from — the capture's own texture being the resolve, since **a
 * texture cannot be both multisampled and sampled**. At the world's sample count and format, because
 * a capture draws the world with the world's pipelines: a pipeline whose count or format disagrees
 * with its attachment is rejected at `finish` and takes the whole capture with it. Remade only if
 * either has changed since. See `sceneCapture.ts` for what a capture is.
 */
export class GpuSceneCaptureTarget {
  private depth: GPUTexture | null = null;
  private depthView: GPUTextureView | null = null;
  private colorMsaa: GPUTexture | null = null;
  private colorMsaaView: GPUTextureView | null = null;
  private key = '';

  constructor(
    private readonly device: GPUDevice,
    readonly width: number,
    readonly height: number,
  ) {}

  attachments(
    samples: number,
    format: GPUTextureFormat,
  ): { depth: GPUTextureView; colorMsaa: GPUTextureView | null } {
    const key = `${samples}:${format}`;
    if (this.depthView === null || key !== this.key) {
      this.dispose();
      this.key = key;
      this.depth = this.device.createTexture({
        label: 'capture.depth',
        size: [this.width, this.height],
        format: DEPTH_FORMAT,
        sampleCount: samples,
        usage: 0x10, // RENDER_ATTACHMENT
      });
      this.depthView = this.depth.createView();
      this.colorMsaa =
        samples > 1
          ? this.device.createTexture({
              label: 'capture.colorMsaa',
              size: [this.width, this.height],
              format,
              sampleCount: samples,
              usage: 0x10, // RENDER_ATTACHMENT
            })
          : null;
      this.colorMsaaView = this.colorMsaa?.createView() ?? null;
    }
    return { depth: this.depthView as GPUTextureView, colorMsaa: this.colorMsaaView };
  }

  dispose(): void {
    this.depth?.destroy();
    this.colorMsaa?.destroy();
    this.depth = null;
    this.depthView = null;
    this.colorMsaa = null;
    this.colorMsaaView = null;
  }
}
