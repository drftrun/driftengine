import { expect, test } from 'vitest';
import { DRAFT_SCENES, SCENES, isDemoScene } from './index';

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

/**
 * **Which pipeline a scene can be drawn on, said by the scene.** The sandbox draws the same world
 * both ways and the city only on the second, and a consumer building a demos page from `SCENES`
 * could not tell either from the list: the sandbox's flag lived on the page's address, and the
 * city on WebGL2 is a mount that refuses. `loadsModel`'s reason, again — a claim about the corpus
 * derived from the corpus rather than kept beside it.
 */
test('A SCENE THAT NAMES ITS PIPELINES NAMES KNOWN ONES, at least one and each once', () => {
  const scene = (pipelines: unknown) => ({
    id: 'a-scene',
    title: 'A',
    note: 'B',
    pipelines,
    mount: () => ({ frame: () => ({ draws: 0, gpuMs: 0 }), dispose: () => {} }),
  });
  expect(isDemoScene(scene(['forward', 'gpu-driven']))).toBe(true);
  expect(isDemoScene(scene(['gpu-driven']))).toBe(true);
  expect(isDemoScene(scene(undefined)), 'absent is the forward path alone').toBe(true);
  expect(isDemoScene(scene([])), 'a scene drawn on nothing').toBe(false);
  expect(isDemoScene(scene(['forward', 'forward'])), 'one named twice').toBe(false);
  expect(isDemoScene(scene(['vulkan'])), 'one the engine does not have').toBe(false);
  expect(isDemoScene(scene('gpu-driven')), 'a name rather than a list').toBe(false);
});

test('THE SANDBOX OFFERS BOTH PIPELINES AND THE CITY ONLY THE SECOND, and the rest say nothing', () => {
  const offered = Object.fromEntries(SCENES.map((scene) => [scene.id, scene.pipelines]));
  expect(offered['voxel-sandbox']).toEqual(['forward', 'gpu-driven']);
  expect(offered['city']).toEqual(['gpu-driven']);
  const rest = SCENES.filter((scene) => scene.id !== 'voxel-sandbox' && scene.id !== 'city');
  expect(rest.every((scene) => scene.pipelines === undefined)).toBe(true);
  /* What a host that cannot run the second pipeline asks the list, and the answer it gets. */
  const needsIt = SCENES.filter((scene) => scene.pipelines?.includes('forward') === false);
  expect(needsIt.map((scene) => scene.id)).toEqual(['city']);
});

test('THE CITY IS PUBLISHED, last, and is no longer a draft', () => {
  expect(SCENES.at(-1)?.id).toBe('city');
  expect(DRAFT_SCENES.some((scene) => scene.id === 'city')).toBe(false);
});
