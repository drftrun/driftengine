/**
 * A hint, from the renderer string, about whether this part can hold the good profile.
 *
 * **It is a hint and never the authority.** A device database is a thing to maintain and
 * it is wrong about every GPU nobody has tested, so the unknown case is deliberately *not*
 * weak: guessing weak on the unknown would ship a soft picture to every device released
 * after this line was written. `ResolutionGovernor` is what corrects a wrong guess, in both
 * directions, from measurement rather than from a table.
 *
 * The families listed are the ones this project has evidence for, and each is a
 * measurement rather than a reputation:
 *
 * - **Adreno 5xx/6xx and 70x/71x** — `NFD6QQ`, an Adreno 619 at 156.66 ms a frame that
 *   then lost its context outright, and `JBL3XG`, an Adreno 710 at 112 ms. Both were
 *   opened at the desktop profile because the default quality is a constant.
 * - **Intel HD/UHD** — a UHD 630 that was unplayable fullscreen and *"perfetto"* in a
 *   small window, which is the signature of a part using system RAM as VRAM.
 * - **Mali-G3x/G5x and PowerVR** — the same class as those Adrenos by every public number.
 *   No report from either yet; listed because the cost of being wrong is a picture one
 *   step softer than it needed to be, and the cost of omitting them is another `NFD6QQ`.
 *
 * Adreno 72x-8xx and the Immortalis Malis are excluded on purpose. `JBL3XG`'s 710 is the
 * one 7xx data point and it belongs to the mid-range; the flagships hold the budget. If a
 * second 7xx report lands, move that whole family here rather than special-casing a number.
 */
/**
 * **WebGPU does not hand out part numbers, and that changes what this table can match.**
 *
 * `UNMASKED_RENDERER_WEBGL` gives a string like `ANGLE (Qualcomm, Adreno (TM) 619, OpenGL ES
 * 3.2)`. `GPUAdapterInfo` deliberately does not: it reports a vendor and an *architecture
 * bucket*, to reduce fingerprinting entropy. Measured on this machine, an RX 9070 XT reports
 * `vendor: "amd", architecture: "rdna-4"` and nothing else — no model, no description.
 *
 * So the patterns below have to recognise both shapes, and the bucketed one costs precision:
 * `adreno-7xx` cannot distinguish the 710 that was measured at 112 ms a frame from the 740 in
 * a current flagship. **It is therefore deliberately absent**, on the same reasoning that keeps
 * the unknown part unclamped — guessing weak is a soft picture for somebody who did not need
 * one, and `ResolutionGovernor` corrects a wrong guess from measurement in either direction.
 *
 * The bucket spellings are inferred from the specification's vocabulary rather than read off a
 * device this project owns, so a phone that ought to clamp and does not is a bug in these two
 * lines rather than in the mechanism. `Renderer.rendererName` is reported in the game's boot
 * log for exactly that reason: the string a real device gives settles it in one message.
 */
const WEAK_ARCHITECTURES: readonly RegExp[] = [/adreno-[56]xx/, /mali-g[35]x/];

const WEAK_FAMILIES: readonly RegExp[] = [
  ...WEAK_ARCHITECTURES,
  // Adreno 5xx and 6xx entirely, plus the 700 and 710 mid-range.
  /adreno\s*(?:\(tm\))?\s*[56]\d\d/,
  /adreno\s*(?:\(tm\))?\s*7[01]\d/,
  // `Intel(R) HD Graphics 520`, `Intel(R) UHD Graphics 630`, and the same without the (R).
  /intel(?:\(r\))?\s+u?hd\s+graphics/,
  // Mali-G31 through G57. The Immortalis and G6xx/G7xx parts are not here.
  /mali-g[35]\d/,
  /powervr/,
];

/** Whether this renderer string names a part known to struggle with the good profile. */
export function isWeakGpuFamily(rendererName: string): boolean {
  const name = rendererName.toLowerCase();
  return WEAK_FAMILIES.some((pattern) => pattern.test(name));
}

