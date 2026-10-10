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

/*
 * **A lit pipeline first needed inside a frame can be compiled without holding the frame.** Where
 * draws skip (`pipelineCompile: 'skip'`), a missing lit pipeline is started off the main thread and
 * answered as none, so the draw is left out; asked again while it compiles, the same compile is
 * shared; once it lands it is found. Where draws wait, the miss builds there, as every draw did.
 */
describe('a lit pipeline asked for inside a frame', () => {
  const device = () => {
    let land: (pipeline: GPURenderPipeline) => void = () => {};
    const createRenderPipelineAsync = vi.fn(
      () =>
        new Promise<GPURenderPipeline>((resolve) => {
          land = resolve;
        }),
    );
    const createRenderPipeline = vi.fn(() => ({ built: 'here' }) as unknown as GPURenderPipeline);
    return {
      gpu: { createRenderPipeline, createRenderPipelineAsync } as unknown as GPUDevice,
      createRenderPipeline,
      createRenderPipelineAsync,
      land: (pipeline: GPURenderPipeline) => land(pipeline),
    };
  };
  const describe_ = () => ({}) as GPURenderPipelineDescriptor;

  it('IS STARTED AND ANSWERED AS NONE WHERE DRAWS SKIP, SHARED WHILE IT COMPILES, AND FOUND ONCE IT LANDS', async () => {
    const d = device();
    const cache = new PipelineCache(d.gpu, 'rgba8unorm');
    cache.skipsCompiling = true;
    expect(cache.lit('flat:a|2s', describe_)).toBeNull();
    expect(cache.lit('flat:a|2s', describe_)).toBeNull();
    expect(d.createRenderPipelineAsync).toHaveBeenCalledTimes(1);
    expect(d.createRenderPipeline).not.toHaveBeenCalled();
    const landed = { landed: true } as unknown as GPURenderPipeline;
    d.land(landed);
    await cache.ready();
    expect(cache.lit('flat:a|2s', describe_)).toBe(landed);
  });

  /*
   * **A compile that fails is not waited on for ever, and is not skipped for ever.** `ready()` once
   * looped while a rejected compile stayed in the list; and a draw skipping a pipeline that will never
   * land would vanish without a word. So a failure leaves the list, and the next ask builds it where
   * it is asked for — where the device says what is wrong with it, loudly.
   */
  it('LETS A FAILED COMPILE GO, AND BUILDS IT WHERE IT IS NEXT ASKED FOR SO THE DEVICE SAYS WHY', async () => {
    const createRenderPipeline = vi.fn(() => ({ built: 'here' }) as unknown as GPURenderPipeline);
    const createRenderPipelineAsync = vi.fn(() => Promise.reject(new Error('no such entry point')));
    const cache = new PipelineCache(
      { createRenderPipeline, createRenderPipelineAsync } as unknown as GPUDevice,
      'rgba8unorm',
    );
    cache.skipsCompiling = true;
    expect(cache.lit('flat:broken', describe_)).toBeNull();
    await cache.ready();
    expect(cache.compilingCount).toBe(0);
    expect(cache.lit('flat:broken', describe_)).not.toBeNull();
    expect(createRenderPipeline).toHaveBeenCalledTimes(1);
  });

  it('IS BUILT WHERE IT IS ASKED FOR WHERE DRAWS WAIT', () => {
    const d = device();
    const cache = new PipelineCache(d.gpu, 'rgba8unorm');
    const pipeline = cache.lit('flat:a|2s', describe_);
    expect(pipeline).not.toBeNull();
    expect(d.createRenderPipeline).toHaveBeenCalledTimes(1);
    expect(d.createRenderPipelineAsync).not.toHaveBeenCalled();
  });
});

/*
 * **`ready()` waits for a switch's rebuild too.** Turning a lit switch on recompiles every lit
 * pipeline off the main thread; until the set lands, draws use the pipelines from before. `ready()`
 * says every compile asked for has finished, and a rebuild is compiles asked for, so a caller that
 * awaits it draws with the switch on — where it once resolved at once and a capture photographed
 * the frames before.
 */
it('WAITS IN ready() FOR A SWITCH’S REBUILD TO LAND', async () => {
  let land: (pipeline: GPURenderPipeline) => void = () => {};
  const createRenderPipelineAsync = vi.fn(
    () =>
      new Promise<GPURenderPipeline>((resolve) => {
        land = resolve;
      }),
  );
  const cache = new PipelineCache(
    {
      createRenderPipeline: vi.fn(() => ({}) as GPURenderPipeline),
      createRenderPipelineAsync,
    } as unknown as GPUDevice,
    'rgba8unorm',
  );
  cache.get('flat:a', () => ({}) as GPURenderPipelineDescriptor, true);
  void cache.enable('WORLD_UVS');
  let settled = false;
  const ready = cache.ready().then(() => {
    settled = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(settled, 'still compiling').toBe(false);
  land({ rebuilt: true } as unknown as GPURenderPipeline);
  await ready;
  expect(settled).toBe(true);
});
