import { describe, expect, it, vi } from 'vitest';

import { createGpuSprites, setGpuSpriteTexture } from './spriteGpu.ts';
import type { SpriteImage } from './spriteTexture.ts';

/**
 * The WebGPU half of the mip chain, on a device that records rather than draws.
 *
 * **WebGPU has no `generateMipmap`**, so where the other backend sets one enum and makes one call,
 * this one asks for the levels at creation, renders each from the one above it, and picks a sampler
 * with a `mipmapFilter`. Three things that have to agree, none of which a screenshot distinguishes
 * from a sheet that happened to sample well.
 */
function fakeDevice() {
  const textures: GPUTextureDescriptor[] = [];
  const samplers: GPUSamplerDescriptor[] = [];
  const passes: string[] = [];
  const device = {
    createTexture: vi.fn((descriptor: GPUTextureDescriptor) => {
      textures.push(descriptor);
      return { createView: vi.fn(() => ({})), destroy: vi.fn() };
    }),
    createSampler: vi.fn((descriptor: GPUSamplerDescriptor = {}) => {
      samplers.push(descriptor);
      return { __sampler: descriptor.label ?? '' };
    }),
    createBuffer: vi.fn(() => ({ destroy: vi.fn() })),
    createBindGroup: vi.fn((descriptor: GPUBindGroupDescriptor) => ({
      entries: descriptor.entries,
    })),
    createBindGroupLayout: vi.fn(() => ({})),
    createPipelineLayout: vi.fn(() => ({})),
    createShaderModule: vi.fn(() => ({})),
    createRenderPipeline: vi.fn(() => ({ getBindGroupLayout: vi.fn(() => ({})) })),
    createCommandEncoder: vi.fn(() => ({
      beginRenderPass: vi.fn((descriptor: GPURenderPassDescriptor) => {
        passes.push(String(descriptor.label ?? ''));
        return {
          setPipeline: vi.fn(),
          setBindGroup: vi.fn(),
          draw: vi.fn(),
          end: vi.fn(),
        };
      }),
      finish: vi.fn(() => ({})),
    })),
    queue: {
      writeBuffer: vi.fn(),
      writeTexture: vi.fn(),
      copyExternalImageToTexture: vi.fn(),
      submit: vi.fn(),
    },
  };
  return { textures, samplers, passes, device: device as unknown as GPUDevice };
}

/* 64 square, so a full chain is seven levels and the count is something to be wrong about. */
const IMAGE = { width: 64, height: 64 } as unknown as SpriteImage;

function sprites(device: GPUDevice) {
  return createGpuSprites(device, 'bgra8unorm', 'depth32float', 1, 16, 4, 'test');
}

describe('a mipmapped sprite sheet on WebGPU', () => {
  it('asks for one level unless a chain was requested', () => {
    const { device, textures, passes } = fakeDevice();
    setGpuSpriteTexture(device, sprites(device), 0, IMAGE, { filter: 'linear' });
    expect(textures.at(-1)?.mipLevelCount).toBe(1);
    expect(
      passes.filter((label) => label.startsWith('mip.')),
      'nothing blitted',
    ).toHaveLength(0);
  });

  it('asks for the whole chain when it was, and renders every level of it', () => {
    const { device, textures, passes } = fakeDevice();
    setGpuSpriteTexture(device, sprites(device), 0, IMAGE, { filter: 'linear', mipmap: true });
    /* 64 -> 1 is seven levels, and six blits to fill the six below the top. */
    expect(textures.at(-1)?.mipLevelCount).toBe(7);
    expect(passes.filter((label) => label.startsWith('mip.level'))).toHaveLength(6);
  });

  /*
   * **Which sampler reached the bind group, not which ones exist.** All four are built when the
   * pass is created, so asserting that one with a `mipmapFilter` exists passes whatever the upload
   * actually chose — the first version of this test did exactly that and survived the mutation
   * that stops the chain being sampled at all.
   */
  const boundSampler = (group: unknown): string => {
    const entries = (group as { entries?: readonly { resource?: unknown }[] }).entries ?? [];
    for (const entry of entries) {
      const label = (entry.resource as { __sampler?: string } | undefined)?.__sampler;
      if (typeof label === 'string') return label;
    }
    return '';
  };

  it('binds the sampler that blends between levels, not the one that ignores them', () => {
    const { device } = fakeDevice();
    const pass = sprites(device);
    setGpuSpriteTexture(device, pass, 0, IMAGE, { filter: 'linear', mipmap: true });
    expect(boundSampler(pass.slots[0]?.bindGroup)).toBe('test.linearMip');
  });

  it('binds the plain one when no chain was asked for', () => {
    const { device } = fakeDevice();
    const pass = sprites(device);
    setGpuSpriteTexture(device, pass, 0, IMAGE, { filter: 'linear' });
    expect(boundSampler(pass.slots[0]?.bindGroup)).toBe('test.linear');
  });

  it('keeps nearest magnification while still blending levels', () => {
    const { device } = fakeDevice();
    const pass = sprites(device);
    setGpuSpriteTexture(device, pass, 0, IMAGE, { filter: 'nearest', mipmap: true });
    expect(boundSampler(pass.slots[0]?.bindGroup)).toBe('test.nearestMip');
  });

  it('keeps the image at level zero before the chain is built from it', () => {
    const { device } = fakeDevice();
    const queue = device.queue as unknown as {
      copyExternalImageToTexture: { mock: { calls: unknown[] } };
    };
    setGpuSpriteTexture(device, sprites(device), 0, IMAGE, { filter: 'linear', mipmap: true });
    expect(queue.copyExternalImageToTexture.mock.calls).toHaveLength(1);
  });
});
