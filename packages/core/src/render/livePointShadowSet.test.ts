import { describe, expect, it } from 'vitest';

import { LivePointShadowSet } from './livePointShadowSet.ts';
import { PointShadowSystem } from './pointShadowSystem.ts';
import { createResolvedPointShadows } from './pointShadowImage.ts';
import type { PointShadowSource } from './pointShadowImage.ts';

/** How long a freshly baked image takes to reach full strength. Mirrors `ARRIVAL_SECONDS`. */
const ARRIVAL_SECONDS = 0.25;

/**
 * The smallest thing that satisfies `PointShadowSource`, with the arrival ramp the real map has.
 *
 * Hand-written rather than reused from a backend, because the whole point of `PointShadowSource`
 * is that neither pool knows which device it is pooling — a stub is the honest consumer of that.
 */
function stubMap(layer: number): PointShadowSource & { bake(): void } {
  let arrival = 0;
  let baked = false;
  return {
    layer,
    far: 20,
    near: 0.25,
    sourceRadius: 0.18,
    /* Distinct per layer, so a published origin cannot be confused with another map's. */
    originX: 100 + layer,
    originY: 200 + layer,
    originZ: 300 + layer,
    get hasBaked() {
      return baked;
    },
    get presence() {
      return arrival;
    },
    advance(dt: number) {
      if (!baked) {
        arrival = 0;
        return;
      }
      arrival = Math.min(1, arrival + dt / ARRIVAL_SECONDS);
    },
    forget() {
      baked = false;
      arrival = 0;
    },
    bake() {
      baked = true;
    },
  };
}

describe('the live shadow pair', () => {
  /*
   * **A live map that is never advanced is a live map that never contributes anything.**
   *
   * `resolve` publishes `crossfade weight * presence`, and presence is the arrival ramp. The ramp
   * only moves when something calls `advance` on the map — and `PointShadowSystem.advance` walks
   * its own pool, which does not contain these two. So the weight stayed at zero for every frame
   * of the engine's life, the shader multiplied the live occlusion by it, and **a moving caster was
   * never shadowed by a point light at all**.
   *
   * Reported from a game as a flickering source no longer casting a moving character's shadow, and
   * reproduced on `demo/dev/pointshadow.html`: the octahedral layer holds the caster, the layer
   * index and far plane are published correctly, `hasBaked` is true, the crossfade weight is 1 —
   * and `presence` reads 0 after eighty frames of a stationary caster.
   *
   * Asserted here rather than in the renderer because none of it is about a device.
   */
  it('lets a baked map become present, so it can contribute', () => {
    const maps: (PointShadowSource & { bake(): void })[] = [];
    const set = new LivePointShadowSet(
      (layer) => {
        const map = stubMap(layer);
        maps.push(map);
        return map;
      },
      () => undefined,
    );

    const lights = [{ x: 0, y: 2.4, z: 0 }];
    const sampled = new Int32Array([0]);
    set.update(lights, sampled, 1, 0, 0, 1.4, 1 / 60);
    /* The bake the renderer would have run: six faces landing makes the image real. */
    for (const map of maps) map.bake();

    /* A quarter second of frames, which is exactly the ramp's own length. */
    for (let frame = 0; frame < 15; frame++) set.advance(1 / 60);

    const out = createResolvedPointShadows(4);
    set.resolve(sampled, new Int32Array([0]), 1, out);

    expect(out.liveLayers[0]).toBe(0);
    expect(out.liveWeights[0]).toBeGreaterThan(0);
  });

  /*
   * And an image that has not arrived yet contributes nothing, which is the property the ramp
   * exists for: a whole mover's shadow switching on in one frame under a lamp that never moved is
   * the pop `advance` was written to remove. A fix that made the weight 1 unconditionally would
   * pass the test above and undo this.
   */
  it('keeps a map that has not been advanced at no presence', () => {
    const maps: (PointShadowSource & { bake(): void })[] = [];
    const set = new LivePointShadowSet(
      (layer) => {
        const map = stubMap(layer);
        maps.push(map);
        return map;
      },
      () => undefined,
    );
    const sampled = new Int32Array([0]);
    set.update([{ x: 0, y: 2.4, z: 0 }], sampled, 1, 0, 0, 1.4, 1 / 60);
    for (const map of maps) map.bake();

    const out = createResolvedPointShadows(4);
    set.resolve(sampled, new Int32Array([0]), 1, out);
    expect(out.liveWeights[0]).toBe(0);
  });
});

describe('the system that advances both halves', () => {
  /*
   * **The wiring, which is where the defect actually was.** `LivePointShadowSet.advance` existing
   * is necessary and not sufficient: `PointShadowSystem.advance` walked only its own pool, so the
   * live pair was never reached. A test that calls the set directly passes with the call site
   * still missing — which it did, and the perturbation that proved it is why this second test
   * exists at all.
   */
  it('advances the live pair, not only the pool', () => {
    const made: (PointShadowSource & { bake(): void })[] = [];
    const system = new PointShadowSystem<PointShadowSource & { bake(): void }>(
      (layer) => {
        const map = stubMap(layer);
        made.push(map);
        return map;
      },
      () => undefined,
    );
    const lights = [{ x: 0, y: 2.4, z: 0, radius: 20, shadowNear: 0.25, sourceRadius: 0.18 }];
    system.prepareStaticMaps(lights.length);
    system.sync(new Int32Array([0]), 1);
    system.updateLiveSelection(lights, 0, 0, 1.4, 1 / 60);

    /* Every map the system built, live pair included, now holds an image. */
    for (const map of made) map.bake();
    for (let frame = 0; frame < 15; frame++) system.advance(1 / 60);

    const out = createResolvedPointShadows(4);
    system.resolve(out);
    expect(out.liveLayers[0]).toBeGreaterThanOrEqual(0);
    expect(out.liveWeights[0]).toBeGreaterThan(0);
  });
});
