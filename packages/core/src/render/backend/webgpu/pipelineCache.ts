/**
 * Render pipelines, built once and looked up by name.
 *
 * **Pipeline creation is the expensive operation in WebGPU** — it compiles shaders and
 * validates state — and `AGENTS.md` forbids allocating in a per-frame path. So a pipeline is
 * built once per distinct state and found by a string key thereafter.
 *
 * The key is the caller's to build, and it must be built at construction time rather than
 * per frame. A key assembled with template interpolation inside a draw call allocates a
 * string sixty times a second for every draw, which is the allocation this class exists to
 * avoid, moved rather than removed.
 */
export class PipelineCache {
  /**
   * The colour format every pipeline here targets, which is wherever the *world* lands.
   *
   * **Not the swap chain's, and the difference is the whole point.** Under a composite the world
   * is drawn into the scene target and only the resolve reaches the canvas, so a pipeline built
   * against the swap chain disagrees with its attachment — which WebGPU raises at `finish`,
   * dropping the frame's entire command buffer. Carried here for the same reason `sampleCount`
   * is: one number, read by every `describe` callback, so no pass can disagree with the target
   * it is about to be used on. `webgpu/renderer.ts` chooses it, once.
   */
  readonly format: GPUTextureFormat;

  /**
   * How many samples every pipeline here rasterises at.
   *
   * **Carried by the cache so no pipeline can disagree with the attachment.** A pipeline's
   * sample count must equal the colour target's exactly, and WebGPU rejects the mismatch at
   * draw time with a message about the pipeline rather than about the target — so a pass that
   * forgot to ask would fail somewhere other than where the mistake was made. One number, read
   * by every `describe` callback.
   */
  readonly sampleCount: number;

  private readonly device: GPUDevice;
  private readonly pipelines = new Map<string, GPURenderPipeline>();
  /**
   * Builds still compiling, by key, so two asks for one pipeline share a compile.
   *
   * **`createRenderPipeline` does not compile, it defers.** It returns in microseconds and
   * leaves the driver to finish the shader the first time something draws with it, which puts
   * the cost inside a frame instead of before one. Measured on an S23 Ultra: twelve pipelines
   * "built" in 3ms, then seven submits in a row each taking 5.2 seconds and all draining
   * together, with no allocation, no long task and an idle main thread the whole time. The
   * queue was blocked on compilation nobody had asked for yet.
   *
   * `createRenderPipelineAsync` is the API that exists for this. It compiles across the
   * driver's own threads and resolves when the pipeline is genuinely ready, so a renderer can
   * wait for readiness rather than discovering it mid-frame.
   */
  private readonly compiling = new Map<string, Promise<GPURenderPipeline>>();

  constructor(device: GPUDevice, format: GPUTextureFormat, sampleCount = 1) {
    this.device = device;
    this.format = format;
    this.sampleCount = sampleCount;
  }

  /** How many distinct pipelines have been built. Read by tests and diagnostics. */
  get size(): number {
    return this.pipelines.size;
  }

  /**
   * The pipeline for this key, compiled off the main thread.
   *
   * Preferred wherever the caller is not inside a frame, which `get`'s own contract says is
   * everywhere: pipelines are built once per distinct state at construction time. The
   * difference is only *when* the driver does the work, and that difference is the whole bug
   * this exists for.
   */
  async getAsync(
    key: string,
    describe: () => GPURenderPipelineDescriptor,
  ): Promise<GPURenderPipeline> {
    const existing = this.pipelines.get(key);
    if (existing !== undefined) return existing;
    const inFlight = this.compiling.get(key);
    if (inFlight !== undefined) return inFlight;

    /*
     * **Falls back where the async form is missing.** It is part of the standard, but a device
     * can be a test double, a polyfill or an older implementation, and a renderer that throws
     * on a device which can still draw is worse than one that compiles the slow way. The
     * fallback keeps the same contract — a promise that resolves when the pipeline exists —
     * so nothing above here has to know which path it got.
     */
    const build =
      typeof this.device.createRenderPipelineAsync === 'function'
        ? this.device.createRenderPipelineAsync(describe())
        : Promise.resolve(this.device.createRenderPipeline(describe()));
    const promise = build.then((built) => {
      this.pipelines.set(key, built);
      this.compiling.delete(key);
      return built;
    });
    this.compiling.set(key, promise);
    return promise;
  }

  /**
   * Resolve once every pipeline asked for so far has finished compiling.
   *
   * A renderer awaits this before its first frame, which is what moves the compile out of the
   * queue and in front of it. A failure is not rethrown: a pipeline that cannot be built will
   * fail again, loudly, at the draw that needs it, and taking the whole boot down here would
   * turn one broken material into a blank page.
   */
  async ready(): Promise<void> {
    while (this.compiling.size > 0) {
      await Promise.allSettled([...this.compiling.values()]);
    }
  }

  /** The pipeline for this key if it is already built, without building one. */
  peek(key: string): GPURenderPipeline | undefined {
    return this.pipelines.get(key);
  }

  /** How many are still compiling. Read by tests and diagnostics. */
  get compilingCount(): number {
    return this.compiling.size;
  }

  /**
   * The pipeline for this key, building it on the first ask only.
   *
   * `describe` is a callback rather than a value because **building the descriptor allocates
   * too**: a nested object with vertex buffer layouts and blend state, constructed to be
   * thrown away on every hit. Passing a function means a hit costs one `Map` lookup.
   */
  get(key: string, describe: () => GPURenderPipelineDescriptor): GPURenderPipeline {
    const existing = this.pipelines.get(key);
    if (existing !== undefined) return existing;
    const built = this.device.createRenderPipeline(describe());
    this.pipelines.set(key, built);
    return built;
  }

  /**
   * Drop every pipeline.
   *
   * WebGPU has no explicit pipeline release — they are freed when nothing references them —
   * so this is about not handing out pipelines belonging to a destroyed device rather than
   * about reclaiming memory here and now.
   */
  dispose(): void {
    this.pipelines.clear();
  }
}
