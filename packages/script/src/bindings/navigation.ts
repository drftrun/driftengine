import { NavPath, NavSearch, createNavSteer, nearestNavNode } from '@driftengine/core';
import type { NavGraph, NavSteer } from '@driftengine/core';
import { type Entity, entityGeneration, entityIndex } from '@driftengine/entities';
import type { CapabilityDefinition, OpaqueType } from 'driftscript';
import { defineCapability } from 'driftscript';

export const NAVIGATION_MODULE = 'drift/navigation';

/**
 * `drift/navigation` — a graph, a route over it, and a point to steer at.
 *
 * **The linker has refused this module by name since the language shipped**, and the reason given
 * was that nothing here paths. That was true and it was never a blocker: it was the row. A consumer
 * reported what its absence costs them — twelve agents that walk straight at whatever they are
 * going to and wedge against a building on the way, about once every two minutes of play — and
 * noted that they already extract a road graph from their world, which is the half of the work that
 * is usually the awkward half.
 *
 * **A graph and not a mesh**, and the header of `navGraph.ts` argues that where the decision is:
 * these consumers arrive with a network already, and open ground crossed by two nodes is crossed in
 * a straight line.
 *
 * **`navigation.read` is a deterministic effect**, which the language decided before this existed
 * and this has to keep true: a route is a function of the graph and its two endpoints and of
 * nothing else, ties included. `navSearch.ts` is where that is held. A `@deterministic` system may
 * therefore path, which is the point — deciding where to walk is exactly the kind of thing that
 * belongs inside the fixed step.
 */
export const NAVIGATION_TYPES: readonly OpaqueType[] = [
  {
    module: NAVIGATION_MODULE,
    name: 'NavGraph',
    doc: 'A network of places and the ways between them.',
  },
  {
    module: NAVIGATION_MODULE,
    name: 'NavPath',
    doc: 'A route being walked, and how far along it the walker is. Ask it where to steer.',
  },
];

const define = (
  name: string,
  params: readonly { name: string; type: string }[],
  returns: string,
  effects: readonly string[],
  doc: string,
  deterministic = true,
  allocates = false,
): CapabilityDefinition =>
  defineCapability({
    module: NAVIGATION_MODULE,
    name,
    signature: `fn(${params.map((p) => `${p.name}: ${p.type}`).join(', ')}) -> ${returns}`,
    params: [...params],
    returns,
    ...(allocates ? { allocates: true } : {}),
    effects: effects as CapabilityDefinition['effects'],
    /*
     * **Writing a route is deterministic too, as of DriftScript 1.12.0**, and this paragraph used
     * to say the opposite. `navigation.read` was in `DETERMINISTIC_EFFECTS` and `navigation.write`
     * was not, so a `@deterministic` system could steer along a route and could not compute one —
     * an agent re-pathing inside the fixed step, because a bridge dropped or because it was pushed
     * off the network, had to path from an ordinary system and hand the result in.
     *
     * **It reversed on exactly the argument this comment named**, which is the whole reason the
     * condition was written down rather than the limitation merely stated: a route is a function of
     * the graph and two endpoints, `navSearch.ts` breaks ties on the node index so two runs agree,
     * and the `NavPath` written into is simulation state rather than a host's. The language's own
     * deferral said the track that builds an effect is the one that can answer for its replay
     * behaviour; this track shipped, so it answered.
     *
     * Every capability here is deterministic now, so the parameter keeps its default and the three
     * writers stopped passing `false`.
     */
    deterministic,
    doc,
    implementation: `${NAVIGATION_MODULE}.${name}`,
  });

