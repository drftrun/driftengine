/**
 * The generated WGSL stores each distinct top-level item once, and a permutation is its items
 * joined back. What must hold is that nothing but naga's expression temporaries is renamed — a
 * function cut in two, or a name renumbered across two functions, would be a shader that means
 * something else — and that items the permutations share are stored once.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renumber, shareItems, splitItems } from './wgsl/share.mjs';

/* Two permutations of one module: the same helper at different places in the module, so naga
   numbered its temporaries differently, and a different main. The helper's body has a blank line
   inside it, which must not cut it. */
const A = [
  'struct Uniforms {\n    u: vec4<f32>,\n}',
  'fn helper(x: f32) -> f32 {\n    let _e12 = (x * 2f);\n\n    let _e14 = (_e12 + 1f);\n    return _e14;\n}',
  'fn main_1() {\n    let _e30 = helper(1f);\n    return;\n}',
].join('\n\n');
const B = [
  'struct Uniforms {\n    u: vec4<f32>,\n}',
  'var<private> extra: f32;',
  'fn helper(x: f32) -> f32 {\n    let _e40 = (x * 2f);\n\n    let _e42 = (_e40 + 1f);\n    return _e42;\n}',
  'fn main_1() {\n    let _e77 = helper(2f);\n    return;\n}',
].join('\n\n');

test('A SHARED ITEM IS STORED ONCE, and each permutation comes back with only its local names renumbered', () => {
  const { parts, index, rebuilt } = shareItems({ a: A, b: B });
  /* The struct and the helper once each, two mains, the private: five parts for seven uses. */
  assert.equal(parts.length, 5);
  assert.deepEqual(index.a, [0, 1, 2]);
  assert.deepEqual(index.b, [0, 3, 1, 4]);
  const helper =
    'fn helper(_l0: f32) -> f32 {\n    let _e0 = (_l0 * 2f);\n\n    let _e1 = (_e0 + 1f);\n    return _e1;\n}';
  assert.equal(
    rebuilt.a,
    [
      'struct Uniforms {\n    u: vec4<f32>,\n}',
      helper,
      'fn main_1() {\n    let _e0 = helper(1f);\n    return;\n}',
    ].join('\n\n'),
  );
  assert.equal(
    rebuilt.b,
    [
      'struct Uniforms {\n    u: vec4<f32>,\n}',
      'var<private> extra: f32;',
      helper,
      'fn main_1() {\n    let _e0 = helper(2f);\n    return;\n}',
    ].join('\n\n'),
  );
});

test('a function with a blank line inside it is one item, and its local names renumber from zero', () => {
  const items = splitItems(A);
  assert.equal(items.length, 3);
  assert.ok(items[1].includes('return _e14;'));
  /* A parameter named like a member, and a member access, are told apart: only the declared name
     moves. A global the function reads is not its to rename. */
  assert.equal(
    renumber(
      'fn f(p_4: vec2<f32>) -> f32 {\n    var i_1: f32;\n    i_1 = p_4.x + glob_3.p_4;\n    return i_1;\n}',
    ),
    'fn f(_l0: vec2<f32>) -> f32 {\n    var _l1: f32;\n    _l1 = _l0.x + glob_3.p_4;\n    return _l1;\n}',
  );
  /* A name that merely contains `_e` followed by digits is someone else's and stays. */
  assert.equal(
    renumber('let x_e12 = _e5; let y = x_e12 + _e5;'),
    'let x_e12 = _e0; let y = x_e12 + _e0;',
  );
});
