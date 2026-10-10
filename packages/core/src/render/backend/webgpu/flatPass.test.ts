import { expect, test, vi } from 'vitest';

import { DEPTH_OFFSET_SIGN, OVERLAY_DEPTH_UNITS } from '../../depthConvention.ts';
import { PipelineCache } from './pipelineCache.ts';
import {
  flatFragmentBindings,
  flatPipeline,
  flatVariant,
  flatVertexBindings,
  flatVertexKey,
  probeStageCeilings,
} from './flatPass.ts';
import { FLAT_BINDINGS, FLAT_FRAG_WGSL } from '../../shaders/generated/flat.wgsl.ts';

/**
 * The depth state a blended draw is built with, which on this backend is pipeline state.
 *
 * **Why this is tested where nothing else about a pipeline is.** WebGL2 toggles depth writing
 * and the polygon offset around a draw, so a wrong value there is one line and is visible in the
 * next frame. Here the same two facts are baked into an object built once and cached under a
 * string, so a draw that asked not to write depth and got a pipeline that does looks exactly
 * like a draw that asked to — no validation error, no warning, and a picture that is wrong in a
 * way only a photograph shows.
 *
 * The sign is the other half. `depthBias` pulls a surface toward the viewer under one depth
 * convention and away from it under the other, and the failure mode is documented at `drawMesh`
 * on the other backend: a marking sinks into the road it is painted on, which reads as a draw
 * call that never happened.
 */

/** Enough of a device for a descriptor to be built and captured. */
function fakeDevice(): { device: GPUDevice; descriptors: GPURenderPipelineDescriptor[] } {
  const descriptors: GPURenderPipelineDescriptor[] = [];
  const device = {
    createRenderPipeline: vi.fn((descriptor: GPURenderPipelineDescriptor) => {
      descriptors.push(descriptor);
      return { id: descriptors.length };
    }),
    createPipelineLayout: vi.fn(() => ({})),
    createShaderModule: vi.fn(() => ({})),
  } as unknown as GPUDevice;
  return { device, descriptors };
}

/** One blended pipeline, built through the cache the renderer uses. */
function blended(
  options: { depthWrite?: boolean; depthLayer?: number } = {},
): GPURenderPipelineDescriptor {
  const { device, descriptors } = fakeDevice();
  const cache = new PipelineCache(device, 'bgra8unorm');
  flatPipeline(
    cache,
    device,
    {} as unknown as GPUBindGroupLayout,
    'none',
    'flat:s0:u0|blend',
    {},
    true,
    false,
    false,
    options.depthWrite ?? true,
    options.depthLayer ?? 0,
  );
  return descriptors[0] as GPURenderPipelineDescriptor;
}

test('a blended pipeline writes depth by default, which is what it has always done', () => {
  const depth = blended().depthStencil;
  expect(depth?.depthWriteEnabled, 'a sign hung in the air has to stand against the sky').toBe(
    true,
  );
  expect(depth?.depthBias ?? 0, 'and takes no offset it did not ask for').toBe(0);
});

test('a blended draw that asked not to write depth gets a pipeline that does not', () => {
  expect(blended({ depthWrite: false }).depthStencil?.depthWriteEnabled).toBe(false);
});

test('a depth layer becomes a bias, toward the viewer, scaled by the layer', () => {
  /* Hand-derived: the units constant times the layer times the convention's sign. */
  expect(blended({ depthLayer: 1 }).depthStencil?.depthBias).toBe(
    OVERLAY_DEPTH_UNITS * DEPTH_OFFSET_SIGN,
  );
  expect(blended({ depthLayer: 3 }).depthStencil?.depthBias).toBe(
    OVERLAY_DEPTH_UNITS * 3 * DEPTH_OFFSET_SIGN,
  );
});

/**
 * The two terms push the same way, which is the one thing about them a capture had to teach.
 *
 * A polygon offset is a constant plus a slope term, and the slope's sign is not free: given the
 * opposite sign to the constant it *fights* it, and at a grazing angle it wins — the overlay is
 * pushed behind the surface it decorates and disappears. That is what a slope of `+1` did here,
 * on both backends, and the symptom is indistinguishable from a draw call that never ran.
 *
 * Asserted as a relationship instead of as two values, because the values are tuning and the
 * relationship is the contract: whatever the constants become, they may not disagree about which
 * way is forward.
 */
test('the slope term pushes the same way the constant does', () => {
  const depth = blended({ depthLayer: 2 }).depthStencil;
  const bias = depth?.depthBias ?? 0;
  const slope = depth?.depthBiasSlopeScale ?? 0;
  expect(slope, 'a slope of zero cannot clear a fight at a grazing angle').not.toBe(0);
  expect(Math.sign(slope), 'and one that fights the constant hides the overlay').toBe(
    Math.sign(bias),
  );
});

