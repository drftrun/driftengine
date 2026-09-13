import { mat4 } from 'gl-matrix';
import { expect, test, vi } from 'vitest';

import {
  EMISSIVE_TEXTURE_UNIT,
  NORMAL_TEXTURE_UNIT,
  ORM_TEXTURE_UNIT,
  SURFACE_TEXTURE_UNIT,
} from './lightBudget.ts';

/** `recordingGl`'s own value, so the two cannot drift. */
const TEXTURE0 = 0x84c0;
import { Renderer } from './backend/webgl2/renderer.ts';
import { recordingGl } from './rendererHarness.ts';
import { resolveRenderQuality } from './renderQuality.ts';
import type { SurfaceMaterial, SurfaceTexture } from './surfaceTexture.ts';

/**
 * The material setter, checked without a GPU.
 *
 * `setSurfaceTexture` took four positional arguments and bound one image. ORM is the next map and
 * emissive the one after, so the choice was a fourth and fifth setter or one object — and a
 * consumer setting four maps in four calls is four chances to forget one, and four resets
 * `bindMeshPass` has to reason about.
 */

/** A `SurfaceTexture` far enough to be bound, with no device behind it. */
function fakeTexture(): SurfaceTexture {
  return { bind: vi.fn() } as unknown as SurfaceTexture;
}

function bindMock(texture: SurfaceTexture): ReturnType<typeof vi.fn> {
  return (texture as unknown as { bind: ReturnType<typeof vi.fn> }).bind;
}

test('setMaterial binds albedo to the surface unit and uploads its scale', () => {
  const { canvas, calls } = recordingGl();
  const renderer = new Renderer(canvas, resolveRenderQuality({}));
  const albedo = fakeTexture();

  calls.length = 0;
  renderer.setMaterial({ albedo, uScale: 3, vScale: 4, cutout: 0.25 });

  expect(bindMock(albedo)).toHaveBeenCalledWith(expect.anything(), SURFACE_TEXTURE_UNIT);
  expect(
    calls.some((c) => c.name === 'uniform2f'),
    'uUvScale is uploaded',
  ).toBe(true);
});

/*
 * **The only thing that makes a deprecated wrapper safe to leave in.**
 *
 * `setSurfaceTexture` has 56 call sites across four repositories, three of which deploy on push,
 * so removing it is a major version taken deliberately rather than a side effect of adding a map.
 * It stays — and it stays *correct* only if it does what it did. Asserted as "the two produce the
 * same calls" rather than by reading the wrapper, because a wrapper that drifts from the thing it
 * wraps is exactly the failure a wrapper invites.
 */
test('setSurfaceTexture and setMaterial make the same calls', () => {
  const viaWrapper = recordingGl();
  const a = new Renderer(viaWrapper.canvas, resolveRenderQuality({}));
  viaWrapper.calls.length = 0;
  a.setSurfaceTexture(fakeTexture(), 3, 4, 0.25);

  const viaMaterial = recordingGl();
  const b = new Renderer(viaMaterial.canvas, resolveRenderQuality({}));
  viaMaterial.calls.length = 0;
  b.setMaterial({ albedo: fakeTexture(), uScale: 3, vScale: 4, cutout: 0.25 });

  expect(viaMaterial.calls.map((c) => c.name)).toEqual(viaWrapper.calls.map((c) => c.name));
});

test('a null material turns albedo off', () => {
  const { canvas, calls } = recordingGl();
  const renderer = new Renderer(canvas, resolveRenderQuality({}));
  renderer.setMaterial({ albedo: fakeTexture() });

  calls.length = 0;
  renderer.setMaterial(null);

  expect(
    calls.filter((c) => c.name === 'uniform1i').length,
    'uAlbedoEnabled goes back to zero',
  ).toBeGreaterThan(0);
});

/*
 * The fields are independent, and this is the one that is easy to get wrong: a material carrying a
 * normal and no albedo is legitimate — vertex colour with authored normals — and must not fall out
 * of the setter through the "no texture" path as though it were no material at all. Nothing
 * samples a normal map yet; what this pins is that the shape survives to the task that adds one.
 */
test('a material with no albedo is still a material', () => {
  const { canvas } = recordingGl();
  const renderer = new Renderer(canvas, resolveRenderQuality({}));
  expect(() => renderer.setMaterial({ normalStrength: 1 })).not.toThrow();
});

/*
 * **The scale belongs to the material, not to the albedo**, and it shipped for one commit not
 * doing so: `uUvScale` was uploaded on the albedo path alone, which was right while albedo was the
 * only map. A material with a normal and no colour then kept whatever `bindMeshPass` last left.
 *
 * Caught by `demo/dev/normal.html`, where the two backends disagreed about how big a dome was —
 * WebGPU writes the scale before its own early return and WebGL2 did not. Asserted here so the
 * next map added does not have to rediscover it from a picture.
 */
