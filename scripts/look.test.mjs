/**
 * `look`'s judgements, tested on frames built by hand. The browser half is `browser.mjs` and
 * `cdp.mjs`, which have their own tests; what is new here is deciding what a frame means.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  EMPTY_SHARE,
  changedShare,
  formatLook,
  frameStats,
  gpuFlagsFor,
  lookUrl,
  sortConsole,
} from '../packages/core/scripts/look.mjs';

/** A frame of one colour with `marked` pixels of another at the start. */
function frame(width, height, [r, g, b], marked = 0, mark = [255, 255, 255]) {
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    const [cr, cg, cb] = i < marked ? mark : [r, g, b];
    rgba.set([cr, cg, cb, 255], i * 4);
  }
  return { width, height, rgba };
}

test('A CANVAS OF ONE COLOUR IS CALLED EMPTY, AND ONE WITH A SCENE ON IT IS NOT', () => {
  const blank = frameStats(frame(100, 100, [13, 14, 18]));
  assert.equal(blank.dominant, '#0d0e12');
  assert.equal(blank.dominantShare, 1);
  assert.ok(blank.dominantShare >= EMPTY_SHARE);

  /* 40 of 10,000 pixels is 0.4%, a cursor's worth: still empty. */
  assert.ok(frameStats(frame(100, 100, [0, 0, 0], 40)).dominantShare >= EMPTY_SHARE);
  /* 60 is 0.6%, just past the line. */
  assert.ok(frameStats(frame(100, 100, [0, 0, 0], 60)).dominantShare < EMPTY_SHARE);
});

test('the mean luminance is Rec. 709 over every pixel', () => {
  /* Half white (255) and half black: 127.5, to the rounding of three coefficients summing to 1. */
  assert.ok(Math.abs(frameStats(frame(10, 10, [0, 0, 0], 50)).meanLuminance - 127.5) < 1e-9);
});

test('movement is the share of pixels past the tolerance, per channel', () => {
  const a = frame(10, 10, [100, 100, 100]);
  const b = frame(10, 10, [100, 100, 100], 25, [100, 103, 100]);
  assert.equal(changedShare(a, b), 0.25);
  /* A difference of 2 on every pixel is dithering, not motion. */
  assert.equal(changedShare(a, frame(10, 10, [102, 100, 98])), 0);
  assert.equal(changedShare(a, frame(5, 5, [100, 100, 100])), 1);
});

test('the console is sorted by the level the browser reported, not by the words in the line', () => {
  const { errors, warnings } = sortConsole([
    'log: 0 errors, 0 warnings',
    'error: Failed to load resource: 404',
    'exception: Uncaught TypeError: x is undefined',
    'warning: a deprecated call',
    'warn: from console.warn',
    'info: an error in prose is not an error',
  ]);
  assert.deepEqual(errors, [
    'error: Failed to load resource: 404',
    'exception: Uncaught TypeError: x is undefined',
  ]);
  assert.deepEqual(warnings, ['warning: a deprecated call', 'warn: from console.warn']);
});

test('the backend is forced by replacing a backend the address already carries, not appending one', () => {
  const url = new URL(lookUrl('http://localhost:5173/?backend=webgpu&level=2', 'webgl2'));
  assert.deepEqual(url.searchParams.getAll('backend'), ['webgl2']);
  assert.equal(url.searchParams.get('splash'), '0');
  assert.equal(url.searchParams.get('level'), '2');
});

test("the GPU flags are ANGLE on each system's native API, and an unknown system gets none", () => {
  assert.deepEqual(gpuFlagsFor('linux'), ['--use-angle=vulkan', '--enable-features=Vulkan']);
  assert.deepEqual(gpuFlagsFor('darwin'), ['--use-angle=metal']);
  assert.deepEqual(gpuFlagsFor('win32'), ['--use-angle=d3d11']);
  assert.equal(gpuFlagsFor('freebsd'), null);
});

test('the report ends on its verdict, and a failed one counts its problems', () => {
  const capture = {
    backend: 'webgl2',
    file: 'out/webgl2.png',
    drawnWith: 'webgl2',
    stats: { dominantShare: 1, dominant: '#000000', meanLuminance: 0 },
    moved: 0,
    errors: ['error: boom'],
    warnings: [],
    problems: ['nothing drew: 100.0% of the canvas is #000000', '1 console error'],
  };
  const text = formatLook({
    url: 'http://localhost:5173/',
    gpu: 'ANGLE (AMD)',
    captures: [capture],
    problems: capture.problems,
    ok: false,
  });
  const lines = text.split('\n');
  assert.equal(lines.at(-1), 'failed: 2 problems');
  assert.ok(lines.includes('  error: boom'));
  assert.ok(lines.some((line) => line.startsWith('  still:')));
});
