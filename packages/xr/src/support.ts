/**
 * What this browser can actually do, asked by doing it.
 *
 * **`isSessionSupported` is a promise about a mode and not an answer about this machine**, and the
 * difference is not academic. Measured on 2026-09-05, Chrome 151 on Linux with no headset:
 * `isSessionSupported('inline')` answers **true**, `requestSession('inline')` **succeeds**,
 * `requestReferenceSpace('viewer')` **succeeds**, and then `gl.makeXRCompatible()` throws
 * `InvalidStateError` because there is no XR device. Without that call there is no base layer, and
 * without a base layer a session delivers **no frame at all**. Every promise along the way was
 * kept, and nothing could be drawn.
 *
 * So this asks the question `probeDevice` asks about a GPU, and for the reason `probeDevice`'s own
 * header gives: *a device that reports support and then draws nothing is a device that lied.* It
 * tries the step that fails.
 *
 * **`reason` is a whole sentence and never empty when something is missing.** A consumer whose
 * button does nothing is owed the difference between a browser with no WebXR, a machine with no
 * headset, and a context that refused to become XR compatible, because those are three different
 * things to do next. The island pool's `parallelism.reason` and `createSplatSortWorker`'s single
 * warning are the same discipline; a silent false is the one outcome none of them allows.
 */

import type { XrMode, XrSystem } from './types.ts';

export interface XrSupport {
  /** Whether `navigator.xr` exists at all. Everything else is false without it. */
  readonly present: boolean;
  readonly immersiveVr: boolean;
  readonly immersiveAr: boolean;
  readonly inline: boolean;
  /**
   * Whether a rendering context could be made XR compatible.
   *
   * The step that actually fails without a device, and the one no `isSessionSupported` reports on.
   */
  readonly compatible: boolean;
  /** Empty when a session could be entered. A whole sentence otherwise. */
  readonly reason: string;
}

const NOTHING: XrSupport = {
  present: false,
  immersiveVr: false,
  immersiveAr: false,
  inline: false,
  compatible: false,
  reason: 'this browser has no WebXR: navigator.xr is not defined.',
};

/** A context that can be asked to become XR compatible. Both backends' contexts satisfy it. */
export interface XrCompatibleContext {
  makeXRCompatible?(): Promise<void>;
}

function systemOf(): XrSystem | null {
  const nav = globalThis.navigator as { xr?: XrSystem } | undefined;
  return nav?.xr ?? null;
}

async function supports(system: XrSystem, mode: XrMode): Promise<boolean> {
  try {
    return await system.isSessionSupported(mode);
  } catch {
    /*
     * A rejection is an answer and not an error. `isSessionSupported` rejects rather than resolving
     * false where a permissions policy forbids the mode, which is a `false` a consumer can do
     * nothing about and must not be a thrown exception on a page that merely asked.
     */
    return false;
  }
}

/**
 * Ask, and try the step that lies.
 *
 * `context` is optional because a consumer may want the modes before they have built a renderer.
 * Without one, `compatible` is false and `reason` says the question was not asked, which is a
 * different thing from asked and refused.
 */
export async function probeXrSupport(
  context?: XrCompatibleContext | null,
  /*
   * The system, overridable for the same reason `enterXr` takes one: a test cannot assign
   * `globalThis.navigator`, which is getter-only, and stubbing a global to ask a question about a
   * pure function would be surgery on the environment to avoid a parameter.
   */
  override?: XrSystem | null,
): Promise<XrSupport> {
  const system = override === undefined ? systemOf() : override;
  if (system === null) return NOTHING;

  const [immersiveVr, immersiveAr, inline] = await Promise.all([
    supports(system, 'immersive-vr'),
    supports(system, 'immersive-ar'),
    supports(system, 'inline'),
  ]);

  let compatible = false;
  let compatibleReason = '';
  if (context?.makeXRCompatible === undefined) {
    compatibleReason =
      'no rendering context was offered, so whether one can be made XR compatible is unasked.';
  } else {
    try {
      await context.makeXRCompatible();
      compatible = true;
    } catch (error) {
      const name = (error as Error)?.name ?? 'Error';
      compatibleReason =
        `the rendering context refused to become XR compatible (${name}), which is what happens ` +
        'when the browser has WebXR but this machine has no XR device attached.';
    }
  }

  /*
   * **The deepest failure wins, and the first draft had this backwards.** It reported the mode
   * message before the compatibility one, so a machine whose context had actually been offered and
   * refused was told "only an inline session is available here" — true, and not the thing that had
   * just gone wrong. `xr-check.mjs` caught it: `compatible` was false while `reason` said nothing
   * about it.
   *
   * A refusal that was *tried* outranks a report about what a mode list says, because it is the
   * concrete step that failed and the one a consumer can do something about.
   */
  const anyMode = immersiveVr || immersiveAr || inline;
  let reason = '';
  if (context?.makeXRCompatible !== undefined && !compatible) {
    reason = compatibleReason;
  } else if (!anyMode) {
    reason =
      'this browser has WebXR but reports no session mode as supported, which is what a machine ' +
      'with no headset answers.';
  } else if (!immersiveVr && !immersiveAr) {
    reason =
      'only an inline session is available here. An inline session has one view and no headset ' +
      'pose, so it draws a window into the scene and does not present to a device.';
  }

  return { present: true, immersiveVr, immersiveAr, inline, compatible, reason };
}

/** The best mode this support answer allows, or null when none is worth asking for. */
export function bestMode(support: XrSupport): XrMode | null {
  if (support.immersiveVr) return 'immersive-vr';
  if (support.immersiveAr) return 'immersive-ar';
  if (support.inline) return 'inline';
  return null;
}
