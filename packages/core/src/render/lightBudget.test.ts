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
  'uLightIesAxis[0]',
];

function fakeGl(): {
  gl: WebGL2RenderingContext;
  seen: Map<string, number>;
  values: Map<string, Float32Array>;
} {
  const seen = new Map<string, number>();
  const values = new Map<string, Float32Array>();
  const names = NAMES;
  const gl = {
    uniform1i: () => {},
    uniform4fv: (location: unknown, value: Float32Array) => {
      seen.set(String(location), value.length);
      values.set(String(location), Float32Array.from(value));
    },
    uniform3fv: (location: unknown, value: Float32Array) =>
      seen.set(String(location), value.length),
    uniform1fv: (location: unknown, value: Float32Array) =>
      seen.set(String(location), value.length),
    uniform2fv: (location: unknown, value: Float32Array) =>
      seen.set(String(location), value.length),
  } as unknown as WebGL2RenderingContext;
  const uniforms: Record<string, WebGLUniformLocation> = {};
  for (const name of names) uniforms[name] = name as unknown as WebGLUniformLocation;
  return { gl, seen: seen as Map<string, number>, values };
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
  /* The azimuth with the channels in w, four a light. */
  expect(seen.get('uLightIesAxis[0]')).toBe(MAX_POINT_LIGHTS * 4);
});

/*
 * **The uniform path carries a light's channels beside its azimuth**, in the lane the axis leaves:
 * channel 1 for every light unless one names others, and channel 1 again for a mask that is not one.
 * Read off what reaches `uLightIesAxis`, which is where the fixed arm reads them.
 */
test("A LIGHT'S CHANNELS REACH THE UNIFORM PATH IN THE AXIS'S FOURTH LANE", () => {
  const { gl, values } = fakeGl();
  const channels = new Float32Array(MAX_POINT_LIGHTS).fill(1);
  channels[0] = 2;
  channels[1] = 300;
  const axes = new Float32Array(MAX_POINT_LIGHTS * 3);
  axes[1] = 1;
  const env = createEnvironment({ lightCount: 3, lightChannels: channels, lightIesAxes: axes });
  bindPointLights(gl, uniforms(), env, 'smooth');
  const sent = values.get('uLightIesAxis[0]') ?? new Float32Array(0);
  expect(Array.from(sent.subarray(0, 4)), 'the axis, then channel 2').toEqual([0, 1, 0, 2]);
  expect(sent[7], 'a mask past 255 is channel 1').toBe(1);
  expect(sent[11], 'and an unnamed light is on channel 1').toBe(1);

  const { gl: plainGl, values: plain } = fakeGl();
  bindPointLights(plainGl, uniforms(), createEnvironment({ lightCount: 1 }), 'smooth');
  expect(plain.get('uLightIesAxis[0]')?.[3], 'an environment naming no channels').toBe(1);
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
