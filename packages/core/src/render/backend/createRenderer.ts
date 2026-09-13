import { Renderer } from './webgl2/renderer.ts';
import { resolveRenderQuality, type RenderQualityOptions } from '../renderQuality.ts';
import type { RenderBackend, RendererApi } from './api.ts';
import { BACKEND_TIMEOUT_MS, forcedBackend, selectBackend } from './select.ts';
import { TIMED_OUT, withDeadline } from './deadline.ts';
import { mountSplash, type MountedSplash, type SplashOptions } from '../../ui/splash.ts';

/** Everything about selection a caller may want to decide instead of inherit. */
export interface CreateRendererOptions {
  /**
   * Whether to try WebGPU at all. **Defaults to true**: WebGPU is the backend this engine is
   * built on now, and WebGL2 is the fallback beneath it rather than the path of record.
   *
   * It defaulted to false for as long as the second backend was under construction, and the
   * comment holding it there pointed at a numbered task in a plan. That is how a default
   * outlives its reason: by the time it was wrong, every consumer in the workspace was already
   * passing `true`, so the conservative default was overridden everywhere and true nowhere.
   *
   * **What this costs** is an `await` on `requestAdapter` in a boot that previously had none,
   * on every consumer that never mentioned a backend. Pass `false` to decline it and get the
   * old boot exactly. **What would make it wrong** is an adapter request slow enough to be felt
   * at startup on a device that was never going to yield a device anyway; nothing measured here
   * shows that, and the fallback is silent when it happens.
   */
  readonly preferWebGpu?: boolean;
  /**
   * The query string to read `?backend=` from. Defaults to the document's own.
   *
   * Injectable because a test has no `location`, and because an application that routes
   * without touching the address bar should be able to say what it means.
   */
  readonly search?: string;
  /**
   * Shader sources the acceptance probe compiles before a device is accepted. Empty by default.
   *
   * **Empty because it was measured, not assumed.** On an AMD Radeon RX 9070 XT (RADV, ANGLE over
   * Vulkan) the draw-and-read check alone costs **4.2–5.4 ms** and catches a device that validates
   * everything and rasterises nothing; adding all **46** generated WGSL modules costs a further
   * **58–62 ms** on every boot and catches the class that
   * `packages/core/src/render/shaders/uniformStride.test.ts` already catches at test time, by
   * reading the committed files. Sixty milliseconds of every player's startup is a poor price for
   * a second copy of a test.
   *
   * **What would make an empty default wrong** is a device-specific compile failure in a shader
   * that test cannot model — which is precisely what the iOS black screen was before that test
   * existed. A consumer shipping to a platform nobody has certified should pass the real set and
   * take the cost: a slower boot is worth more than a black screen. `scripts/probe-check.mjs`
   * re-measures both figures on any machine.
   */
  readonly probeShaders?: readonly string[];
  /**
   * How long the WebGPU path may take before WebGL2 is answered instead. `Infinity` waits forever.
   *
   * **A preference that cannot fall back is not a preference.** Every other refusal arrives as an
   * answer — a null adapter, a throw, a device that cannot draw — and each lands on WebGL2 with a
   * reason. A request that never settles is none of those and has nothing under it: the boot stops
   * at an `await`, nothing throws, and the player is left looking at the window the game was going
   * to be drawn in. See `BACKEND_TIMEOUT_MS` for the default and what it was measured against.
   */
  readonly backendTimeoutMs?: number;
  /**
   * The engine badge shown over the page until the first frame reaches the screen.
   *
   * **On by default, and that default is the feature.** A web-delivered game has no shell to
   * show one for it — `drift-package` opens a window for exactly this and a browser tab has
   * nowhere to put it — so the engine mounts it here, before the device probe, and a game
   * inherits it by calling the function it was already calling. See `ui/splash.ts`.
   *
   * `false` declines it. Pass that for anything that is not a game booting: a site whose canvas
   * is one section of a page, a tool that opens into its own interface, a demo harness. Those
   * are the cases where a full-screen badge is an interruption rather than a cover, and they
   * are the reason this is a decision rather than a behaviour.
   *
   * `?splash=0` and `?splash=1` override it either way without a code change, which is how the
   * badge is looked at on a deployed build.
   */
  readonly splash?: boolean | SplashOptions;
}

