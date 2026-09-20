/**
 * Putting the engine's frame in the window: one full-screen triangle, reading the canvas's texture.
 *
 * **A browser presents a canvas by itself and a host has to.** The engine draws into the canvas's
 * current texture and stops; this copies that texture into the window's swap chain.
 *
 * **Decoded to linear on the way into an sRGB swap chain**, because Dawn's window renderer hands back
 * `bgra8unorm-srgb`, and writing into one encodes. The engine has already graded and encoded its
 * frame, so writing its bytes as they are would encode them a second time and every picture would
 * come out paler. Decoding first puts the engine's own bytes on the screen, within a step of
 * rounding. **The pixel gate reads the canvas texture, not the window**, so that rounding is on the
 * screen and never in a comparison.
 */

const BLIT_WGSL = /* wgsl */ `
@group(0) @binding(0) var frame: texture_2d<f32>;

@vertex
fn vertexMain(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  let x = f32((index << 1u) & 2u);
  let y = f32(index & 2u);
  return vec4f(x * 2.0 - 1.0, 1.0 - y * 2.0, 0.0, 1.0);
}

fn toLinear(encoded: vec3f) -> vec3f {
  let low = encoded / 12.92;
  let high = pow((encoded + 0.055) / 1.055, vec3f(2.4));
  return select(high, low, encoded <= vec3f(0.04045));
}

@fragment
fn fragmentMain(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let size = vec2i(textureDimensions(frame)) - vec2i(1, 1);
  let texel = textureLoad(frame, min(vec2i(position.xy), size), 0);
  return vec4f(DECODE(texel.rgb), 1.0);
}
`;

/** Whether writing into `format` encodes, so the blit has to decode first. */
export function encodesOnWrite(format: GPUTextureFormat): boolean {
  return format.endsWith('-srgb');
}

/** The blit's source, with the decode chosen for the swap chain it writes into. */
export function blitSource(target: GPUTextureFormat): string {
  return BLIT_WGSL.replace(
    'DECODE(texel.rgb)',
    encodesOnWrite(target) ? 'toLinear(texel.rgb)' : 'texel.rgb',
  );
}

/** One pipeline, and one bind group a frame texture, made when they are first needed. */
export class Presenter {
  private readonly device: GPUDevice;
  private readonly pipeline: GPURenderPipeline;
  private source: GPUTexture | null = null;
  private group: GPUBindGroup | null = null;

  constructor(device: GPUDevice, target: GPUTextureFormat) {
    this.device = device;
    const module = device.createShaderModule({ label: 'native present', code: blitSource(target) });
    this.pipeline = device.createRenderPipeline({
      label: 'native present',
      layout: 'auto',
      vertex: { module, entryPoint: 'vertexMain' },
      fragment: { module, entryPoint: 'fragmentMain', targets: [{ format: target }] },
      primitive: { topology: 'triangle-list' },
    });
  }

  /** Draw `frame` into `view`, and submit. */
  present(frame: GPUTexture, view: GPUTextureView): void {
    if (this.source !== frame) {
      this.source = frame;
      this.group = this.device.createBindGroup({
        label: 'native present',
        layout: this.pipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: frame.createView() }],
      });
    }
    const encoder = this.device.createCommandEncoder({ label: 'native present' });
    const pass = encoder.beginRenderPass({
      label: 'native present',
      colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.group);
    pass.draw(3);
    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }
}
