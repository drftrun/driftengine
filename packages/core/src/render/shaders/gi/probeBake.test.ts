import { expect, test } from 'vitest';
import { flatFrag } from '../flat/index.ts';
import { SKY_FRAG } from '../sky.ts';
import { probeBakeWgsl } from './probeBake.wgsl.ts';

/**
 * The traced bounce against the surface shader it has to agree with.
 *
 * **A wall seen directly and the same wall seen by a probe are one wall**, and the two paths light
 * it in different languages: the frame in GLSL through the flat shader, the probe bake in
 * hand-written WGSL. Nothing ties them but these assertions, which read both sources. That makes
 * this a check that two transcriptions agree and nothing more; what says the agreed number is
 * *right* is `scripts/bounce-check.mjs`, which holds the traced room against a path-traced
 * reference of it.
 */

const collapse = (text: string): string => text.replace(/\s+/g, ' ');

const frame = collapse(
  flatFrag({
    pointShadows: true,
    directionalShadows: true,
    environmentProbe: true,
    nightEmissive: false,
  }),
);
const bake = collapse(probeBakeWgsl());

test('A SUNLIT WALL SENDS A PROBE WHAT THE FRAME DRAWS IT AS, the sun at the scale the surface shader lights with', () => {
  /*
   * The frame's diffuse: albedo times the ambient plus the sun's colour times its cosine, and no
   * division by pi — `directionalColor` is the radiance a white surface facing the sun sends back.
   * The probes' own level is stored as a mean radiance, so the ambient term needs none either.
   */
  /* The frame's sun is the environment's colour times what glass lets through on its way; the bake
     sees no glass, so a bounce through a tinted window comes back untinted — stated in glassShadow.ts. */
  expect(frame).toContain('vec3 sunColor = uDirectionalColor * sunGlass;');
  expect(frame).toContain('lit = albedo * (ambient + sunColor * direct * (1.0 - metal));');
  /*
   * So a traced hit sends the sun at the same scale. Divided by pi it did not, and every sunlit
   * wall a probe struck came back a third as bright as the frame drew it: a room lit through its
   * one open side measured 66 of 255 against a path-traced 200.
   */
  expect(bake).toContain('let direct = bake.sunColour * facing * probeSunVisible(p, n);');
  expect(bake).toContain('return albedo * (direct + bounced + summed + probeLampsAt(p, n));');
});

test('A RAY THAT LEAVES THE WORLD SEES THE SKY THE FRAME DRAWS, its gradient and its sunset bands', () => {
  /*
   * The trace read one flat colour for everything outside, the environment's ambient, while the
   * rasterised probes it replaces saw the sky as drawn: at ten degrees of sun a horizon of
   * (1.5, 1.08, 0.66) against an ambient of (0.26, 0.28, 0.38), five times dimmer and blue. So a
   * courtyard at dusk came out cooler traced than the grade it was judged on. The bake now shades
   * an escaping ray with the sky shader's own shape, line for line, and each pair here is one line
   * of the sky and its transcription: change either and this says which the other one is.
   */
  const sky = collapse(SKY_FRAG);
  const pairs: [string, string][] = [
    [
      'mix(uHorizonColor, uTopColor, pow(min(t, 1.0), 0.55))',
      'mix(bake.skyColour, bake.skyTop, pow(min(t, 1.0), 0.55))',
    ],
    [
      'mix(uHorizonColor, uDeepColor, min(-t * 1.8, 1.0))',
      'mix(bake.skyColour, bake.skyDeep, min(-t * 1.8, 1.0))',
    ],
    [
      'float sunset = (1.0 - smoothstep(-0.03, 0.30, uSunDir.y)) * smoothstep(-0.35, -0.05, uSunDir.y);',
      'let sunset = (1.0 - smoothstep(-0.03, 0.30, bake.skySun.y)) * smoothstep(-0.35, -0.05, bake.skySun.y);',
    ],
    ['vec3 ember = vec3(1.0, 0.36, 0.13);', 'let ember = vec3<f32>(1.0, 0.36, 0.13);'],
    [
      'vec2 sunBearing = normalize(uSunDir.xz + vec2(1e-5));',
      'let sunBearing = normalize(bake.skySun.xz + vec2<f32>(1e-5));',
    ],
    [
      'float fromHorizon = dir.y >= 0.0 ? dir.y : -dir.y * 3.0;',
      'let fromHorizon = select(-t * 3.0, t, t >= 0.0);',
    ],
    [
      'float band = pow(1.0 - min(fromHorizon * 2.2, 1.0), 2.6);',
      'let band = pow(1.0 - min(fromHorizon * 2.2, 1.0), 2.6);',
    ],
    [
      'col += ember * sunset * band * (0.18 + 0.75 * pow(toward, 2.2));',
      'col += ember * sunset * band * (0.18 + 0.75 * pow(toward, 2.2));',
    ],
    [
      'col += vec3(0.42, 0.28, 0.45) * sunset * band * away * 0.22;',
      'col += vec3<f32>(0.42, 0.28, 0.45) * sunset * band * away * 0.22;',
    ],
  ];
  for (const [drawn, traced] of pairs) {
    expect(sky, 'the sky shader changed; change the bake with it').toContain(drawn);
    expect(bake, 'the bake no longer draws this line of the sky').toContain(traced);
  }
});