test('the uv scale is uploaded for a material with no albedo', () => {
  const { canvas, calls } = recordingGl();
  const renderer = new Renderer(canvas, resolveRenderQuality({}));

  calls.length = 0;
  renderer.setMaterial({ normal: fakeTexture(), uScale: 3, vScale: 4 });

  const scale = calls.find((c) => c.name === 'uniform2f');
  expect(scale, 'uUvScale is uploaded whatever maps the material carries').toBeDefined();
  expect([scale?.args[1], scale?.args[2]]).toEqual([3, 4]);
});

/*
 * A type-level test, which is the only kind available before a renderer reads these. It fails to
 * compile rather than to assert, which is why the gate for it is `typecheck` and not vitest.
 */
test('a material can carry an ORM map and its three scales', () => {
  const orm = fakeTexture();
  const material: SurfaceMaterial = {
    orm,
    roughnessScale: 0.8,
    metallicScale: 0.5,
    occlusionStrength: 0.25,
  };
  expect(material.orm).toBe(orm);
  expect(material.roughnessScale).toBe(0.8);
  expect(material.metallicScale).toBe(0.5);
  expect(material.occlusionStrength).toBe(0.25);
});

test('setMaterial binds the ORM map to its own unit and writes the three scales', () => {
  const { canvas, calls } = recordingGl();
  const renderer = new Renderer(canvas, resolveRenderQuality({}));
  const orm = fakeTexture();

  calls.length = 0;
  renderer.setMaterial({ orm, roughnessScale: 0.8, metallicScale: 0.5, occlusionStrength: 0.25 });

  expect((orm as unknown as { bind: ReturnType<typeof vi.fn> }).bind).toHaveBeenCalledWith(
    expect.anything(),
    ORM_TEXTURE_UNIT,
  );
  /*
   * Component-aligned with the map — r occlusion, g roughness, b metallic — so the order is the
   * channel order and not the field order of `SurfaceMaterial`, and getting it wrong would swap
   * two scales silently.
   *
   * Found by call name rather than by uniform, because `recordingGl` answers `ACTIVE_UNIFORMS`
   * with zero and every location is therefore null. **So the discriminator is order**, which was
   * not needed while `uOrmScale` was the only `vec3` this method wrote and is needed now that the
   * emissive scale is a second one: ORM is bound before emissive in `setMaterial`, so the first
   * `uniform3f` is the ORM scale and the second is the emissive one. If a third arrives, this is
   * the assertion that will say so rather than silently reading the wrong call.
   */
  const scale = calls.filter((c) => c.name === 'uniform3f');
  expect(scale.length, 'the ORM scale and the emissive scale, in that order').toBe(2);
  expect(
    scale[0]?.args.slice(1),
    "occlusion, roughness, metallic, in the map's channel order",
  ).toEqual([0.25, 0.8, 0.5]);
  /* Unasked for, so the identity: this one multiplies a glow and zero would switch it off. */
  expect(scale[1]?.args.slice(1), 'the emissive scale defaults to one per channel').toEqual([
    1, 1, 1,
  ]);
});

/*
 * The gate, and the reason every published scene is bit-identical. A material with no `orm` must
 * write 0 rather than leaving whatever the last material left, or a mesh drawn after a mapped one
 * samples a map it never asked for.
 */
test('a material with no ORM map disables it rather than inheriting one', () => {
  const { canvas, calls } = recordingGl();
  const renderer = new Renderer(canvas, resolveRenderQuality({}));

  renderer.setMaterial({ orm: fakeTexture() });
  calls.length = 0;
  renderer.setMaterial({ albedo: fakeTexture() });

  /*
   * On the value, because every location is null here. Nothing else in this sequence writes an int
   * zero — the albedo is being *enabled*, and the two map samplers are written their unit numbers —
   * so a `uniform1i(_, 0)` is `uOrmEnabled` being cleared and can be nothing else.
   */
  expect(
    calls.some((c) => c.name === 'uniform1i' && c.args[1] === 0),
    'uOrmEnabled is written back to 0 rather than left where the last material put it',
  ).toBe(true);
});

/**
 * The least camera and environment `bindMeshPass` reads with no uniform table under it.
 *
 * Copied from `rendererHarness.test.ts` rather than shared, because that file owns visibility and
 * this one owns materials; a helper spanning both would make either free to break the other.
 */
function passInputs() {
  const projection = mat4.perspective(mat4.create(), Math.PI / 2, 1, 1, 500);
  const view = mat4.lookAt(mat4.create(), [0, 0, 0], [0, 0, -1], [0, 1, 0]);
  const camera = {
    viewProjection: mat4.multiply(mat4.create(), projection, view),
    projection,
    position: new Float32Array([0, 0, 0]),
  } as never;
  const env = {
    directionalDir: new Float32Array([0, 1, 0]),
    directionalColor: new Float32Array([1, 1, 1]),
    ambient: new Float32Array([0.1, 0.1, 0.1]),
    ambientGround: new Float32Array([0.1, 0.1, 0.1]),
    shadowDepthSpan: 100,
    shadowStrength: 0.5,
    fogColor: new Float32Array([0.5, 0.5, 0.5]),
    fogDensity: 0.01,
    fogHeightFalloff: 0.1,
    fogBaseY: 0,
    underwater: null,
    emissiveGain: 1,
    nightFactor: 0,
    lightViewProj: new Float32Array(16),
  } as never;
  return { camera, env };
}

