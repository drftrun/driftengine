/**
 * The alpha step of a browser's image copy, done where the browser does it: on the device.
 *
 * **Chrome converts alpha in a copy with a shader**, Dawn's `CopyTextureForBrowser`: it divides a
 * premultiplied image's colour by its alpha, or multiplies a straight one's, in single precision on
 * the GPU, and into an sRGB texture it decodes the result first so the write's own encode lands on
 * it. This GPU's division is not correctly rounded, so no arithmetic on the CPU gives the same
 * bytes: a rounded `c · 255 / a` differed from Chrome on 4,299 of 65,024 (colour, alpha) pairs.
 * The same steps run here, in the same order and precision, on the same device.
 *
 * Measured 2026-09-19 against Chrome on this machine, for every colour at every alpha: the
 * divide and the multiply, into `rgba8unorm` and into `rgba8unorm-srgb` — see `device.test.ts` for
 * the pairs held as literals.
 *
 * **What it gives up: the bytes are this GPU's.** Another GPU divides differently, and so does
 * Chrome on it, so the claim is "what Chrome writes on the machine the host runs on", which is
 * the only thing a pixel gate on that machine can compare.
 */

/** Which conversion a copy needs. */
export type AlphaStep = 'unpremultiply' | 'premultiply';

const STEP_WGSL = /* wgsl */ `
struct Params {
  origin: vec2i,
  steps: u32,
  g: f32, a: f32, b: f32, c: f32, d: f32, e: f32, f: f32,
}

@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var<uniform> params: Params;

@vertex
fn vertexMain(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  let x = f32((index << 1u) & 2u);
  let y = f32(index & 2u);
  return vec4f(x * 2.0 - 1.0, 1.0 - y * 2.0, 0.0, 1.0);
}

/* Dawn's parametric transfer function, as its copy shader writes it. */
fn transfer(v: f32) -> f32 {
  let absV = abs(v);
  let sgn = sign(v);
  if (absV < params.d) {
    return sgn * (params.c * absV + params.f);
  }
  return sgn * (pow(params.a * absV + params.b, params.g) + params.e);
}

@fragment
fn fragmentMain(@builtin(position) position: vec4f) -> @location(0) vec4f {
  var color = textureLoad(source, vec2i(position.xy) - params.origin, 0);
  if ((params.steps & 1u) != 0u) {
    if (color.a != 0.0) {
      color = vec4f(color.rgb / color.a, color.a);
    }
  }
  if ((params.steps & 2u) != 0u) {
    color = vec4f(color.rgb * color.a, color.a);
  }
  if ((params.steps & 4u) != 0u) {
    color = vec4f(transfer(color.r), transfer(color.g), transfer(color.b), color.a);
  }
  return color;
}
`;

/* Usage flags, named here rather than read off a global a host may not have installed. */
const COPY_DST = 0x2;
const TEXTURE_BINDING = 0x4;
const BUFFER_COPY_DST = 0x8;
const UNIFORM = 0x40;

const UNPREMULTIPLY = 1;
const PREMULTIPLY = 2;
const DECODE_FOR_SRGB = 4;

/**
 * The sRGB decode's parameters, as Dawn passes them: computed in double and stored as float, which
 * is what a `Float32Array` does with the same expressions.
 */
const SRGB_DECODE = [2.4, 1 / 1.055, 0.055 / 1.055, 1 / 12.92, 0.04045, 0, 0];

/** 48 bytes: the struct is 40, and a uniform binding is sized in sixteens. */
const PARAMS_BYTES = 48;

export class AlphaCopier {
  private readonly device: GPUDevice;
  private readonly pipelines = new Map<GPUTextureFormat, GPURenderPipeline>();
  private module: GPUShaderModule | null = null;

  constructor(device: GPUDevice) {
    this.device = device;
  }

  /**
   * Write an image through `step` into `destination`: `bytes` are four a texel, `imageWidth` wide,
   * and the top-left `width` by `height` of them is what is copied.
   *
   * The destination must allow rendering into it, which a copy's destination already must
   * (`copyExternalImageToTexture` asks for `RENDER_ATTACHMENT`). Submitted here, so it is ordered
   * on the queue where the copy it stands in for was called.
   */
  copy(
    bytes: Uint8Array,
    imageWidth: number,
    imageHeight: number,
    step: AlphaStep,
    destination: GPUCopyExternalImageDestInfo,
    width: number,
    height: number,
  ): void {
    const device = this.device;
    const target = destination.texture;
    const format = target.format;
    const origin = destination.origin as GPUOrigin3DDict | undefined;
    const x = origin?.x ?? 0;
    const y = origin?.y ?? 0;

    const source = device.createTexture({
      label: 'native alpha copy',
      size: [imageWidth, imageHeight],
      format: 'rgba8unorm',
      usage: COPY_DST | TEXTURE_BINDING,
    });
    device.queue.writeTexture({ texture: source }, bytes, { bytesPerRow: imageWidth * 4 }, [
      imageWidth,
      imageHeight,
    ]);

    const params = new ArrayBuffer(PARAMS_BYTES);
    new Int32Array(params, 0, 2).set([x, y]);
    const steps =
      (step === 'unpremultiply' ? UNPREMULTIPLY : PREMULTIPLY) |
      (format.endsWith('-srgb') ? DECODE_FOR_SRGB : 0);
    new Uint32Array(params, 8, 1)[0] = steps;
    new Float32Array(params, 12, 7).set(SRGB_DECODE);
    const uniforms = device.createBuffer({
      label: 'native alpha copy',
      size: PARAMS_BYTES,
      usage: UNIFORM | BUFFER_COPY_DST,
    });
    device.queue.writeBuffer(uniforms, 0, params);

    const pipeline = this.pipelineFor(format);
    const group = device.createBindGroup({
      label: 'native alpha copy',
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: source.createView() },
        { binding: 1, resource: { buffer: uniforms } },
      ],
    });
    const encoder = device.createCommandEncoder({ label: 'native alpha copy' });
    const pass = encoder.beginRenderPass({
      label: 'native alpha copy',
      colorAttachments: [
        {
          view: target.createView({
            dimension: '2d',
            baseMipLevel: destination.mipLevel ?? 0,
            mipLevelCount: 1,
            baseArrayLayer: origin?.z ?? 0,
            arrayLayerCount: 1,
          }),
          /* Kept, because the copy covers a rectangle and the rest of the level is not its own. */
          loadOp: 'load',
          storeOp: 'store',
        },
      ],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.setViewport(x, y, width, height, 0, 1);
    pass.setScissorRect(x, y, width, height);
    pass.draw(3);
    pass.end();
    device.queue.submit([encoder.finish()]);
    /* Released once the work that reads them is done; Dawn's binding asserts on a release under
       work in flight. */
    void device.queue.onSubmittedWorkDone().then(() => {
      source.destroy();
      uniforms.destroy();
    });
  }

  private pipelineFor(format: GPUTextureFormat): GPURenderPipeline {
    const held = this.pipelines.get(format);
    if (held !== undefined) return held;
    this.module ??= this.device.createShaderModule({ label: 'native alpha copy', code: STEP_WGSL });
    const pipeline = this.device.createRenderPipeline({
      label: 'native alpha copy',
      layout: 'auto',
      vertex: { module: this.module, entryPoint: 'vertexMain' },
      fragment: { module: this.module, entryPoint: 'fragmentMain', targets: [{ format }] },
      primitive: { topology: 'triangle-list' },
    });
    this.pipelines.set(format, pipeline);
    return pipeline;
  }
}
