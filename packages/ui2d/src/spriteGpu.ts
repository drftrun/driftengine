/** The WebGPU half of the sprite pass: one pipeline, one instance buffer, a bind group per slot. */

import {
  SPRITE_BINDINGS,
  SPRITE_FRAG_WGSL,
  SPRITE_VERT_WGSL,
} from './shaders/generated/sprite.wgsl.ts';
import { SPRITE_FLOATS } from './spriteBatch.ts';
import type { SpriteBatch } from './spriteBatch.ts';
/*
 * **The first runtime import this package takes from the engine, and it was measured before it was
 * taken.** Everything else here is `import type`, which erases, so `ui2d` has had no runtime edge
 * to `core` at all — and a value import from a barrel is how a package quietly acquires the whole
 * of another one. Bundled alone, with the import and with it stubbed out: **32,801 against 31,031
 * raw and 11,777 against 11,163 gzipped**, so 614 gzipped bytes, which is the blit and its shader
 * and nothing else. The alternative was a second copy of the mip blit living here, and the second
 * copy is the one that ends up disagreeing about the colour space.
 */
import { generateMipChain, mipLevelCount, type MipPipelines } from '@driftengine/core';
import type { SpriteImage, SpriteTextureOptions } from './spriteTexture.ts';

const VERT = SPRITE_BINDINGS.SPRITE_VERT;
const FRAG = SPRITE_BINDINGS.SPRITE_FRAG;

const STRIDE = SPRITE_FLOATS * 4;
const STAGE_VERTEX = 1; // GPUShaderStage.VERTEX
const STAGE_FRAGMENT = 2; // GPUShaderStage.FRAGMENT
const UNIFORM_COPY_DST = 64 | 8; // GPUBufferUsage.UNIFORM | COPY_DST
const VERTEX_COPY_DST = 32 | 8; // GPUBufferUsage.VERTEX | COPY_DST
const TEXTURE_USAGE = 4 | 2 | 16; // TEXTURE_BINDING | COPY_DST | RENDER_ATTACHMENT

export interface GpuSpriteSlot {
  readonly texture: GPUTexture;
  readonly bindGroup: GPUBindGroup;
}

export interface GpuSprites {
  readonly pipeline: GPURenderPipeline;
  readonly layout: GPUBindGroupLayout;
  readonly vertexUniforms: GPUBuffer;
  readonly fragmentUniforms: GPUBuffer;
  readonly instances: GPUBuffer;
  readonly samplers: {
    readonly nearest: GPUSampler;
    readonly linear: GPUSampler;
    readonly nearestMip: GPUSampler;
    readonly linearMip: GPUSampler;
  };
  /** One mip-blit pipeline per format, built on first use. See `generateMipChain`. */
  readonly mipPipelines: MipPipelines;
  readonly slots: (GpuSpriteSlot | null)[];
  readonly vertexScratch: ArrayBuffer;
  readonly vertexFloats: Float32Array;
  readonly fragmentScratch: ArrayBuffer;
  readonly fragmentFloats: Float32Array;
  readonly fragmentInts: Int32Array;
}

