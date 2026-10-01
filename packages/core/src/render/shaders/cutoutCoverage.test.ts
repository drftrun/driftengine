import { expect, test } from 'vitest';
import { CUTOUT_COVERAGE_GLSL, cutoutAlpha } from './cutoutCoverage.ts';
import { DEPTH_CUTOUT_FRAG } from './depth.ts';
import { MAIN_GLSL } from './flat/main.ts';

test('A NEEDLE AVERAGED TO A QUARTER TWO LEVELS DOWN STILL PASSES A CUTOFF OF A HALF', () => {
  /*
   * One texel of alpha 1 on a clear ground is 0.25 two levels down. Credited a quarter a level
   * that is 0.25 · 1.5 = 0.375, and at three levels, where it is 0.0625 · 1.75 = 0.109, it has
   * gone: the credit slows the thinning rather than stopping it, which is what keeps a far tree a
   * tree without turning a clear texel solid.
   */
  expect(cutoutAlpha(0.25, 2)).toBeCloseTo(0.375, 12);
  expect(cutoutAlpha(0.0625, 3)).toBeCloseTo(0.109375, 12);
  /* A texel at 0.3 on level 2 reaches 0.45; on level 3, 0.525, past a cutoff of a half. */
  expect(cutoutAlpha(0.3, 3)).toBeCloseTo(0.525, 12);
  /* Magnified, the base level is the base level. */
  expect(cutoutAlpha(0.4, 0)).toBe(0.4);
  expect(cutoutAlpha(0.4, -2)).toBe(0.4);
});

test('the shader carries the same arithmetic, and both cutout tests use it', () => {
  expect(CUTOUT_COVERAGE_GLSL).toContain(
    'float level = max(0.0, 0.5 * log2(max(dot(dx, dx), dot(dy, dy))));',
  );
  expect(CUTOUT_COVERAGE_GLSL).toContain('return alpha * (1.0 + level * 0.25);');
  expect(MAIN_GLSL).toContain(
    'float tested = cutoutAlpha(texel.a, vUv.xy * vec2(textureSize(uAlbedo, 0).xy));',
  );
  expect(DEPTH_CUTOUT_FRAG).toContain(
    'float alpha = cutoutAlpha(texture(uCutoutMap, at).a, vUv.xy * vec2(textureSize(uCutoutMap, 0).xy));',
  );
});

test('A BACK FACE OF A TWO-SIDED SURFACE IS LIT AS ITS FRONT, after its map and relief have turned it', () => {
  /*
   * glTF's rule for doubleSided. Turned before the normal map, only the interpolated normal would
   * flip and the map's in-plane tilt would still point the front's way, lighting every fold of a
   * curtain from the wrong side.
   */
  expect(MAIN_GLSL).toContain(
    'bool backFace = (uDoubleSided != 0 || glassTransmission > 0.0) && dot(n, uCameraPos - vWorldPos) < 0.0;',
  );
  /* No gl_FrontFacing: it is a seventeenth fragment input, over WebGPU's sixteen. */
  expect(MAIN_GLSL).not.toContain('gl_FrontFacing');
  const flip = MAIN_GLSL.indexOf('if (backFace) n = -n;');
  expect(flip).toBeGreaterThan(0);
  expect(flip).toBeGreaterThan(
    MAIN_GLSL.indexOf('n = normalize(mix(n, normalize(tbn * mapped), uNormalStrength));'),
  );
  expect(flip).toBeGreaterThan(MAIN_GLSL.indexOf('n = normalize(abs(det) * n - slope);'));
});
