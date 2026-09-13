/**
 * An agent that can be asked to go somewhere, and a guard that knows whether it still can.
 *
 * **This is the first tool in this package whose guard says something.** A buffered intent is a
 * proposal authored against one snapshot and executed later, and until now the strongest `admits`
 * a consumer could write was "the entity still exists". Navigation can do better: a bridge that
 * dropped, a door that closed, a region that streamed out all make a destination unreachable
 * between the moment a model chose it and the moment the agent acts on it. `navigate@1` runs the
 * search in its guard and the intent is discarded, with the policy floor covering — which is what
 * the package already promises for every other kind of stale proposal.
 *
 * **What the engine owns here is the graph and the search; what it does not own is the agent.**
 * `tools/registry.ts` says a guard is "the consumer's sentence, written against the consumer's
 * world", and that stays true: the three functions of `NavigationAdapter` are the consumer's, and
 * everything above them is this file's. A tool that knew which entity was which, or how an agent
 * moves, would be a particular game's engine.
 *
 * ## What it costs
 *
 * **Three searches per navigation intent that is accepted and applied**, and the third was a
 * correction: this header said two until the demo was wired and the real path counted. `take` runs
 * the guard when the buffered intent drains, `applyCommand` runs it **again** on the way in — which
 * `apply.ts` argues for at length, because those are two different moments and a snapshot is never
 * authority — and `execute` runs a third.
 *
 * Caching a route between any two of them would key it on nothing stable, since the world changing
 * between them is the entire reason the guard exists. A guard that trusted the previous answer
 * would be the guard `apply.ts` refuses to be.
 *
 * `nearestNavNode` is a linear scan over `nodeCount`, and both endpoints need one, so a navigation
 * intent is `O(nodes)` six times plus three A*. At the sizes these graphs are built at that is tens
 * of microseconds against an intent that happens on the order of once a second per agent. It is
 * written down here so a consumer profiling a thousand agents knows where to look rather than
 * discovering it.
 */

import { NavSearch, nearestNavNode } from '@driftengine/core';
import type { NavGraph, NavPath } from '@driftengine/core';
import type { ToolDefinition } from '../tools/registry.ts';

/** What the consumer answers, because only the consumer knows what an agent is. */
export interface NavigationAdapter<W> {
  /** The graph this agent navigates. A world may have several. Null means it cannot navigate. */
  graphOf(world: W, agentId: string): NavGraph | null;
  /** Where the agent is now, written into `out` as x, y, z. False when the agent is gone. */
  positionOf(world: W, agentId: string, out: Float32Array): boolean;
  /**
   * The route object this agent follows.
   *
   * The consumer's and not the bridge's, deliberately: they already own its lifetime, its capacity
   * and its steering options, and a second one owned here would be a second answer to where the
   * agent is going.
   */
  pathOf(world: W, agentId: string): NavPath | null;
}

export interface NavigationBridgeOptions {
  /**
   * How far a destination may be from the nearest graph node and still count as that node.
   *
   * Infinite by default, which snaps to the nearest node however far away it is. A consumer with a
   * sparse graph over a large world wants a real number here: without one, "go to the roof" routes
   * to the nearest node on the ground and the agent walks confidently to the wrong place.
   */
  readonly snapDistance?: number;
  /** Longest route the bridge will hold, in nodes. */
  readonly maxNodes?: number;
}

