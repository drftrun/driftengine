import type { NavGraph } from './navGraph.ts';

/**
 * Following a route, which is the half of navigation that is not the search.
 *
 * **A path is a list of nodes and an agent is not.** Between the two sits a set of decisions every
 * consumer makes and none of them enjoys: when has a waypoint been reached, what happens when the
 * agent is pushed off the line, what does the last waypoint mean, and — the one that is always got
 * wrong first — what do you steer *at*. Steering at the next node makes an agent visibly zigzag
 * between waypoints on a curved road; steering at a point a fixed distance ahead *along* the path
 * makes it cut the corner smoothly, and that is what this returns.
 *
 * **It does not move anything.** It answers where to aim, in world units, and the caller applies
 * their own speed, acceleration, turn rate and physics — which is the same boundary
 * `CharacterController` and `groundMotor` draw, and for the same reason: how a thing moves is the
 * game's, where it should go is the engine's.
 *
 * Nothing here allocates and nothing reads a clock.
 */
export interface NavSteer {
  /** Where to aim, in world units. */
  x: number;
  y: number;
  z: number;
  /** How far along the path is left, following the line rather than as the crow flies. */
  remainingM: number;
  /** True once the agent is within `arriveM` of the final node. */
  arrived: boolean;
}

export function createNavSteer(): NavSteer {
  return { x: 0, y: 0, z: 0, remainingM: 0, arrived: false };
}

export interface NavPathOptions {
  /**
   * How far ahead along the path to aim, metres.
   *
   * **The one number that decides whether following looks like driving or like a wind-up toy.**
   * Short and the agent snaps at each waypoint in turn; long and it cuts corners so hard it leaves
   * the road. A useful value is a little more than the agent's turning radius, and the default of
   * two metres suits somebody walking.
   */
  readonly lookaheadM?: number;
  /** Within this of the last node, the agent has arrived. Default half a metre. */
  readonly arriveM?: number;
}

/**
 * A route being walked: the nodes, and how far along them the agent is.
 *
 * **Progress is a distance along the path, not an index into it**, and that is what makes this
 * survive an agent being shoved. An index only ever counts up when a waypoint is reached, so an
 * agent knocked backwards past one keeps aiming at the waypoint behind it; a distance is recovered
 * from the agent's own position every update, against the segment it is nearest to, so being pushed
 * about costs progress and never correctness.
 */
export class NavPath {
  private readonly graph: NavGraph;
  private readonly lookaheadM: number;
  private readonly arriveM: number;
  /** Node indices of the route, and how many are live. */
  private readonly nodes: Uint32Array;
  private length = 0;
  /** Cumulative distance to the start of each segment, so a lookahead is a lookup. */
  private readonly distanceTo: Float64Array;
  private total = 0;
  /** Which segment the agent was on last update: where the search for the nearest one starts. */
  private segment = 0;

  constructor(graph: NavGraph, capacity: number, options: NavPathOptions = {}) {
    if (!(capacity > 1)) throw new Error(`NavPath: capacity must be at least 2, got ${capacity}`);
    this.graph = graph;
    this.nodes = new Uint32Array(capacity);
    this.distanceTo = new Float64Array(capacity);
    this.lookaheadM = options.lookaheadM ?? 2;
    this.arriveM = options.arriveM ?? 0.5;
  }

  get nodeCount(): number {
    return this.length;
  }

  get lengthM(): number {
    return this.total;
  }

  /** Whether there is a route to follow at all. */
  get active(): boolean {
    return this.length > 1;
  }

  /**
   * Take a route, as `NavSearch.find` filled it.
   *
   * A route of one node is a route to where the agent already is, and is stored as no route: it
   * has no direction to steer along and every caller would otherwise have to special-case it.
   */
  set(path: Uint32Array, count: number): void {
    this.length = 0;
    this.total = 0;
    this.segment = 0;
    if (count < 2) return;
    const usable = Math.min(count, this.nodes.length);
    this.nodes.set(path.subarray(0, usable));
    this.length = usable;
    this.distanceTo[0] = 0;
    for (let i = 1; i < usable; i++) {
      this.total += this.span(i - 1, i);
      this.distanceTo[i] = this.total;
    }
  }

