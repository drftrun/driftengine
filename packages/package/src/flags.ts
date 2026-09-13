import type { PackageManifest, Target } from './manifest.ts';

/**
 * The Chromium switches a shipped build launches with.
 *
 * **This is most of why the packager exists.** Every switch below was paid for once already, in
 * this repository or by a consumer, and a game that wraps Electron by hand rediscovers each of
 * them — two of them only by measuring a frame nobody thought to measure.
 *
 * **What this costs**: the flags are ours rather than the platform's defaults, so a Chromium
 * change can invalidate one and nothing will say so. **What would make it wrong**: Electron
 * enabling Vulkan on Linux by default, at which point the first block below becomes a no-op worth
 * deleting rather than a fix worth keeping.
 *
 * **Checked 2026-09-09 and still needed**, on Electron 43.4.1 / Chromium 150.0.7871.224 with an
 * RX 9070 XT: launched with no switches at all, `navigator.gpu` is present and `requestAdapter`
 * answers **null**. With the interop feature it hands back an `amd`/`rdna-4` adapter and a device.
 * So the block below is doing the work rather than riding along, six Chromium majors after it was
 * written.
 *
 * **And a switch is now only asked for on a runtime it has been seen to work on**, because the
 * other half of "nothing will say so" is a name Chromium does not recognise: unknown features in
 * `--enable-features` are dropped in silence, and the build that results is indistinguishable from
 * a machine with no adapter to offer. See `WEBGPU_INTEROP_ELECTRON`.
 */
export interface FlagPlan {
  readonly switches: readonly (readonly [string, string])[];
  /** Non-null means refuse to build, and this is what to print. */
  readonly refusal: string | null;
  /**
   * What a caller must print, having decided nothing.
   *
   * **A switch that names a feature the runtime has never heard of is worse than no switch**, and
   * that is what these exist for: Chromium ignores an unknown name in `--enable-features` without a
   * word, so a build that cannot deliver WebGPU looks exactly like a machine whose driver had no
   * adapter to offer. Where this plan declines to ask for something, it says so out loud.
   */
  readonly notes: readonly string[];
}

/**
 * The Electron the Linux WebGPU switch below is written against, and measured on.
 *
 * **Not the version the feature was introduced in, which nobody here has established.** It is the
 * version this repository has run the switch against and watched WebGPU come up: Electron 43.4.1,
 * Chromium 150.0.7871.224, an RX 9070 XT, where `requestAdapter` answers null without the switch
 * and hands back an `amd`/`rdna-4` adapter with it. Reported from outside against Electron 33.4.11,
 * Chromium 130: the feature name is not in that binary at all, and the switch is inert there.
 *
 * So a runtime older than this is *unverified*, not known-broken — and the plan declines to ship an
 * unverified switch rather than shipping one that may do nothing silently.
 */
export const WEBGPU_INTEROP_ELECTRON = 43;

/**
 * @param electronMajor The major version of the Electron these switches will be applied to, or
 *   `null` where a caller genuinely cannot know. Both callers in this package can: the build reads
 *   it out of the installed package, and the main process reads it out of `process.versions`.
 */