export const NAVIGATION_CAPABILITIES: readonly CapabilityDefinition[] = [
  define(
    'nearest',
    [
      { name: 'graph', type: 'NavGraph' },
      { name: 'x', type: 'float' },
      { name: 'y', type: 'float' },
      { name: 'z', type: 'float' },
    ],
    'i32',
    ['navigation.read'],
    'The node nearest a place, or -1 where the graph has none. How an agent gets onto the network.',
  ),
  define(
    'nearestWithin',
    [
      { name: 'graph', type: 'NavGraph' },
      { name: 'x', type: 'float' },
      { name: 'y', type: 'float' },
      { name: 'z', type: 'float' },
      { name: 'maxDistance', type: 'float' },
    ],
    'i32',
    ['navigation.read'],
    'The nearest node within a distance, or -1. Use it so an agent that has walked off the network is not snapped to the far side of the map.',
  ),
  /*
   * **`route` takes places and not node indices**, which is the whole difference between a binding
   * a script author can use and one they have to learn a data model for first. Getting onto a graph
   * is `nearest` twice, and a script that had to write that would write it identically every time
   * and get the out-of-reach case wrong once.
   */
  define(
    'route',
    [
      { name: 'path', type: 'NavPath' },
      { name: 'graph', type: 'NavGraph' },
      { name: 'fromX', type: 'float' },
      { name: 'fromY', type: 'float' },
      { name: 'fromZ', type: 'float' },
      { name: 'toX', type: 'float' },
      { name: 'toY', type: 'float' },
      { name: 'toZ', type: 'float' },
    ],
    'bool',
    ['navigation.write'],
    'Path from one place to another, storing the route. False where there is no way through, which is an answer and not a failure.',
  ),
  define(
    'routeBetween',
    [
      { name: 'path', type: 'NavPath' },
      { name: 'graph', type: 'NavGraph' },
      { name: 'from', type: 'i32' },
      { name: 'to', type: 'i32' },
    ],
    'bool',
    ['navigation.write'],
    'The same, between two nodes you already have. For a consumer with their own spatial index.',
  ),
  /*
   * **A route per agent, because a script had nowhere to keep one.**
   *
   * Every capability above takes a `NavPath` and nothing here made one, so a consumer kept a path
   * per agent in TypeScript and called a script function once per agent per step — which is the
   * report DriftScript 1.8.0's `uses` clause answers half of. `uses` hands a system the *graph*, one
   * per world; a route is one per walker, and a resource is one per type, so the other half has to
   * arrive as a value a script can ask for by entity. This is it, and with it the loop over agents
   * goes back into the `system` where it can be reloaded.
   *
   * **Kept per entity *index*, with the generation beside it.** A map keyed by the handle would grow
   * for the life of the world — every agent that ever pathed, long after it was destroyed, with no
   * moment at which anything could know to drop one. An index is bounded by the world's ceiling, and
   * a reused index arriving with a different generation is a different agent, so the route is
   * cleared rather than inherited. That is the failure worth naming: without the check a freshly
   * spawned walker would set off along the route of whatever died in its slot.
   *
   * **It allocates the first time it is asked about an agent** and never again, which `allocates`
   * says so a `@hot` function is told. There is no way around it — a route is a buffer — and the
   * alternative, making a script pass its own, is the thing this exists to remove.
   */
  define(
    'path',
    [{ name: 'agent', type: 'Entity' }],
    'NavPath',
    ['navigation.read'],
    "The route this agent is following, kept by the host between steps. Empty until something routes it, and empty again if the agent's handle is reused.",
    true,
    true,
  ),
  define(
    'clear',
    [{ name: 'path', type: 'NavPath' }],
    'void',
    ['navigation.write'],
    'Forget the route. The walker is then arrived, wherever it is.',
  ),
  define(
    'following',
    [{ name: 'path', type: 'NavPath' }],
    'bool',
    ['navigation.read'],
    'Whether there is a route to follow.',
  ),
  /*
   * **The steer is read back through four accessors**, which is the shape `input.axisX` and
   * `animation.hitX` already have and the reason is the same: the language has no way to return a
   * record by value into a caller's own storage, and an opaque handle for a three-float answer
   * would be a lifetime a script author has to think about to read a direction.
   *
   * The implementation answers all four from one computation — see `navigationImplementation`,
   * where the reason it can is that the arguments say what the answer depends on.
   */
  define(
    'steerX',
    [
      { name: 'path', type: 'NavPath' },
      { name: 'x', type: 'float' },
      { name: 'y', type: 'float' },
      { name: 'z', type: 'float' },
    ],
    'float',
    ['navigation.read'],
    'Where a walker at this place should aim, along x. A point ahead on the path rather than the next node, so corners are cut smoothly instead of snapped at.',
  ),
  define(
    'steerY',
    [
      { name: 'path', type: 'NavPath' },
      { name: 'x', type: 'float' },
      { name: 'y', type: 'float' },
      { name: 'z', type: 'float' },
    ],
    'float',
    ['navigation.read'],
    'The same aim point, along y.',
  ),
  define(
    'steerZ',
    [
      { name: 'path', type: 'NavPath' },
      { name: 'x', type: 'float' },
      { name: 'y', type: 'float' },
      { name: 'z', type: 'float' },
    ],
    'float',
    ['navigation.read'],
    'The same aim point, along z.',
  ),
  define(
    'remaining',
    [
      { name: 'path', type: 'NavPath' },
      { name: 'x', type: 'float' },
      { name: 'y', type: 'float' },
      { name: 'z', type: 'float' },
    ],
    'float',
    ['navigation.read'],
    'How far is left, following the path rather than as the crow flies.',
  ),
  define(
    'arrived',
    [
      { name: 'path', type: 'NavPath' },
      { name: 'x', type: 'float' },
      { name: 'y', type: 'float' },
      { name: 'z', type: 'float' },
    ],
    'bool',
    ['navigation.read'],
    'Whether the walker is there. True with no route at all, so one check covers both.',
  ),
];

