import { expect, test } from 'vitest';
import { uniformLocations } from './shader.ts';

/**
 * The uniform map, and the one thing about it that can fail in silence.
 *
 * No GL here — a fake context is enough, because what is being tested is a naming
 * decision rather than a rendering. WebGL reports an array uniform as `uThing[0]`, and a
 * caller that asks for `uThing` gets `undefined`; passing that to `uniformNfv` is a no-op
 * with no error, no warning and no console output. The uniform never receives its data and
 * the feature that depended on it simply does not happen.
 *
 * That is exactly how the foliage's trample field shipped uploading into nothing: 523
 * tests green, zero console errors, and grass that did not move. It was found by
 * playing, twice — never by the suite.
 */
function fakeGl(names: readonly string[]): WebGL2RenderingContext {
  const locations = new Map<string, WebGLUniformLocation>();
  for (const name of names) locations.set(name, { name } as unknown as WebGLUniformLocation);
  return {
    ACTIVE_UNIFORMS: 0x8b86,
    getProgramParameter: () => names.length,
    getActiveUniform: (_program: unknown, index: number) => ({ name: names[index] }),
    getUniformLocation: (_program: unknown, name: string) => locations.get(name) ?? null,
  } as unknown as WebGL2RenderingContext;
}

test('an array uniform can be reached by its bare name', () => {
  const u = uniformLocations(fakeGl(['uTrample[0]', 'uViewProj']), {} as WebGLProgram);

  // Both spellings, so neither is wrong: the caller should not have to know that WebGL
  // renames arrays.
  expect(u['uTrample[0]'], 'the reported name').toBeDefined();
  expect(u['uTrample'], 'the bare name — this is the one that was missing').toBeDefined();
  expect(u['uTrample']).toBe(u['uTrample[0]']);

  // And a plain uniform is untouched by any of it.
  expect(u['uViewProj']).toBeDefined();
  expect(u['uViewProj[0]']).toBeUndefined();
});

test('a real element never loses to an alias', () => {
  /*
   * If a shader somehow declared both `uThing` and `uThing[0]`, the exact match has to
   * win — an alias that overwrote a genuine uniform would be a worse bug than the one it
   * was added to prevent.
   */
  const u = uniformLocations(fakeGl(['uThing[0]', 'uThing']), {} as WebGLProgram);
  expect((u['uThing'] as unknown as { name: string }).name).toBe('uThing');
});

test('nothing is invented for a program with no uniforms', () => {
  expect(Object.keys(uniformLocations(fakeGl([]), {} as WebGLProgram))).toEqual([]);
});
