/**
 * The surface half of a reflection traced through the frame's materials, on this backend: the
 * frame's opaque lit draws again, against the depth they wrote, into two half-float targets — the
 * environment as the frame shows it with the surface's roughness, and what a reflection found in the
 * frame is multiplied by to land in its place. `shaders/flat/reflectionSurface.ts` is what the two
 * hold and why the swap is exact; this is where they are drawn.
 *
 * **Why a second pass and not a second output of the frame's.** Every pipeline drawn into the
 * frame's pass would have to declare a target it never writes — the sky, water, particles, text and
 * every pass a consumer registers — so the frame keeps its one attachment, and the lit stage's two
 * extra outputs land nowhere there. Here they land: the same pipelines with `REFLECTION_SURFACE` on,
 * which leaves before the lamps, the same bind groups and ring slots, tested `equal` against the
 * frame's depth so only what the frame kept writes.
 *
 * **The draws are commands, kept the way the skin's halves are** (`skinScatterPass.ts`): the frame
 * graph's pool is spent at every flush, and these are replayed after the flush that ends the frame's
 * pass. Each holds the ring slots its frame draw used, which stay valid until the frame's last
 * submit, after this has run.
 *
 * **What it costs**: every opaque lit draw twice, the second without its lamps; two half-float
 * targets the size of the frame. Single-sampled only, as the trace that reads them is.
 */
import { createCommandPool, resetPool, takeCommand } from './drawCommand.ts';
import type { CommandPool, DrawCommand } from './drawCommand.ts';

/** Both targets' format: linear light and a tint, which an eight-bit target would clip and band. */
export const REFLECTION_SURFACE_FORMAT: GPUTextureFormat = 'rgba16float';

const USAGE_TARGET = 0x10 | 0x4; // RENDER_ATTACHMENT | TEXTURE_BINDING

export class ReflectionSurfacePass {
  private readonly device: GPUDevice;
  private readonly commands: CommandPool = createCommandPool(256);
  private probe: GPUTexture | null = null;
  private tint: GPUTexture | null = null;
  /** The environment as the frame shows it, and the roughness in alpha. */
  probeView: GPUTextureView | null = null;
  /** What a found reflection is multiplied by. */
  tintView: GPUTextureView | null = null;

  constructor(device: GPUDevice) {
    this.device = device;
  }

  /** A command for one opaque lit draw's surface half, filled by the caller. */
  take(): DrawCommand {
    return this.commands.commands[takeCommand(this.commands)] as DrawCommand;
  }

  /** How many draws the frame kept. */
  get kept(): number {
    return this.commands.taken;
  }

  /** A new frame keeps nothing yet. */
  reset(): void {
    resetPool(this.commands);
  }

  /** The two targets at the frame's size, made again only when it changes. */
  size(width: number, height: number): void {
    if (this.probe !== null && this.probe.width === width && this.probe.height === height) return;
    this.release();
    const make = (label: string): GPUTexture =>
      this.device.createTexture({
        label,
        size: [width, height],
        format: REFLECTION_SURFACE_FORMAT,
        usage: USAGE_TARGET,
      });
    this.probe = make('reflection.probe');
    this.tint = make('reflection.tint');
    this.probeView = this.probe.createView();
    this.tintView = this.tint.createView();
  }

  /**
   * Every kept draw into the two targets against the frame's depth, which it reads and does not
   * write; both cleared first, so a pixel no lit surface reached reflects nothing. Called with no
   * pass open on `encoder`, and drawn even with nothing kept, since the clear is what the trace
   * reads there.
   */
  draw(
    encoder: GPUCommandEncoder,
    depth: GPUTextureView,
    issue: (pass: GPURenderPassEncoder, command: DrawCommand) => void,
  ): void {
    const probe = this.probeView;
    const tint = this.tintView;
    if (probe === null || tint === null) return;
    const pass = encoder.beginRenderPass({
      label: 'reflection.surface',
      colorAttachments: [
        null,
        { view: probe, clearValue: [0, 0, 0, 1], loadOp: 'clear', storeOp: 'store' },
        { view: tint, clearValue: [0, 0, 0, 0], loadOp: 'clear', storeOp: 'store' },
      ],
      depthStencilAttachment: { view: depth, depthReadOnly: true },
    });
    for (let i = 0; i < this.commands.taken; i += 1) {
      issue(pass, this.commands.commands[i] as DrawCommand);
    }
    pass.end();
  }

  release(): void {
    this.probe?.destroy();
    this.tint?.destroy();
    this.probe = null;
    this.tint = null;
    this.probeView = null;
    this.tintView = null;
  }
}
