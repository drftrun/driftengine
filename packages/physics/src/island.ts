import { BODY_DYNAMIC } from './bodies.ts';
import type { BodySet } from './bodies.ts';
import type { JointSet } from './joints.ts';
import type { ContactConstraints } from './solver.ts';

/**
 * Connected components of the contact graph, and the sleeping that rides on them.
 *
 * **Only dynamic bodies join islands.** A static floor touches everything standing on it, so
 * letting it merge would make one island of the whole world and nothing would ever sleep. That is
 * not an optimisation: it is what an island *means*, and it is why two towers on one floor are two.
 *
 * **A body with no contacts is a singleton island**, so every dynamic body belongs to exactly one
 * and the executor can own the whole substep loop for it rather than integration being a separate
 * global pass. That is the shape a worker pool needs.
 *
 * **Islands are ordered by their lowest body index, and bodies within one by index.** That comes
 * from the *ascending scan* below, which numbers an island the first time it meets a member — not
 * from union-find's root choice, which is why swapping the root to the larger index changes no
 * result and no test catches it. Keeping the smaller one is convention and shortens paths a little;
 * nothing depends on it. Nothing here iterates a `Map` or a `Set`.
 */

export class IslandSet {
  /** How many islands the last build found. */
  count = 0;
  /** Constraint indices grouped by island. */
  constraintOrder: Int32Array;
  /** Offsets into `constraintOrder`, length `count + 1`. */
  constraintStart: Int32Array;
  /** Dynamic body indices grouped by island. */
  bodyOrder: Int32Array;
  /** Offsets into `bodyOrder`, length `count + 1`. */
  bodyStart: Int32Array;
  /** Which island a body is in, or −1 for a body that is not dynamic. */
  islandOf: Int32Array;

  private parent: Int32Array;
  private islandIndex: Int32Array;

  constructor(capacity = 64) {
    this.constraintOrder = new Int32Array(capacity);
    this.constraintStart = new Int32Array(capacity + 1);
    this.bodyOrder = new Int32Array(capacity);
    this.bodyStart = new Int32Array(capacity + 1);
    this.islandOf = new Int32Array(capacity);
    this.parent = new Int32Array(capacity);
    this.islandIndex = new Int32Array(capacity);
  }

  /** Joint indices grouped by island. */
  jointOrder: Int32Array = new Int32Array(32);
  /** Offsets into `jointOrder`, length `count + 1`. */
  jointStart: Int32Array = new Int32Array(33);