test('a layer beyond the ceiling is clamped rather than dragging a surface through the world', () => {
  expect(blended({ depthLayer: 99 }).depthStencil?.depthBias).toBe(
    blended({ depthLayer: 4 }).depthStencil?.depthBias,
  );
  expect(blended({ depthLayer: -3 }).depthStencil?.depthBias, 'and so is a negative one').toBe(0);
});

/*
 * The instanced variant's block, which is the one that could have shipped a scrambled frame.
 *
 * It declares neither `uModel` nor `uTint` — placement and tint arrive as vertex attributes — so
 * it is shorter than the plain block. What must never differ is where the fields they *do* share
 * live, because the renderer writes them by offset from the plain table.
 *
 * This is asserted rather than trusted because it was wrong once, measured: with `uModel`
 * declared second in the source, the instanced block put `uHasTangents` at 64 against the plain
 * variant's 128, and `uLightViewProj` and `uUvScale` moved with it. Declaring the two optional
 * uniforms last is what fixes it, and nothing else in the file says so.
 */
test('the instanced vertex block omits placement and tint and moves nothing else', () => {
  const plain = flatVertexBindings(false, false, false);
  const instanced = flatVertexBindings(false, false, true);

  expect(instanced.fields.uModel).toBeUndefined();
  expect(instanced.fields.uTint).toBeUndefined();

  for (const field of ['uViewProj', 'uHasTangents', 'uLightViewProj', 'uUvScale']) {
    expect(instanced.fields[field]?.offset).toBe(plain.fields[field]?.offset);
  }
  expect(instanced.uniformSize).toBeLessThan(plain.uniformSize);
});

test('the instanced variant is keyed the way the generator keys it', () => {
  expect(flatVertexKey(false, false, true)).toBe('instanced');
  expect(flatVertexKey(false, false, false)).toBe('none');
});

/*
 * **What lets `writeWind` skip the instanced path safely.**
 *
 * The renderer writes this uniform block by offset, and `flatPass.ts` records what writing a field
 * a variant does not declare costs: the block is shorter, so the write lands on whatever occupies
 * that offset instead — a scrambled frame rather than an error. The instanced variant carries no
 * per-vertex channel, so it declares no wind, and the renderer must not write any for it.
 *
 * If a later change gives the instanced variant a channel, this fails and points at the write.
 */
test('every variant that can bend declares the wind, and the instanced one declares none', () => {
  /* In the view block, which is the pass's: the frame's wind, not the draw's. */
  const wind = ['uWindDirection', 'uWindSpeed', 'uWindGust', 'uWindTime', 'uWindSpatialPhase'];
  const view = (key: string): string[] =>
    Object.keys(
      (FLAT_BINDINGS.flatVert as Record<string, { viewFields?: Record<string, unknown> }>)[key]
        ?.viewFields ?? {},
    );
  for (const key of ['none', 'skinned', 'morphed', 'morphed+skinned']) {
    for (const name of wind) expect(view(key)).toContain(name);
  }
  for (const name of wind) expect(view('instanced')).not.toContain(name);
});

/*
 * **Every switch is in every variant.** The generated WGSL is one string for both values of each:
 * the lit stage branches on five overrides — glass, then `litSwitchesGlsl`'s four — which a pipeline
 * sets from its cache, and on the four shading models', skin's three halves and the lightmap's
 * (`models.ts`), which it sets from its own key, and last on the physical highlight's, from the
 * cache again, after it on a surface overlay's, from the cache too, and on the reflection
 * pass's surface half, from the key, and whether the frame's draws write its maps, from the cache,
 * and on whether a material's maps are placed by the world, and last whether its layers are
 * blended, both from the cache. The moving sun's switch sits after the four, ahead of the shadow
 * lookup that reads it. Every variant declares all twenty, because a pipeline naming an override its
 * module lacks fails validation and drops the frame, the permutations without shadows included,
 * which read the glass switch nowhere. The models and halves are generated off, the lit features on.
 */