export function createGpuSprites(
  device: GPUDevice,
  format: GPUTextureFormat,
  depthFormat: GPUTextureFormat,
  samples: number,
  capacity: number,
  slots: number,
  label: string,
): GpuSprites {
  const layout = device.createBindGroupLayout({
    label: `${label}.layout`,
    entries: [
      { binding: VERT.uniforms, visibility: STAGE_VERTEX, buffer: { type: 'uniform' } },
      { binding: FRAG.uniforms, visibility: STAGE_FRAGMENT, buffer: { type: 'uniform' } },
      {
        binding: FRAG.textures.uSpriteTexture.texture,
        visibility: STAGE_FRAGMENT,
        texture: { sampleType: 'float' },
      },
      {
        binding: FRAG.textures.uSpriteTexture.sampler,
        visibility: STAGE_FRAGMENT,
        sampler: { type: 'filtering' },
      },
    ],
  });

  const pipeline = device.createRenderPipeline({
    label,
    layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
    vertex: {
      module: device.createShaderModule({ label: `${label}.vert`, code: SPRITE_VERT_WGSL }),
      entryPoint: 'main',
      buffers: [
        {
          arrayStride: STRIDE,
          stepMode: 'instance',
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x4' },
            { shaderLocation: 1, offset: 16, format: 'float32x4' },
            { shaderLocation: 2, offset: 32, format: 'float32x4' },
            { shaderLocation: 3, offset: 48, format: 'float32x2' },
          ],
        },
      ],
    },
    fragment: {
      module: device.createShaderModule({ label: `${label}.frag`, code: SPRITE_FRAG_WGSL }),
      entryPoint: 'main',
      targets: [
        {
          format,
          /* Premultiplied `over`, matching the WebGL2 half exactly. */
          blend: {
            color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          },
        },
      ],
    },
    /*
     * Nothing is culled: a sprite is mirrored by giving it a negative width, which reverses its
     * winding, and a character facing left is exactly that.
     */
    primitive: { topology: 'triangle-list', cullMode: 'none' },
    multisample: { count: samples },
    /*
     * Neither tested nor written. The 2D layer's order *is* its layering — there is no z to sort
     * by — and a pass that depth-tested would let whatever 3D geometry is in the frame punch holes
     * in an overlay drawn over it. Declared all the same, because a pipeline in a render pass that
     * has a depth attachment must name its format.
     */
    depthStencil: { format: depthFormat, depthWriteEnabled: false, depthCompare: 'always' },
  });

  const vertexUniforms = device.createBuffer({
    label: `${label}.vertexUniforms`,
    size: VERT.uniformSize,
    usage: UNIFORM_COPY_DST,
  });
  const fragmentUniforms = device.createBuffer({
    label: `${label}.fragmentUniforms`,
    size: FRAG.uniformSize,
    usage: UNIFORM_COPY_DST,
  });
  const instances = device.createBuffer({
    label: `${label}.instances`,
    size: capacity * STRIDE,
    usage: VERTEX_COPY_DST,
  });

  const vertexScratch = new ArrayBuffer(VERT.uniformSize);
  const fragmentScratch = new ArrayBuffer(FRAG.uniformSize);

  return {
    pipeline,
    layout,
    vertexUniforms,
    fragmentUniforms,
    instances,
    samplers: {
      nearest: device.createSampler({ label: `${label}.nearest` }),
      linear: device.createSampler({
        label: `${label}.linear`,
        magFilter: 'linear',
        minFilter: 'linear',
      }),
      /*
       * The mipmapped pair. `mipmapFilter` is the level blend and is `linear` in both, because
       * that is minification; `magFilter` is what `filter` was asked about. Four samplers rather
       * than two because the questions are independent, and the same split `SurfaceTexture` makes.
       */
      nearestMip: device.createSampler({
        label: `${label}.nearestMip`,
        mipmapFilter: 'linear',
      }),
      linearMip: device.createSampler({
        label: `${label}.linearMip`,
        magFilter: 'linear',
        minFilter: 'linear',
        mipmapFilter: 'linear',
      }),
    },
    mipPipelines: mipPipelineCache(device),
    slots: new Array<null>(slots).fill(null),
    vertexScratch,
    vertexFloats: new Float32Array(vertexScratch),
    fragmentScratch,
    fragmentFloats: new Float32Array(fragmentScratch),
    fragmentInts: new Int32Array(fragmentScratch),
  };
}

/**
 * One pipeline per format, kept on the sprite pass rather than in the renderer's cache.
 *
 * The renderer's `PipelineCache` is not reachable from a contributed pass, and the chain builder
 * takes an interface for exactly that reason. A `Map` is the whole of what is needed: there are at
 * most two formats here, and they are built once each.
 */
function mipPipelineCache(device: GPUDevice): MipPipelines {
  const built = new Map<string, GPURenderPipeline>();
  return {
    get(key: string, describe: () => GPURenderPipelineDescriptor): GPURenderPipeline {
      const existing = built.get(key);
      if (existing !== undefined) return existing;
      const pipeline = device.createRenderPipeline(describe());
      built.set(key, pipeline);
      return pipeline;
    },
  };
}