export function planFlags(
  manifest: PackageManifest,
  target: Target,
  electronMajor: number | null = null,
): FlagPlan {
  /*
   * **A mobile host has no command line to pass switches on.** The renderer is the platform's own
   * WebView, updated by the store rather than by us, and every decision below is about a Chromium
   * this package ships. Returning nothing is the honest answer rather than switches that would be
   * silently dropped — and it is why the Linux refusal further down cannot fire on a phone.
   */
  if (target === 'android' || target === 'ios') return { switches: [], refusal: null, notes: [] };

  const switches: (readonly [string, string])[] = [];
  const notes: string[] = [];
  const wantsWebGpu = manifest.backend.webgpu !== 'off';
  const linux = target === 'linux-x64';

  /*
   * **A software rasteriser is never chosen silently.** Plain headless Chromium selects
   * SwiftShader on a development machine, measured, and says nothing about it — every
   * frame it produces is a lie about what a player sees and it saturates the CPU producing it.
   * `requireHardwareGpu()` refuses it in the capture harness; this refuses it in the product.
   */
  if (!manifest.backend.allowSoftwareRenderer) {
    switches.push(['disable-software-rasterizer', '']);
  }

  if (linux && wantsWebGpu) {
    /*
     * **Electron does not enable WebGPU on Linux although Chrome does** (`electron#40929`), so
     * without this there is no WebGPU on that target at all — `requestAdapter` simply answers null
     * and the engine falls back, correctly and invisibly.
     *
     * **The interop feature, and deliberately not `--use-angle=vulkan --enable-features=Vulkan`.**
     * Both yield WebGPU. The second also breaks video encoding under Wayland: measured on an
     * RX 9070 XT, canvas frames encode as all-zero YUV — a green clip — with nothing reporting it,
     * since `VideoEncoder.error` never fires and the muxer finalises a file of the expected size.
     * `ForceEnableWebGpuInterop` composites WebGPU through GL instead of moving ANGLE onto Vulkan,
     * and both survive: measured in a packaged build on this machine, WebGPU drew and a vp8 round
     * trip came back magenta rather than green.
     *
     * **This is why clip export and WebGPU are no longer refused together.** They were, for as
     * long as the only switch known to work was the one that broke encoding.
     *
     * **What would make it wrong** is a Chromium that retires the feature, at which point WebGPU
     * quietly stops being offered on Linux and the acceptance probe reports the fallback — which
     * is the failure mode to watch for rather than a green clip.
     *
     * **Reported from outside as hanging a Wayland session, and it does not do that here.** The
     * report is a packaged game that never paints on AMD under Wayland: an adapter is offered and
     * the renderer's creation never returns. Chromium does print
     * `'--ozone-platform=wayland' is not compatible with Vulkan` on stderr while this switch is
     * applied, on this machine too. But run against the engine's own starter — an RX 9070 XT on a
     * Wayland session under COSMIC, Electron 43.4.1, Chromium 150 — the acquisition completes in
     * **153 ms, three runs of three**, and the example draws with WebGPU. The bare path completes
     * as well: adapter, device, canvas context, swapchain, submit, and a one-pixel readback that
     * comes back magenta.
     *
     * **Chromium's own advice is worse here.** Pairing this with `--ozone-platform=x11`, which is
     * what that message suggests, takes the GPU process down on this machine: `exit_code=139`, and
     * a screenshot request answers `UnknownVizError`. So it is not offered.
     *
     * The switch is therefore kept, because withdrawing it on every Wayland session would take a
     * measured-working backend away from every machine like this one. What the report is right
     * about is that a stall had no floor under it, and that is closed where it belongs: see
     * `BACKEND_TIMEOUT_MS` in the engine's backend selection, which answers WebGL2 rather than
     * waiting for a device that is not coming.
     */
    /*
     * **And it is only asked for on a runtime it has been seen to work on.** The switch was
     * verified once and then travelled, unchecked, into whatever Electron a consumer's install
     * happened to resolve — which is how a build reached a Chromium whose binary does not contain
     * the feature name at all. Nothing reported it, because nothing could: an ignored feature name
     * and an absent adapter produce the same product.
     */
    /*
     * **And there is no second-best route on an older runtime, deliberately.**
     *
     * There is one that works: measured on Electron 33.4.11 against this machine, WebGPU comes up
     * under `--enable-unsafe-webgpu` *and* `--enable-features=Vulkan` together — neither alone
     * produces an adapter, nor does `--use-angle=vulkan` beside them. It is not offered, for two
     * reasons that hold together. This package declares the Electron it is written against, so a
     * build resolving an older one has an install to fix rather than a workaround to adopt; and the
     * route costs video encoding under Wayland, where canvas frames encode as all-zero YUV — a
     * green clip, with `VideoEncoder.error` never firing and the muxer finalising a file of the
     * expected size. Shipping an unsafe flag and that trade, to a configuration this package says
     * it does not support, is a worse answer than saying so.
     */
    if (electronMajor === null || electronMajor >= WEBGPU_INTEROP_ELECTRON) {
      switches.push(['enable-features', 'ForceEnableWebGpuInterop']);
    } else if (manifest.backend.webgpu === 'require') {
      return {
        switches,
        notes,
        refusal:
          `backend.webgpu is "require" and Electron ${electronMajor} cannot deliver it on Linux. ` +
          `This package declares Electron ${WEBGPU_INTEROP_ELECTRON}; an install resolving an older ` +
          'one is the thing to fix. Otherwise set backend.webgpu to "prefer" or "off" to ship ' +
          'WebGL2 on this target deliberately.',
      };
    } else {
      notes.push(
        `no WebGPU on Linux: Electron ${electronMajor} predates the interop switch this package is ` +
          `written against (${WEBGPU_INTEROP_ELECTRON}), so this build falls back to WebGL2 there. ` +
          'Install the Electron this package declares to get it back.',
      );
    }
  }

  return { switches, refusal: null, notes };
}