test('EVERY LIT VARIANT DECLARES THE TWENTY SWITCHES ITS PIPELINES SET', () => {
  const variants = Object.entries(FLAT_FRAG_WGSL);
  expect(variants.length).toBe(16);
  const switches = [
    'GLASS_SHADOWS',
    'CLUSTERED_LIGHTS',
    'LIGHT_FIXTURES',
    'SURFACE_EFFECTS',
    'DRIFT_LIGHT',
    'MOVING_SUN',
  ] as const;
  const models = [
    'MODEL_ANISOTROPIC',
    'MODEL_HAIR',
    'MODEL_SKIN',
    'MODEL_EYE',
    'SKIN_SCREEN',
    'SKIN_DIFFUSE',
    'SKIN_ALBEDO',
    'MODEL_LIGHTMAP',
  ] as const;
  for (const [variant, wgsl] of variants) {
    switches.forEach((name, id) => {
      expect(wgsl, `${variant}: ${name}`).toMatch(
        new RegExp(`@id\\(${id}\\) override ${name}: bool = true;`),
      );
    });
    models.forEach((name, k) => {
      expect(wgsl, `${variant}: ${name}`).toMatch(
        new RegExp(`@id\\(${6 + k}\\) override ${name}: bool = false;`),
      );
    });
    expect(wgsl, `${variant}: PHYSICAL_SPECULAR`).toMatch(
      /@id\(14\) override PHYSICAL_SPECULAR: bool = true;/,
    );
    expect(wgsl, `${variant}: SURFACE_OVERLAY`).toMatch(
      /@id\(15\) override SURFACE_OVERLAY: bool = true;/,
    );
    expect(wgsl, `${variant}: REFLECTION_SURFACE`).toMatch(
      /@id\(16\) override REFLECTION_SURFACE: bool = false;/,
    );
    expect(wgsl, `${variant}: REFLECTION_MAPS`).toMatch(
      /@id\(17\) override REFLECTION_MAPS: bool = true;/,
    );
    expect(wgsl, `${variant}: WORLD_UVS`).toMatch(/@id\(18\) override WORLD_UVS: bool = true;/);
    expect(wgsl, `${variant}: LAYERED`).toMatch(/@id\(19\) override LAYERED: bool = true;/);
    const bindings = (FLAT_BINDINGS.flatFrag as Record<string, { overrides?: unknown }>)[variant];
    expect(bindings?.overrides, variant).toEqual({
      GLASS_SHADOWS: 0,
      CLUSTERED_LIGHTS: 1,
      LIGHT_FIXTURES: 2,
      SURFACE_EFFECTS: 3,
      DRIFT_LIGHT: 4,
      MOVING_SUN: 5,
      MODEL_ANISOTROPIC: 6,
      MODEL_HAIR: 7,
      MODEL_SKIN: 8,
      MODEL_EYE: 9,
      SKIN_SCREEN: 10,
      SKIN_DIFFUSE: 11,
      SKIN_ALBEDO: 12,
      MODEL_LIGHTMAP: 13,
      PHYSICAL_SPECULAR: 14,
      SURFACE_OVERLAY: 15,
      REFLECTION_SURFACE: 16,
      REFLECTION_MAPS: 17,
      WORLD_UVS: 18,
      LAYERED: 19,
    });
  }
});

/*
 * **A lit pipeline reads glass once there is glass to read, and only then.** The switch was set from
 * the profile, so every scene built every lit pipeline with the glass lookups in it — three thousand
 * instructions and their registers on every surface, finding nothing in a world with no pane. On a
 * phone that was the lit pass. Now it is off until the renderer reports a glass caster, and that
 * report rebuilds every lit pipeline with it on, in one swap; a profile with glass shadows off
 * never turns it on at all.
 */
test('A LIT PIPELINE READS GLASS ONLY ONCE ITS CACHE IS TOLD THERE IS GLASS, and never where glass shadows are off', async () => {
  for (const glassShadows of [true, false]) {
    const { device, descriptors } = fakeDevice();
    const cache = new PipelineCache(device, 'bgra8unorm', 1, glassShadows);
    const before = flatPipeline(
      cache,
      device,
      {} as unknown as GPUBindGroupLayout,
      'none',
      'flat:s0:u0',
      {},
    );
    /* By its id, 0, not its name: Chrome refuses the name of an override declared with an id. */
    expect(descriptors[0]?.fragment?.constants?.['0'], `${glassShadows}, before`).toBe(0);

    await cache.enable('GLASS_SHADOWS');
    if (!glassShadows) {
      expect(descriptors, 'nothing rebuilt where glass shadows are off').toHaveLength(1);
      continue;
    }
    expect(descriptors[1]?.fragment?.constants?.['0'], 'rebuilt with the switch on').toBe(1);
    expect(cache.peek('flat:s0:u0'), 'and that is the pipeline a draw finds').not.toBe(before);
  }
});

