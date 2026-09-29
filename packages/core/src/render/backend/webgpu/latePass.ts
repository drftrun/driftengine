/**
 * What a reconstructing frame draws after the upscale: its blended draws, at the output size.
 *
 * **Why late.** A blended surface writes no depth the motion pass could test against and has no
 * single motion per pixel — a caption over a wall is two surfaces moving two ways — so a
 * reconstruction can only smear it. Drawn after the resolve, at output resolution and unjittered,
 * it is as sharp as a native frame and has no history to ghost.
 *
 * **What it holds**: a command pool of its own, because the frame graph's pool is spent at every
 * scene flush and these must survive until the reconstruction has run; an output-size depth
 * target; and the pass that fills it from the render's depth. Cost: translucent pixels are shaded
 * at output resolution — 2.25x as many at ratio 1.5, only where translucency is — plus one
 * full-screen depth pass.
 */
import { DEPTH_CLEAR, DEPTH_FORMAT } from '../../depthConvention.ts';
import { LATE_DEPTH_WGSL } from '../../shaders/recon/lateDepth.wgsl.ts';
import type { CommandPool, DrawCommand } from './drawCommand.ts';
import { createCommandPool, resetPool, takeCommand } from './drawCommand.ts';

export class LatePass {
  private readonly device: GPUDevice;
  private readonly commands: CommandPool = createCommandPool(64);
  private depth: GPUTexture | null = null;
  private depthTextureView: GPUTextureView | null = null;
  private readonly layout: GPUBindGroupLayout;
  private readonly pipeline: GPURenderPipeline;
  private readonly sizes: GPUBuffer;
  private readonly sizeStaging = new Float32Array(4);
  private group: GPUBindGroup | null = null;
  private groupSource: GPUTextureView | null = null;

  constructor(device: GPUDevice) {
    this.device = device;
    this.layout = device.createBindGroupLayout({
      label: 'recon.lateDepth.layout',
      entries: [
        { binding: 0, visibility: 0x2, texture: { sampleType: 'depth' } },
        { binding: 1, visibility: 0x2, buffer: { type: 'uniform' } },
      ],
    });
    const module = device.createShaderModule({ label: 'recon.lateDepth', code: LATE_DEPTH_WGSL });
    this.pipeline = device.createRenderPipeline({
      label: 'recon.lateDepth',
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.layout] }),
      vertex: { module, entryPoint: 'lateDepthVert' },
      fragment: { module, entryPoint: 'lateDepthFrag', targets: [] },
      primitive: { topology: 'triangle-list' },
      depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: true, depthCompare: 'always' },
    });
    this.sizes = device.createBuffer({
      label: 'recon.lateDepth.sizes',
      size: 16,
      usage: 0x40 | 0x8, // UNIFORM | COPY_DST
    });
  }

  /** The output-size depth, (re)made when the output changes size. */
  depthView(width: number, height: number): GPUTextureView {
    if (this.depth === null || this.depth.width !== width || this.depth.height !== height) {
      this.depth?.destroy();
      this.depth = this.device.createTexture({
        label: 'recon.lateDepth',
        size: [width, height],
        format: DEPTH_FORMAT,
        usage: 0x10, // RENDER_ATTACHMENT
      });
      this.depthTextureView = this.depth.createView();
    }
    return this.depthTextureView as GPUTextureView;
  }

  /** Fill the output-size depth from `source`, the render's single-sample depth. */
  upscale(
    encoder: GPUCommandEncoder,
    source: GPUTextureView,
    renderWidth: number,
    renderHeight: number,
    outputWidth: number,
    outputHeight: number,
  ): void {
    const target = this.depthView(outputWidth, outputHeight);
    this.sizeStaging[0] = renderWidth;
    this.sizeStaging[1] = renderHeight;
    this.sizeStaging[2] = outputWidth;
    this.sizeStaging[3] = outputHeight;
    this.device.queue.writeBuffer(this.sizes, 0, this.sizeStaging);
    if (this.group === null || this.groupSource !== source) {
      this.group = this.device.createBindGroup({
        label: 'recon.lateDepth.group',
        layout: this.layout,
        entries: [
          { binding: 0, resource: source },
          { binding: 1, resource: { buffer: this.sizes } },
        ],
      });
      this.groupSource = source;
    }
    const pass = encoder.beginRenderPass({
      label: 'recon.lateDepth',
      colorAttachments: [],
      depthStencilAttachment: {
        view: target,
        depthClearValue: DEPTH_CLEAR,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
      },
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.group);
    pass.draw(3);
    pass.end();
  }

  /** A command slot for one late draw. Every field a caller uses it fills; see `takeCommand`. */
  take(): DrawCommand {
    const at = takeCommand(this.commands);
    const command = this.commands.commands[at] as DrawCommand;
    command.offsetCount = 0;
    command.vertexCount = 0;
    command.indexBuffer = null;
    command.indexed = false;
    command.instances = 1;
    return command;
  }

  /** Late draws recorded this frame. */
  get pending(): number {
    return this.commands.taken;
  }

  /** Every late draw, in the order it was recorded, through the renderer's own issue. */
  replay(
    pass: GPURenderPassEncoder,
    issue: (pass: GPURenderPassEncoder, command: DrawCommand) => void,
  ): void {
    for (let i = 0; i < this.commands.taken; i += 1) {
      const command = this.commands.commands[i];
      if (command !== undefined) issue(pass, command);
    }
  }

  reset(): void {
    resetPool(this.commands);
  }

  dispose(): void {
    this.depth?.destroy();
    this.depth = null;
    this.depthTextureView = null;
    this.sizes.destroy();
  }
}
