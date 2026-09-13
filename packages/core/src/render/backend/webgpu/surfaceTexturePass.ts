import type { SurfaceTextureOptions } from '../../surfaceTexture.ts';
import type { PipelineCache } from './pipelineCache.ts';
import { shaderModule } from './shaderModules.ts';

/**
 * A caller's image on the device, and the mip chain WebGPU will not build for it.
 *
 * The boundary is `surfaceTexture.ts`'s and is unchanged: the engine ships no image assets and
 * fetches nothing, so what arrives is a `TexImageSource` the consumer already has. This owns
 * the texture and the sampler; where the pixels came from stays the caller's business.
 *
 * **The one real difference from WebGL2 is mipmaps.** `gl.generateMipmap` is a single call and
 * WebGPU has no equivalent at all — a chain is built by rendering each level from the one above
 * it. So this carries a blit pipeline and spends a render pass per level, once, at upload.
 * Everything else is a rename: `UNPACK_FLIP_Y_WEBGL` is `flipY` on the copy, `SRGB8_ALPHA8` is
 * the `-srgb` format suffix, and anisotropy is a sampler field rather than an extension.
 */

const DEFAULT_ANISOTROPY = 4;

/**
 * The blit that fills one mip level from the level above it.
 *
 * A fullscreen triangle from `vertex_index` rather than a quad from a buffer, because this
 * shader is this file's own — it is not generated from GLSL and has no WebGL2 counterpart to
 * stay honest against. `textureSampleLevel` at 0 reads the source view, which is a single level.
 */
const MIP_WGSL = `
struct Varying {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
}

@vertex
fn vertexMain(@builtin(vertex_index) index: u32) -> Varying {
  var out: Varying;
  let x = f32((index << 1u) & 2u);
  let y = f32(index & 2u);
  out.uv = vec2<f32>(x, y);
  out.position = vec4<f32>(x * 2.0 - 1.0, 1.0 - y * 2.0, 0.0, 1.0);
  return out;
}

@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;

@fragment
fn fragmentMain(in: Varying) -> @location(0) vec4<f32> {
  return textureSampleLevel(source, samp, in.uv, 0.0);
}
`;

/** How many levels an image of this size has, counting the one it arrives with. */
export function mipLevelCount(width: number, height: number): number {
  return Math.floor(Math.log2(Math.max(width, height))) + 1;
}

function sourceSize(source: TexImageSource): { width: number; height: number } {
  const candidate = source as {
    width?: number;
    height?: number;
    videoWidth?: number;
    videoHeight?: number;
  };
  const width = candidate.videoWidth ?? candidate.width ?? 0;
  const height = candidate.videoHeight ?? candidate.height ?? 0;
  return { width: Math.max(1, width), height: Math.max(1, height) };
}

/** An image uploaded once and bound per material. */
export class GpuSurfaceTexture {
  readonly view: GPUTextureView;
  readonly sampler: GPUSampler;

  private texture: GPUTexture | null;
  private readonly format: GPUTextureFormat;
  private readonly mipmapped: boolean;
  private readonly levels: number;
  private readonly width: number;
  private readonly height: number;

  constructor(
    private readonly device: GPUDevice,
    private readonly pipelines: PipelineCache,
    source: TexImageSource,
    options: SurfaceTextureOptions = {},
  ) {
    const { width, height } = sourceSize(source);
    this.width = width;
    this.height = height;
    this.mipmapped = options.mipmap ?? true;
    this.levels = this.mipmapped ? mipLevelCount(width, height) : 1;
    /* `SRGB8_ALPHA8`'s equivalent. Decoded in the sampler, before filtering, which is the only
       place it is correct — `surfaceTexture.ts` makes the argument in full. */
    this.format = (options.colorSpace ?? 'linear') === 'srgb' ? 'rgba8unorm-srgb' : 'rgba8unorm';

    this.texture = device.createTexture({
      label: 'surface.texture',
      size: [width, height],
      format: this.format,
      mipLevelCount: this.levels,
      /*
       * **`RENDER_ATTACHMENT` is required by `copyExternalImageToTexture`, not by the mip
       * chain**, and the difference matters enough to state.
       *
       * This used to say the flag was there "because building the chain renders into levels 1
       * and below", which is true and is not the reason. The upload itself demands it: Dawn
       * rejects a destination without `CopyDst | RenderAttachment` outright, whatever its mip
       * count. Gating it on `levels > 1` therefore breaks every unmipped texture, and the read
       * of the old comment that led there cost a broken build to disprove.
       *
       * So it cannot be dropped to make a sampled-only allocation, and anything that wants one
       * has to leave `copyExternalImageToTexture` behind and write raw pixels instead, which
       * trades a driver cost for a CPU readback.
       */
      usage: 0x2 | 0x4 | 0x10, // COPY_DST | TEXTURE_BINDING | RENDER_ATTACHMENT
    });
    this.view = this.texture.createView();

    const wrap: GPUAddressMode =
      (options.wrap ?? 'repeat') === 'repeat' ? 'repeat' : 'clamp-to-edge';
    /*
     * Nearest where the caller said their pixels are the subject. `mipmapFilter` stays as it was:
     * the choice is about magnification, and taking the nearest mip *level* as well would trade a
     * smear for a visible pop as the camera pulls back. See `SurfaceTextureOptions.filter`.
     */
    const nearest = options.filter === 'nearest';
    this.sampler = device.createSampler({
      label: 'surface.sampler',
      addressModeU: wrap,
      addressModeV: wrap,
      magFilter: nearest ? 'nearest' : 'linear',
      minFilter: nearest ? 'nearest' : 'linear',
      mipmapFilter: this.mipmapped ? 'linear' : 'nearest',
      /*
       * A sampler field here, where WebGL2 needs `EXT_texture_filter_anisotropic`. **Only legal
       * above 1 when every filter is `linear`**, which is why it is gated on the mip chain — with
       * `mipmapFilter: 'nearest'` a value above 1 is a validation error rather than a nicety — and
       * now on the filter too.
       *
       * **That second gate is a real asymmetry between the backends and not a tidy-up.** WebGL2
       * accepts the anisotropy parameter beside `NEAREST` and simply gets nothing useful from it;
       * WebGPU refuses the sampler outright, and a refused sampler is a bind group that never
       * builds and a frame that draws nothing at all. So a caller asking for nearest gets 1 here
       * and an ignored request there, which is the same picture by two routes.
       */
      maxAnisotropy:
        this.mipmapped && !nearest
          ? Math.max(1, Math.floor(options.anisotropy ?? DEFAULT_ANISOTROPY))
          : 1,
    });

    this.upload(source);
  }