/*
 * **Every switch the lit stage declares is set, from the cache.** Clustering is the profile's and
 * fixed when the cache is made; DriftLight, like fixtures and effects, is off until it is used and
 * then rebuilt on, beside whatever else is already on. The ids are the generator's declaration
 * order, which `litSwitchesGlsl` keeps after glass.
 */
test('A LIT PIPELINE SETS ALL ITS SWITCHES, clustering from the profile and the rest as they are used', async () => {
  const { device, descriptors } = fakeDevice();
  const cache = new PipelineCache(device, 'bgra8unorm', 1, true, true);
  flatPipeline(cache, device, {} as unknown as GPUBindGroupLayout, 'none', 'flat:s0:u0', {});
  const off = {
    '5': 0,
    '6': 0,
    '7': 0,
    '8': 0,
    '9': 0,
    '10': 0,
    '11': 0,
    '12': 0,
    '13': 0,
    '14': 0,
    '15': 0,
    '16': 0,
    '17': 0,
    '18': 0,
    '19': 0,
  };
  expect(descriptors[0]?.fragment?.constants).toEqual({
    '0': 0,
    '1': 1,
    '2': 0,
    '3': 0,
    '4': 0,
    ...off,
  });

  await cache.enable('DRIFT_LIGHT');
  expect(descriptors[1]?.fragment?.constants).toEqual({
    '0': 0,
    '1': 1,
    '2': 0,
    '3': 0,
    '4': 1,
    ...off,
  });
  /* And a material's projection, last, by its id 18; and the moving sun's matrix, by its id 5. */
  await cache.enable('WORLD_UVS');
  expect(descriptors[2]?.fragment?.constants?.['18']).toBe(1);
  await cache.enable('MOVING_SUN');
  expect(descriptors[3]?.fragment?.constants?.['5']).toBe(1);
  /* And a material's layers, by its id 19. */
  await cache.enable('LAYERED');
  expect(descriptors[4]?.fragment?.constants?.['19']).toBe(1);
});

/*
 * **A material's model is its pipeline's own switch**, set from the key it was built for and kept
 * through a lit rebuild: a hair pipeline is hair whatever the cache turns on after it, and the
 * standard pipeline beside it is none of them.
 */
test('A MODELLED PIPELINE TURNS ON ITS OWN MODEL AND NO OTHER, and keeps it through a rebuild', async () => {
  const { device, descriptors } = fakeDevice();
  const cache = new PipelineCache(device, 'bgra8unorm', 1, true, true);
  const layout = {} as unknown as GPUBindGroupLayout;
  flatPipeline(
    cache,
    device,
    layout,
    'none',
    'flat:s0:u0|m:hair',
    {},
    false,
    false,
    false,
    true,
    0,
    false,
    'none',
    false,
    false,
    false,
    false,
    'hair',
  );
  flatPipeline(cache, device, layout, 'none', 'flat:s0:u0', {});
  const models = (k: number) => {
    const c = descriptors[k]?.fragment?.constants ?? {};
    return [c['6'], c['7'], c['8'], c['9']];
  };
  expect(models(0)).toEqual([0, 1, 0, 0]);
  expect(models(1)).toEqual([0, 0, 0, 0]);
  await cache.enable('SURFACE_EFFECTS');
  expect(models(2)).toEqual([0, 1, 0, 0]);
  expect(descriptors[2]?.fragment?.constants?.['3']).toBe(1);
});

/*
 * **Skin's two halves under the screen-space blur are two pipelines of their own.** The frame's half
 * turns on `SKIN_SCREEN` and draws as any lit surface does; the diffuse half turns on `SKIN_DIFFUSE`
 * and is the same surface drawn again, so it writes no depth, finds the depth its frame half wrote by
 * equality, and never turns alpha into coverage — its alpha is the blur's profile, not a share. The
 * whole surface turns on neither.
 */
test('A SKIN DRAWS ITS TWO HALVES THROUGH PIPELINES THAT SAY WHICH, the diffuse one finding the depth its frame half wrote', () => {
  const { device, descriptors } = fakeDevice();
  const cache = new PipelineCache(device, 'rgba16float', 4, true, false);
  const layout = {} as unknown as GPUBindGroupLayout;
  for (const half of ['whole', 'scene', 'diffuse'] as const) {
    flatPipeline(
      cache,
      device,
      layout,
      'none',
      `flat:s0:u0|m:skin|${half}`,
      {},
      false,
      false,
      false,
      true,
      0,
      false,
      'none',
      false,
      true,
      false,
      false,
      'skin',
      half,
    );
  }
  const halves = (k: number) => {
    const c = descriptors[k]?.fragment?.constants ?? {};
    return [c['8'], c['10'], c['11']];
  };
  expect(halves(0)).toEqual([1, 0, 0]);
  expect(halves(1)).toEqual([1, 1, 0]);
  expect(halves(2)).toEqual([1, 0, 1]);
  expect(descriptors[1]?.depthStencil?.depthWriteEnabled).toBe(true);
  expect(descriptors[1]?.multisample?.alphaToCoverageEnabled).toBe(true);
  expect(descriptors[2]?.depthStencil?.depthWriteEnabled).toBe(false);
  expect(descriptors[2]?.depthStencil?.depthCompare).toBe('equal');
  expect(descriptors[2]?.multisample?.alphaToCoverageEnabled).toBeUndefined();
});