test('A PROBE AVERAGES ITS REFRESHES, rather than showing each noisy estimate as it lands', () => {
  /*
   * Each refresh is 256 rays over a direction set that turns every frame, so two refreshes of one
   * probe are two estimates, a few per cent apart. Written straight into the array, a probe jumped
   * that much every time it came round, about nine times a second at 120 frames; the bounce page
   * reported its far wall never still to a level over 240 frames. The convolution now blends the
   * new estimate into what the layer held, by a weight the bake sets.
   */
  expect(bake).toContain(
    'let kept = mix(value, probeHistory(schedule[slot], u, v), bake.history);',
  );
  /* And what it held is the level the blit writes, read texel for texel at the map's own size. */
  expect(bake).toContain(
    'return textureLoad(probeArray, vec2<i32>(i32(u), i32(v)), i32(layer), i32(volume.level)).rgb;',
  );
});

test('A LAMP LIGHTS WHAT A PROBE STRIKES AS IT LIGHTS THE FRAME, its falloff, cone and cosine line for line', () => {
  /*
   * DriftRay shaded a hit with the sun alone, so a courtyard at night bounced no firelight: the
   * braziers and lanterns lit the walls they faced and nothing past them. The frame's exact lights
   * now light a hit too, and each pair here is a line of the lit shader's lamp term and its
   * transcription: change either and this says which the other one is.
   */
  const pairs: [string, string][] = [
    [
      'float window = clamp(1.0 - pow(dist / max(lightRadius, 1e-4), 4.0), 0.0, 1.0);',
      'let window = clamp(1.0 - pow(dist / max(lightRadius, 1e-4), 4.0), 0.0, 1.0);',
    ],
    [
      'falloff = window * window / max(dist * dist, 0.01);',
      'falloff = window * window / max(dist * dist, 0.01);',
    ],
    [
      'falloff = clamp(1.0 - dist / lightRadius, 0.0, 1.0);',
      'falloff = clamp(1.0 - dist / lightRadius, 0.0, 1.0);',
    ],
    [
      'float ndl = max(dot(n, toLight / max(dist, 1e-4)), 0.0);',
      'let ndl = max(dot(n, toLight / max(dist, 1e-4)), 0.0);',
    ],
    [
      'smoothstep(lightCone.y, lightCone.x, dot(-toLight / max(dist, 1e-4), lightDir));',
      'smoothstep(aim.w, colour.w, dot(-toLight / max(dist, 1e-4), aim.xyz));',
    ],
    [
      'falloff = pow(clamp(1.0 - reach * reach, 0.0, 1.0), lightExponent);',
      'falloff = pow(clamp(1.0 - reach * reach, 0.0, 1.0), lightExponent);',
    ],
    [
      '(lightExponent > 0.0 || uLightFalloff == 1 ? falloff : falloff * falloff) *',
      'let shape = select(falloff * falloff, falloff, lightExponent > 0.0 || bake.falloff == 1.0) * coneFalloff;',
    ],
    [
      'vec3 lampDiffuse = albedo * lightColor * ndl * shape * lightWeight * (1.0 - metal);',
      'sum = sum + colour.rgb * ndl * shape * seen;',
    ],
  ];
  for (const [drawn, traced] of pairs) {
    expect(frame, 'the lit shader changed; change the bake with it').toContain(drawn);
    expect(bake, 'the bake no longer lights a hit with this line').toContain(traced);
  }
});
