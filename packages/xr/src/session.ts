/**
 * A session, from asking for one to giving it back.
 *
 * **`requestSession` must be called from a user gesture** and no wrapper can change that, so this
 * takes the call rather than deciding when to make it: a consumer's button handler calls
 * `enterXr`, and everything after that is this file's.
 *
 * What it owns is the order, which has four steps and fails differently at each:
 *
 * 1. the session itself, which a browser refuses without a device or a gesture,
 * 2. a layer to draw into, which needs a context the runtime accepts,
 * 3. a reference space, which decides what the poses in every frame are relative to,
 * 4. the frame source, which is what makes the engine's loop run on the headset's clock.
 *
 * **Every failure answers with a sentence and none of them throws.** A consumer whose button did
 * nothing is owed the difference between a browser without WebXR, a machine without a headset, a
 * context that would not become XR compatible, and a reference space the runtime declined. Those
 * are four different things to do next, and `reason` is where they are told apart.
 */

import type { FrameSource } from '@driftengine/core';
import { chooseLayer } from './layers.ts';
import type { LayerBackend, LayerSources, XrLayer } from './layers.ts';
import type { XrFrame, XrMode, XrSession, XrSystem } from './types.ts';

/**
 * Which space poses are reported in.
 *
 * `local-floor` first, because a scene authored in metres from a floor is what a room-scale
 * experience is, and `local` puts the origin at the headset's starting height instead, which stands
 * a player's feet wherever their head happened to be. `viewer` is the last resort and the only one
 * an inline session is guaranteed.
 */
const SPACE_ORDER: readonly string[] = ['local-floor', 'local', 'viewer'];

export interface EnterXrOptions {
  readonly mode?: XrMode;
  /** Passed to `requestSession`. `hand-tracking` is here rather than required. */
  readonly optionalFeatures?: readonly string[];
  readonly sources: LayerSources;
  /** Override the system, which is how a test drives this without a headset. */
  readonly system?: XrSystem | null;
}

export interface XrRun {
  readonly session: XrSession;
  readonly referenceSpace: unknown;
  readonly referenceSpaceType: string;
  readonly layer: XrLayer;
  readonly backend: LayerBackend;
  /** Hand this to `startLoop` and the engine runs on the session's clock. */
  readonly frameSource: FrameSource;
  /** Ends the session. Safe to call twice. */
  end(): Promise<void>;
  /** Runs when the session ends, however it ends, including the user taking the headset off. */
  onEnd(listener: () => void): void;
}

export type EnterXrResult =
  { readonly ok: true; readonly run: XrRun } | { readonly ok: false; readonly reason: string };

function systemOf(override?: XrSystem | null): XrSystem | null {
  if (override !== undefined) return override;
  return (globalThis.navigator as { xr?: XrSystem } | undefined)?.xr ?? null;
}

/**
 * Ask for a session and set everything up behind it.
 *
 * Call it from a click. Everything it can go wrong at is a `reason` and never a throw.
 */
export async function enterXr(options: EnterXrOptions): Promise<EnterXrResult> {
  const system = systemOf(options.system);
  if (system === null) {
    return { ok: false, reason: 'this browser has no WebXR: navigator.xr is not defined.' };
  }

  const mode = options.mode ?? 'immersive-vr';
  let session: XrSession;
  try {
    session = await system.requestSession(mode, { optionalFeatures: options.optionalFeatures });
  } catch (error) {
    const name = (error as Error)?.name ?? 'Error';
    return {
      ok: false,
      reason:
        `the browser refused an immersive session (${mode}, ${name}). That is what it answers when no device ` +
        'is attached, and also when the call did not come from a user gesture.',
    };
  }

  const layer = chooseLayer(session, options.sources);
  if (layer.baseLayer === null && layer.projectionLayer === null) {
    await session.end().catch(() => {});
    return { ok: false, reason: layer.reason };
  }

  const space = await firstSpace(session);
  if (space === null) {
    await session.end().catch(() => {});
    return {
      ok: false,
      reason:
        `the session offered none of ${SPACE_ORDER.join(', ')} as a reference space, so there is ` +
        'nothing to report poses relative to.',
    };
  }

  let ended = false;
  const listeners: (() => void)[] = [];
  session.addEventListener('end', () => {
    ended = true;
    for (const listener of listeners) listener();
  });

  const frameSource: FrameSource = {
    /*
     * Narrowed here and nowhere else. `core`'s loop types this argument `unknown` because it has no
     * business naming an `XRFrame`; this is the one place that knows what arrived, and it hands it
     * straight on rather than reading it, because the reading belongs to whoever draws.
     */
    requestAnimationFrame: (callback: (timeMs: number, frame?: unknown) => void): number =>
      session.requestAnimationFrame((timeMs: number, frame: XrFrame) => callback(timeMs, frame)),
    cancelAnimationFrame: (handle: number): void => {
      session.cancelAnimationFrame(handle);
    },
  };

  return {
    ok: true,
    run: {
      session,
      referenceSpace: space.space,
      referenceSpaceType: space.type,
      layer,
      backend: layer.backend,
      frameSource,
      async end(): Promise<void> {
        if (ended) return;
        ended = true;
        await session.end().catch(() => {});
      },
      onEnd(listener: () => void): void {
        if (ended) listener();
        else listeners.push(listener);
      },
    },
  };
}

/**
 * The best reference space this session will give, in the order that matters to a scene.
 *
 * Asked one at a time rather than in parallel, because a runtime may charge for a space it then has
 * to discard and because the order is the whole point: taking whichever resolves first would be a
 * race deciding where a player's floor is.
 */
async function firstSpace(session: XrSession): Promise<{ space: unknown; type: string } | null> {
  for (const type of SPACE_ORDER) {
    try {
      return { space: await session.requestReferenceSpace(type), type };
    } catch {
      /* Declined. The next one is not a fallback so much as the next preference. */
    }
  }
  return null;
}