/** What a consumer hands the host so scripts can path over their world. */
export interface NavigationServices {
  /** The network. One graph; a consumer with several composes them into one before handing it over. */
  readonly graph: NavGraph;
  /** A search over that graph, reused across every agent. */
  readonly search: NavSearch;
  /** How many nodes a route may have. Longer routes are refused rather than truncated. */
  readonly maxRouteNodes?: number;
}

export function navigationImplementation(services: NavigationServices): Record<string, unknown> {
  const buffer = new Uint32Array(services.maxRouteNodes ?? 256);
  const steer: NavSteer = createNavSteer();
  /*
   * The last place a steer was computed for, so `steerX`, `steerY`, `steerZ`, `remaining` and
   * `arrived` at one position cost one walk of the path rather than five. Correct rather than
   * merely fast: the answer is a function of the path and the place, and the path cannot change
   * between two reads inside a script's own statement.
   */
  let cachedPath: NavPath | null = null;
  let cachedX = NaN;
  let cachedY = NaN;
  let cachedZ = NaN;

  /*
   * One route per agent, by entity **index**, with the generation beside it.
   *
   * Two sparse arrays rather than a `Map` keyed by the handle: a map grows for the life of the
   * world, one entry per agent that ever pathed, and nothing is in a position to know when to drop
   * one. An index is bounded by the world's ceiling. The generation is what makes a reused index
   * safe — a slot arriving with a different one is a different agent, and its route is cleared
   * rather than inherited, which would otherwise send a freshly spawned walker off along the route
   * of whatever died in its place.
   */
  const routes: (NavPath | undefined)[] = [];
  const owners: number[] = [];

  const at = (path: NavPath, x: number, y: number, z: number): NavSteer => {
    if (path !== cachedPath || x !== cachedX || y !== cachedY || z !== cachedZ) {
      path.steer(x, y, z, steer);
      cachedPath = path;
      cachedX = x;
      cachedY = y;
      cachedZ = z;
    }
    return steer;
  };
  /** Any write to a path invalidates the cache, since the answer depends on the route. */
  const invalidate = (): void => {
    cachedPath = null;
  };

  return {
    path(agent: Entity): NavPath {
      const index = entityIndex(agent);
      const generation = entityGeneration(agent);
      let route = routes[index];
      if (route === undefined) {
        route = new NavPath(services.graph, services.maxRouteNodes ?? 256);
        routes[index] = route;
      } else if (owners[index] !== generation) {
        /* The slot was somebody else's. Clearing rather than replacing keeps the allocation this
           agent is about to need and leaves nothing of the last one's route. */
        route.clear();
        invalidate();
      }
      owners[index] = generation;
      return route;
    },
    nearest: (graph: NavGraph, x: number, y: number, z: number) => nearestNavNode(graph, x, y, z),
    nearestWithin: (graph: NavGraph, x: number, y: number, z: number, maxDistance: number) =>
      nearestNavNode(graph, x, y, z, maxDistance),
    route(
      path: NavPath,
      graph: NavGraph,
      fromX: number,
      fromY: number,
      fromZ: number,
      toX: number,
      toY: number,
      toZ: number,
    ): boolean {
      invalidate();
      const from = nearestNavNode(graph, fromX, fromY, fromZ);
      const to = nearestNavNode(graph, toX, toY, toZ);
      if (from < 0 || to < 0) {
        path.clear();
        return false;
      }
      const count = services.search.find(from, to, buffer);
      path.set(buffer, count);
      return count > 1;
    },
    routeBetween(path: NavPath, graph: NavGraph, from: number, to: number): boolean {
      invalidate();
      void graph;
      const count = services.search.find(from, to, buffer);
      path.set(buffer, count);
      return count > 1;
    },
    clear(path: NavPath): void {
      invalidate();
      path.clear();
    },
    following: (path: NavPath) => path.active,
    steerX: (path: NavPath, x: number, y: number, z: number) => at(path, x, y, z).x,
    steerY: (path: NavPath, x: number, y: number, z: number) => at(path, x, y, z).y,
    steerZ: (path: NavPath, x: number, y: number, z: number) => at(path, x, y, z).z,
    remaining: (path: NavPath, x: number, y: number, z: number) => at(path, x, y, z).remainingM,
    arrived: (path: NavPath, x: number, y: number, z: number) => at(path, x, y, z).arrived,
  };
}
