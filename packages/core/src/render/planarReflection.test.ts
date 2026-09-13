import { expect, test, vi } from 'vitest';
import { PlanarReflection } from './planarReflection.ts';

/**
 * What a device that refuses the reflection target gets: a scene without a reflection.
 *
 * **The bug this exists for.** `ensureSize` threw when the framebuffer came back
 * incomplete, and it is reached from `Renderer.resize`, which a consumer calls every
 * frame. So on a device that cannot afford tens of megabytes for a full drawing-buffer
 * colour target and its depth buffer, the result was not a missing reflection: it was an
 * exception escaping the middle of every frame. Nothing after `resize` ran, the canvas
 * kept whatever had last been drawn, and the scene appeared to render as a fragment of
 * itself. Reported from an iOS webview as a room with only its fire in it, on the one
 * scene in the project using a planar reflection, and it survived a full revert of that
 * scene's render settings — which is what ruled the settings out and pointed here.
 *
 * It also broke the engine's own rule, stated in the same function for the lost-context
 * case: only initialisation fails loudly, and a running frame never throws.
 *
 * No real GL. What is under test is a failure policy, not a rendering.
 */
function fakeGl(status: number): WebGL2RenderingContext {
  return {
    TEXTURE_2D: 0x0de1,
    RGBA8: 0x8058,
    RGBA: 0x1908,
    UNSIGNED_BYTE: 0x1401,
    RENDERBUFFER: 0x8d41,
    DEPTH_COMPONENT24: 0x81a6,
    FRAMEBUFFER: 0x8d40,
    COLOR_ATTACHMENT0: 0x8ce0,
    DEPTH_ATTACHMENT: 0x8d00,
    FRAMEBUFFER_COMPLETE: 0x8cd5,
    TEXTURE_MIN_FILTER: 0x2801,
    TEXTURE_MAG_FILTER: 0x2800,
    TEXTURE_WRAP_S: 0x2802,
    TEXTURE_WRAP_T: 0x2803,
    LINEAR: 0x2601,
    CLAMP_TO_EDGE: 0x812f,
    createTexture: () => ({}) as WebGLTexture,
    createRenderbuffer: () => ({}) as WebGLRenderbuffer,
    createFramebuffer: () => ({}) as WebGLFramebuffer,
    bindTexture: () => {},
    bindRenderbuffer: () => {},
    bindFramebuffer: () => {},
    texParameteri: () => {},
    texImage2D: () => {},
    renderbufferStorage: () => {},
    framebufferTexture2D: () => {},
    framebufferRenderbuffer: () => {},
    checkFramebufferStatus: () => status,
    isContextLost: () => false,
    invalidateFramebuffer: () => {},
    clearColor: () => {},
    clear: () => {},
    viewport: () => {},
  } as unknown as WebGL2RenderingContext;
}

/** The same context, with every call recorded so a test can ask what order they came in. */
function recordingGl(status: number) {
  const calls: { name: string; args: unknown[] }[] = [];
  const base = fakeGl(status) as unknown as Record<string, unknown>;
  const gl = new Proxy(base, {
    get(target, prop: string) {
      const value = target[prop];
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        calls.push({ name: prop, args });
        return (value as (...a: unknown[]) => unknown)(...args);
      };
    },
  }) as unknown as WebGL2RenderingContext;
  return { gl, calls };
}

const COMPLETE = 0x8cd5;
/** `FRAMEBUFFER_UNSUPPORTED`: what a driver answers when it will not give you this. */
const UNSUPPORTED = 0x8cdd;

test('a target the driver refuses disables itself rather than throwing', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const reflection = new PlanarReflection(fakeGl(UNSUPPORTED), 1, 4096);

  expect(() => reflection.prepare(fakeGl(UNSUPPORTED), 1920, 1080)).not.toThrow();
  expect(reflection.usable, 'a refused target must not be rendered into').toBe(false);
  expect(reflection.isReadyFor(0), 'and nothing may sample it').toBe(false);
  expect(warn, 'a misconfiguration still has to be findable').toHaveBeenCalledTimes(1);

  // Asked again at a new size, it stays refused and stays quiet: retrying every resize
  // would spend the same memory on the same answer and put the warning in the frame loop.
  reflection.prepare(fakeGl(UNSUPPORTED), 1280, 720);
  expect(warn).toHaveBeenCalledTimes(1);
  warn.mockRestore();
});

test('a target the driver accepts is usable, which is the case that must not regress', () => {
  const gl = fakeGl(COMPLETE);
  const reflection = new PlanarReflection(gl, 1, 4096);
  reflection.prepare(gl, 1920, 1080);
  expect(reflection.usable).toBe(true);
});

/**
 * The mirror's depth is finished with the moment the mirror is.
 *
 * It is a `DEPTH_COMPONENT24` **renderbuffer**, so no shader can sample it — the same argument
 * `SceneTarget.resolve` makes about the multisampled pair, and the same one the WebGPU backend
 * acts on with `depthStoreOp: 'discard'`. This backend simply unbound and left it, so a tiler
 * wrote a full-size depth attachment out to memory for a reader that cannot exist.
 *
 * **Before the unbind**, because `invalidateFramebuffer` acts on whatever is bound: after it,
 * the call names the default framebuffer, which is the frame.
 */
test('the mirror says its depth is finished with, before it unbinds', () => {
  const { gl, calls } = recordingGl(COMPLETE);
  const reflection = new PlanarReflection(gl, 1, 4096);
  reflection.prepare(gl, 1920, 1080);
  calls.length = 0;

  reflection.end(gl);

  const invalidated = calls.findIndex((call) => call.name === 'invalidateFramebuffer');
  const unbound = calls.findIndex((call) => call.name === 'bindFramebuffer');
  expect(invalidated, 'the mirror has to say it is finished with its depth').toBeGreaterThanOrEqual(
    0,
  );
  expect(invalidated, 'and say it while the mirror is still bound').toBeLessThan(unbound);
  expect(calls[invalidated]?.args[1]).toEqual([0x8d00]);
});

/** The dial a consumer turns when it distrusts a discard, on this backend as on the other. */
test('the mirror keeps its depth when discards are switched off', () => {
  const { gl, calls } = recordingGl(COMPLETE);
  const reflection = new PlanarReflection(gl, 1, 4096, false);
  reflection.prepare(gl, 1920, 1080);
  calls.length = 0;

  reflection.end(gl);

  expect(calls.some((call) => call.name === 'invalidateFramebuffer')).toBe(false);
});