export interface NavigateArgs {
  readonly agentId: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface NavigateResult {
  readonly found: boolean;
  /** Nodes in the route, or 0. */
  readonly nodes: number;
  /**
   * Route length in metres, or 0.
   *
   * Here because `Intent.expectedExtentMs` drives the continuation watermark, and a navigation
   * intent is the one case where the engine knows the extent better than the policy that proposed
   * it: a caller with a speed can turn this into a time. Ignoring it costs nothing.
   */
  readonly lengthM: number;
}

const NO_ROUTE: NavigateResult = { found: false, nodes: 0, lengthM: 0 };

/**
 * Build the navigation tools for a consumer's world.
 *
 * Named `navigationBridge` deliberately: `docs/CAPABILITIES.md` carries a sentinel matching this
 * symbol, so the day this file exists the documentation gate fails and the row that calls this
 * capability absent has to be rewritten. A bridge named something else would have landed the
 * capability and left the guard quiet, which is worse than the stale prose it replaces.
 */
export function navigationBridge<W>(
  adapter: NavigationAdapter<W>,
  options: NavigationBridgeOptions = {},
): readonly ToolDefinition<NavigateArgs, NavigateResult, W>[] {
  const snap = options.snapDistance ?? Infinity;
  const maxNodes = Math.max(2, options.maxNodes ?? 512);

  /*
   * One scratch route and one search per graph, reused across every call.
   *
   * `NavSearch` allocates five arrays sized by the graph, so building one per intent would be an
   * allocation proportional to the world on a path the fixed step reaches. Keyed by graph because a
   * world may have several and a search is bound to the one it was built for.
   */
  const route = new Uint32Array(maxNodes);
  const here = new Float32Array(3);
  const searches = new WeakMap<NavGraph, NavSearch>();

  const searchFor = (graph: NavGraph): NavSearch => {
    let search = searches.get(graph);
    if (search === undefined) {
      search = new NavSearch(graph);
      searches.set(graph, search);
    }
    return search;
  };

  /**
   * The route this request would produce, or 0 nodes.
   *
   * Shared by the guard and the action so they cannot disagree about what "reachable" means. They
   * each call it once, which is the two searches the header prices.
   */
  const solve = (world: W, args: NavigateArgs): { graph: NavGraph; count: number } | null => {
    const graph = adapter.graphOf(world, args.agentId);
    if (graph === null) return null;
    if (!adapter.positionOf(world, args.agentId, here)) return null;

    const from = nearestNavNode(graph, here[0] ?? 0, here[1] ?? 0, here[2] ?? 0, snap);
    if (from < 0) return null;
    const to = nearestNavNode(graph, args.x, args.y, args.z, snap);
    if (to < 0) return null;

    return { graph, count: searchFor(graph).find(from, to, route) };
  };

  const navigate: ToolDefinition<NavigateArgs, NavigateResult, W> = {
    id: 'navigate@1',
    description:
      'Move an agent to a world position along the navigation graph. Fails when no route exists.',
    schema: {
      kind: 'object',
      fields: {
        agentId: { kind: 'string' },
        x: { kind: 'number' },
        y: { kind: 'number' },
        z: { kind: 'number' },
      },
    },
    /*
     * **Not idempotent, and the distinction is not pedantic.** Calling it twice re-runs the search
     * against wherever the agent has moved to, which is a different route from the same arguments.
     */
    idempotent: false,
    rateClass: 'navigation',

    admits(args: NavigateArgs, world: W): boolean {
      const solved = solve(world, args);
      return solved !== null && solved.count > 1;
    },

    execute(args: NavigateArgs, world: W): NavigateResult {
      const path = adapter.pathOf(world, args.agentId);
      if (path === null) return NO_ROUTE;
      const solved = solve(world, args);
      if (solved === null || solved.count < 2) {
        /*
         * Cleared rather than left alone. A failed navigate that leaves the previous route in place
         * is an agent that keeps walking to somewhere nobody asked for any more, which reads as the
         * tool having worked.
         */
        path.clear();
        return NO_ROUTE;
      }
      path.set(route, solved.count);
      return { found: true, nodes: solved.count, lengthM: path.lengthM };
    },
  };

  return [navigate];
}

/**
 * Whether a route exists for this agent right now, without writing one.
 *
 * The guard, as a question. `navigate@1` answers it as a side effect of doing the thing, so a
 * caller wanting to *ask* had to route and then undo. `drift/ai.reachable` is this, and so is any
 * consumer's own policy that wants to score a destination before proposing it.
 */
export function reachableBy<W>(
  tools: readonly ToolDefinition<NavigateArgs, NavigateResult, W>[],
  args: NavigateArgs,
  world: W,
): boolean {
  const navigate = tools.find((tool) => tool.id === 'navigate@1');
  return navigate !== undefined && navigate.admits(args, world);
}
