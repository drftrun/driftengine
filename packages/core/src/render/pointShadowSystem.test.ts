import { expect, test } from 'vitest';
import { LIVE_POINT_SHADOW_MAPS, MAX_POINT_LIGHTS, POINT_SHADOW_POOL } from './lightBudget.ts';
import type { PointShadowTarget } from './pointShadowArray.ts';
import { PointShadowMap } from './pointShadowMap.ts';
import { createResolvedPointShadows } from './pointShadowImage.ts';
import { PointShadowSystem } from './pointShadowSystem.ts';
import type { ShadowLight } from './pointShadowSystem.ts';

/**
 * The shadow pool, and the two bugs it exists to make impossible.
 *
 * No GL here — a fake context is enough, because what is being tested is an
 * allocation policy rather than a rendering. Both bugs shipped, both were
 * invisible on a GPU with its own memory, and together they made the game
 * unplayable on an integrated one:
 *
 * 1. One permanent cubemap per world light. Fifty lamps meant fifty maps, about
 *    327 MB, so that the eight `MAX_POINT_LIGHTS` the shader can bind could be
 *    read. Forty-two were unreadable by construction.
 * 2. A flickering light re-baking six faces of the static world every frame,
 *    because its few centimetres of wander failed an exact position compare.
 */
function fakeGl(): { gl: WebGL2RenderingContext; textures: () => number } {
  let textures = 0;
  const gl = {
    TEXTURE_CUBE_MAP: 0x8513,
    TEXTURE_CUBE_MAP_POSITIVE_X: 0x8515,
    DEPTH_COMPONENT24: 0x81a6,
    DEPTH_ATTACHMENT: 0x8d00,
    FRAMEBUFFER: 0x8d40,
    FRAMEBUFFER_COMPLETE: 0x8cd5,
    DEPTH_BUFFER_BIT: 0x100,
    TEXTURE_MIN_FILTER: 0x2801,
    TEXTURE_MAG_FILTER: 0x2800,
    TEXTURE_WRAP_S: 0x2802,
    TEXTURE_WRAP_T: 0x2803,
    TEXTURE_WRAP_R: 0x8072,
    NEAREST: 0x2600,
    CLAMP_TO_EDGE: 0x812f,
    CULL_FACE: 0x0b44,
    BACK: 0x0405,
    NONE: 0,
    createTexture: () => {
      textures++;
      return {} as WebGLTexture;
    },
    createFramebuffer: () => ({}) as WebGLFramebuffer,
    bindTexture: () => {},
    bindFramebuffer: () => {},
    texStorage2D: () => {},
    texParameteri: () => {},
    framebufferTexture2D: () => {},
    drawBuffers: () => {},
    readBuffer: () => {},
    checkFramebufferStatus: () => 0x8cd5,
    clear: () => {},
    viewport: () => {},
    enable: () => {},
    disable: () => {},
    cullFace: () => {},
    activeTexture: () => {},
    uniform1i: () => {},
    uniform1iv: () => {},
    uniform1fv: () => {},
    deleteTexture: () => {},
    deleteFramebuffer: () => {},
  } as unknown as WebGL2RenderingContext;
  return { gl, textures: () => textures };
}

/**
 * A pool over real `PointShadowMap`s against the fake context.
 *
 * The system takes a factory now rather than a context, so that a WebGPU pool can be the same
 * pool. These tests still count *textures*, which is why the factory builds the GL map: what
 * they protect is how many cubemaps a world of N lights allocates, and that is the pooling
 * rule rather than anything about the device.
 */
/**
 * A target that records the faces resolved into it and allocates nothing.
 *
 * Every assertion in this file is about the pooling rule rather than about a texture, and since
 * the maps stopped owning one there is nothing device-shaped left for them to need. Counting
 * resolved faces is the honest replacement for counting `createTexture` calls: it is what the
 * bake actually does now, and it is per layer, which the texture count never was.
 */
