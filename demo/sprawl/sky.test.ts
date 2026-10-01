import { describe, expect, it } from 'vitest';

import { createEnvironment } from '../../packages/core/src/index';

import { CitySky, bloomThreshold } from './sky';

/** The environment as the scene makes it: with a ground's ambient for the sky to set. */
const sceneEnvironment = () => createEnvironment({ ambientGround: [0, 0, 0] });

/** The most a white surface facing the light takes from it: the sun, or moon, and the sky. */
const whiteLevel = (env: ReturnType<typeof createEnvironment>): number =>
  Math.max(
    ...[0, 1, 2].map((c) => (env.directionalColor[c] as number) + (env.ambient[c] as number)),
  );

describe("the city's bloom", () => {
  it('A WHITE WALL IN THE NOON SUN DOES NOT BLOOM, and a pale street under it does not either', () => {
    const env = sceneEnvironment();
    new CitySky().apply(12, 0, env, 0);
    /* The sun alone is 1.5 in its brightest channel: a white wall facing it is past 1.2 by far. */
    expect(whiteLevel(env)).toBeGreaterThan(1.2);
    expect(bloomThreshold(env)).toBeGreaterThan(whiteLevel(env));
  });

  it('AT MIDNIGHT THE THRESHOLD IS THE ONE THE SIGNS AND WINDOWS WERE CHOSEN TO CLEAR', () => {
    const env = sceneEnvironment();
    new CitySky().apply(0, 0, env, 0);
    expect(bloomThreshold(env)).toBe(1.2);
  });

  it('THE THRESHOLD MOVES IN STEPS, so a day moving every frame rewrites the bloom a few times', () => {
    const env = sceneEnvironment();
    const sky = new CitySky();
    /* A whole day a frame at a time, at the city's twenty-minute day: 72,000 frames, every one of
       dawn's and dusk's moving the light. */
    let changes = 0;
    let last = -1;
    for (let i = 0; i <= 72_000; i++) {
      sky.apply((24 * i) / 72_000, 0, env, 0);
      const threshold = bloomThreshold(env);
      if (threshold !== last) changes += 1;
      last = threshold;
    }
    expect(changes).toBeLessThan(40);
  });
});
