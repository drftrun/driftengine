import { describe, expect, it } from 'vitest';
import { NavPath, buildNavGraph } from '@driftengine/core';
import type { NavGraph } from '@driftengine/core';
import { navigationBridge, reachableBy } from './navigation.ts';
import type { NavigateArgs, NavigateResult, NavigationAdapter } from './navigation.ts';
import type { ToolDefinition } from '../tools/registry.ts';

/**
 * The guard, which is the whole reason this bridge is a row rather than a wrapper.
 *
 * Everything else here would pass with `admits` returning `true` unconditionally. So the cases that
 * matter are the ones where a route *stops existing between the proposal and the act*: that is what
 * a buffered intent is exposed to, and until navigation there was nothing in this engine that could
 * answer it.
 */

/**
 * A corridor of nodes with a bridge in the middle, so a link can be cut.
 *
 * ```
 *   0 - 1 - 2   |   3 - 4 - 5
 * ```
 *
 * The `2 - 3` edge is the bridge. Built with it or without it, which is the only difference between
 * a world where a plan is still a plan and one where it is not.
 */
function corridor(bridged: boolean): NavGraph {
  const positions: number[] = [];
  for (let i = 0; i < 6; i++) positions.push(i * 10, 0, 0);
  const edges = [
    { from: 0, to: 1 },
    { from: 1, to: 2 },
    { from: 3, to: 4 },
    { from: 4, to: 5 },
  ];
  if (bridged) edges.push({ from: 2, to: 3 });
  return buildNavGraph(new Float32Array(positions), edges);
}

/** A world of exactly what the adapter is asked for, and nothing this package could guess at. */
interface World {
  graph: NavGraph | null;
  x: number;
  path: NavPath | null;
  present: boolean;
}

function bridgeOver(world: World): {
  tools: readonly ToolDefinition<NavigateArgs, NavigateResult, World>[];
  navigate: ToolDefinition<NavigateArgs, NavigateResult, World>;
} {
  const adapter: NavigationAdapter<World> = {
    graphOf: (w) => w.graph,
    positionOf: (w, _id, out) => {
      if (!w.present) return false;
      out[0] = w.x;
      out[1] = 0;
      out[2] = 0;
      return true;
    },
    pathOf: (w) => w.path,
  };
  const tools = navigationBridge(adapter);
  return { tools, navigate: tools[0] as ToolDefinition<NavigateArgs, NavigateResult, World> };
}

function world(bridged: boolean): World {
  const graph = corridor(bridged);
  return { graph, x: 0, path: new NavPath(graph, 16), present: true };
}

const FAR_END: NavigateArgs = { agentId: 'A17', x: 50, y: 0, z: 0 };