/** What was built, and which path built it. */
export interface CreatedRenderer {
  /** The renderer, behind the surface both backends satisfy. */
  readonly renderer: RendererApi;
  /** Which backend is actually drawing. Report this; never infer it. */
  readonly backend: RenderBackend;
  /** Why that backend, in words, for the frame meter and for bug reports. */
  readonly reason: string;
  /**
   * What the part calls itself, from whichever backend was actually built.
   *
   * **The third of the same kind of fact as `backend` and `reason`, and it was the one missing.**
   * `select.ts` already carried it to hand the WebGPU renderer a part number for the capability
   * clamp, and then dropped it here — so `gpuCapability.ts`'s own claim that the string "is
   * reported in the game's boot log, because the string a real device gives settles it in one
   * message" was true of this repository's harness and not of a consumer, whose boot log could not
   * print what it was never handed. Reported from outside 2026-08-28 as exactly that: a bug report
   * that cannot say which GPU it came from.
   *
   * `''` where the browser declined to name the part, which is an ordinary answer rather than a
   * failure — see `webgl2RendererName`.
   *
   * **For a log and a bug report, not for choosing a profile.** By the time this exists the
   * renderer is built and every setting except the pixel density is memory allocated at
   * construction. `describeGpu()` is the same question asked early enough to act on.
   */
  readonly rendererName: string;

  /**
   * Which way this renderer's depth buffer actually runs.
   *
   * **The answer a consumer has to key their near plane on, and it is the *runtime* one.** The
   * engine's own wish is the `REVERSED_DEPTH` constant; this is what the context granted. On
   * WebGPU they always agree, because its clip space is already `[0, 1]`. On WebGL2 they can
   * differ: reversing needs `EXT_clip_control`, and a context without it keeps the conventional
   * sense — so a game that read the constant would pick a near plane the machine in front of it
   * cannot honour.
   *
   * **Why it is reported at all.** A conventional buffer resolves about `z² / (near · 2^bits)`,
   * which makes the near plane the only control there is, and a consumer that cannot ask has to
   * choose for the worse case and gains nothing from the better one. Reported the way
   * `rendererName` is, and for the same reason: it is a fact about the machine that only the
   * renderer knows.
   */
  readonly reversedDepth: boolean;
}

/**
 * Hand the badge the one fact it is waiting for: a frame reached the screen.
 *
 * **Patched onto the instance and deleted by its own first call**, so what a game runs from the
 * second frame on is the prototype method it would have run anyway. The alternative — a flag the
 * backends check inside `endFrame` — puts a branch in the hot path of both renderers forever to
 * learn something that is true exactly once, and puts the splash's name in `render/`, which is the
 * boundary this whole module sits outside of.
 */
function presentOnFirstFrame(renderer: RendererApi, splash: MountedSplash): void {
  const target = renderer as RendererApi & { endFrame(): void };
  const inherited = target.endFrame.bind(target);
  Object.defineProperty(target, 'endFrame', {
    configurable: true,
    writable: true,
    value(): void {
      inherited();
      /* Before `present`, not after: the badge's removal must not be able to leave the patch
         behind if it throws. Deleting an own property uncovers the prototype's. */
      delete (target as Partial<Record<'endFrame', unknown>>).endFrame;
      splash.present();
    },
  });
}

