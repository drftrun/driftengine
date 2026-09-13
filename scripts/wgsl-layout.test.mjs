import assert from 'node:assert/strict';
import { test } from 'node:test';

import { blockLayout, numericDefines } from './wgsl/layout.mjs';

/*
 * Uniform offsets, which nothing checks at runtime.
 *
 * A wrong offset does not throw. It reads a fog colour out of a light direction and draws a
 * picture that is confidently wrong, so these rules are asserted against the cases that
 * actually catch people out rather than against a happy path.
 */

test('scalars pack tightly', () => {
  const { fields, size } = blockLayout(['float a', 'float b', 'int c']);
  assert.equal(fields['a'].offset, 0);
  assert.equal(fields['b'].offset, 4);
  assert.equal(fields['c'].offset, 8);
  assert.equal(size, 16);
});

/*
 * The rule that catches everybody: a `vec3` is twelve bytes and aligns to sixteen, so the
 * next member starts at 16 rather than 12 and a scalar after it lands in the padding.
 */
test('a vec3 occupies twelve bytes and aligns to sixteen', () => {
  const { fields } = blockLayout(['vec3 dir', 'float strength', 'vec3 colour']);
  assert.equal(fields['dir'].offset, 0);
  assert.equal(fields['dir'].size, 12);
  /* The float fits in the vec3's own padding. */
  assert.equal(fields['strength'].offset, 12);
  /* The next vec3 has to start on sixteen. */
  assert.equal(fields['colour'].offset, 16);
});

test('a mat4 is sixty-four bytes on a sixteen-byte boundary', () => {
  const { fields } = blockLayout(['float lead', 'mat4 viewProj']);
  assert.equal(fields['viewProj'].offset, 16);
  assert.equal(fields['viewProj'].size, 64);
});

/*
 * An array's element stride is at least sixteen in the uniform address space, which is WGSL's
 * rule rather than a convention. This file asserted the packed stride for a release, after a
 * measurement of Dawn that was right about Dawn and wrong about the language, and every shader
 * that draws geometry was rejected by WebKit for it. Getting it wrong the other way reads every
 * element but the first from the wrong place.
 */
test('an array of floats strides by sixteen, which the uniform address space requires', () => {
  const { fields } = blockLayout(['float radius[8]']);
  assert.equal(fields['radius'].stride, 16);
  assert.equal(fields['radius'].size, 128);
});

/* A `vec3` array was already conformant, because a `vec3` aligns to sixteen on its own. */
test('a vec3 array is unchanged by the rule, having always satisfied it', () => {
  const { fields } = blockLayout(['vec3 lightPos[4]']);
  assert.equal(fields['lightPos'].stride, 16);
  assert.equal(fields['lightPos'].size, 64);
});

test('an array length comes from a define', () => {
  const defines = numericDefines('#define MAX_LIGHTS 8\n#define UNUSED 3\n');
  const { fields } = blockLayout(['vec3 lightPos[MAX_LIGHTS]'], defines);
  assert.equal(fields['lightPos'].length, 8);
  assert.equal(fields['lightPos'].size, 128);
});

test('an unresolvable array length is an error rather than a guess', () => {
  assert.throws(() => blockLayout(['vec3 lightPos[MAX_LIGHTS]'], {}), /resolvable define/);
});

test('an unknown type is an error rather than a guess', () => {
  assert.throws(() => blockLayout(['mat2x3 odd']), /unknown type/);
});

test('the flat vertex block matches what the shader declares', () => {
  const { fields, size } = blockLayout([
    'mat4 uViewProj',
    'mat4 uModel',
    'vec3 uTint',
    'mat4 uLightViewProj',
    'vec2 uUvScale',
  ]);
  assert.equal(fields['uViewProj'].offset, 0);
  assert.equal(fields['uModel'].offset, 64);
  assert.equal(fields['uTint'].offset, 128);
  /* 128 + 12 rounds to 144 for the matrix, not 140. */
  assert.equal(fields['uLightViewProj'].offset, 144);
  assert.equal(fields['uUvScale'].offset, 208);
  assert.equal(size, 224);
});