  /**
   * Replace the pixels, keeping the texture, its view and its sampler.
   *
   * The binding a draw loop already holds stays valid, so the swap is a swap rather than a
   * rebuild — the same argument `surfaceTexture.ts` makes. Not a hot path: it re-uploads the
   * whole image and rebuilds the chain.
   */
  update(source: TexImageSource): void {
    if (this.texture === null) return;
    this.upload(source);
  }

  dispose(): void {
    if (this.texture === null) return;
    this.texture.destroy();
    this.texture = null;
  }

  private upload(source: TexImageSource): void {
    const texture = this.texture;
    if (texture === null) return;
    /*
     * **No flip, matching WebGL2 — and this is where the two APIs differ most quietly.**
     *
     * `UNPACK_FLIP_Y_WEBGL` is ignored for an `ImageBitmap` and honoured for a canvas, so that
     * backend flipped one source type and not the other. `copyExternalImageToTexture`'s `flipY`
     * has no such exception and flips both. So a `flipY: true` here was *self*-consistent and
     * disagreed with WebGL2 on exactly the sources `drftLoader` uses for every model texture.
     *
     * The orientation check that passed this backend was run on a canvas alone, where the two
     * agreed. Measure both source types, or a texture pipeline is half tested.
     */
    this.device.queue.copyExternalImageToTexture(
      { source: source as GPUCopyExternalImageSource, flipY: false },
      { texture },
      [this.width, this.height],
    );
    if (this.levels > 1) this.generateMips(texture);
  }

  /**
   * Each level rendered from the one above it, which is what WebGPU asks for instead of a call.
   *
   * One encoder and one pass per level, submitted together. The source view is a single level
   * so the sample cannot read the level being written, which would be the same texture bound as
   * an attachment and a resource at once — rejected, and rejected silently enough to matter.
   */
  private generateMips(texture: GPUTexture): void {
    const pipeline = this.mipPipeline();
    const sampler = this.device.createSampler({
      label: 'surface.mipSampler',
      magFilter: 'linear',
      minFilter: 'linear',
    });
    const encoder = this.device.createCommandEncoder({ label: 'surface.mips' });
    for (let level = 1; level < this.levels; level++) {
      const source = texture.createView({ baseMipLevel: level - 1, mipLevelCount: 1 });
      const target = texture.createView({ baseMipLevel: level, mipLevelCount: 1 });
      const pass = encoder.beginRenderPass({
        label: `surface.mip${level}`,
        colorAttachments: [
          { view: target, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] },
        ],
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(
        0,
        this.device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: source },
            { binding: 1, resource: sampler },
          ],
        }),
      );
      pass.draw(3);
      pass.end();
    }
    this.device.queue.submit([encoder.finish()]);
  }

  /**
   * Cached per format, because the two differ: an `-srgb` target encodes on write, and blitting
   * a linear chain through a pipeline declared for the other one is a gamma error per level.
   */
  private mipPipeline(): GPURenderPipeline {
    return this.pipelines.get(`surface.mip:${this.format}`, () => ({
      label: `surface.mip:${this.format}`,
      layout: 'auto' as const,
      vertex: {
        module: shaderModule(this.device, { label: 'surface.mip', code: MIP_WGSL }),
        entryPoint: 'vertexMain',
      },
      fragment: {
        module: shaderModule(this.device, { label: 'surface.mip', code: MIP_WGSL }),
        entryPoint: 'fragmentMain',
        targets: [{ format: this.format }],
      },
      primitive: { topology: 'triangle-list' as const },
    }));
  }
}