/*
 * **Every material field the renderer writes is in every layout it writes into.** `materialField`
 * reads an absent name as offset 0, so a uniform renamed in the GLSL, or added there and bound here
 * before `npm run wgsl` ran, writes over the first field of the block and the frame draws on with
 * no error anywhere. Read off the renderer's own source, so a new field is covered the day it is
 * written; checked against all sixteen permutations, because a field one leaves out is one that
 * permutation writes over its neighbour.
 */
test('EVERY MATERIAL FIELD THE WEBGPU RENDERER NAMES IS IN THE MATERIAL BLOCK OF EVERY PERMUTATION', async () => {
  /* Vite's `?raw` carries no type declaration; a variable path keeps TS quiet, as flat.test.ts does. */
  const path = './renderer.ts?raw';
  const source = (await import(/* @vite-ignore */ path)).default as string;
  const names = [...new Set([...source.matchAll(/materialField\('(\w+)'\)/g)].map((m) => m[1]))];
  expect(names, 'the renderer was read').toContain('uNormalStrength');
  for (let bits = 0; bits < 16; bits++) {
    const variant = flatVariant({
      directionalShadows: (bits & 1) !== 0,
      environmentProbe: (bits & 2) !== 0,
      nightEmissive: (bits & 4) !== 0,
      pointShadows: (bits & 8) !== 0,
    });
    /*
     * In the material block and not merely in the stage: a setter marks only the material changed,
     * so a field it writes that sat in the pass's block would reach no draw until the next pass.
     */
    const fields = flatFragmentBindings(variant).materialFields ?? {};
    for (const name of names) {
      expect(
        fields[name as string],
        `${name} in variant ${variant}'s material block`,
      ).toBeDefined();
    }
  }
});

/*
 * **The probe's ceilings are the generated bindings' own.** Counted by hand off the widest variant,
 * `directionalShadows+environmentProbe+pointShadows`: sixteen textures, from the refraction copy to
 * the model map, and twelve samplers once the four the shadow share holds and the two the glass tint
 * share holds are each counted once. The renderer typed seven and four here until it was derived.
 */
test('THE PROBE ASKS A DEVICE FOR THE TEXTURES AND SAMPLERS ITS WIDEST VARIANT BINDS', () => {
  expect(probeStageCeilings()).toEqual({ textures: 16, samplers: 12 });
});

/*
 * **The reflection pass's surface half is the frame's draw again**: the same layout and vertex stage,
 * its own switch on, the two maps as its targets with nothing at the colour's location, and a depth
 * it tests `equal` and never writes — so only what the frame kept writes a material, and the frame's
 * depth is left as the frame left it. The ordinary pipeline beside it has the switch off.
 */
test('THE REFLECTION SURFACE HALF WRITES ITS TWO MAPS AGAINST THE DEPTH THE FRAME WROTE', () => {
  const { device, descriptors } = fakeDevice();
  const cache = new PipelineCache(device, 'bgra8unorm', 1, true, true);
  const layout = {} as unknown as GPUBindGroupLayout;
  flatPipeline(cache, device, layout, 'none', 'flat:s0:u0', {});
  flatPipeline(
    cache,
    device,
    layout,
    'none',
    'flat:s0:u0|rs',
    {},
    false,
    false,
    false,
    true,
    0,
    false,
    'none',
    false,
    false,
    false,
    false,
    null,
    'whole',
    true,
  );
  const [frame, surface] = descriptors;
  expect(frame?.fragment?.constants?.['16'], 'the frame’s own: off').toBe(0);
  expect(surface?.fragment?.constants?.['16'], 'the surface half: on').toBe(1);
  expect(surface?.fragment?.targets).toEqual([
    null,
    { format: 'rgba16float' },
    { format: 'rgba16float' },
  ]);
  expect(surface?.depthStencil?.depthWriteEnabled).toBe(false);
  expect(surface?.depthStencil?.depthCompare).toBe('equal');
});