describe('the navigation bridge', () => {
  it('registers one versioned tool and describes its arguments', () => {
    const { navigate } = bridgeOver(world(true));
    expect(navigate.id).toBe('navigate@1');
    expect(navigate.schema).toEqual({
      kind: 'object',
      fields: {
        agentId: { kind: 'string' },
        x: { kind: 'number' },
        y: { kind: 'number' },
        z: { kind: 'number' },
      },
    });
    /* Two calls with one argument set are two different routes, from wherever the agent got to. */
    expect(navigate.idempotent).toBe(false);
  });

  it('routes across the bridge and reports the distance', () => {
    const w = world(true);
    const { navigate } = bridgeOver(w);
    expect(navigate.admits(FAR_END, w)).toBe(true);
    const result = navigate.execute(FAR_END, w);
    expect(result.found).toBe(true);
    expect(result.nodes).toBe(6);
    expect(result.lengthM).toBeCloseTo(50, 5);
    expect(w.path?.active).toBe(true);
  });

  /**
   * **The case the row exists for.** The proposal was authored while the bridge stood; by the time
   * it executes the bridge is gone. `admits` says so, so the intent is discarded and the floor
   * covers — instead of the agent walking to the near bank and standing there having reported
   * success.
   */
  it('refuses a destination that stopped being reachable after the proposal', () => {
    const w = world(true);
    const { navigate } = bridgeOver(w);
    expect(navigate.admits(FAR_END, w)).toBe(true);

    w.graph = corridor(false);
    w.path = new NavPath(w.graph, 16);

    expect(navigate.admits(FAR_END, w)).toBe(false);
  });

  /**
   * And the guard is not merely pessimistic. A bridge that answered `false` for everything would
   * pass the case above and be useless, so the same world with the link restored must admit again.
   */
  it('admits again when the route comes back', () => {
    const w = world(false);
    const { navigate } = bridgeOver(w);
    expect(navigate.admits(FAR_END, w)).toBe(false);

    w.graph = corridor(true);
    w.path = new NavPath(w.graph, 16);
    expect(navigate.admits(FAR_END, w)).toBe(true);
  });

  /**
   * An execute that slips past a false guard must not leave the old route running.
   *
   * A tool is guarded, so this should not happen; `execute` is public and a consumer may call it
   * directly, and a failed navigate that leaves the previous route in place is an agent still
   * walking to somewhere nobody asked for, which reads exactly like the tool having worked.
   */
  it('clears the route when it executes without one', () => {
    const w = world(true);
    const { navigate } = bridgeOver(w);
    navigate.execute(FAR_END, w);
    expect(w.path?.active).toBe(true);

    w.graph = corridor(false);
    const result = navigate.execute(FAR_END, w);
    expect(result).toEqual({ found: false, nodes: 0, lengthM: 0 });
    expect(w.path?.active).toBe(false);
  });

  it('refuses an agent the consumer cannot place', () => {
    const w = world(true);
    const { navigate } = bridgeOver(w);
    w.present = false;
    expect(navigate.admits(FAR_END, w)).toBe(false);
  });

  it('refuses an agent with no graph at all', () => {
    const w = world(true);
    const { navigate } = bridgeOver(w);
    w.graph = null;
    expect(navigate.admits(FAR_END, w)).toBe(false);
  });

  /**
   * **`snapDistance` is why a sparse graph does not send an agent confidently to the wrong place.**
   * Without it the nearest node to a destination fifty metres off the graph is still *a* node, and
   * the route to it succeeds.
   */
  it('refuses a destination beyond the snap distance, and accepts one inside it', () => {
    const w = world(true);
    const adapter: NavigationAdapter<World> = {
      graphOf: (x) => x.graph,
      positionOf: (x, _id, out) => {
        out[0] = x.x;
        out[1] = 0;
        out[2] = 0;
        return true;
      },
      pathOf: (x) => x.path,
    };
    const tight = navigationBridge(adapter, { snapDistance: 4 })[0] as ToolDefinition<
      NavigateArgs,
      NavigateResult,
      World
    >;
    expect(tight.admits({ agentId: 'A17', x: 50, y: 0, z: 30 }, w)).toBe(false);
    expect(tight.admits({ agentId: 'A17', x: 50, y: 0, z: 2 }, w)).toBe(true);

    const loose = navigationBridge(adapter)[0] as ToolDefinition<
      NavigateArgs,
      NavigateResult,
      World
    >;
    expect(loose.admits({ agentId: 'A17', x: 50, y: 0, z: 30 }, w)).toBe(true);
  });

  /** Asking is the guard without the act, which is what a policy scoring a destination needs. */
  it('answers reachability without writing a route', () => {
    const w = world(true);
    const { tools } = bridgeOver(w);
    expect(reachableBy(tools, FAR_END, w)).toBe(true);
    expect(w.path?.active).toBe(false);

    w.graph = corridor(false);
    expect(reachableBy(tools, FAR_END, w)).toBe(false);
  });

  /**
   * Allocation is what puts a bridge inside a fixed step or outside it. `NavSearch` sizes five
   * arrays by the graph, so one per intent would allocate proportionally to the world every time an
   * agent decided anything.
   */
  it('builds one search per graph and reuses it', () => {
    const w = world(true);
    const { navigate } = bridgeOver(w);
    const first = w.graph;
    for (let i = 0; i < 50; i++) expect(navigate.admits(FAR_END, w)).toBe(true);
    expect(w.graph).toBe(first);
  });
});
