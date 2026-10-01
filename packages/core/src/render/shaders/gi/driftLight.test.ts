import { expect, test } from 'vitest';

import { DRIFT_LIGHT_GLSL } from '../flat/driftLight.ts';
import { DRIFT_LIGHT_WGSL } from './driftLight.wgsl.ts';
import { probeBakeWgsl } from './probeBake.wgsl.ts';

/**
 * The summed light as the frame reads it and as a probe's ray reads it, which are one lookup in two
 * languages. Nothing ties them but these assertions, so this checks that two transcriptions agree
 * and nothing more; what says the lookup is right is the bake beside the GLSL, `driftLight/bake.ts`.
 */

const collapse = (text: string): string => text.replace(/\s+/g, ' ');

test('A PROBE READS THE SUMMED LIGHT THE WAY THE FRAME DOES, line for line', () => {
  const glsl = collapse(DRIFT_LIGHT_GLSL);
  const wgsl = collapse(DRIFT_LIGHT_WGSL);
  /* Each pair is one line of the frame's lookup and its transcription. */
  const pairs: [string, string][] = [
    [
      'vec3 at = (world + n * (0.5 * spacing) - uDriftLightOrigin.xyz) / (3.0 * spacing);',
      'let at = (world + n * (0.5 * spacing) - origin.xyz) / (3.0 * spacing);',
    ],
    ['int across = size.x / 8;', 'let across = size.x / 8;'],
    ['int down = size.y / 4;', 'let down = size.y / 4;'],
    [
      'float((brick % across) * 8), float(((brick / across) % down) * 4), float((brick / (across * down)) * 4)',
      'f32((brick % across) * 8), f32(((brick / across) % down) * 4), f32((brick / (across * down)) * 4)',
    ],
    [
      'vec3 inside = (at - vec3(cell)) * 3.0 + 0.5;',
      'let inside = (at - vec3<f32>(cell)) * 3.0 + 0.5;',
    ],
    [
      'vec4 light = textureLod(uDriftLightAtlas, (corner + inside) * texel, 0.0);',
      'let light = textureSampleLevel(driftAtlas, driftSampler, (corner + inside) * texel, 0.0);',
    ],
    [
      '(corner + vec3(4.0, 0.0, 0.0) + inside) * texel',
      '(corner + vec3<f32>(4.0, 0.0, 0.0) + inside) * texel',
    ],
    ['if (light.a < 1e-3) return vec3(0.0);', 'if (light.a < 1e-3) { return vec3<f32>(0.0); }'],
    [
      'float facing = max(dot(n, from), 0.0) + (1.0 - min(length(from), 1.0)) * 0.25;',
      'let facing = max(dot(n, towardLight), 0.0) + (1.0 - min(length(towardLight), 1.0)) * 0.25;',
    ],
    ['return driftLightFacing(light, toward, n);', 'return driftLightFacing(light, toward, n);'],
    /* A world's dense volume, chosen by a negative spacing: one sample a texel, light below and
       direction above along y. */
    [
      'if (spacing < 0.0) return driftLightDense(world, n, -spacing);',
      'if (spacing < 0.0) { return driftLightDense(world, n, origin, -spacing); }',
    ],
    [
      'vec3 dims = vec3(float(size.x), float(size.y / 2), float(size.z));',
      'let dims = vec3<f32>(f32(size.x), f32(size.y / 2), f32(size.z));',
    ],
    [
      'vec3 at = (world + n * (0.5 * spacing) - uDriftLightOrigin.xyz) / spacing;',
      'let at = (world + n * (0.5 * spacing) - origin.xyz) / spacing;',
    ],
    [
      'if (any(lessThan(at, vec3(0.0))) || any(greaterThan(at, dims - 1.0))) return vec3(0.0);',
      'if (any(at < vec3<f32>(0.0)) || any(at > dims - 1.0)) { return vec3<f32>(0.0); }',
    ],
    [
      'vec3 uvw = (at + 0.5) / vec3(dims.x, dims.y * 2.0, dims.z);',
      'let uvw = (at + 0.5) / vec3<f32>(dims.x, dims.y * 2.0, dims.z);',
    ],
    [
      'textureLod(uDriftLightAtlas, uvw + vec3(0.0, 0.5, 0.0), 0.0)',
      'textureSampleLevel(driftAtlas, driftSampler, uvw + vec3<f32>(0.0, 0.5, 0.0), 0.0)',
    ],
  ];
  for (const [frame, probe] of pairs) {
    expect(glsl, 'the frame lookup changed; change the probe lookup with it').toContain(frame);
    expect(wgsl, 'the probe lookup no longer reads this line of the frame').toContain(probe);
  }
});

test('A SURFACE A PROBE STRIKES IS LIT BY THE SUMMED LIGHT AS WELL AS THE SUN, which is the bounce', () => {
  /*
   * A candle past the frame's choice lit the wall beside it and nothing else: the trace shaded what
   * it struck with the sun alone, so a courtyard at night bounced no candlelight into the corners
   * the candles could not see. The summed light is added to what arrives at the hit, at the
   * presence and scale the frame uses, before the albedo multiplies it.
   */
  const bake = collapse(probeBakeWgsl());
  expect(bake).toContain(
    'let summed = driftLightIrradiance(p, n, bake.driftOrigin) * (bake.driftLight.x * bake.driftLight.w);',
  );
  expect(bake).toContain('return albedo * (direct + bounced + summed + probeLampsAt(p, n));');
});
