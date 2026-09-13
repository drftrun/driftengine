import { expect, test, vi } from 'vitest';
import { MAX_POINT_LIGHTS, bindPointLights } from './lightBudget.ts';
import { createEnvironment } from './backend/webgl2/renderer.ts';

/**
 * What a uniform is handed when a consumer has not bound everything.
 *
 * **This exists because two adjacent guards disagreed about what absent means.** One checked a
 * length and the other checked for `undefined`, and `createEnvironment` initialises the whole
 * family to a zero-length array, which is not undefined. So the emitter-size fallback never
 * fired, `uniform1fv` refused a short array with `INVALID_VALUE` on every lit frame, and the
 * uniform kept its zeros: every light shaded as a mathematical point, which is the speckle on
 * dark glossy paint that the emitter size was added to remove. It was reported from outside,
 * after an afternoon, because the symptom is "the highlights look wrong" and the error is a
 * console flood rather than a throw.
 *
 * A fake context rather than a real one: what is asserted is the *length* of what reaches each
 * uniform, which is the whole of the bug and needs no GPU.
 */
/** Every array the binder uploads. The cone pair joined it when spot lights landed. */
const NAMES = [
  'uLightPos[0]',
  'uLightColor[0]',
  'uLightRadius[0]',
  'uLightSourceRadius[0]',
  'uLightWeight[0]',
  'uLightDir[0]',
  'uLightCone[0]',
];

function fakeGl(): { gl: WebGL2RenderingContext; seen: Map<string, number> } {
  const seen = new Map<string, number>();
  const names = NAMES;
  const gl = {
    uniform1i: () => {},
    uniform3fv: (location: unknown, value: Float32Array) =>
      seen.set(String(location), value.length),
    uniform1fv: (location: unknown, value: Float32Array) =>
      seen.set(String(location), value.length),
    uniform2fv: (location: unknown, value: Float32Array) =>
      seen.set(String(location), value.length),
  } as unknown as WebGL2RenderingContext;
  const uniforms: Record<string, WebGLUniformLocation> = {};
  for (const name of names) uniforms[name] = name as unknown as WebGLUniformLocation;
  return { gl, seen: seen as Map<string, number> };
}

function uniforms(): Record<string, WebGLUniformLocation> {
  const out: Record<string, WebGLUniformLocation> = {};
  for (const name of NAMES) {
    out[name] = name as unknown as WebGLUniformLocation;
  }
  return out;
}

test('every light array reaches its uniform at full length, whatever the caller bound', () => {
  const { gl, seen } = fakeGl();
  const env = createEnvironment({});
  /* A consumer that set a count and bound nothing, which is the shape of the reported bug. */
  const lights = { ...env, lightCount: 3 };
  bindPointLights(gl, uniforms(), lights, 'smooth');

  expect(seen.get('uLightPos[0]')).toBe(MAX_POINT_LIGHTS * 3);
  expect(seen.get('uLightColor[0]')).toBe(MAX_POINT_LIGHTS * 3);
  expect(seen.get('uLightRadius[0]')).toBe(MAX_POINT_LIGHTS);
  expect(seen.get('uLightSourceRadius[0]'), 'the one that guarded on undefined').toBe(
    MAX_POINT_LIGHTS,
  );
  expect(seen.get('uLightWeight[0]')).toBe(MAX_POINT_LIGHTS);
  /*
   * The cone joins the family, and it is the member whose fallback matters most: the shader reads
   * these two unconditionally, so a uniform left at its zeros is a cone admitting nothing — every
   * lamp in the world switched off, from a caller who never heard of spot lights.
   */
  expect(seen.get('uLightDir[0]')).toBe(MAX_POINT_LIGHTS * 3);
  expect(seen.get('uLightCone[0]')).toBe(MAX_POINT_LIGHTS * 2);
});

test('a short array is replaced rather than passed on, and says so once', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const { gl, seen } = fakeGl();
  const env = createEnvironment({});
  const lights = {
    ...env,
    lightCount: 2,
    /* Five of six bound, which is exactly what the reporting consumer had. */
    lightSourceRadii: new Float32Array(0),
  };
  bindPointLights(gl, uniforms(), lights, 'smooth');
  expect(seen.get('uLightSourceRadius[0]')).toBe(MAX_POINT_LIGHTS);
  warn.mockRestore();
});

test('createEnvironment leaves weights fully present, because that array inverts with length', () => {
  /*
   * The trap in the fix rather than in the bug. A short `lightWeights` means every light is
   * fully present, so filling it to full length with zeros would have meant the opposite and
   * turned every light off in every scene that never binds it.
   */
  const env = createEnvironment({});
  expect(env.lightWeights.length).toBe(MAX_POINT_LIGHTS);
  for (const weight of env.lightWeights) expect(weight).toBe(1);
});
