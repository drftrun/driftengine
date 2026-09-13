/**
 * Where a session draws, on either backend.
 *
 * **Both paths are built, and the WebGPU one is newer than the engine that uses it.** Measured
 * 2026-09-05 in Chrome 151: `XRGPUBinding` is undefined under ordinary flags and present under
 * `--enable-experimental-web-platform-features`, isolated from three other flags that do not do it.
 * Chrome's own note calls WebGPU in WebXR available for developer testing on Windows and Android.
 *
 * So the choice is made from what the runtime **has**, never from a preference:
 *
 * - `XRGPUBinding` present and a device to hand: a projection layer, and the session composites it.
 * - Otherwise `XRWebGLLayer`, which every WebXR implementation has had since the first one.
 *
 * **A backend the session cannot bind is not a failure to report, it is the other path.** A game
 * running on WebGPU on a browser whose WebXR is WebGL-only should enter a session on WebGL2 rather
 * than refuse, which is why `chooseLayer` answers with what it built and which backend it is for
 * instead of throwing.
 */

import type { XrSession, XrWebGlLayer } from './types.ts';

export type LayerBackend = 'webgl2' | 'webgpu';

export interface XrLayer {
  readonly backend: LayerBackend;
  /** Set on the session's render state. A WebGL layer here; a projection layer goes in `layers`. */
  readonly baseLayer: XrWebGlLayer | null;
  /** The WebGPU projection layer, when that is the path taken. */
  readonly projectionLayer: unknown | null;
  /** A whole sentence when the chosen path was not the one asked for. Empty when it was. */
  readonly reason: string;
}

/** What a caller offers. Whichever of the two it has; both is allowed and neither is not. */
export interface LayerSources {
  /** A WebGL2 context, already made XR compatible by the caller. */
  readonly gl?: unknown;
  /** A `GPUDevice`. */
  readonly device?: unknown;
}

interface WebGlLayerCtor {
  new (session: XrSession, gl: unknown): XrWebGlLayer;
}

interface GpuBindingCtor {
  new (
    session: XrSession,
    device: unknown,
  ): {
    createProjectionLayer(options: { colorFormat: unknown }): unknown;
  };
  getPreferredColorFormat?(): unknown;
}

function webGlLayerCtor(): WebGlLayerCtor | null {
  return (globalThis as { XRWebGLLayer?: WebGlLayerCtor }).XRWebGLLayer ?? null;
}

function gpuBindingCtor(): GpuBindingCtor | null {
  return (globalThis as { XRGPUBinding?: GpuBindingCtor }).XRGPUBinding ?? null;
}

/**
 * Build the layer this session and these sources allow.
 *
 * Never throws. It is called at the moment a session starts, which is a moment a consumer is
 * showing a user something, and `AGENTS.md`'s rule about not throwing in a frame loop is the same
 * rule one step earlier: a session that cannot draw should say so and leave the page alive.
 */
export function chooseLayer(session: XrSession, sources: LayerSources): XrLayer {
  const binding = gpuBindingCtor();

  if (sources.device !== undefined && binding !== null) {
    try {
      const bound = new binding(session, sources.device);
      const colorFormat = binding.getPreferredColorFormat?.() ?? 'bgra8unorm';
      const projectionLayer = bound.createProjectionLayer({ colorFormat });
      session.updateRenderState({ layers: [projectionLayer] });
      return { backend: 'webgpu', baseLayer: null, projectionLayer, reason: '' };
    } catch (error) {
      /*
       * Falling through to WebGL2 rather than failing. The binding constructs on a browser whose
       * runtime cannot actually composite a WebGPU layer, so the honest test of this path is
       * building the layer, and the honest answer to it failing is the path that has worked since
       * WebXR shipped.
       */
      const name = (error as Error)?.name ?? 'Error';
      const fallback = buildWebGlLayer(session, sources);
      return fallback.baseLayer === null
        ? {
            ...fallback,
            reason:
              `the WebGPU layer could not be built (${name}) and no WebGL2 context was offered to ` +
              'fall back to.',
          }
        : {
            ...fallback,
            reason:
              `the WebGPU layer could not be built (${name}), so this session draws through ` +
              'WebGL2. WebGPU in WebXR is experimental and is behind a flag in current browsers.',
          };
    }
  }

  const layer = buildWebGlLayer(session, sources);
  if (layer.baseLayer !== null && sources.device !== undefined && binding === null) {
    return {
      ...layer,
      reason:
        'this browser has no XRGPUBinding, so a WebGPU device cannot be bound to a session and ' +
        'this one draws through WebGL2.',
    };
  }
  return layer;
}

function buildWebGlLayer(session: XrSession, sources: LayerSources): XrLayer {
  const ctor = webGlLayerCtor();
  if (ctor === null) {
    return {
      backend: 'webgl2',
      baseLayer: null,
      projectionLayer: null,
      reason: 'this browser has no XRWebGLLayer, so a session has nothing to draw into.',
    };
  }
  if (sources.gl === undefined) {
    return {
      backend: 'webgl2',
      baseLayer: null,
      projectionLayer: null,
      reason: 'no WebGL2 context was offered, so a session has nothing to draw into.',
    };
  }
  try {
    const baseLayer = new ctor(session, sources.gl);
    session.updateRenderState({ baseLayer });
    return { backend: 'webgl2', baseLayer, projectionLayer: null, reason: '' };
  } catch (error) {
    const name = (error as Error)?.name ?? 'Error';
    return {
      backend: 'webgl2',
      baseLayer: null,
      projectionLayer: null,
      reason:
        `the WebGL2 layer could not be built (${name}), which is what happens when the context ` +
        'was never made XR compatible.',
    };
  }
}
