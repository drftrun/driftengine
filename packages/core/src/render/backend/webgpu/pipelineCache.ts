import { noLitSwitches, type LitSwitch } from '../../shaders/flat/glassTint.ts';

export type { LitSwitch };

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

  /**
   * Which of the lit stage's switches the pipelines built now have on: the pipeline-overridable
   * constants the generated lit shader branches on (`GLASS_SHADOWS` and `litSwitchesGlsl`), which
   * the device compiles away where they are off. Read by `flatPass` when it describes a pipeline.
   *
   * **Each is code a scene pays for in every lit pixel's registers whether it uses it or not**, so
   * each is off until it is used: glass until the renderer is offered a pane, a fixture until one is
   * loaded, the effects until a material carries a table, DriftLight until a volume is set — and
   * then on for good, through `enable`. Clustering is the profile's, fixed at construction. Every
   * scene paid for all of it from 4.5.0 to 4.8.1, and on a phone that was the lit pass: about 30%
   * of the lit shader's instructions for glass alone, measured on RADV. **What it costs** is the
   * frames between a feature's first use and its recompiled pipelines, which draw without it.
   */
  readonly litSwitches: Record<LitSwitch, boolean> = noLitSwitches();

  /** Whether glass may ever be switched on here: `glassShadows` other than `'off'`. */
  readonly glassShadows: boolean;

  /** How to describe each lit pipeline again, so `enable` can rebuild every one. */
  private readonly litDescribers = new Map<string, () => GPURenderPipelineDescriptor>();
  /** Bumped by every switch, so a lit build started before one is not kept after it. */
  private litGeneration = 0;
  /** The last rebuild, which the next one waits for so they land in the order they were asked. */
  private litRebuild: Promise<void> = Promise.resolve();

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

  constructor(
    device: GPUDevice,
    format: GPUTextureFormat,
    sampleCount = 1,
    glassShadows = true,
    /** The profile's `clusteredLights`, which compiles the clustered arm in or leaves it out. */
    clusteredLights = false,
  ) {
    this.device = device;
    this.format = format;
    this.sampleCount = sampleCount;
    this.glassShadows = glassShadows;
    this.litSwitches.CLUSTERED_LIGHTS = clusteredLights;
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
    /** Whether this is a lit pipeline, which `enable` rebuilds. See `litSwitches`. */
    lit = false,
  ): Promise<GPURenderPipeline> {
    if (lit) this.litDescribers.set(key, describe);
    const existing = this.pipelines.get(key);
    if (existing !== undefined) return existing;
    const inFlight = this.compiling.get(key);
    if (inFlight !== undefined) return inFlight;
    const generation = this.litGeneration;

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
      /* A lit pipeline started before a switch is not kept: the switch rebuilds it. */
      if (!lit || generation === this.litGeneration) this.pipelines.set(key, built);
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
  get(
    key: string,
    describe: () => GPURenderPipelineDescriptor,
    /** Whether this is a lit pipeline, which `enable` rebuilds. See `litSwitches`. */
    lit = false,
  ): GPURenderPipeline {
    if (lit) this.litDescribers.set(key, describe);
    const existing = this.pipelines.get(key);
    if (existing !== undefined) return existing;
    const built = this.device.createRenderPipeline(describe());
    this.pipelines.set(key, built);
    return built;
  }

  /**
   * Turn one of the lit stage's switches on, for every lit pipeline built from now on and every one
   * already built. See `litSwitches`.
   *
   * **The rebuilt set lands at once**, when every one of them has compiled, so no frame draws some
   * surfaces with a feature and others without. Until then the pipelines already built go on drawing
   * as they were. Once only: a switch is not turned off again when the last user of it leaves,
   * because a second switch would cost a second compile for a saving the first use showed was not
   * needed. Glass is never turned on where the profile asked for no glass shadows.
   */
  enable(feature: LitSwitch): Promise<void> {
    if (this.litSwitches[feature]) return this.litRebuild;
    if (feature === 'GLASS_SHADOWS' && !this.glassShadows) return this.litRebuild;
    this.litSwitches[feature] = true;
    this.litGeneration += 1;
    const generation = this.litGeneration;
    this.litRebuild = this.litRebuild.then(async () => {
      /* A later switch has its own rebuild, which describes every pipeline with this one on too. */
      if (generation !== this.litGeneration) return;
      const rebuilt = [...this.litDescribers].map(([key, describe]) => {
        const descriptor = describe();
        const build =
          typeof this.device.createRenderPipelineAsync === 'function'
            ? this.device.createRenderPipelineAsync(descriptor)
            : Promise.resolve(this.device.createRenderPipeline(descriptor));
        return build.then((pipeline) => [key, pipeline] as const);
      });
      const results = await Promise.allSettled(rebuilt);
      if (generation !== this.litGeneration) return;
      for (const result of results) {
        if (result.status === 'fulfilled') this.pipelines.set(result.value[0], result.value[1]);
      }
    });
    return this.litRebuild;
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
