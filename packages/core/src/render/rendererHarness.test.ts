import { mat4 } from 'gl-matrix';
import { expect, test, vi } from 'vitest';

import { boundsOfPositions, createBounds } from '../math/bounds.ts';
import { Renderer } from './backend/webgl2/renderer.ts';
import { recordingGl } from './rendererHarness.ts';
import { resolveRenderQuality } from './renderQuality.ts';

test('the harness constructs a WebGL2 renderer at all', () => {
  const { canvas } = recordingGl();
  expect(() => new Renderer(canvas, resolveRenderQuality({}))).not.toThrow();
});

/**
 * A package draws where the caller puts it, and nowhere else.
 *
 * Registering is not drawing — a package builds its resources at registration and a frame that
 * never invokes it must cost nothing — and invoking it twice in a frame draws twice, because the
 * caller's order is the only order there is.
 */
test('a registered pass draws where the caller asked, and only then', () => {
  const { canvas, gl } = recordingGl();
  const renderer = new Renderer(canvas, resolveRenderQuality({}));
  const contexts: unknown[] = [];
  const handle = renderer.registerPass({
    label: 'probe',
    draw: (ctx) => contexts.push(ctx),
  });

  renderer.beginFrame([0, 0, 0]);
  expect(contexts.length, 'registering draws nothing').toBe(0);

  renderer.drawPass(handle);
  expect(contexts.length, 'and invoking it draws once').toBe(1);
  /* Identity rather than deep equality: the context is a `Proxy` and walking it diverges. */
  const ctx = contexts[0] as { backend: string; gl: unknown };
  expect(ctx.backend, 'told which backend it is talking to').toBe('webgl2');
  expect(ctx.gl, 'and handed that backend, not a copy of it').toBe(gl);

  renderer.endFrame();
  expect(contexts.length, 'and the frame ending does not run it again').toBe(1);
});

/** What `init` is for, and when it happens. */
test('a registered pass builds its resources once, at registration', () => {
  const { canvas, gl } = recordingGl();
  const renderer = new Renderer(canvas, resolveRenderQuality({}));
  const built: unknown[] = [];
  const handle = renderer.registerPass({
    label: 'probe',
    init: (device) => built.push(device),
    draw: () => {},
  });

  expect(built.length, 'built the moment it registered').toBe(1);
  const device = built[0] as { backend: string; gl: unknown };
  expect(device.backend).toBe('webgl2');
  expect(device.gl).toBe(gl);

  renderer.beginFrame([0, 0, 0]);
  renderer.drawPass(handle);
  renderer.drawPass(handle);
  renderer.endFrame();
  expect(built.length, 'and not again, however often it draws').toBe(1);
});

/** A torn-down package must stop drawing, which is what the handle's generation is for. */
test('an unregistered pass stops drawing and is disposed', () => {
  const { canvas } = recordingGl();
  const renderer = new Renderer(canvas, resolveRenderQuality({}));
  let drawn = 0;
  let disposed = 0;
  const handle = renderer.registerPass({
    label: 'probe',
    draw: () => {
      drawn += 1;
    },
    dispose: () => {
      disposed += 1;
    },
  });

  renderer.beginFrame([0, 0, 0]);
  renderer.drawPass(handle);
  renderer.unregisterPass(handle);
  renderer.drawPass(handle);
  renderer.endFrame();

  expect(drawn, 'the second invocation names a pass that is gone').toBe(1);
  expect(disposed, 'and it was told to let go of what it built').toBe(1);
});

/**
 * Teardown releases what registration built.
 *
 * **A private field going out of scope is not a GPU object being deleted.** `unregisterPass` has
 * always released the definition it removed, and nothing called it on teardown — so a consumer
 * that creates and destroys renderers, which is a page switching worlds, an editor reopening a
 * viewport, or a suite like this one, leaked a program and its buffers per registration per
 * renderer. The pass surface is where a contributing package puts its resources, so the leak is
 * in the seam rather than in any one contributor.
 */
test('disposing the renderer releases every registered pass, exactly once', () => {
  const { canvas, gl } = recordingGl();
  const renderer = new Renderer(canvas, resolveRenderQuality({}));
  const released: unknown[] = [];
  renderer.registerPass({
    label: 'probe',
    draw: () => {},
    dispose: (device) => released.push(device),
  });

  renderer.dispose();
  expect(released.length, 'told to let go of what it built').toBe(1);
  const device = released[0] as { backend: string; gl: unknown };
  expect(device.backend, 'and handed the device it was given at init').toBe('webgl2');
  expect(device.gl, 'that one, not a copy of it').toBe(gl);

  /* Idempotent for the reason `dispose` itself is: a React cleanup can race an unmount. */
  renderer.dispose();
  expect(released.length, 'and not again on a second teardown').toBe(1);
});

