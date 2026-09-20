import { expect, test } from 'vitest';
import {
  CHANNEL_SEMANTICS,
  isColour,
  linearToSrgb,
  needsVarianceMips,
  normaliseSample,
  semanticAt,
  semanticIndex,
  srgbToLinear,
} from './semantics.ts';
import { REMAP_SEMANTICS } from './decodeCpu.ts';

test('a colour channel is a colour and a roughness channel is not', () => {
  expect(isColour('albedo-srgb')).toBe(true);
  expect(isColour('roughness-linear')).toBe(false);
});

test('only a normal channel asks for variance-preserving mips', () => {
  expect(needsVarianceMips('normal-tangent-yup')).toBe(true);
  expect(needsVarianceMips('normal-tangent-ydown')).toBe(true);
  expect(needsVarianceMips('albedo-srgb')).toBe(false);
});

test('a Y-down normal comes out Y-up, so a consumer never asks which it is', () => {
  const out = new Float32Array(4);
  normaliseSample(out, { semantic: 'normal-tangent-ydown', component: 1 }, 0.25);
  expect(out[1]).toBeCloseTo(0.75, 6);
});

test('a Y-up normal is left alone', () => {
  const out = new Float32Array(4);
  normaliseSample(out, { semantic: 'normal-tangent-yup', component: 1 }, 0.25);
  expect(out[1]).toBeCloseTo(0.25, 6);
});

test('gloss becomes roughness, because the engine shades with one of them', () => {
  const out = new Float32Array(4);
  normaliseSample(out, { semantic: 'gloss-linear', component: 0 }, 0.8);
  expect(out[0]).toBeCloseTo(0.2, 6);
});

test('the sRGB curve is the exact one, and the midpoint is what tells it from the approximation', () => {
  const out = new Float32Array(4);
  normaliseSample(out, { semantic: 'albedo-srgb', component: 0 }, 0.5);
  expect(out[0]).toBeCloseTo(0.214, 4);
  /* The 2.2 power approximation would give 0.2176, which this must not be. */
  expect(Math.abs((out[0] as number) - 0.2176)).toBeGreaterThan(0.002);
});

test('the transfer curve round-trips', () => {
  for (const v of [0, 0.01, 0.04, 0.5, 0.9, 1]) {
    expect(linearToSrgb(srgbToLinear(v))).toBeCloseTo(v, 6);
  }
});

test('a linear channel passes through untouched', () => {
  const out = new Float32Array(4);
  normaliseSample(out, { semantic: 'metallic-linear', component: 2 }, 0.37);
  expect(out[2]).toBeCloseTo(0.37, 6);
});

/**
 * **The order of the semantics is part of the file format**, because a `DTEX` chunk stores a
 * channel as `(semanticIndex << 4) | component` rather than as a name — `@driftengine/drft` is the
 * container and knows nothing about what a channel means. So this is not a list of what exists: it
 * is the *numbering*, and reordering it silently changes what every file written before the change
 * decodes to. A normal map read as roughness inverts every highlight in a scene and looks like a
 * shading fault.
 */
test('IS FIXED, AND MAY ONLY BE APPENDED TO', () => {
  expect(CHANNEL_SEMANTICS).toEqual([
    'albedo-srgb',
    'albedo-linear',
    'normal-tangent-yup',
    'normal-tangent-ydown',
    'roughness-linear',
    'gloss-linear',
    'metallic-linear',
    'occlusion-linear',
    'height-linear',
    'emissive-srgb',
    'mask-linear',
  ]);
});

test('round-trips every semantic through its index', () => {
  for (const semantic of CHANNEL_SEMANTICS) {
    const index = semanticIndex(semantic);
    expect(index).toBeGreaterThanOrEqual(0);
    expect(semanticAt(index)).toBe(semantic);
  }
  /* Every index distinct, so no two semantics share a slot. */
  expect(new Set(CHANNEL_SEMANTICS.map((s) => semanticIndex(s))).size).toBe(
    CHANNEL_SEMANTICS.length,
  );
});

test('answers nothing for an index a later version wrote, rather than guessing', () => {
  expect(semanticAt(CHANNEL_SEMANTICS.length)).toBeNull();
  expect(semanticAt(-1)).toBeNull();
  expect(semanticAt(4095)).toBeNull();
});

/**
 * A channel is packed into one word with four bits of component beside the semantic, so the
 * numbering has room for 268 million semantics and the component for sixteen — and what would
 * actually run out first is the component, which is what this pins.
 */
test('leaves room beside the component the packing gives it', () => {
  expect(CHANNEL_SEMANTICS.length).toBeLessThan(1 << 28);
  for (const semantic of CHANNEL_SEMANTICS) {
    const packed = (semanticIndex(semantic) << 4) | 3;
    expect(packed & 15).toBe(3);
    expect(semanticAt(packed >>> 4)).toBe(semantic);
  }
});

test('THE PACKING ORDER AND THE SEMANTIC TABLE ARE ONE LIST, not two that agree today', () => {
  /*
   * `REMAP_SEMANTICS` is what the decode interpreter packs a channel by and `CHANNEL_SEMANTICS` is
   * what a `DTEX` chunk numbers one by. **They were two copies of the same eleven names** until
   * 2026-09-20, with nothing holding them together — and a file numbered by one and read by the
   * other decodes its channels as something else. This asserts they are the same object, which is
   * stronger than asserting they are equal: two lists that are equal can stop being.
   */
  expect(REMAP_SEMANTICS).toBe(CHANNEL_SEMANTICS);
});