function recordingTarget() {
  const resolved: { layer: number; face: number }[] = [];
  const target: PointShadowTarget = {
    beginFace: () => {},
    resolveFace: (_gl, layer, face) => {
      resolved.push({ layer, face });
    },
  };
  return { target, resolved };
}

function makeSystem(
  gl: WebGL2RenderingContext,
  target: PointShadowTarget = recordingTarget().target,
): PointShadowSystem<PointShadowMap> {
  return new PointShadowSystem(
    (layer) => new PointShadowMap(() => target, layer, 512),
    (map) => map.dispose(gl),
  );
}

/** `sync` takes the shading pass's list verbatim, so hand it one. */
function chooseLights(system: PointShadowSystem<PointShadowMap>, indices: readonly number[]): void {
  const active = new Int32Array(MAX_POINT_LIGHTS).fill(-1);
  for (let i = 0; i < indices.length && i < MAX_POINT_LIGHTS; i++) {
    active[i] = indices[i] ?? -1;
  }
  system.sync(active, Math.min(indices.length, MAX_POINT_LIGHTS));
}

/*
 * **These used to count `createTexture` calls and now count maps.** A map owned a cubemap until
 * the octahedral change put every light in one array texture, so there is no per-light allocation
 * left to count here — `pointShadowArray.test.ts` asserts the layer count, which is where that
 * storage went. The pooling rule is unchanged and is what these two were always about.
 */
test('a world with more lights than the pool holds only the pool', () => {
  const { gl } = fakeGl();
  const system = makeSystem(gl);

  system.prepareStaticMaps(50);

  // The bug this replaces gave fifty lights a cubemap each, about 327 MB, to let the
  // shader read eight.
  const held = new Set<number>();
  for (let light = 0; light < 50; light++) {
    chooseLights(system, [light]);
    const map = system.mapForLight(light);
    if (map !== undefined) held.add(map.layer);
  }
  expect(held.size, 'distinct layers for 50 world lights').toBe(POINT_SHADOW_POOL);
});

test('a world with fewer lights than the pool holds only its lights', () => {
  const { gl } = fakeGl();
  const system = makeSystem(gl);

  system.prepareStaticMaps(3);

  const held = new Set<number>();
  for (let light = 0; light < 3; light++) {
    chooseLights(system, [light]);
    const map = system.mapForLight(light);
    if (map !== undefined) held.add(map.layer);
  }
  expect(held.size, 'three lamps have no use for twelve maps').toBe(3);
});

/*
 * And the layers do not overlap, which the texture count used to guarantee for free: two maps
 * writing one layer is one lamp's shadow appearing under another, and nothing else would say so.
 */
test('every map in the pool has a layer of its own, live maps included', () => {
  const { gl } = fakeGl();
  const system = makeSystem(gl);
  system.prepareStaticMaps(50);

  const layers = new Set<number>();
  for (let light = 0; light < 50; light++) {
    chooseLights(system, [light]);
    const map = system.mapForLight(light);
    if (map !== undefined) layers.add(map.layer);
  }
  for (let live = 0; live < LIVE_POINT_SHADOW_MAPS; live++) {
    const map = system.liveMap(live);
    if (map !== undefined) {
      expect(layers.has(map.layer), `live map ${live} shares a layer`).toBe(false);
      layers.add(map.layer);
    }
  }
  expect(layers.size).toBe(POINT_SHADOW_POOL + LIVE_POINT_SHADOW_MAPS);
});

test('every chosen light is holding a map, and only chosen lights are', () => {
  const { gl } = fakeGl();
  const system = makeSystem(gl);
  system.prepareStaticMaps(50);

  chooseLights(system, [4, 9, 14, 19]);

  for (const light of [4, 9, 14, 19]) {
    expect(system.mapForLight(light), `light ${light}`).toBeDefined();
  }
  expect(system.mapForLight(7), 'a light nobody chose').toBeUndefined();
});