export function setGpuSpriteTexture(
  device: GPUDevice,
  sprites: GpuSprites,
  slot: number,
  source: SpriteImage,
  options: SpriteTextureOptions,
): void {
  const previous = sprites.slots[slot];
  if (previous !== null && previous !== undefined) previous.texture.destroy();
  const format: GPUTextureFormat =
    options.colorSpace === 'linear' ? 'rgba8unorm' : 'rgba8unorm-srgb';
  /* One level unless a chain was asked for. `TEXTURE_USAGE` already carries RENDER_ATTACHMENT,
     which is what the blit needs to draw into each level. */
  const levels = options.mipmap === true ? mipLevelCount(source.width, source.height) : 1;
  const texture = device.createTexture({
    label: `ui2d.sprite.${slot}`,
    size: [source.width, source.height],
    format,
    mipLevelCount: levels,
    usage: TEXTURE_USAGE,
  });
  /*
   * **No flip, matching WebGL2** — `surfaceTexture.ts` carries the whole argument and the bug it
   * came from: `UNPACK_FLIP_Y_WEBGL` is ignored for an `ImageBitmap` and honoured for a canvas, so
   * a `flipY: true` here would be self-consistent and disagree with the other backend on exactly
   * the source type most callers use.
   */
  device.queue.copyExternalImageToTexture(
    { source: source as GPUCopyExternalImageSource, flipY: false },
    { texture },
    [source.width, source.height],
  );
  /* After the copy, which is the only order that works: every level is rendered from the one above
     it, and level 0 has to hold the image before the chain can be built from it. */
  generateMipChain(device, sprites.mipPipelines, texture, format, levels);
  const linear = options.filter === 'linear';
  const sampler =
    levels > 1
      ? linear
        ? sprites.samplers.linearMip
        : sprites.samplers.nearestMip
      : linear
        ? sprites.samplers.linear
        : sprites.samplers.nearest;
  const bindGroup = device.createBindGroup({
    label: `ui2d.sprite.${slot}.bindGroup`,
    layout: sprites.layout,
    entries: [
      { binding: VERT.uniforms, resource: { buffer: sprites.vertexUniforms } },
      { binding: FRAG.uniforms, resource: { buffer: sprites.fragmentUniforms } },
      { binding: FRAG.textures.uSpriteTexture.texture, resource: texture.createView() },
      { binding: FRAG.textures.uSpriteTexture.sampler, resource: sampler },
    ],
  });
  sprites.slots[slot] = { texture, bindGroup };
}

/** The same one white texel, written straight into a texture. See the WebGL2 half for why. */
export function setGpuWhiteTexture(device: GPUDevice, sprites: GpuSprites, slot: number): void {
  const texture = device.createTexture({
    label: 'ui2d.sprite.white',
    size: [1, 1],
    /* Not `-srgb`: 255 is 255 either way, and a linear format says so without a decode. */
    format: 'rgba8unorm',
    usage: TEXTURE_USAGE,
  });
  device.queue.writeTexture(
    { texture },
    new Uint8Array([255, 255, 255, 255]),
    { bytesPerRow: 4 },
    [1, 1],
  );
  const bindGroup = device.createBindGroup({
    label: 'ui2d.sprite.white.bindGroup',
    layout: sprites.layout,
    entries: [
      { binding: VERT.uniforms, resource: { buffer: sprites.vertexUniforms } },
      { binding: FRAG.uniforms, resource: { buffer: sprites.fragmentUniforms } },
      { binding: FRAG.textures.uSpriteTexture.texture, resource: texture.createView() },
      { binding: FRAG.textures.uSpriteTexture.sampler, resource: sprites.samplers.nearest },
    ],
  });
  sprites.slots[slot] = { texture, bindGroup };
}

export function uploadGpuInstances(
  device: GPUDevice,
  sprites: GpuSprites,
  batch: SpriteBatch,
): void {
  if (batch.count === 0) return;
  device.queue.writeBuffer(
    sprites.instances,
    0,
    batch.instances.buffer,
    batch.instances.byteOffset,
    batch.count * STRIDE,
  );
}

export function drawGpuSprites(
  pass: GPURenderPassEncoder,
  sprites: GpuSprites,
  batch: SpriteBatch,
): void {
  if (batch.count === 0) return;
  pass.setPipeline(sprites.pipeline);
  for (let run = 0; run < batch.runCount; run += 1) {
    const at = run * 3;
    const slot = sprites.slots[batch.runs[at] as number];
    if (slot === null || slot === undefined) continue;
    const first = batch.runs[at + 1] as number;
    const count = batch.runs[at + 2] as number;
    pass.setBindGroup(0, slot.bindGroup);
    /*
     * The run's offset goes into the vertex buffer binding rather than into `firstInstance`,
     * which is the one place the two backends can be made to do the same arithmetic: WebGL2 has
     * no base-instance call at all and re-points its attributes the same way.
     */
    pass.setVertexBuffer(0, sprites.instances, first * STRIDE, count * STRIDE);
    pass.draw(6, count);
  }
}

export function disposeGpuSprites(sprites: GpuSprites): void {
  sprites.vertexUniforms.destroy();
  sprites.fragmentUniforms.destroy();
  sprites.instances.destroy();
  for (const slot of sprites.slots) if (slot !== null) slot.texture.destroy();
}