  build(bodies: BodySet, c: ContactConstraints, joints: JointSet): number {
    const n = bodies.count;
    this.ensureBodies(n);
    this.ensureConstraints(c.count);

    for (let i = 0; i < n; i++) this.parent[i] = i;
    for (let k = 0; k < c.count; k++) {
      const a = c.bodyA[k] ?? 0;
      const b = c.bodyB[k] ?? 0;
      if (bodies.type[a] !== BODY_DYNAMIC || bodies.type[b] !== BODY_DYNAMIC) continue;
      this.union(a, b);
    }
    /*
     * A joint is an edge in the same graph a contact is. Two bodies held together would otherwise
     * sleep independently and be woken independently, and a jointed pair whose halves disagree
     * about being asleep pulls apart.
     */
    for (let k = 0; k < joints.count; k++) {
      if (joints.broken[k]) continue;
      const a = joints.bodyA[k] ?? 0;
      const b = joints.bodyB[k] ?? 0;
      if (bodies.type[a] !== BODY_DYNAMIC || bodies.type[b] !== BODY_DYNAMIC) continue;
      this.union(a, b);
    }

    // Roots in ascending order become islands 0, 1, 2 …, so ordering follows body index.
    let islands = 0;
    for (let i = 0; i < n; i++) {
      this.islandOf[i] = -1;
      this.islandIndex[i] = -1;
    }
    for (let i = 0; i < n; i++) {
      if (bodies.type[i] !== BODY_DYNAMIC) continue;
      const root = this.find(i);
      if (this.islandIndex[root] < 0) this.islandIndex[root] = islands++;
      this.islandOf[i] = this.islandIndex[root] ?? -1;
    }
    this.count = islands;
    if (islands + 1 > this.bodyStart.length) {
      this.bodyStart = new Int32Array(islands + 1);
      this.constraintStart = new Int32Array(islands + 1);
    }

    // Counting sort of bodies into islands: count, prefix, place.
    this.bodyStart.fill(0);
    for (let i = 0; i < n; i++) {
      const island = this.islandOf[i] ?? -1;
      if (island >= 0) this.bodyStart[island + 1]++;
    }
    for (let i = 0; i < islands; i++) {
      this.bodyStart[i + 1] = (this.bodyStart[i + 1] ?? 0) + (this.bodyStart[i] ?? 0);
    }
    const bodyAt = new Int32Array(islands);
    for (let i = 0; i < n; i++) {
      const island = this.islandOf[i] ?? -1;
      if (island < 0) continue;
      this.bodyOrder[(this.bodyStart[island] ?? 0) + (bodyAt[island] ?? 0)] = i;
      bodyAt[island]++;
    }

    // And of constraints, by whichever of their bodies is dynamic.
    this.constraintStart.fill(0);
    for (let k = 0; k < c.count; k++) {
      const island = this.islandOfConstraint(bodies, c, k);
      if (island >= 0) this.constraintStart[island + 1]++;
    }
    for (let i = 0; i < islands; i++) {
      this.constraintStart[i + 1] =
        (this.constraintStart[i + 1] ?? 0) + (this.constraintStart[i] ?? 0);
    }
    const conAt = new Int32Array(islands);
    for (let k = 0; k < c.count; k++) {
      const island = this.islandOfConstraint(bodies, c, k);
      if (island < 0) continue;
      this.constraintOrder[(this.constraintStart[island] ?? 0) + (conAt[island] ?? 0)] = k;
      conAt[island]++;
    }
    // And of joints, the same way.
    if (islands + 1 > this.jointStart.length) this.jointStart = new Int32Array(islands + 1);
    if (joints.count > this.jointOrder.length) {
      let size = this.jointOrder.length || 1;
      while (size < joints.count) size *= 2;
      this.jointOrder = new Int32Array(size);
    }
    this.jointStart.fill(0);
    for (let k = 0; k < joints.count; k++) {
      const island = this.islandOfJoint(bodies, joints, k);
      if (island >= 0) this.jointStart[island + 1]++;
    }
    for (let i = 0; i < islands; i++) {
      this.jointStart[i + 1] = (this.jointStart[i + 1] ?? 0) + (this.jointStart[i] ?? 0);
    }
    const jointAt = new Int32Array(islands);
    for (let k = 0; k < joints.count; k++) {
      const island = this.islandOfJoint(bodies, joints, k);
      if (island < 0) continue;
      this.jointOrder[(this.jointStart[island] ?? 0) + (jointAt[island] ?? 0)] = k;
      jointAt[island]++;
    }
    return islands;
  }

  private islandOfJoint(bodies: BodySet, joints: JointSet, k: number): number {
    if (joints.broken[k]) return -1;
    const a = joints.bodyA[k] ?? 0;
    const b = joints.bodyB[k] ?? 0;
    if (bodies.type[a] === BODY_DYNAMIC) return this.islandOf[a] ?? -1;
    if (bodies.type[b] === BODY_DYNAMIC) return this.islandOf[b] ?? -1;
    return -1;
  }

  private islandOfConstraint(bodies: BodySet, c: ContactConstraints, k: number): number {
    const a = c.bodyA[k] ?? 0;
    const b = c.bodyB[k] ?? 0;
    if (bodies.type[a] === BODY_DYNAMIC) return this.islandOf[a] ?? -1;
    if (bodies.type[b] === BODY_DYNAMIC) return this.islandOf[b] ?? -1;
    return -1;
  }

  /**
   * The smaller index wins, which shortens paths slightly and is otherwise arbitrary.
   *
   * **It is not what orders islands** — the ascending scan in `build` is. Said here because the
   * version of this comment that claimed otherwise sent a reader looking for a property the code
   * does not have and does not need.
   */
  private union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return;
    if (ra < rb) this.parent[rb] = ra;
    else this.parent[ra] = rb;
  }

  private find(i: number): number {
    let root = i;
    while ((this.parent[root] ?? root) !== root) root = this.parent[root] ?? root;
    // Path compression, so a long chain is walked once.
    let at = i;
    while ((this.parent[at] ?? at) !== at) {
      const next = this.parent[at] ?? at;
      this.parent[at] = root;
      at = next;
    }
    return root;
  }

  private ensureBodies(n: number): void {
    if (n <= this.parent.length) return;
    let size = this.parent.length || 1;
    while (size < n) size *= 2;
    this.parent = new Int32Array(size);
    this.islandOf = new Int32Array(size);
    this.islandIndex = new Int32Array(size);
    this.bodyOrder = new Int32Array(size);
  }

  private ensureConstraints(n: number): void {
    if (n <= this.constraintOrder.length) return;
    let size = this.constraintOrder.length || 1;
    while (size < n) size *= 2;
    this.constraintOrder = new Int32Array(size);
  }
}