/** Two paths release a definition, and between them they release it once. */
test('a pass unregistered before teardown is not released a second time', () => {
  const { canvas } = recordingGl();
  const renderer = new Renderer(canvas, resolveRenderQuality({}));
  let released = 0;
  const handle = renderer.registerPass({
    label: 'probe',
    draw: () => {},
    dispose: () => {
      released += 1;
    },
  });

  renderer.unregisterPass(handle);
  renderer.dispose();

  expect(released, 'the registry no longer holds it, so teardown finds nothing').toBe(1);
});

/** A camera at the origin looking down -Z, with a real projection in it. */
function cameraLookingDownZ() {
  const projection = mat4.perspective(mat4.create(), Math.PI / 2, 1, 1, 500);
  const view = mat4.lookAt(mat4.create(), [0, 0, 0], [0, 0, -1], [0, 1, 0]);
  const viewProjection = mat4.multiply(mat4.create(), projection, view);
  return { viewProjection, projection, position: new Float32Array([0, 0, 0]) } as never;
}

/** The least environment `bindMeshPass` reads without a real uniform table under it. */
const ENV = {
  directionalDir: new Float32Array([0, 1, 0]),
  directionalColor: new Float32Array([1, 1, 1]),
  ambient: new Float32Array([0.1, 0.1, 0.1]),
  ambientGround: new Float32Array([0.1, 0.1, 0.1]),
  shadowDepthSpan: 100,
  shadowStrength: 0.5,
  fogColor: new Float32Array([0.5, 0.5, 0.5]),
  fogDensity: 0.01,
  fogHeightFalloff: 0.1,
  fogBaseY: 0,
  underwater: null,
  emissiveGain: 1,
  nightFactor: 0,
  lightViewProj: new Float32Array(16),
} as never;

const unit = boundsOfPositions(
  new Float32Array([1, 0, 0, -1, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 1, 0, 0, -1]),
  createBounds(),
);

/**
 * The same question, asked of the other backend.
 *
 * Both renderers call one shared `boundsVisible`, so this is checking the wiring — that a
 * frustum is built at `bindMeshPass` from the uncorrected camera matrix — rather than the
 * arithmetic, which `visibility.test.ts` owns.
 */
test('the WebGL2 renderer says what is on screen', () => {
  const { canvas } = recordingGl();
  const renderer = new Renderer(canvas, resolveRenderQuality({}));

  renderer.beginFrame([0, 0, 0]);
  renderer.bindMeshPass(cameraLookingDownZ(), ENV);

  expect(
    renderer.visible(unit, mat4.fromTranslation(mat4.create(), [0, 0, -10]) as Float32Array),
    'ten metres along the axis the camera looks down',
  ).toBe(true);
  expect(
    renderer.visible(unit, mat4.fromTranslation(mat4.create(), [0, 0, 400]) as Float32Array),
    'four hundred the other way',
  ).toBe(false);
});

/**
 * The seam for a stage this backend does not have.
 *
 * **A no-op is what the 2026-08-13 rule forbids, and a refusal is what it asks for.** WebGL2 has
 * no compute shaders, so there is nothing to degrade *to*; what is left is to say so at the one
 * moment a consumer can still act on it, which is registration. These assert that it is said, that
 * it is said once, and that nothing afterwards throws inside a frame.
 */
test('the compute seam says WebGL2 has no compute, rather than answering a live handle', () => {
  const { canvas } = recordingGl();
  const renderer = new Renderer(canvas, resolveRenderQuality({}));
  const said = vi.spyOn(console, 'error').mockImplementation(() => {});

  expect(renderer.computeSupported, 'answered honestly rather than hopefully').toBe(false);
  const handle = renderer.registerCompute({ label: 'binner', dispatch: () => {} });

  /* Zero is the handle `definitionAt` already reads as naming nothing. */
  expect(handle).toBe(0);
  expect(said).toHaveBeenCalledTimes(1);
  const message = String(said.mock.calls[0]?.[0]);
  expect(message, 'names the definition that will never run').toContain('binner');
  expect(message, 'and the member to read instead').toContain('computeSupported');
  said.mockRestore();
});

