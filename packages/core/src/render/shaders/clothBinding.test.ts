import { expect, test } from 'vitest';

import { CLOTH_BINDING_GLSL, clothBound } from './clothBinding.ts';
import { DEPTH_SKINNED_VERT, DEPTH_VERT, GLASS_TINT_SKINNED_VERT } from './depth.ts';
import { flatVert } from './flat/index.ts';
import { DEPTH_SKINNED_VERT_WGSL, GLASS_TINT_SKINNED_VERT_WGSL } from './generated/depth.wgsl.ts';

const flat = (skinned: boolean): string =>
  flatVert({ skinned, morphed: false, instanced: false }).replace(/\s+/g, ' ');

/*
 * **The colour pass and the caster move a bound vertex the same way**, after the skeleton and the
 * bend, by the painted weight — or the garment's shadow parts from the garment as it swings.
 */
test('THE COLOUR PASS AND THE SHADOW CASTER MOVE A BOUND VERTEX THE SAME WAY', () => {
  const colour = flat(true);
  expect(colour).toContain('if (CLOTH_BOUND) {');
  expect(colour).toContain('world = vec4(mix(world.xyz, clothPosition, follow), world.w);');
  expect(colour).toContain('worldNormal = normalize(mix(worldNormal, turn * aNormal, follow));');
  /* After the cloth has moved it, so lighting and the shadow lookup read where it is drawn. */
  expect(colour.indexOf('vWorldPos = world.xyz;')).toBeGreaterThan(
    colour.indexOf('CLOTH_BOUND) {'),
  );
  const caster = DEPTH_SKINNED_VERT.replace(/\s+/g, ' ');
  expect(caster).toContain('bent = mix(bent, clothPosition, follow);');
  expect(caster.indexOf('vLightPosition = uLightViewProj * vec4(bent')).toBeGreaterThan(
    caster.indexOf('CLOTH_BOUND) {'),
  );
});

/* Only the skinned variants carry it: a rigid mesh and the glass-tint caster keep their bindings. */
test('only the skinned colour and caster stages declare the cloth binding', () => {
  expect(flat(false)).not.toContain('CLOTH_BOUND');
  expect(DEPTH_VERT).not.toContain('CLOTH_BOUND');
  expect(GLASS_TINT_SKINNED_VERT).not.toContain('CLOTH_BOUND');
  expect(GLASS_TINT_SKINNED_VERT_WGSL).not.toContain('CLOTH_BOUND');
  expect(DEPTH_SKINNED_VERT_WGSL).toMatch(/override CLOTH_BOUND\s*:\s*bool\s*=\s*false/);
});

/* The switch flips the constant and nothing else, and refuses a stage that has none to flip. */
test('clothBound flips the constant and refuses a stage without one', () => {
  const on = clothBound(CLOTH_BINDING_GLSL);
  expect(on).toContain('const bool CLOTH_BOUND = true;');
  expect(on.replace('= true;', '= false;')).toBe(CLOTH_BINDING_GLSL);
  expect(() => clothBound('void main() {}')).toThrow(/CLOTH_BOUND/);
});

/* A vertex named to one particle three times sits on it: no frame is built from a degenerate one. */
test('a vertex bound to one particle sits on it with no turn', () => {
  const source = CLOTH_BINDING_GLSL.replace(/\s+/g, ' ');
  expect(source).toContain('if (a == b && b == c) { position = pa; turn = mat3(1.0);');
});
