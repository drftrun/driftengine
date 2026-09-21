import { expect, test } from 'vitest';
import { uniformLocations } from './shader.ts';

/**
 * Uniform arrays resolve under both spellings, whichever one the driver reports.
 *
 * **The bug.** `getActiveUniform` may return an active array's name as `uThing[0]` *or*
 * as bare `uThing` — GLES 3.0 §2.12.6 permits both, and the two families of
 * implementation this engine actually runs on disagree. ANGLE returns the subscript, so
 * every desktop browser and Chrome on Android; WebKit's Metal backend returns the bare
 * name, so every browser on iOS.
 *
 * The map was built from the reported name and aliased in one direction only, so on iOS
 * every `uniforms['uLightPos[0]']` came back `undefined`. Passing that to `uniform3fv`
 * is a silent no-op — no GL error, nothing thrown — so the entire point-light system
 * uploaded to nothing. Positions, colours, radii and weights stayed at zero and point
 * lights contributed exactly nothing to the shading.
 *
 * What it looked like: a scene with a sun was perfect, and a scene lit only by lamps
 * rendered its geometry to ambient alone. A dark courtyard with its fire still burning,
 * because emissive surfaces need no light to arrive. Four wrong diagnoses went past it —
 * sampler binding, shadow map sizes, a reflection target, texture-unit exhaustion — none
 * of which could have been right, because from the API's point of view nothing failed.
 *
 * No real GL: what is under test is a naming convention, not a rendering. The fake
 * reports whichever spelling it is constructed with, which is the only variable that
 * mattered and the one no available device could vary.
 */
/** Element count, which is how a bare-reported array is told from a scalar. */
const ARRAY_SIZE = 10;

function fakeGl(reportedNames: readonly string[]): WebGL2RenderingContext {
  return {
    ACTIVE_UNIFORMS: 0x8b86,
    getProgramParameter: () => reportedNames.length,
    getActiveUniform: (_program: WebGLProgram, index: number) => {
      const name = reportedNames[index];
      return name === undefined ? null : { name, size: ARRAY_SIZE, type: 0x8b50 };
    },
    // A distinct object per name, so a mixed-up alias is visible rather than plausible.
    getUniformLocation: (_program: WebGLProgram, name: string) =>
      ({ name }) as unknown as WebGLUniformLocation,
  } as unknown as WebGL2RenderingContext;
}

const program = {} as WebGLProgram;

test('an array reported with a subscript is reachable by its bare name', () => {
  const locations = uniformLocations(fakeGl(['uLightPos[0]']), program);
  expect(locations['uLightPos[0]']).toBeDefined();
  expect(locations['uLightPos'], 'the ANGLE spelling, aliased for a bare-name caller').toBe(
    locations['uLightPos[0]'],
  );
});

test('an array reported bare is reachable by its subscripted name', () => {
  /*
   * This is the direction that was missing, and the one every point-light upload site
   * depends on. Every call in lightBudget.ts, pointShadowSystem.ts and
   * livePointShadowSet.ts asks for `uThing[0]`.
   */
  const locations = uniformLocations(fakeGl(['uLightPos']), program);
  expect(locations['uLightPos']).toBeDefined();
  expect(
    locations['uLightPos[0]'],
    'the WebKit spelling — without this alias, every point light on iOS uploads to null',
  ).toBe(locations['uLightPos']);
});

test('a driver reporting both spellings does not have one clobber the other', () => {
  // Nothing observed does this, but the aliases are only safe if they never overwrite a
  // location the driver itself reported.
  const locations = uniformLocations(fakeGl(['uLightPos[0]', 'uLightPos']), program);
  expect((locations['uLightPos[0]'] as unknown as { name: string }).name).toBe('uLightPos[0]');
  expect((locations['uLightPos'] as unknown as { name: string }).name).toBe('uLightPos');
});

test('every point-light upload site can resolve under either convention', () => {
  /*
   * The upload sites named as data, because the failure was not one lookup being wrong:
   * it was a whole subsystem addressing uniforms in a spelling one browser family never
   * produces. Listing them means adding a light uniform that only works on desktop fails
   * here rather than on somebody's phone.
   */
  const arrays = [
    'uLightPos',
    'uLightColor',
    'uLightRadius',
    'uLightWeight',
    'uPointShadowIndex',
    'uPointShadowProjection',
    'uPointShadowNear',
    'uPointShadowSize',
    'uPointShadowWeight',
    'uLivePointShadowIndex',
    'uLivePointShadowProjection',
    'uLivePointShadowNear',
    'uLivePointShadowSize',
    'uLivePointShadowWeight',
  ];

  for (const convention of ['angle', 'webkit'] as const) {
    const reported = arrays.map((name) => (convention === 'angle' ? `${name}[0]` : name));
    const locations = uniformLocations(fakeGl(reported), program);
    for (const name of arrays) {
      expect(locations[`${name}[0]`], `${name} under the ${convention} convention`).toBeDefined();
    }
  }
});
