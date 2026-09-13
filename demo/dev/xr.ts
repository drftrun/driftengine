/**
 * What a real browser answers about WebXR, which is the half a synthetic runtime cannot.
 *
 * **The unit tests cover everything from the first frame onward and none of it against a browser.**
 * This is the other half: capability detection, a real session requested and ended, a real reference
 * space, whether `XRGPUBinding` exists, and every refusal path. On a machine with no headset that
 * last group is most of what a consumer's users will actually hit.
 *
 * Nothing is drawn. The subject is what the runtime says and does, and a page that also rendered
 * would be asserting about a GPU while claiming to be about sessions.
 */
import { enterXr, probeXrSupport } from '@driftengine/xr';

async function inlineSession(): Promise<Record<string, unknown>> {
  const xr = (navigator as { xr?: { requestSession(mode: string): Promise<unknown> } }).xr;
  if (xr === undefined) return { requested: false, why: 'no navigator.xr' };
  try {
    const session = (await xr.requestSession('inline')) as {
      requestReferenceSpace(type: string): Promise<unknown>;
      end(): Promise<void>;
    };
    let space = '';
    for (const type of ['local-floor', 'local', 'viewer']) {
      try {
        await session.requestReferenceSpace(type);
        space = type;
        break;
      } catch {
        /* the next preference */
      }
    }
    await session.end();
    return { requested: true, referenceSpace: space, ended: true };
  } catch (error) {
    return {
      requested: false,
      why: `${(error as Error).name}: ${(error as Error).message.slice(0, 60)}`,
    };
  }
}

async function run(): Promise<Record<string, unknown>> {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 128;
  const gl = canvas.getContext('webgl2');

  const support = await probeXrSupport(
    gl as unknown as { makeXRCompatible?(): Promise<void> } | null,
  );

  /*
   * Entering with no device, which is the path almost every visitor to a consumer's site takes. The
   * assertion worth making is that it refuses with a sentence rather than throwing or hanging.
   */
  const refused = await enterXr({ mode: 'immersive-vr', sources: { gl } });

  return {
    present: support.present,
    immersiveVr: support.immersiveVr,
    immersiveAr: support.immersiveAr,
    inline: support.inline,
    compatible: support.compatible,
    supportReason: support.reason,
    hasWebGlLayer: typeof (globalThis as { XRWebGLLayer?: unknown }).XRWebGLLayer === 'function',
    hasGpuBinding: typeof (globalThis as { XRGPUBinding?: unknown }).XRGPUBinding === 'function',
    hasFrameClass: typeof (globalThis as { XRFrame?: unknown }).XRFrame === 'function',
    entered: refused.ok,
    enterReason: refused.ok ? '' : refused.reason,
    inlineSession: await inlineSession(),
  };
}

run().then(
  (result) => {
    (globalThis as { __xrCheck?: unknown }).__xrCheck = result;
    const out = document.getElementById('out');
    if (out) out.textContent = JSON.stringify(result, null, 2);
  },
  (error: unknown) => {
    const failed = { error: String((error as Error)?.message ?? error) };
    (globalThis as { __xrCheck?: unknown }).__xrCheck = failed;
    const out = document.getElementById('out');
    if (out) out.textContent = JSON.stringify(failed, null, 2);
  },
);