/**
 * What a WebGPU adapter calls the part, in the shape the table above matches.
 *
 * **Here rather than inline in `selectBackend`, because two callers need the identical string.**
 * The backend selection builds it to hand the renderer a part number for the clamp, and
 * `describeGpu` builds it to answer a consumer choosing a profile *before* a renderer exists. Two
 * spellings of this join is the 2026-08-13 rule's first clause exactly: one decision, two
 * implementations, and the drift shows up as a clamp that fires in one path and not the other.
 *
 * Every field is optional and browsers withhold them to differing degrees, so they are joined
 * rather than formatted: a string with a vendor and nothing else is still something the table can
 * recognise. An empty result falls back to the literal `WebGPU`, so nothing that prints it gets a
 * blank — which is also why `isWeakGpuFamily('WebGPU')` is false and must stay false.
 */
export function adapterRendererName(info: GPUAdapterInfo | undefined): string {
  return (
    [info?.description, info?.vendor, info?.architecture, info?.device]
      .filter((part) => typeof part === 'string' && part.length > 0)
      .join(' ')
      .trim() || 'WebGPU'
  );
}

/**
 * What a WebGL2 context calls the part.
 *
 * `WEBGL_debug_renderer_info` is an extension and a browser may withhold it, so the empty string
 * is an ordinary answer and not a failure — `isWeakGpuFamily('')` is false, which is the same
 * "unknown is not weak" rule the table above is built on.
 */
export function webgl2RendererName(gl: WebGL2RenderingContext): string {
  const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
  if (debugInfo === null) return '';
  return String((gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) as unknown) ?? '');
}

/** What part this machine has, as far as the browser will say. See `describeGpu`. */
export interface GpuIdentity {
  /**
   * The part's own string, or `''` where the browser declined to name it.
   *
   * The same string `RendererApi.rendererName` carries once a renderer exists, from the same two
   * derivations — this is that answer, moved earlier.
   */
  readonly rendererName: string;
  /** `isWeakGpuFamily(rendererName)`, so a caller does not have to remember to ask. */
  readonly weak: boolean;
  /**
   * Which API answered, and **never a prediction of the backend `createRenderer` will build on.**
   *
   * Naming the part and choosing a backend are different questions with different costs: this
   * asks an adapter for its name, and the selection asks for a *device*, compiles what it was
   * given and reads back a pixel. A machine can name a WebGPU adapter and still end up on WebGL2.
   * The field is here so a bug report can say where the string came from, not so a caller can
   * branch on it.
   */
  readonly source: 'webgpu' | 'webgl2' | 'none';
}

/** The seams a test needs. A caller in a browser passes none of them. */
export interface DescribeGpuOptions {
  /** Whether to ask WebGPU first. Defaults to true, matching `createRenderer`. */
  readonly preferWebGpu?: boolean;
  /** Defaults to `navigator.gpu`. */
  readonly gpu?: GPU | null;
  /**
   * Where the WebGL2 fallback reads its string from. Defaults to a **detached** canvas.
   *
   * **Detached, and that is the whole reason this is not read off the caller's canvas.** A second
   * `getContext('webgl2')` on one canvas returns the *existing* context and silently ignores the
   * attributes, so whoever calls first decides `alpha`, `antialias` and `powerPreference` for
   * everybody — and `Renderer` chooses `antialias` from the very profile a caller is here to
   * decide. Reading the name off the real canvas would settle a rendering attribute as a side
   * effect of asking a question. `webgl2/renderer.ts` records the same trap from the other side,
   * where a consumer doing this by hand was the bug.
   */
  readonly createCanvas?: () => HTMLCanvasElement | null;
}

const UNKNOWN: GpuIdentity = { rendererName: '', weak: false, source: 'none' };

