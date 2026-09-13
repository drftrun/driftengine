import { expect, test } from 'vitest';

import { EnvProbeArray } from './envProbeArray.ts';
import type { ProbeLevelKind } from './envProbeArray.ts';
import { ggxMaxLevelFor, irradianceLevelFor, roughnessForLevel } from './prefilterEnvMap.ts';
import { recordingGl } from './rendererHarness.ts';

/*
 * **The chain stops at the irradiance level and nothing above it is allocated.** `texStorage3D` is
 * immutable and may take fewer levels than a full chain, so a 256 edge is six levels rather than
 * nine — the levels that would hold sixteen, four and one texel are never created. Asserted on the
 * call, because "fewer levels" is invisible from anywhere else and a full chain would look right.
 */
test('the array allocates one level per roughness stop plus the irradiance level', () => {
  const { gl, calls } = recordingGl();
  const array = new EnvProbeArray(gl, 256, 8, true);
  const storage = calls.find((c) => c.name === 'texStorage3D');
  /* texStorage3D(target, levels, internalformat, width, height, depth) */
  expect(storage?.args[1], 'levels 0 through the irradiance level').toBe(6);
  expect(storage?.args[3], 'the octahedral edge').toBe(256);
  expect(storage?.args[5], 'one layer a probe').toBe(8);
  expect(array.irradianceLevel).toBe(5);
  expect(array.ggxMaxLevel).toBe(4);
  array.dispose(gl);
});

/*
 * A metal has no diffuse term, so an eight-bit environment caps the whole surface at its own
 * albedo — the measurement `reflectionProbe.ts` records at length, where driving a studio's gain
 * moved a byte cube by half a level and a half-float one by four times. The array inherits that
 * decision rather than making a new one.
 */
test('the format follows whether the scene keeps its range', () => {
  const { gl, calls } = recordingGl();
  const float = new EnvProbeArray(gl, 128, 2, true);
  expect(calls.find((c) => c.name === 'texStorage3D')?.args[2]).toBe(gl.RGBA16F);
  float.dispose(gl);

  const { gl: gl2, calls: calls2 } = recordingGl();
  const bytes = new EnvProbeArray(gl2, 128, 2, false);
  expect(calls2.find((c) => c.name === 'texStorage3D')?.args[2]).toBe(gl2.RGBA8);
  bytes.dispose(gl2);
});

/*
 * **A level is one draw rather than six.** A cube's convolution runs its triangle once per face per
 * level; an octahedral map has no faces. The viewport has to halve with the level or the triangle
 * covers a quarter of the target, which reads as a probe going dark at high roughness.
 */
test('convolving a layer attaches every level of it, halving the viewport', () => {
  const { gl, calls } = recordingGl();
  const array = new EnvProbeArray(gl, 256, 4, true);
  calls.length = 0;

  const drawn: { level: number; roughness: number; kind: ProbeLevelKind }[] = [];
  array.convolve(gl, 2, (level, roughness, kind) => drawn.push({ level, roughness, kind }));

  expect(drawn.map((d) => d.level)).toEqual([0, 1, 2, 3, 4, 5]);
  const attaches = calls.filter((c) => c.name === 'framebufferTextureLayer');
  expect(attaches).toHaveLength(6);
  /* framebufferTextureLayer(target, attachment, texture, level, layer) */
  expect(
    attaches.map((c) => c.args[3]),
    'every level',
  ).toEqual([0, 1, 2, 3, 4, 5]);
  for (const attach of attaches) expect(attach.args[4], "the probe's own layer").toBe(2);
  expect(calls.filter((c) => c.name === 'viewport').map((c) => c.args[2])).toEqual([
    256, 128, 64, 32, 16, 8,
  ]);
  array.dispose(gl);
});

/*
 * The division that lets one binding carry both integrals. A level read as the wrong kind is a
 * cosine convolution sampled as though it were a reflection, on every rough metal in the world.
 */
test('the top level is the cosine convolution and the rest are the GGX chain', () => {
  const { gl } = recordingGl();
  const array = new EnvProbeArray(gl, 256, 1, true);
  const drawn: { level: number; roughness: number; kind: ProbeLevelKind }[] = [];
  array.convolve(gl, 0, (level, roughness, kind) => drawn.push({ level, roughness, kind }));

  const irradiance = drawn.filter((d) => d.kind === 'irradiance');
  expect(irradiance).toHaveLength(1);
  expect(irradiance[0]?.level).toBe(irradianceLevelFor(256));

  for (const step of drawn.filter((d) => d.kind === 'radiance')) {
    expect(step.roughness, `level ${step.level}`).toBe(
      roughnessForLevel(step.level, ggxMaxLevelFor(256)),
    );
  }
  /* Roughness 0 is a mirror at level 0, and 1 at the coarsest reflection level. */
  expect(drawn[0]?.roughness).toBe(0);
  expect(drawn[ggxMaxLevelFor(256)]?.roughness).toBe(1);
  array.dispose(gl);
});

/*
 * **The gate is the whole grid rather than any part of it.** A grid baked a probe a frame passes
 * through a state where some layers hold whatever the driver left, and a fragment blending eight
 * corners reads four of those. One probe already had this rule — `uEnvironmentEnabled` stayed at
 * zero until a bake finished — and the reason has not changed: a car mirroring uninitialised
 * memory is worse than a car mirroring a gradient.
 */
test('the array is not ready until every layer has been convolved', () => {
  const { gl } = recordingGl();
  const array = new EnvProbeArray(gl, 128, 3, false);
  expect(array.ready).toBe(false);
  for (let layer = 0; layer < 3; layer++) {
    expect(array.ready, `after ${layer} layers`).toBe(false);
    array.convolve(gl, layer, () => {});
    expect(array.filled).toBe(layer + 1);
  }
  expect(array.ready).toBe(true);
  array.dispose(gl);
});

/* Convolving the same layer twice is a rebake, not a second probe. */
test('rebaking a layer does not count it twice', () => {
  const { gl } = recordingGl();
  const array = new EnvProbeArray(gl, 128, 2, false);
  array.convolve(gl, 0, () => {});
  array.convolve(gl, 0, () => {});
  expect(array.filled).toBe(1);
  expect(array.ready).toBe(false);
  array.dispose(gl);
});

/*
 * A grid is an improvement to an appearance rather than a requirement, exactly as one probe was.
 * A device that will not give us the layers keeps the gradient and loses nothing else, and it must
 * not then be sampled.
 */
test('an allocation the driver refuses leaves the grid unusable rather than sampled', () => {
  const { gl } = recordingGl();
  /*
   * A Proxy rather than a spread: `recordingGl` is itself a Proxy with only a `get` trap, so
   * `{ ...gl }` copies no methods at all and the constructor fails on `createTexture` instead of
   * on the allocation this is about.
   */
  const refusing = new Proxy({} as WebGL2RenderingContext, {
    get(_target, prop: string) {
      /* GL_OUT_OF_MEMORY, which is what a grid too large for a part actually answers. */
      if (prop === 'getError') return () => 0x0505;
      return (gl as unknown as Record<string, unknown>)[prop];
    },
  });
  const array = new EnvProbeArray(refusing, 256, 64, true);
  expect(array.usable).toBe(false);
  array.convolve(refusing, 0, () => {
    throw new Error('an unusable array must not draw');
  });
  expect(array.ready).toBe(false);
  array.dispose(refusing);
});
