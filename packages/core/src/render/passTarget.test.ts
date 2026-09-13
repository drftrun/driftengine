import { expect, test } from 'vitest';

import type { PassDevice } from './pass.ts';
import { createPassAttachment } from './passTarget.ts';
import { recordingGl } from './rendererHarness.ts';

/**
 * A target a contributed pass owns, on the backend a test can run without a GPU.
 *
 * The WebGPU arm is not tested here and nothing pretends otherwise: it is four `createTexture`
 * calls against an object no harness in this repository can stand in for, and its evidence is
 * `demo/dev/passtarget.html` driven on hardware, which is the same division `compute.html` makes
 * for the other seam that has no picture.
 *
 * What *is* asserted here is the half that has a contract in words rather than in pixels: the
 * builder leaves the default framebuffer bound, refuses a size that cannot work, and releases
 * exactly what it made.
 */
function deviceOf(gl: WebGL2RenderingContext): PassDevice {
  return { backend: 'webgl2', gl, clipCorrection: new Float32Array(16) };
}

test('a target is a colour texture, a depth texture and a framebuffer', () => {
  const { gl, calls } = recordingGl();
  const target = createPassAttachment(deviceOf(gl), { width: 64, height: 32 });

  expect(target.backend).toBe('webgl2');
  expect(target.width).toBe(64);
  expect(target.height).toBe(32);
  expect(calls.filter((c) => c.name === 'createTexture').length, 'colour and depth').toBe(2);
  const attachments = calls.filter((c) => c.name === 'framebufferTexture2D').map((c) => c.args[1]);
  expect(attachments).toContain(gl.COLOR_ATTACHMENT0);
  expect(attachments).toContain(gl.DEPTH_ATTACHMENT);
});

/**
 * **The contract `PrepareContext` writes out, asserted at the one place that could break it.**
 *
 * A pass calls this from `init` or from `prepare`, and both have the default framebuffer bound.
 * A builder that left its own framebuffer bound would take the entire frame with it — every draw
 * after it would land in a 64-pixel texture — and nothing would report an error.
 */
test('it leaves the default framebuffer bound', () => {
  const { gl, calls } = recordingGl();
  createPassAttachment(deviceOf(gl), { width: 8, height: 8 });

  const binds = calls.filter((c) => c.name === 'bindFramebuffer');
  expect(binds.length, 'it binds its own to attach, then puts it back').toBeGreaterThan(1);
  expect(binds[binds.length - 1]?.args[1], 'and the last bind is the default').toBe(null);
});

test('a depthless target makes one texture and attaches only colour', () => {
  const { gl, calls } = recordingGl();
  const target = createPassAttachment(deviceOf(gl), { width: 8, height: 8, depth: false });

  expect(calls.filter((c) => c.name === 'createTexture').length).toBe(1);
  expect(calls.filter((c) => c.name === 'framebufferTexture2D').length).toBe(1);
  expect(target.backend === 'webgl2' && target.depth).toBe(null);
});

test('half floats are asked for as half floats', () => {
  const { gl, calls } = recordingGl();
  createPassAttachment(deviceOf(gl), { width: 8, height: 8, format: 'rgba16float', depth: false });

  const image = calls.find((c) => c.name === 'texImage2D');
  expect(image?.args[2], 'the internal format').toBe(gl.RGBA16F);
  expect(image?.args[7], 'and the type that goes with it').toBe(gl.HALF_FLOAT);
});

/** Fail fast at init: a zero-sized attachment is a framebuffer no driver calls complete. */
test('a size that cannot work is refused rather than built', () => {
  const { gl } = recordingGl();
  expect(() => createPassAttachment(deviceOf(gl), { width: 0, height: 8 })).toThrow(/size/);
  expect(() => createPassAttachment(deviceOf(gl), { width: 8, height: -1 })).toThrow(/size/);
  expect(() => createPassAttachment(deviceOf(gl), { width: 8.5, height: 8 })).toThrow(/size/);
});

/**
 * Nothing releases a pass-owned target for the pass, so the release has to be complete.
 *
 * A leaked framebuffer is cheap and a leaked texture is not: a package that rebuilds its target
 * on every resize would hold one for every size the window has been.
 */
test('dispose releases the framebuffer and both textures', () => {
  const { gl, calls } = recordingGl();
  const target = createPassAttachment(deviceOf(gl), { width: 8, height: 8 });
  const before = calls.length;
  target.dispose();

  const released = calls.slice(before).map((c) => c.name);
  expect(released.filter((n) => n === 'deleteTexture').length).toBe(2);
  expect(released.filter((n) => n === 'deleteFramebuffer').length).toBe(1);
});
