import { mat4, quat } from 'gl-matrix';

import { createBounds } from '../math/bounds.ts';
import type { Bounds } from '../math/bounds.ts';

/**
 * A transform with a parent, and the world matrix it derives.
 *
 * **Additive and never required.** Three consumers describe their worlds their own way and none of
 * them has to adopt this; nothing in the renderer knows a node exists. What it offers is the one
 * thing an immediate-mode API makes a caller repeat — composing a child's placement out of its
 * parent's — done once, and done only for what moved.
 *
 * **It does not draw, and that is deliberate rather than unfinished.** The render graph work
 * established that a caller's draw order carries meaning: alpha and depth make *after* different
 * from *before*, and it is why a registered pass runs where a caller invokes it rather than at a
 * phase the engine picks. A traversal that issued draws would take that back. `visitVisible`
 * yields nodes; what to do with one is the caller's.
 */

/** Bumped on every world recomputation, so a caller can tell whether anything happened. */
let revisions = 0;

export class SceneNode {
  /** Local translation. Written in place; call `markMoved` if you write it directly. */
  readonly position = new Float32Array([0, 0, 0]);
  /**
   * Local rotation, as a quaternion.
   *
   * **A quaternion and not the yaw this engine uses everywhere else.** Every rotation in the tree
   * today is a yaw or a matrix, because nothing has needed to *interpolate* one — and a node is
   * what animation will hold, where "rigid TRS, then skinning" is the first line of that track.
   * Interpolating Euler angles gives gimbal artefacts and a path through orientations nobody
   * authored, and carrying the right type from the start is cheaper than migrating every node a
   * consumer has built.
   */
  readonly rotation = new Float32Array([0, 0, 0, 1]);
  readonly scale = new Float32Array([1, 1, 1]);

  readonly localMatrix = new Float32Array(16);
  readonly worldMatrix = new Float32Array(16);

  parent: SceneNode | null = null;
  readonly children: SceneNode[] = [];

  /** What `worldMatrix` was last recomputed at. See `revisions`. */
  worldRevision = 0;

  /**
   * This node's own geometry, in its own space, or null for a node that only groups.
   *
   * Set from a mesh's `bounds`, which the renderer measures at upload — so a caller hands over
   * what it already has rather than describing its geometry twice.
   */
  private localBounds: Bounds | null = null;

  /**
   * A sphere enclosing this node's geometry **and every descendant's**.
   *
   * **The union is what makes a traversal a partition rather than a loop.** A parent that can be
   * tested once and answer for everything beneath it lets a frustum discard a subtree; a parent
   * covering only its own geometry answers for nothing, and the walk has to visit every node to
   * find out — which is the linear scan a hierarchy exists to replace.
   *
   * A node with no geometry and no children is a point at its own origin, which is the honest
   * answer and is never inside a frustum by accident: a zero radius passes only where the point
   * itself does.
   */
  readonly worldBounds: Bounds = createBounds();

  /** This node's own transform has changed and `localMatrix` is stale. */
  private localDirty = true;
  /** This node or something above it has moved, so `worldMatrix` is stale. */
  private worldDirty = true;
  /** What `worldBounds` was last unioned at, so a child moving alone is still noticed. */
  private boundsRevision = -1;

  constructor() {
    mat4.identity(this.localMatrix);
    mat4.identity(this.worldMatrix);
  }

  setPosition(x: number, y: number, z: number): void {
    this.position[0] = x;
    this.position[1] = y;
    this.position[2] = z;
    this.markMoved();
  }

  setScale(x: number, y: number, z: number): void {
    this.scale[0] = x;
    this.scale[1] = y;
    this.scale[2] = z;
    this.markMoved();
  }

  /**
   * Say what geometry this node holds, in its own space.
   *
   * Held by reference rather than copied: a mesh's bounds do not change after upload, and a
   * caller passing the same mesh to a thousand nodes should not pay for a thousand copies.
   */
  setBounds(bounds: Bounds | null): void {
    this.localBounds = bounds;
    this.markMoved();
  }

  /** Whether this node has geometry of its own, as opposed to only grouping others. */
  get hasGeometry(): boolean {
    return this.localBounds !== null;
  }