test('a refused definition never runs, and dispatching it never throws', () => {
  const { canvas } = recordingGl();
  const renderer = new Renderer(canvas, resolveRenderQuality({}));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const dispatch = vi.fn();
  const handle = renderer.registerCompute({ label: 'binner', dispatch });

  /* After boot the frame loop never throws, whatever it is asked to do. */
  expect(() => renderer.dispatchCompute(handle)).not.toThrow();
  expect(() => renderer.unregisterCompute(handle)).not.toThrow();
  expect(dispatch).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

test('the refusal is once a definition, not once a frame', () => {
  const { canvas } = recordingGl();
  const renderer = new Renderer(canvas, resolveRenderQuality({}));
  const said = vi.spyOn(console, 'error').mockImplementation(() => {});

  renderer.registerCompute({ label: 'binner', dispatch: () => {} });
  renderer.registerCompute({ label: 'binner', dispatch: () => {} });
  renderer.registerCompute({ label: 'sorter', dispatch: () => {} });

  /* A consumer that registers per frame would otherwise flood a console it needs to read. */
  expect(said).toHaveBeenCalledTimes(2);
  said.mockRestore();
});

/**
 * `prepare` runs once a frame, before the frame's own target is touched.
 *
 * **The ordering is the capability**, not the callback: a pass-owned target filled *after* the
 * frame's pass had opened would be sampled a frame late, which looks like a one-frame lag and gets
 * blamed on the consumer's own timing. The clear is the marker because it is the first thing
 * `beginFrame` does to the frame after this step.
 */
test('a pass that owns a target fills it before the frame is cleared', () => {
  const { canvas, calls } = recordingGl();
  const renderer = new Renderer(canvas, resolveRenderQuality({}));
  let clearsWhenPrepared = -1;
  renderer.registerPass({
    label: 'owner',
    prepare: () => {
      clearsWhenPrepared = calls.filter((c) => c.name === 'clear').length;
    },
    draw: () => {},
  });

  const clearsBefore = calls.filter((c) => c.name === 'clear').length;
  renderer.beginFrame([0, 0, 0]);

  expect(clearsWhenPrepared, 'it ran at all').toBeGreaterThanOrEqual(0);
  expect(clearsWhenPrepared, 'and ran before the frame cleared').toBe(clearsBefore);
  expect(
    calls.filter((c) => c.name === 'clear').length,
    'while the frame did go on to clear',
  ).toBeGreaterThan(clearsBefore);
});

/**
 * Registration order, and it must not be read as dependency order.
 *
 * Gate 1.2 withdrew dependency ordering with a reason on record. This is an order, not a graph: a
 * pass that needs another's output registers after it and knows that it does.
 */
test('passes that own targets are prepared in registration order, once a frame', () => {
  const { canvas } = recordingGl();
  const renderer = new Renderer(canvas, resolveRenderQuality({}));
  const ran: string[] = [];
  renderer.registerPass({ label: 'first', prepare: () => ran.push('first'), draw: () => {} });
  renderer.registerPass({ label: 'second', prepare: () => ran.push('second'), draw: () => {} });

  renderer.beginFrame([0, 0, 0]);
  renderer.endFrame();
  expect(ran).toEqual(['first', 'second']);

  renderer.beginFrame([0, 0, 0]);
  expect(ran, 'a second frame prepares them again, and only once each').toEqual([
    'first',
    'second',
    'first',
    'second',
  ]);
});

/** A pass that never asked for the step is never asked, and neither is one that has gone. */
test('a pass with no prepare is not prepared, and an unregistered one stops', () => {
  const { canvas } = recordingGl();
  const renderer = new Renderer(canvas, resolveRenderQuality({}));
  let quiet = 0;
  let noisy = 0;
  renderer.registerPass({
    label: 'quiet',
    draw: () => {
      quiet++;
    },
  });
  const handle = renderer.registerPass({
    label: 'noisy',
    prepare: () => {
      noisy++;
    },
    draw: () => {},
  });

  renderer.beginFrame([0, 0, 0]);
  expect(noisy).toBe(1);
  expect(quiet, 'and preparing is not drawing').toBe(0);

  renderer.unregisterPass(handle);
  renderer.beginFrame([0, 0, 0]);
  expect(noisy, 'a pass let go of prepares nothing').toBe(1);
});
