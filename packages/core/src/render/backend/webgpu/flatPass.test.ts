import { expect, test, vi } from 'vitest';

import { DEPTH_OFFSET_SIGN, OVERLAY_DEPTH_UNITS } from '../../depthConvention.ts';
import { PipelineCache } from './pipelineCache.ts';
import { flatPipeline, flatVertexBindings, flatVertexKey } from './flatPass.ts';
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
  const wind = ['uWindDirection', 'uWindSpeed', 'uWindGust', 'uWindTime', 'uWindSpatialPhase'];
  for (const key of ['none', 'skinned', 'morphed', 'morphed+skinned']) {
    const fields = FLAT_BINDINGS.flatVert[key as keyof typeof FLAT_BINDINGS.flatVert].fields;
    for (const name of wind) expect(Object.keys(fields)).toContain(name);
  }
  const instanced = FLAT_BINDINGS.flatVert.instanced.fields;
  for (const name of wind) expect(Object.keys(instanced)).not.toContain(name);
});

/*
 * **Every switch is in every variant.** The generated WGSL is one string for both values of each:
 * the lit stage branches on five overrides — glass, then `litSwitchesGlsl`'s four — and a pipeline
 * sets each from its cache. Every variant declares all five, because a pipeline naming an override
 * its module lacks fails validation and drops the frame, the permutations without shadows included,
 * which read the glass switch nowhere.
 */
test('EVERY LIT VARIANT DECLARES THE FIVE SWITCHES ITS PIPELINES SET', () => {
  const variants = Object.entries(FLAT_FRAG_WGSL);
  expect(variants.length).toBe(16);
  const switches = [
    'GLASS_SHADOWS',
    'CLUSTERED_LIGHTS',
    'LIGHT_FIXTURES',
    'SURFACE_EFFECTS',
    'DRIFT_LIGHT',
  ] as const;
  for (const [variant, wgsl] of variants) {
    switches.forEach((name, id) => {
      expect(wgsl, `${variant}: ${name}`).toMatch(
        new RegExp(`@id\\(${id}\\) override ${name}: bool = true;`),
      );
    });
    const bindings = (FLAT_BINDINGS.flatFrag as Record<string, { overrides?: unknown }>)[variant];
    expect(bindings?.overrides, variant).toEqual({
      GLASS_SHADOWS: 0,
      CLUSTERED_LIGHTS: 1,
      LIGHT_FIXTURES: 2,
      SURFACE_EFFECTS: 3,
      DRIFT_LIGHT: 4,
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
test('A LIT PIPELINE SETS ALL FIVE SWITCHES, clustering from the profile and the rest as they are used', async () => {
  const { device, descriptors } = fakeDevice();
  const cache = new PipelineCache(device, 'bgra8unorm', 1, true, true);
  flatPipeline(cache, device, {} as unknown as GPUBindGroupLayout, 'none', 'flat:s0:u0', {});
  expect(descriptors[0]?.fragment?.constants).toEqual({ '0': 0, '1': 1, '2': 0, '3': 0, '4': 0 });

  await cache.enable('DRIFT_LIGHT');
  expect(descriptors[1]?.fragment?.constants).toEqual({ '0': 0, '1': 1, '2': 0, '3': 0, '4': 1 });
});
