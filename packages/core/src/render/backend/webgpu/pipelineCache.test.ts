import { describe, expect, it, vi } from 'vitest';

import { PipelineCache } from './pipelineCache.ts';

/*
 * Pipeline creation is the expensive operation in WebGPU, and `AGENTS.md` forbids allocating
 * in a per-frame path. A pipeline is built once per distinct state and looked up by a string
 * key thereafter, and the key is built at construction time rather than per frame.
 */
describe('the pipeline cache', () => {
  it('builds a pipeline once and returns the same one after', () => {
    const createRenderPipeline = vi.fn(() => ({ id: 1 }));
    const cache = new PipelineCache({ createRenderPipeline } as unknown as GPUDevice, 'bgra8unorm');
    const describe_ = () => ({}) as GPURenderPipelineDescriptor;

    const a = cache.get('flat:opaque', describe_);
    const b = cache.get('flat:opaque', describe_);

    expect(a).toBe(b);
    expect(createRenderPipeline).toHaveBeenCalledTimes(1);
  });

  /*
   * The describe callback must not run on a hit either: building a descriptor allocates, and
   * a hot path that allocates only on a cache hit is still a hot path that allocates.
   */
  it('does not build a descriptor on a hit', () => {
    const cache = new PipelineCache(
      { createRenderPipeline: vi.fn(() => ({})) } as unknown as GPUDevice,
      'bgra8unorm',
    );
    const describe_ = vi.fn(() => ({}) as GPURenderPipelineDescriptor);

    cache.get('k', describe_);
    cache.get('k', describe_);

    expect(describe_).toHaveBeenCalledTimes(1);
  });

  it('keeps distinct keys apart', () => {
    const createRenderPipeline = vi.fn((d: GPURenderPipelineDescriptor) => ({ label: d.label }));
    const cache = new PipelineCache({ createRenderPipeline } as unknown as GPUDevice, 'bgra8unorm');

    const opaque = cache.get('flat:opaque', () => ({ label: 'a' }) as GPURenderPipelineDescriptor);
    const blended = cache.get('flat:blend', () => ({ label: 'b' }) as GPURenderPipelineDescriptor);

    expect(opaque).not.toBe(blended);
    expect(createRenderPipeline).toHaveBeenCalledTimes(2);
  });

  it('reports the format it builds against, since every pipeline needs it', () => {
    const cache = new PipelineCache(
      { createRenderPipeline: vi.fn(() => ({})) } as unknown as GPUDevice,
      'rgba8unorm',
    );
    expect(cache.format).toBe('rgba8unorm');
  });

  /* Disposing drops the pipelines so a rebuilt renderer does not hand out dead ones. */
  it('is empty after disposal', () => {
    const createRenderPipeline = vi.fn(() => ({}));
    const cache = new PipelineCache({ createRenderPipeline } as unknown as GPUDevice, 'bgra8unorm');
    const describe_ = () => ({}) as GPURenderPipelineDescriptor;

    cache.get('k', describe_);
    cache.dispose();
    cache.get('k', describe_);

    expect(createRenderPipeline).toHaveBeenCalledTimes(2);
    expect(cache.size).toBe(1);
  });
});