test('the map wanted longest ago is the one reused', () => {
  const { gl, textures } = fakeGl();
  const system = makeSystem(gl);
  system.prepareStaticMaps(50);
  const afterPrepare = textures();

  // Fill the pool, oldest first, then keep everything but light 0 alive.
  const filling: number[] = [];
  for (let i = 0; i < POINT_SHADOW_POOL; i++) filling.push(i);
  chooseLights(system, filling.slice(0, MAX_POINT_LIGHTS));
  chooseLights(system, filling.slice(MAX_POINT_LIGHTS));
  // Light 0 was wanted in the first frame and not since; lights 8..11 are current.
  chooseLights(system, [8, 9, 10, 11, 30]);

  expect(system.mapForLight(30), 'the newcomer got a map').toBeDefined();
  expect(system.mapForLight(0), 'the light nobody has wanted since frame one').toBeUndefined();
  // Reuse, not growth: the pool is the ceiling.
  expect(textures(), 'no new allocation for the newcomer').toBe(afterPrepare);
});

test('a light chosen this frame is never evicted for another chosen this frame', () => {
  const { gl } = fakeGl();
  const system = makeSystem(gl);
  // A pool of exactly the sampled count is the case that would thrash.
  system.prepareStaticMaps(MAX_POINT_LIGHTS);

  const all: number[] = [];
  for (let i = 0; i < MAX_POINT_LIGHTS; i++) all.push(i);
  chooseLights(system, all);

  // All eight are bound in the same frame, so all eight must still hold maps.
  for (const light of all) {
    expect(system.mapForLight(light), `light ${light} after a full frame`).toBeDefined();
  }
});

test('a light that comes back gets a map again', () => {
  const { gl } = fakeGl();
  const system = makeSystem(gl);
  system.prepareStaticMaps(50);

  chooseLights(system, [0]);
  const first = system.mapForLight(0);
  expect(first).toBeDefined();

  // Push it out with a pool's worth of strangers, twice, so it is the coldest.
  for (let round = 0; round < 2; round++) {
    for (let i = 0; i < POINT_SHADOW_POOL; i += MAX_POINT_LIGHTS) {
      const batch: number[] = [];
      for (let k = 0; k < MAX_POINT_LIGHTS; k++) batch.push(20 + i + k);
      chooseLights(system, batch);
    }
  }
  expect(system.mapForLight(0), 'evicted while away').toBeUndefined();

  chooseLights(system, [0]);
  expect(system.mapForLight(0), 'holding a map again on return').toBeDefined();
});

test('a tolerance forgives a drift, and the caller chooses how much', () => {
  const { gl } = fakeGl();
  const map = new PointShadowMap(() => recordingTarget().target, 0, 512);
  const light: ShadowLight = {
    x: 10,
    y: 2,
    z: 10,
    radius: 8,
    shadowNear: 0.25,
    sourceRadius: 0.05,
  };

  map.bake(
    gl,
    light.x,
    light.y,
    light.z,
    light.radius,
    () => {},
    light.shadowNear,
    light.sourceRadius,
  );

  /*
   * A consumer wanders a flame by 0.12 in x and z and half that in y, so the furthest two points
   * on that path are about 0.36 apart, and 0.4 clears it from either extreme.
   *
   * **That was the engine's default until 4.1.5 and is not any more**, so what this pins is the
   * mechanism rather than the shipped number. A tolerance wide enough to swallow a flame's whole
   * wander means a flame never re-bakes, and its shadow of the static world stands still while
   * the live map under the same light swings with it. The mechanism is still exactly right for a
   * lamp that drifts once and then holds. See `pointShadowRebakeDistance`.
   */
  const wandered = map.matchesSource(
    light.x + 0.12,
    light.y + 0.06,
    light.z - 0.12,
    light.radius,
    light.shadowNear,
    light.sourceRadius,
    0.4,
  );
  expect(wandered, 'six face passes a frame used to hinge on this').toBe(true);

  // Far enough to matter still re-bakes, or a lamp on a lift would drag its shadow.
  const moved = map.matchesSource(
    light.x + 3,
    light.y,
    light.z,
    light.radius,
    light.shadowNear,
    light.sourceRadius,
    0.4,
  );
  expect(moved, 'a light that really moved').toBe(false);

  // And zero tolerance is still the exact compare, for callers that want it.
  const exact = map.matchesSource(
    light.x + 0.01,
    light.y,
    light.z,
    light.radius,
    light.shadowNear,
    light.sourceRadius,
    0,
  );
  expect(exact, 'tolerance 0 keeps the old behaviour').toBe(false);
});

