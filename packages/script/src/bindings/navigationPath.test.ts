/**
 * A route per agent, which is the half of a consumer's report that `uses` does not answer.
 *
 * DriftScript 1.8.0 lets a system be handed the *graph* — one per world, and a resource is one per
 * type. A route is one per walker, so it has to arrive as something a script can ask for by entity;
 * otherwise the loop over agents stays in TypeScript, which is the thing the report is about.
 */
import { describe, expect, it } from 'vitest';
import { NavSearch, buildNavGraph } from '@driftengine/core';
import type { NavPath } from '@driftengine/core';
import { World } from '@driftengine/entities';
import { navigationImplementation } from './navigation.ts';

/** Four nodes in a line, one metre apart, joined end to end. */
const line = () => {
  const graph = buildNavGraph(
    [0, 0, 0, 1, 0, 0, 2, 0, 0, 3, 0, 0],
    [
      { from: 0, to: 1 },
      { from: 1, to: 2 },
      { from: 2, to: 3 },
    ],
  );
  return { graph, search: new NavSearch(graph) };
};

const navigation = () =>
  navigationImplementation(line()) as {
    path: (agent: number) => NavPath;
    route: (
      path: NavPath,
      graph: unknown,
      fromX: number,
      fromY: number,
      fromZ: number,
      toX: number,
      toY: number,
      toZ: number,
    ) => boolean;
    following: (path: NavPath) => boolean;
  };

describe('the route an agent is following', () => {
  it('gives one path per agent, and the same one every time', () => {
    /* The same object on every call is the whole point: a script asks for it inside a query loop,
       every step, and a fresh route each time would forget where the walker had got to. */
    const nav = navigation();
    const world = new World();
    const walker = world.create();
    expect(nav.path(walker)).toBe(nav.path(walker));
  });

  it('gives two agents two routes', () => {
    const nav = navigation();
    const world = new World();
    expect(nav.path(world.create())).not.toBe(nav.path(world.create()));
  });

  it('starts empty, so an agent nobody routed is not following anything', () => {
    const nav = navigation();
    const world = new World();
    expect(nav.following(nav.path(world.create()))).toBe(false);
  });

  it('keeps the route between steps, which is what makes it worth holding', () => {
    const nav = navigation();
    const world = new World();
    const walker = world.create();
    const { graph } = line();
    expect(nav.route(nav.path(walker), graph, 0, 0, 0, 3, 0, 0)).toBe(true);
    expect(nav.following(nav.path(walker))).toBe(true);
  });

  it('does not hand a new agent the route of the one whose slot it took', () => {
    /*
     * **The failure this test exists for.** Entity indices are reused, so a table keyed by index
     * alone would give a freshly spawned walker the route of whatever died in its place — and it
     * would set off confidently in the wrong direction with nothing to find. The generation beside
     * the index is what makes the reuse safe.
     */
    const nav = navigation();
    const world = new World();
    const first = world.create();
    const { graph } = line();
    nav.route(nav.path(first), graph, 0, 0, 0, 3, 0, 0);
    expect(nav.following(nav.path(first))).toBe(true);

    world.destroy(first);
    const second = world.create();
    expect(second).not.toBe(first);
    expect(nav.following(nav.path(second))).toBe(false);
  });

  it('allocates once per agent and never again', () => {
    /* A route is a buffer, so the first call for an agent has to allocate — which the capability
       declares with `allocates`. What matters is that a query loop asking every step does not. */
    const nav = navigation();
    const world = new World();
    const walker = world.create();
    const first = nav.path(walker);
    for (let i = 0; i < 1000; i += 1) nav.path(walker);
    expect(nav.path(walker)).toBe(first);
  });
});