  /** Set the rotation from an axis and an angle in radians. The axis need not be normalised. */
  setRotationAxisAngle(x: number, y: number, z: number, radians: number): void {
    const length = Math.sqrt(x * x + y * y + z * z);
    const scale = length > 1e-12 ? 1 / length : 0;
    quat.setAxisAngle(this.rotation, [x * scale, y * scale, z * scale], radians);
    this.markMoved();
  }

  /**
   * Say that this node's transform was written directly.
   *
   * `position`, `rotation` and `scale` are handed out as arrays a caller can write in place,
   * because copying three vectors per node per frame is the allocation-free path an animation
   * system wants. The cost is that this class cannot see the write, so a caller doing it says so.
   */
  markMoved(): void {
    this.localDirty = true;
    this.markSubtreeStale();
  }

  /**
   * Put `child` under this node, taking it from wherever it was.
   *
   * **A cycle is refused here rather than discovered while walking**, because a walk that meets
   * one does not throw: it recurses until the stack is gone, inside a frame loop, with the tab
   * stopped and no useful trace. The check walks up from this node, which is the depth of the
   * tree and not its size.
   */
  attachChild(child: SceneNode): void {
    if (child === this) throw new Error('SceneNode: a node cannot be its own child (cycle)');
    for (let at: SceneNode | null = this; at !== null; at = at.parent) {
      if (at === child) throw new Error('SceneNode: that would make a cycle');
    }
    if (child.parent === this) return;
    child.parent?.detachChild(child);
    child.parent = this;
    this.children.push(child);
    child.markSubtreeStale();
  }

  detachChild(child: SceneNode): void {
    const at = this.children.indexOf(child);
    if (at < 0) return;
    this.children.splice(at, 1);
    child.parent = null;
    child.markSubtreeStale();
  }

  /**
   * Bring this node and everything under it up to date.
   *
   * **Only what moved.** A hierarchy that recomputes every world matrix every frame is slower
   * than the callers it replaces, which already keep matrices they touch only when something
   * moves. A clean subtree is skipped entirely, which is what makes the walk proportional to what
   * changed rather than to the size of the world.
   *
   * **Its ancestors are brought up to date first, and that is a correctness fix rather than a
   * courtesy.** Without it, updating a branch after moving something above it composes against a
   * stale parent and puts the whole branch in the wrong place — silently, with no error and a
   * plausible-looking matrix. Walking up costs the depth of the tree, not its size, and touches
   * only this node's own ancestors: a sibling subtree is not recomputed for it.
   */
  updateWorld(): void {
    this.refreshAncestors();
    this.recompute(this.parent?.worldMatrix ?? null, false);
  }

  /** @internal Bring this node's ancestor chain up to date, root first. */
  private refreshAncestors(): void {
    const parent = this.parent;
    if (parent === null) return;
    parent.refreshAncestors();
    parent.recomputeSelf(parent.parent?.worldMatrix ?? null);
  }

  /**
   * @internal Recompute just this node's matrices, leaving its children alone.
   *
   * **`worldDirty` is left set on purpose.** This node's children have not been recomputed, and
   * clearing it here would let a later `updateWorld` at the root decide the subtree is clean and
   * skip them. `recompute` is what clears it, once the whole subtree really is current.
   */
  private recomputeSelf(parentWorld: Float32Array | null): void {
    if (this.worldDirty) this.composeWorld(parentWorld);
  }

  /** @internal Recompute this subtree. `forced` is set when an ancestor recomputed. */
  protected recompute(parentWorld: Float32Array | null, forced: boolean): void {
    const changed = forced || this.worldDirty;
    if (changed) {
      this.composeWorld(parentWorld);
      this.worldDirty = false;
    }
    for (const child of this.children) child.recompute(this.worldMatrix, changed);
    if (changed || this.childBoundsMoved()) this.unionBounds();
  }

  /**
   * @internal Whether any child's world bounds are newer than this node's own union.
   *
   * A child that moved without this node moving still grows the parent, and the walk above has
   * already recomputed it by the time this asks.
   */
  private childBoundsMoved(): boolean {
    for (const child of this.children) {
      if (child.worldRevision > this.boundsRevision) return true;
    }
    return false;
  }