test('a changed radius re-bakes however little the light moved', () => {
  const { gl } = fakeGl();
  const map = new PointShadowMap(() => recordingTarget().target, 0, 512);
  map.bake(gl, 0, 0, 0, 8, () => {}, 0.25, 0.05);

  // The radius is the map's far plane, so a pad light fading its radius to zero
  // must not keep sampling a cube projected for the old one.
  expect(map.matchesSource(0, 0, 0, 4, 0.25, 0.05, 0.4)).toBe(false);
});

test("a recycled slot does not hand the next light the last one's shadow", () => {
  /*
   * The regression, and the reason it was so hard to look at: *"the lights glare and
   * shadows on elements seems appearing/disappearing while I move the camera."*
   *
   * A pool slot keeps its cubemap when it changes hands. `baked` was set the first
   * time a bake finished and never cleared, so a re-borrowed slot reported
   * `hasBaked === true` while holding the *previous* lamp's image, taken from
   * somewhere else entirely. The renderer's `bakeReady` believed it, the shader
   * sampled it, and for the three frames a re-bake takes at two faces each the new
   * light was shaded with another lamp's shadow.
   *
   * The guard that was supposed to prevent exactly this — `bind` skipping a map that
   * has never baked — only ever protected a *fresh* slot. Once the pool is warm, which
   * is within seconds, every slot is a recycled one.
   */
  const { gl } = fakeGl();
  const system = makeSystem(gl);
  system.prepareStaticMaps(50);

  // Fill the pool, then bake the map the first light is holding.
  const first = Array.from({ length: MAX_POINT_LIGHTS }, (_, i) => i);
  chooseLights(system, first);
  const victim = system.mapForLight(0);
  expect(victim).toBeDefined();
  victim?.bake(gl, 1, 2, 3, 10, () => {}, 0.1, 0.2, 6);
  expect(victim?.hasBaked, 'the bake under test must actually have happened').toBe(true);

  /*
   * Push enough different lights through to evict light 0's slot. The pool has
   * `POINT_SHADOW_POOL` slots and only lights chosen *this frame* are protected, so a
   * later frame choosing an entirely different set reclaims it.
   */
  for (let round = 0; round < 3; round++) {
    const next = Array.from({ length: MAX_POINT_LIGHTS }, (_, i) => 20 + round * 8 + i);
    chooseLights(system, next);
  }

  expect(system.mapForLight(0), 'light 0 should have lost its slot').toBeUndefined();
  // Whoever holds that map now must not be able to sample light 0's picture.
  expect(victim?.hasBaked, 'a recycled map must not claim an image of its own').toBe(false);
});

test('a re-baked map arrives rather than appears', () => {
  /*
   * Once the light itself stopped switching, the same note applied to the map: even
   * the drastic case has to fade in and out rather than snap on and off.
   *
   * A light leaving takes its shadow with it and needs nothing here, because by the
   * time it loses its place in the set it is already at no weight at all. A light
   * *keeping* its place can still lose its picture: a pool slot changes hands, the
   * image is thrown away, and the re-bake lands whole between two frames under a lamp
   * that has not moved. Six faces arriving at once used to be a shadow switching on.
   */
  const { gl } = fakeGl();
  const map = new PointShadowMap(() => recordingTarget().target, 0, 512);

  map.bake(gl, 0, 0, 0, 8, () => {}, 0.25, 0.05);
  expect(map.hasBaked).toBe(true);
  expect(map.presence, 'a complete image is still not a present one').toBe(0);

  map.advance(0.05);
  const arriving = map.presence;
  expect(arriving, 'and it is on its way').toBeGreaterThan(0);
  expect(arriving, 'but nowhere near all there').toBeLessThan(0.5);

  map.advance(10);
  expect(map.presence, 'given long enough it is a shadow like any other').toBe(1);

  // Losing the image loses the presence with it: whatever the next borrower bakes
  // is a new light's shadow and arrives as one.
  map.forget();
  expect(map.presence).toBe(0);
  map.advance(1);
  expect(map.presence, 'nothing to be present with until a bake lands').toBe(0);
});