/*
 * **A pass must not inherit a map from the pass before it**, which is what `setMaterial`'s own
 * comment and `ARCHITECTURE`'s account of `bindMeshPass` both claim, and what was true of the
 * albedo alone. `uNormalStrength` is an ordinary GL uniform and survives a pass boundary, so a
 * pass that ended normal-mapped handed its map to the next one until something called
 * `setMaterial` — every mesh in it lit through an image it never asked for.
 *
 * Invisible in every capture, because no published scene binds a normal map. WebGPU never had it:
 * a new pass sets `materialSlot` to -1 and the next draw copies the pass's base block, in which
 * `uNormalStrength` is zero. So this is also the two backends disagreeing.
 */
test('a pass does not inherit the previous pass its normal map', () => {
  const { canvas, calls } = recordingGl();
  const renderer = new Renderer(canvas, resolveRenderQuality({}));
  const { camera, env } = passInputs();

  renderer.beginFrame([0, 0, 0]);
  renderer.bindMeshPass(camera, env);
  renderer.setMaterial({ normal: fakeTexture(), normalStrength: 1 });

  calls.length = 0;
  renderer.bindMeshPass(camera, env);

  /*
   * On the texture unit rather than on the uniform, because `recordingGl` answers `ACTIVE_UNIFORMS`
   * with zero — which is what lets it stand in for a driver without knowing a single uniform name —
   * so every location is null and one `uniform1f` is indistinguishable from another.
   *
   * The unit is unambiguous. `bindMeshPass` touches the three cascades, the point-shadow array, the
   * surface unit and the probe; the normal map's is the one unit in that range it had no reason to
   * activate, so an `activeTexture` on it is this reset and can be nothing else.
   */
  expect(
    calls.some((c) => c.name === 'activeTexture' && c.args[0] === TEXTURE0 + NORMAL_TEXTURE_UNIT),
    'the normal map unit is reset when a pass opens',
  ).toBe(true);
});

/* The same property, for the map this plan adds. See the normal-map case above for the mechanism. */
test('a pass does not inherit the previous pass its ORM map', () => {
  const { canvas, calls } = recordingGl();
  const renderer = new Renderer(canvas, resolveRenderQuality({}));
  const { camera, env } = passInputs();

  renderer.beginFrame([0, 0, 0]);
  renderer.bindMeshPass(camera, env);
  renderer.setMaterial({ orm: fakeTexture() });

  calls.length = 0;
  renderer.bindMeshPass(camera, env);

  expect(
    calls.some((c) => c.name === 'activeTexture' && c.args[0] === TEXTURE0 + ORM_TEXTURE_UNIT),
    'the ORM unit is reset when a pass opens',
  ).toBe(true);
});

/*
 * The fourth and last map `MATL` carries, and the first thing in the engine to read it.
 *
 * The gate is what every published scene depends on: a material with no emissive map must write 0
 * and a scale of one, or a mesh drawn after a mapped one glows through an image it never asked for
 * — or, worse, is switched off by a scale nobody set.
 */
test('setMaterial binds the emissive map to its own unit and defaults its scale to one', () => {
  const { canvas, calls } = recordingGl();
  const renderer = new Renderer(canvas, resolveRenderQuality({}));
  const emissive = fakeTexture();

  calls.length = 0;
  renderer.setMaterial({ emissive, emissiveScale: [2, 1.5, 1] });

  expect((emissive as unknown as { bind: ReturnType<typeof vi.fn> }).bind).toHaveBeenCalledWith(
    expect.anything(),
    EMISSIVE_TEXTURE_UNIT,
  );
  /* Second of the two vec3s, ORM being first. See the ORM test above for why order is the key. */
  const scales = calls.filter((c) => c.name === 'uniform3f');
  expect(scales.length).toBe(2);
  expect(scales[1]?.args.slice(1), 'the scale a caller asked for, per channel').toEqual([
    2, 1.5, 1,
  ]);
});

test('a material with no emissive map disables it rather than inheriting one', () => {
  const { canvas, calls } = recordingGl();
  const renderer = new Renderer(canvas, resolveRenderQuality({}));
  const emissive = fakeTexture();

  renderer.setMaterial({ emissive });
  calls.length = 0;
  renderer.setMaterial({ albedo: null });

  const scales = calls.filter((c) => c.name === 'uniform3f');
  expect(
    scales[1]?.args.slice(1),
    'one and not zero, because this multiplies a glow rather than adding one',
  ).toEqual([1, 1, 1]);
});
