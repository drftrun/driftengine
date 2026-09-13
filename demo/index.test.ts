import { expect, test } from 'vitest';
import { SCENES, isDemoScene } from './index';

/**
 * The contract a consumer mounts against, asserted without a GL context.
 *
 * A demo is the engine demonstrating itself, so the thing worth protecting is
 * that every scene answers the same three questions before anything is drawn:
 * what is it called, what is it showing, and how is it started. A consumer picks
 * a scene from a list and mounts it knowing nothing else, and that is only true
 * while this holds.
 */
test('a scene is recognised by its shape, not by where it came from', () => {
  expect(
    isDemoScene({
      id: 'a-scene',
      title: 'A',
      note: 'B',
      mount: () => ({ frame: () => ({ draws: 0, gpuMs: 0 }), dispose: () => {} }),
    }),
  ).toBe(true);
  expect(
    isDemoScene({ id: 'no-mount', title: 'A', note: 'B' }),
    'a scene that cannot be started is not a scene',
  ).toBe(false);
  expect(
    isDemoScene({
      id: 'Bad Id',
      title: 'A',
      note: 'B',
      mount: () => ({ frame: () => ({ draws: 0, gpuMs: 0 }), dispose: () => {} }),
    }),
    'an id is used as a key and in a URL',
  ).toBe(false);
  expect(
    isDemoScene({
      id: 'blank',
      title: '  ',
      note: 'B',
      mount: () => ({ frame: () => ({ draws: 0, gpuMs: 0 }), dispose: () => {} }),
    }),
    'a blank title tells a reader nothing',
  ).toBe(false);
  expect(isDemoScene(null)).toBe(false);
});

/**
 * The registry starts empty and every entry has to earn its place through the
 * same gate. Asserted over whatever is registered rather than against a count,
 * so adding a scene cannot quietly skip the contract.
 */
test('every registered scene satisfies the contract, and ids are unique', () => {
  const ids = new Set<string>();
  for (const scene of SCENES) {
    expect(isDemoScene(scene), `${scene.id} does not satisfy the contract`).toBe(true);
    expect(ids.has(scene.id), `duplicate scene id ${scene.id}`).toBe(false);
    ids.add(scene.id);
  }
});