test('a light being shaded is not also warmed', () => {
  /*
   * The two lists overlap almost entirely — the shadow list is the lights inside
   * their own radius, and a light that close is nearly always in the shaded set
   * already. Counted twice, the pool reported more lights than it held, and the
   * pool-length bake arrays meant the genuinely extra ones fell off the end. The
   * four spare slots the pool carries for exactly this never held anything.
   */
  const { gl } = fakeGl();
  const system = makeSystem(gl);
  system.prepareStaticMaps(50);

  const active = new Int32Array(MAX_POINT_LIGHTS).fill(-1);
  active[0] = 3;
  active[1] = 8;
  const warm = new Int32Array(POINT_SHADOW_POOL).fill(-1);
  warm[0] = 3;
  warm[1] = 8;
  warm[2] = 21;
  system.sync(active, 2, warm, 3);

  expect(system.pooledCount, 'two shaded and one genuinely warm').toBe(3);
  expect(system.pooledLight(2), 'and the warm one is the one nobody is shading').toBe(21);
  expect(
    system.mapForLight(21),
    'which is holding a map, ready for when it is wanted',
  ).toBeDefined();
});

/**
 * A map is sampled from where it was baked, not from where the flame has wandered to.
 *
 * **The other half of the drift tolerance above, and it was missing for as long as the tolerance
 * existed.** `matchesSource` deliberately lets a flame wander up to `pointShadowRebakeDistance`
 * from the point its image was rendered at, because re-baking six faces of the static world on
 * every frame of a flicker is what made a brazier the most expensive object in a scene. The
 * shader then sampled that image from the light's **live** position — so the ray and the picture
 * disagreed by up to the whole tolerance, every frame, in a pattern driven by the flicker.
 *
 * The argument recorded for the tolerance was that "the shadow of static geometry metres away
 * barely moves when the emitter shifts by centimetres". That is true of where the shadow *lands*
 * and false of the two things this shader actually asks. `dist` is compared against the stored
 * distance, and it moves one for one with the drift against a bias of a few centimetres; and the
 * blocker search reads one texel, so a fraction of the drift is enough to move it across an
 * occluder's silhouette and swap `occluderDistance` between the caster and nothing at all. With
 * a fire's `sourceRadius` that swings `strength` between a two-thirds shadow and none, so the
 * whole shape switches rather than its edge shifting.
 *
 * Reported on a brazier at night: a hard square under the fire, flashing in time with the flame
 * while the camera stood still, present on one page load and absent on the next — which is the
 * flame's phase against wherever the map happened to be baked.
 *
 * Publishing the bake origin makes the tolerance free, which is what it was always claimed to be.
 */
test('a map publishes the origin it was baked at, not the light that drifted away from it', () => {
  const { gl } = fakeGl();
  const system = makeSystem(gl);
  system.prepareStaticMaps(1);
  chooseLights(system, [0]);

  const map = system.mapForLight(0);
  expect(map, 'the light holds a map').toBeDefined();
  if (map === undefined) return;

  /* A brazier's light: 2.1 m above its pit, which is what throws the square. */
  map.bake(gl, 10, 2.5, 10, 18, () => {}, 0.2, 0.45);

  const out = createResolvedPointShadows(MAX_POINT_LIGHTS);
  system.resolve(out);

  expect(out.projections[0], 'x').toBe(10);
  expect(out.projections[1], 'y').toBe(2.5);
  expect(out.projections[2], 'z').toBe(10);
  /* The far plane rides in the same row; see `uPointShadowProjection`. */
  expect(out.projections[3], 'far').toBe(18);
});
