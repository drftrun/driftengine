/**
 * The programs a pane of glass casts through: the plain depth programs for where the nearest pane
 * is, and these for what the panes let through. Read as source, as `flat.test.ts` reads the lit
 * shader, because the failure they guard is a missing term rather than a wrong number.
 */
import { expect, test } from 'vitest';
import {
  DEPTH_CUTOUT_FRAG,
  DEPTH_VERT,
  GLASS_TINT_CUTOUT_FRAG,
  GLASS_TINT_CUTOUT_VERT,
  GLASS_TINT_FRAG,
  GLASS_TINT_INSTANCED_CUTOUT_VERT,
  GLASS_TINT_INSTANCED_VERT,
  GLASS_TINT_SKINNED_VERT,
  GLASS_TINT_VERT,
} from './depth.ts';

const flat = (source: string): string => source.replace(/\s+/g, ' ');

test('A PANE PASSES ITS COLOUR, LESS WHAT IT REFLECTS TOWARD THE LIGHT, and says how clear it is', () => {
  const frag = flat(GLASS_TINT_FRAG);
  expect(frag).toContain('out vec4 outTint;');
  /* The pane's own normal, from its flat triangle, in uniform control flow. */
  expect(frag).toContain('normalize(cross(dFdx(vGlassWorld), dFdy(vGlassWorld)))');
  /* Schlick at 0.04, glass.ts's arithmetic, at the angle the light meets the pane. */
  expect(frag).toContain('0.04 + 0.96 * pow(1.0 - cosLight, 5.0)');
  expect(frag).toContain('outTint = vec4(uGlassPane.rgb * (1.0 - reflected), uGlassPane.a);');
});

test('EVERY WAY A CASTER IS DRAWN HAS A TINT TWIN that hands the fragment its world position', () => {
  for (const vert of [
    GLASS_TINT_VERT,
    GLASS_TINT_INSTANCED_VERT,
    GLASS_TINT_SKINNED_VERT,
    GLASS_TINT_CUTOUT_VERT,
    GLASS_TINT_INSTANCED_CUTOUT_VERT,
  ]) {
    expect(flat(vert)).toContain('vGlassWorld = bent;');
  }
  /* And the opaque depth program is untouched by any of it. */
  expect(DEPTH_VERT).not.toContain('vGlassWorld');
});

test('A CUT-OUT PANE CASTS ITS COLOUR ONLY WHERE IT CASTS ITS DEPTH', () => {
  /* Stained glass with holes: the tint discards exactly where the depth cutout does. */
  const tint = flat(GLASS_TINT_CUTOUT_FRAG);
  const depth = flat(DEPTH_CUTOUT_FRAG);
  const coverage =
    'float alpha = cutoutAlpha(texture(uCutoutMap, at).a, vUv.xy * vec2(textureSize(uCutoutMap, 0).xy));';
  expect(depth).toContain(coverage);
  expect(tint).toContain(coverage);
  expect(tint).toContain('if (alpha < vAlphaCutout) discard;');
});