  /**
   * @internal This node's geometry, placed, then grown to hold every child.
   *
   * Growing a sphere to contain another is the standard construction: if one already contains the
   * other it is unchanged, and otherwise the new sphere spans from the far side of each. Written
   * out rather than taken from a library because it runs per node per change and the three-line
   * version allocates a vector.
   */
  private unionBounds(): void {
    const local = this.localBounds;
    let cx = this.worldMatrix[12] ?? 0;
    let cy = this.worldMatrix[13] ?? 0;
    let cz = this.worldMatrix[14] ?? 0;
    let radius = 0;

    if (local !== null) {
      const lx = local.centre[0] ?? 0;
      const ly = local.centre[1] ?? 0;
      const lz = local.centre[2] ?? 0;
      const m = this.worldMatrix;
      cx = (m[0] ?? 0) * lx + (m[4] ?? 0) * ly + (m[8] ?? 0) * lz + (m[12] ?? 0);
      cy = (m[1] ?? 0) * lx + (m[5] ?? 0) * ly + (m[9] ?? 0) * lz + (m[13] ?? 0);
      cz = (m[2] ?? 0) * lx + (m[6] ?? 0) * ly + (m[10] ?? 0) * lz + (m[14] ?? 0);
      /* The largest axis scale, for the reason `boundsVisible` gives at length. */
      const sx = axisScale(m, 0);
      const sy = axisScale(m, 4);
      const sz = axisScale(m, 8);
      radius = local.radius * Math.max(sx, sy, sz);
    }

    let started = local !== null;
    for (const child of this.children) {
      const other = child.worldBounds;
      /* A child that is a point with nothing under it contributes nothing. */
      if (other.radius === 0 && !child.hasGeometry && child.children.length === 0) continue;
      const ox = other.centre[0] ?? 0;
      const oy = other.centre[1] ?? 0;
      const oz = other.centre[2] ?? 0;
      if (!started) {
        cx = ox;
        cy = oy;
        cz = oz;
        radius = other.radius;
        started = true;
        continue;
      }
      const dx = ox - cx;
      const dy = oy - cy;
      const dz = oz - cz;
      const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (distance + other.radius <= radius) continue;
      if (distance + radius <= other.radius) {
        cx = ox;
        cy = oy;
        cz = oz;
        radius = other.radius;
        continue;
      }
      const grown = (distance + radius + other.radius) * 0.5;
      const along = distance > 1e-12 ? (grown - radius) / distance : 0;
      cx += dx * along;
      cy += dy * along;
      cz += dz * along;
      radius = grown;
    }

    this.worldBounds.centre[0] = cx;
    this.worldBounds.centre[1] = cy;
    this.worldBounds.centre[2] = cz;
    this.worldBounds.radius = radius;
    this.worldBounds.min[0] = cx - radius;
    this.worldBounds.min[1] = cy - radius;
    this.worldBounds.min[2] = cz - radius;
    this.worldBounds.max[0] = cx + radius;
    this.worldBounds.max[1] = cy + radius;
    this.worldBounds.max[2] = cz + radius;
    revisions += 1;
    this.boundsRevision = revisions;
  }

  /** @internal The composition itself, in one place so the two callers cannot drift. */
  private composeWorld(parentWorld: Float32Array | null): void {
    if (this.localDirty) {
      mat4.fromRotationTranslationScale(this.localMatrix, this.rotation, this.position, this.scale);
      this.localDirty = false;
    }
    if (parentWorld === null) this.worldMatrix.set(this.localMatrix);
    else mat4.multiply(this.worldMatrix, parentWorld, this.localMatrix);
    revisions += 1;
    this.worldRevision = revisions;
  }

  /** @internal Mark this node and everything under it as needing a new world matrix. */
  protected markSubtreeStale(): void {
    if (this.worldDirty) return;
    this.worldDirty = true;
    for (const child of this.children) child.markSubtreeStale();
  }
}

/**
 * The length of one of a matrix's three basis columns.
 *
 * `Math.sqrt` of a sum of squares rather than `Math.hypot`, which `scripts/determinism.mjs` refuses
 * inside the simulation set: ECMAScript declines to specify `hypot`, so two engines may answer an
 * ulp apart and a world matrix feeds a query. What `hypot` buys and this gives up is range — a sum
 * of squares overflows above about 1e154 — and a basis column of a transform is near one.
 */
function axisScale(m: ArrayLike<number>, at: number): number {
  const x = m[at] ?? 0;
  const y = m[at + 1] ?? 0;
  const z = m[at + 2] ?? 0;
  return Math.sqrt(x * x + y * y + z * z);
}