/**
 * Build a renderer on the best backend this browser will actually give us.
 *
 * **Asynchronous because it has to be.** `navigator.gpu.requestAdapter()` returns a promise
 * and there is no synchronous way to learn whether a usable device exists. That is the one
 * change this reaches into a consumer's boot sequence, and it is exactly why
 * `new Renderer(canvas, quality)` keeps working untouched: three applications construct one
 * today and none of them should be made to move on this plan's schedule.
 *
 * **Both backends are behind it now**, and which one a caller gets is this function's whole
 * job: WebGPU where the browser offers a usable device, WebGL2 everywhere else. The returned
 * `backend` and `reason` say which and why, and they are meant to be read — `reason` was
 * returned and ignored by every caller for long enough that a silent fallback could be
 * mistaken for a comparison.
 */
export async function createRenderer(
  canvas: HTMLCanvasElement,
  quality: RenderQualityOptions = {},
  options: CreateRendererOptions = {},
): Promise<CreatedRenderer> {
  const search = options.search ?? globalThis.location?.search ?? '';

  /*
   * **Mounted before the probe, because the probe is part of the wait.** `selectBackend` asks for
   * an adapter, compiles what it was given and reads back a pixel; on a slow machine that is the
   * first visible fraction of a second, and it happens over an empty canvas.
   */
  const splashOptions: SplashOptions =
    options.splash === undefined
      ? {}
      : typeof options.splash === 'boolean'
        ? { enabled: options.splash }
        : options.splash;
  const splash = mountSplash({ search, ...splashOptions });

  /**
   * Attach the badge to whichever renderer was built. Every return goes through here, including
   * the two failure paths — a fallback still paints, and a badge that outlived a fallback would
   * sit on the screen until the cap for a game that was running perfectly well underneath it.
   */
  const built = (
    result: Omit<CreatedRenderer, 'rendererName' | 'reversedDepth'>,
  ): CreatedRenderer => {
    if (splash !== null) presentOnFirstFrame(result.renderer, splash);
    /*
     * **Read off the renderer here rather than carried down from the choice**, and the difference
     * is the fallback. `choice.rendererName` is the *adapter's* name and is null on every WebGL2
     * branch; more than that, a WebGPU surface that fails after a device was granted returns a
     * WebGL2 renderer through this same wrapper, so the choice's name would then describe a
     * backend that is not drawing. Every return goes through here and every renderer carries its
     * own name, so there is one place and it cannot disagree with the object beside it.
     */
    /*
     * `reversedDepth` is read off the renderer for the same reason and with more force: on WebGL2
     * it depends on an extension the context may not offer, so it is a property of the object
     * that got built and of nothing upstream of it.
     */
    return {
      ...result,
      rendererName: result.renderer.rendererName,
      reversedDepth: result.renderer.reversedDepth,
    };
  };

  /*
   * **One budget for the whole WebGPU branch, spent in two halves.**
   *
   * Acquisition is the first half and `selectBackend` bounds it. Construction is the second — a
   * dynamically imported backend, a surface and a renderer — and it used to be bounded by nothing,
   * which meant a boot could stall with a deadline visibly present and never firing. Reported from
   * outside exactly that way: every GPU call in the hung page completed by hand in milliseconds
   * while the engine's own boot never returned, because whatever it was waiting on was not inside
   * the promise the deadline was racing.
   */
  const budgetMs = options.backendTimeoutMs ?? BACKEND_TIMEOUT_MS;
  const startedAt = Date.now();
  const choice = await selectBackend(
    search,
    options.preferWebGpu ?? true,
    quality.gpuTiming ?? false,
    options.probeShaders ?? [],
    budgetMs,
  );

  if (choice.backend === 'webgpu' && choice.device !== null) {
    /*
     * **A failure here falls back rather than propagating.** Everything up to this point
     * proved a device exists; a canvas that will not give a `webgpu` context after that is
     * a different fault, and one a consumer can do nothing about. Falling back draws the
     * frame on WebGL2 and says why, which beats a black canvas and a stack trace.
     *
     * The device is destroyed on the way past, because the surface that would have owned it
     * was never built and nothing else will free it.
     */
    /*
     * **What it was doing when it stopped, kept as a word.** A consumer cannot read a stack out of
     * a packaged build with no developer tools, and the question a stalled boot raises is which of
     * these three steps it is sitting in. The reason string carries the answer rather than a
     * request to reproduce it under a debugger.
     */
    let stage = 'importing the backend';
    const device = choice.device;
    try {
      const construction = (async () => {
        /*
         * Imported dynamically so a bundler can split them out. A consumer that ends up on
         * WebGL2 — every consumer today, and every browser without WebGPU afterwards — should
         * not be made to download a backend it will never construct.
         *
         * **And it is an await over a network, which is why it is inside the race.** In a packaged
         * artifact these chunks come back through the application's own protocol handler; a request
         * that never answers is a boot that never finishes, and nothing about it is a GPU fault.
         */
        const { createGpuSurface } = await import('./webgpu/device.ts');
        const { WebGPURenderer } = await import('./webgpu/renderer.ts');
        stage = 'creating the surface';
        const surface = createGpuSurface(canvas, device);
        stage = 'constructing the renderer';
        return { surface, WebGPURenderer };
      })();

      const spent = Date.now() - startedAt;
      const settled = await withDeadline(construction, budgetMs - spent);
      if (settled === TIMED_OUT) {
        device.destroy();
        return built({
          renderer: new Renderer(canvas, quality),
          backend: 'webgl2',
          reason: `WebGPU stalled while ${stage}, fell back after ${budgetMs} ms`,
        });
      }
      const { surface, WebGPURenderer } = settled;
      return built({
        /*
         * **No cast: `WebGPURenderer` satisfies `RendererApi` outright.** It implemented
         * `Partial<RendererApi>` while its passes were being written and the cast here was what
         * let an incomplete backend be returned behind the complete surface. That hole is
         * closed, and closing it is what makes the derived type do the job it exists for —
         * adding a method to `Renderer` now stops this backend compiling until it has one too.
         *
         * It takes the *resolved* profile rather than the options, because it reads its shadow
         * terms off it and a bare options object leaves every unset field undefined. `Renderer`
         * resolves internally, so the two backends get the same numbers by construction rather
         * than from a copied set of defaults somebody has to keep in step.
         */
        renderer: new WebGPURenderer(
          surface,
          resolveRenderQuality(quality),
          /* The adapter's own words, so the capability clamp has a part number to
             recognise rather than the literal string `WebGPU`. */
          choice.rendererName ?? undefined,
        ),
        backend: 'webgpu',
        reason: choice.reason,
      });
    } catch (error) {
      choice.device.destroy();
      const detail = error instanceof Error ? error.message : String(error);
      return built({
        renderer: new Renderer(canvas, quality),
        backend: 'webgl2',
        reason: `WebGPU surface failed, fell back: ${detail}`,
      });
    }
  }

  choice.device?.destroy();
  /*
   * **Asked for WebGPU and did not get it: say so, once, out loud.**
   *
   * `reason` has always been returned and a caller is free to ignore it, which every caller
   * did — so a browser without WebGPU, a driver that refused a device and a misspelt query all
   * produced the same thing: a perfectly ordinary WebGL2 frame and no indication that the
   * request had been dropped. Somebody comparing the two backends then compares one of them
   * with itself, which is the exact failure `shots.mjs --backend` exists to prevent, arrived at
   * from the other direction.
   *
   * Only when it was asked for **explicitly** — a `?backend=webgpu` or a literal
   * `preferWebGpu: true`. Since the default became true this is a narrower test than it reads,
   * and deliberately so: every consumer now asks, so warning on the default would put a console
   * line in front of every player whose browser simply has no WebGPU, which is most of the
   * reason the fallback exists. Someone comparing the two backends states it, and gets told.
   */
  if (forcedBackend(search) === 'webgpu' || options.preferWebGpu === true) {
    console.warn(`[driftengine] WebGPU was asked for and is not being used: ${choice.reason}`);
  }
  return built({
    renderer: new Renderer(canvas, quality),
    backend: 'webgl2',
    reason: choice.reason,
  });
}