  clear(): void {
    this.length = 0;
    this.total = 0;
    this.segment = 0;
  }

  /**
   * Where an agent at `(x, y, z)` should aim next.
   *
   * With no route, the agent is told to aim where it stands and that it has arrived, so a caller
   * driving off `arrived` needs no separate check for having no path at all.
   */
  steer(x: number, y: number, z: number, out: NavSteer): void {
    if (this.length < 2) {
      out.x = x;
      out.y = y;
      out.z = z;
      out.remainingM = 0;
      out.arrived = true;
      return;
    }

    /*
     * Where the agent is, as a distance along the route. Searched over the whole path rather than
     * forward from the last segment: an agent carried backwards — a lift, a shove, a vehicle it
     * was standing on — is exactly the case a forward-only scan gets wrong, and a route is tens of
     * nodes rather than thousands.
     */
    let bestSquared = Infinity;
    let travelled = 0;
    for (let i = 0; i + 1 < this.length; i++) {
      const along = this.project(i, x, y, z);
      const squared = this.distanceSquaredTo(i, along, x, y, z);
      if (squared < bestSquared) {
        bestSquared = squared;
        travelled = (this.distanceTo[i] ?? 0) + along;
        this.segment = i;
      }
    }

    const remaining = this.total - travelled;
    out.remainingM = remaining > 0 ? remaining : 0;
    out.arrived = remaining <= this.arriveM;
    /* Aim ahead along the line, clamped to the end: near the goal the target is the goal, which is
       what stops an agent overshooting it to satisfy a lookahead. */
    this.pointAt(Math.min(travelled + this.lookaheadM, this.total), out);
  }

  /** How far along segment `i` the point `(x, y, z)` projects, clamped to the segment. */
  private project(i: number, x: number, y: number, z: number): number {
    const ax = this.px(i);
    const ay = this.py(i);
    const az = this.pz(i);
    const dx = this.px(i + 1) - ax;
    const dy = this.py(i + 1) - ay;
    const dz = this.pz(i + 1) - az;
    const lengthSquared = dx * dx + dy * dy + dz * dz;
    if (lengthSquared === 0) return 0;
    let t = ((x - ax) * dx + (y - ay) * dy + (z - az) * dz) / lengthSquared;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
    return t * Math.sqrt(lengthSquared);
  }

  private distanceSquaredTo(i: number, along: number, x: number, y: number, z: number): number {
    const span = this.span(i, i + 1);
    const t = span === 0 ? 0 : along / span;
    const dx = this.px(i) + (this.px(i + 1) - this.px(i)) * t - x;
    const dy = this.py(i) + (this.py(i + 1) - this.py(i)) * t - y;
    const dz = this.pz(i) + (this.pz(i + 1) - this.pz(i)) * t - z;
    return dx * dx + dy * dy + dz * dz;
  }

  /** The world point a given distance along the route. */
  private pointAt(distance: number, out: NavSteer): void {
    let i = this.segment;
    while (i + 2 < this.length && (this.distanceTo[i + 1] ?? 0) < distance) i++;
    const base = this.distanceTo[i] ?? 0;
    const span = this.span(i, i + 1);
    const t = span === 0 ? 0 : Math.min(1, Math.max(0, (distance - base) / span));
    out.x = this.px(i) + (this.px(i + 1) - this.px(i)) * t;
    out.y = this.py(i) + (this.py(i + 1) - this.py(i)) * t;
    out.z = this.pz(i) + (this.pz(i + 1) - this.pz(i)) * t;
  }

  private span(a: number, b: number): number {
    const dx = this.px(b) - this.px(a);
    const dy = this.py(b) - this.py(a);
    const dz = this.pz(b) - this.pz(a);
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  private px(i: number): number {
    return this.graph.positions[(this.nodes[i] ?? 0) * 3] ?? 0;
  }

  private py(i: number): number {
    return this.graph.positions[(this.nodes[i] ?? 0) * 3 + 1] ?? 0;
  }

  private pz(i: number): number {
    return this.graph.positions[(this.nodes[i] ?? 0) * 3 + 2] ?? 0;
  }
}
