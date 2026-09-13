/**
 * The two measurements the visual gate rests on.
 *
 * Both have a wrong version that reads as right, which is why they are tested rather than
 * eyeballed. `compare` collapsed to a single mean would call a tone curve and eight-bit rounding
 * the same event. `speckle` built on a 3x3 *mean* is dragged upward by the very pixel under test,
 * so a bright speck partly hides itself; the median is what makes the comparison be against what
 * the neighbourhood would have been without it.
 *
 * Expectations are hand-derived from the constructed images, never from the functions.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { compare, luminance, speckle } from '../packages/core/scripts/frames.mjs';

/** A grey image, so luminance equals the value written and the arithmetic stays checkable. */
function grey(width, height, fill) {
  const channels = 4;
  const pixels = Buffer.alloc(width * height * channels);
  for (let i = 0; i < width * height; i++) {
    const at = i * channels;
    const value = typeof fill === 'function' ? fill(i % width, Math.floor(i / width)) : fill;
    pixels[at] = value;
    pixels[at + 1] = value;
    pixels[at + 2] = value;
    pixels[at + 3] = 255;
  }
  return { width, height, channels, pixels };
}

test('a grey pixel has its own value as its luminance', () => {
  /* The three weights sum to 1, so this is the check that they were transcribed correctly. */
  const image = grey(1, 1, 200);
  assert.ok(Math.abs(luminance(image.pixels, 0) - 200) < 1e-6);
});

test('two identical frames are reported as identical', () => {
  const one = grey(4, 4, 100);
  const result = compare(one, grey(4, 4, 100));
  assert.equal(result.changed, 0);
  assert.equal(result.meanDelta, 0);
  assert.equal(result.worstAt, null);
});

test('a change below the tolerance is not a change', () => {
  /*
   * One step of eight bits is what rounding produces between a byte and a half float, and a gate
   * that called it a difference would report every frame as changed for ever.
   */
  const result = compare(grey(4, 4, 100), grey(4, 4, 101));
  assert.equal(result.changed, 0);
  assert.equal(compare(grey(4, 4, 100), grey(4, 4, 103)).changed, 16);
});

test('the bands split by the first frame, which is what makes an effect legible', () => {
  /*
   * Left half dark at 10, right half near white at 240. Only the bright half moves, by 20.
   * A single mean over the frame would report 10 across everything and say nothing about where.
   */
  const one = grey(4, 2, (x) => (x < 2 ? 10 : 240));
  const two = grey(4, 2, (x) => (x < 2 ? 10 : 220));
  const result = compare(one, two);
  const band = (name) => result.bands.find((entry) => entry.name === name);
  assert.equal(band('dark').pixels, 4);
  assert.equal(band('dark').changed, 0);
  assert.equal(band('near white').pixels, 4);
  assert.equal(band('near white').changed, 4);
  assert.ok(Math.abs(band('near white').meanDelta - 20) < 1e-6);
  assert.equal(result.changed, 4);
});

test('a region excludes the readout a harness draws over the picture', () => {
  /* Bottom row differs, as a frame rate printed in a corner does on every single run. */
  const one = grey(4, 4, 100);
  const two = grey(4, 4, (_x, y) => (y === 3 ? 200 : 100));
  assert.equal(compare(one, two).changed, 4);
  assert.equal(compare(one, two, { region: { x0: 0, y0: 0, x1: 4, y1: 3 } }).changed, 0);
});

test('frames of different sizes are refused rather than compared', () => {
  assert.throws(() => compare(grey(4, 4, 0), grey(4, 5, 0)), /nothing to compare/);
});

test('speckle counts a lone bright pixel and ignores a flat field', () => {
  const flat = grey(5, 5, 100);
  assert.equal(speckle(flat), 0);

  /* One pixel at the centre, 40 above its neighbours. Above 12, above 25, and it is one pixel. */
  const speck = grey(5, 5, (x, y) => (x === 2 && y === 2 ? 140 : 100));
  assert.equal(speckle(speck, { threshold: 12 }), 1);
  assert.equal(speckle(speck, { threshold: 25 }), 1);
  assert.equal(speckle(speck, { threshold: 60 }), 0);
});

test('the interior of a real highlight is not speckle, which is why the median is used', () => {
  /*
   * A 3x3 bright block in a dark field. Its centre pixel has eight bright neighbours, so the
   * median of its neighbourhood is bright and it counts for nothing. A 3x3 *mean* would put the
   * median at roughly the field's value and report the middle of every highlight in the frame.
   */
  const block = grey(7, 7, (x, y) => (x >= 2 && x <= 4 && y >= 2 && y <= 4 ? 200 : 20));
  assert.equal(speckle(block, { threshold: 12, region: { x0: 3, y0: 3, x1: 4, y1: 4 } }), 0);
});