/**
 * Ask what part this machine has, **before** building a renderer.
 *
 * **The gap this closes:** `isWeakGpuFamily` is exported for a consumer to classify the part it is
 * running on, and until now the only string to hand it arrived on a renderer that had already been
 * constructed — by which time the profile has been consumed and, as `applyResolutionScale` puts
 * it, everything except the pixel density is memory allocated at construction. So the one function
 * the engine offers for this decision took an argument the engine would not give you in time.
 * Reported from outside 2026-08-28, by a consumer that had fallen back to `(pointer: coarse)`
 * instead: a good proxy, right about a phone and wrong about a weak desktop, which is exactly the
 * case `isWeakGpuFamily` exists for.
 *
 * **WebGL2 is asked first, and that order is a measurement rather than a preference.** The first
 * version of this asked WebGPU first, and on this machine it answered `amd rdna-4` where the built
 * WebGL2 renderer answered `ANGLE (AMD, Vulkan 1.4.354 (AMD Radeon RX 9070 XT (RADV GFX1201)
 * (0x00007550)), radv)` — the same part, two spellings, and only one of them carries a model
 * number. That is not cosmetic: `GPUAdapterInfo` reports an *architecture bucket* to limit
 * fingerprinting, so `adreno-7xx` is one string for both the 710 measured at 112 ms a frame and
 * the 740 in a flagship, and the table above deliberately refuses to clamp it. The unmasked
 * WebGL2 string says `Adreno (TM) 710` and the table does clamp that. Asking the API that names
 * the part first therefore gives a **more accurate verdict on the devices this table exists for**,
 * and it costs an adapter request less on every machine that answers.
 *
 * **So this can be more precise than the renderer's own `rendererName`, and a caller comparing
 * the two should expect that** rather than read it as a fault: a WebGPU renderer on that phone
 * knows only `adreno-7xx` and its internal clamp cannot fire, while a consumer that called this
 * has the part number and can choose a profile the clamp could not reach.
 *
 * **What it costs** is one detached WebGL2 context, created and immediately handed back, and — only
 * where that declines to name the part — one adapter request. An adapter request, not a device
 * request, which is the cheap half of what `selectBackend` does. Only a consumer that asks pays it.
 *
 * **Why this rather than a callback inside `createRenderer`.** Handing the profile in as a function
 * of the part was the alternative and was not taken: the WebGL2 name cannot be read off the real
 * canvas before the profile is chosen anyway, since that canvas's `antialias` comes *from* the
 * profile; and a fallback from WebGPU to WebGL2 mid-creation would have to call that function a
 * second time with a different identity, which is a re-entrancy trap inside the one function every
 * consumer calls. This keeps the decision in the consumer's hands and the signature unchanged.
 *
 * **Nothing here throws.** A machine that will name itself through neither API is an ordinary
 * outcome and answers `source: 'none'` with an empty name — which `isWeakGpuFamily` reads as *not
 * weak*, the same "unknown is not weak" rule the table is built on. A caller gets the good profile
 * and `ResolutionGovernor` corrects it from measurement, which is the design.
 */
export async function describeGpu(options: DescribeGpuOptions = {}): Promise<GpuIdentity> {
  const named = (rendererName: string, source: 'webgpu' | 'webgl2'): GpuIdentity => ({
    rendererName,
    weak: isWeakGpuFamily(rendererName),
    source,
  });

  /* WebGL2 first: it is the API that gives a model number. See the header for the measurement. */
  const canvas =
    options.createCanvas === undefined
      ? (globalThis.document?.createElement('canvas') ?? null)
      : options.createCanvas();
  if (canvas !== null) {
    let gl: WebGL2RenderingContext | null = null;
    try {
      gl = canvas.getContext('webgl2');
    } catch {
      gl = null;
    }
    if (gl !== null) {
      const name = webgl2RendererName(gl);
      /*
       * Handed back promptly rather than left to the collector. A detached canvas holding a live
       * context is a GPU allocation nothing will use again, and a boot that leaks one on every
       * consumer is the kind of cost this function has no business adding.
       */
      gl.getExtension('WEBGL_lose_context')?.loseContext();
      if (name !== '') return named(name, 'webgl2');
    }
  }

  /*
   * Only where WebGL2 declined to name the part — a browser withholding
   * `WEBGL_debug_renderer_info`, or one with no WebGL2 at all. The bucketed adapter string is
   * less precise and is better than nothing.
   */
  if (options.preferWebGpu ?? true) {
    const gpu = options.gpu === undefined ? globalThis.navigator?.gpu : options.gpu;
    if (gpu != null) {
      try {
        const adapter = await gpu.requestAdapter();
        /*
         * A browser that offers no adapter has told us nothing about the part, so this answers
         * unknown rather than `WebGPU` — the literal the join defaults to would be a name nobody
         * can act on standing where the absence of one is the honest answer.
         */
        if (adapter !== null) return named(adapterRendererName(adapter.info), 'webgpu');
      } catch {
        /* An adapter request that throws is a machine without usable WebGPU. */
      }
    }
  }

  return UNKNOWN;
}
