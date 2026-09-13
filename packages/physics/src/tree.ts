import type { Aabb } from './collide/index.ts';

/**
 * A dynamic bounding-volume tree over moving proxies.
 *
 * **Two structures answer two questions, and this is the second one.** `ColliderSet`'s uniform hash
 * is right for static geometry: built once, from solids of known extent, never touched again. It is
 * wrong for bodies, whose sizes vary by orders of magnitude and which move every tick — a large
 * body straddles hundreds of cells and every body rehashes. *What would make this wrong* is a
 * measurement showing the tree beats the hash on static geometry too, at which point they collapse
 * into one and the hash goes.
 *
 * **Fat bounds are what make it incremental.** A proxy re-inserts only when its tight box leaves
 * the margin it was given, so a body drifting slowly costs nothing but a comparison.
 *
 * **Nothing downstream may see this tree.** Insertion order decides tree shape and tree shape
 * decides enumeration order, and with sequential impulses enumeration order changes the result.
 * `pairs.ts` sorts by body index for exactly that reason, and this file's ordering is therefore
 * free to be whatever the heuristic produces.
 */

/** How far a proxy's stored box is grown past its tight one, in metres. */
const MARGIN = 0.1;
/** A node with no child. Chosen over −1 so the arrays can stay unsigned. */
export const NIL = 0x7fffffff;

export class DynamicTree {
  root = NIL;
  /** minX, minY, minZ, maxX, maxY, maxZ per node. */
  bounds: Float32Array;
  parent: Int32Array;
  child1: Int32Array;
  child2: Int32Array;
  /** The caller's own id for a leaf; −1 on an internal node. */
  proxy: Int32Array;
  height: Int32Array;

  private capacity: number;
  private free = 0;
  private nodeCount = 0;
  private stack: Int32Array;

  constructor(capacity = 64) {
    this.capacity = Math.max(2, capacity | 0);
    this.bounds = new Float32Array(this.capacity * 6);
    this.parent = new Int32Array(this.capacity);
    this.child1 = new Int32Array(this.capacity);
    this.child2 = new Int32Array(this.capacity);
    this.proxy = new Int32Array(this.capacity);
    this.height = new Int32Array(this.capacity);
    this.stack = new Int32Array(64);
    this.resetFreeList(0);
  }

  /** How many nodes are in use. A tree of n leaves has 2n − 1 nodes. */
  get count(): number {
    return this.nodeCount;
  }

  insert(proxyId: number, box: Aabb): number {
    const leaf = this.allocate();
    const at = leaf * 6;
    this.bounds[at] = box.minX - MARGIN;
    this.bounds[at + 1] = box.minY - MARGIN;
    this.bounds[at + 2] = box.minZ - MARGIN;
    this.bounds[at + 3] = box.maxX + MARGIN;
    this.bounds[at + 4] = box.maxY + MARGIN;
    this.bounds[at + 5] = box.maxZ + MARGIN;
    this.proxy[leaf] = proxyId;
    this.height[leaf] = 0;
    this.insertLeaf(leaf);
    return leaf;
  }

  remove(leaf: number): void {
    this.removeLeaf(leaf);
    this.freeNode(leaf);
  }

  /**
   * Re-place a proxy whose tight box has moved. Returns whether the tree changed.
   *
   * A move entirely inside the fat box is free: the stored bounds still enclose the proxy, so no
   * query can miss it. That is the whole point of the margin, and the reason it is a *conservative*
   * enlargement rather than a tolerance.
   */
  move(leaf: number, box: Aabb): boolean {
    const at = leaf * 6;
    if (
      box.minX >= (this.bounds[at] ?? 0) &&
      box.minY >= (this.bounds[at + 1] ?? 0) &&
      box.minZ >= (this.bounds[at + 2] ?? 0) &&
      box.maxX <= (this.bounds[at + 3] ?? 0) &&
      box.maxY <= (this.bounds[at + 4] ?? 0) &&
      box.maxZ <= (this.bounds[at + 5] ?? 0)
    ) {
      return false;
    }
    const id = this.proxy[leaf] ?? 0;
    this.removeLeaf(leaf);
    this.bounds[at] = box.minX - MARGIN;
    this.bounds[at + 1] = box.minY - MARGIN;
    this.bounds[at + 2] = box.minZ - MARGIN;
    this.bounds[at + 3] = box.maxX + MARGIN;
    this.bounds[at + 4] = box.maxY + MARGIN;
    this.bounds[at + 5] = box.maxZ + MARGIN;
    this.proxy[leaf] = id;
    this.insertLeaf(leaf);
    return true;
  }

  /** Fill `out` with every proxy id whose stored box overlaps `box`. Returns how many. */
  query(box: Aabb, out: Int32Array): number {
    if (this.root === NIL) return 0;
    let top = 0;
    this.stack[top++] = this.root;
    let found = 0;
    while (top > 0) {
      const node = this.stack[--top] ?? NIL;
      if (node === NIL) continue;
      const at = node * 6;
      if (
        (this.bounds[at] ?? 0) > box.maxX ||
        (this.bounds[at + 3] ?? 0) < box.minX ||
        (this.bounds[at + 1] ?? 0) > box.maxY ||
        (this.bounds[at + 4] ?? 0) < box.minY ||
        (this.bounds[at + 2] ?? 0) > box.maxZ ||
        (this.bounds[at + 5] ?? 0) < box.minZ
      ) {
        continue;
      }
      if (this.child1[node] === NIL) {
        if (found < out.length) out[found] = this.proxy[node] ?? 0;
        found++;
        continue;
      }
      if (top + 2 > this.stack.length) this.stack = growInt(this.stack, this.stack.length * 2);
      this.stack[top++] = this.child1[node] ?? NIL;
      this.stack[top++] = this.child2[node] ?? NIL;
    }
    return found > out.length ? out.length : found;
  }

  private insertLeaf(leaf: number): void {
    if (this.root === NIL) {
      this.root = leaf;
      this.parent[leaf] = NIL;
      return;
    }
    // Descend to the sibling whose union with the leaf costs the least surface area.
    let node = this.root;
    while (this.child1[node] !== NIL) {
      const c1 = this.child1[node] ?? NIL;
      const c2 = this.child2[node] ?? NIL;
      node = this.unionArea(leaf, c1) < this.unionArea(leaf, c2) ? c1 : c2;
    }

    const sibling = node;
    const oldParent = this.parent[sibling] ?? NIL;
    const newParent = this.allocate();
    this.parent[newParent] = oldParent;
    this.proxy[newParent] = -1;
    this.union(newParent, leaf, sibling);
    this.height[newParent] = (this.height[sibling] ?? 0) + 1;

    if (oldParent !== NIL) {
      if (this.child1[oldParent] === sibling) this.child1[oldParent] = newParent;
      else this.child2[oldParent] = newParent;
    } else {
      this.root = newParent;
    }
    this.child1[newParent] = sibling;
    this.child2[newParent] = leaf;
    this.parent[sibling] = newParent;
    this.parent[leaf] = newParent;

    this.refit(this.parent[leaf] ?? NIL);
  }

  private removeLeaf(leaf: number): void {
    if (leaf === this.root) {
      this.root = NIL;
      return;
    }
    const parent = this.parent[leaf] ?? NIL;
    const grand = this.parent[parent] ?? NIL;
    const sibling =
      this.child1[parent] === leaf ? (this.child2[parent] ?? NIL) : (this.child1[parent] ?? NIL);
    if (grand !== NIL) {
      if (this.child1[grand] === parent) this.child1[grand] = sibling;
      else this.child2[grand] = sibling;
      this.parent[sibling] = grand;
      this.freeNode(parent);
      this.refit(grand);
    } else {
      this.root = sibling;
      this.parent[sibling] = NIL;
      this.freeNode(parent);
    }
  }

  private refit(from: number): void {
    let node = from;
    while (node !== NIL) {
      node = this.balance(node);
      const c1 = this.child1[node] ?? NIL;
      const c2 = this.child2[node] ?? NIL;
      this.union(node, c1, c2);
      const h1 = this.height[c1] ?? 0;
      const h2 = this.height[c2] ?? 0;
      this.height[node] = (h1 > h2 ? h1 : h2) + 1;
      node = this.parent[node] ?? NIL;
    }
  }

  /**
   * One AVL-style rotation where a subtree leans by more than one, returning the new subtree root.
   *
   * **Without this the surface-area descent builds a chain, and it does so on the most ordinary
   * scene there is.** Measured: sixty-four boxes in a row along x came out as a tree of height 63,
   * because each new box unions most cheaply with the rightmost leaf and the descent therefore
   * walks the right spine every time. A wall, a stack and a floor strip are all that shape, and a
   * chain makes every query linear, which is the entire cost the tree exists to avoid. A grid was
   * height 14 and hid it.
   *
   * The heuristic chooses *where* to insert and the rotation keeps the result usable; neither
   * substitutes for the other. **What this costs** is a rotation test per node on the way up, all
   * of it integer comparison. **What would make it wrong** is nothing measured yet; the alternative
   * is a full rebuild, which is dearer and not incremental.
   */
  private balance(a: number): number {
    if (this.child1[a] === NIL || (this.height[a] ?? 0) < 2) return a;
    const b = this.child1[a] ?? NIL;
    const c = this.child2[a] ?? NIL;
    const lean = (this.height[c] ?? 0) - (this.height[b] ?? 0);
    if (lean > 1) return this.rotate(a, c, b);
    if (lean < -1) return this.rotate(a, b, c);
    return a;
  }

  /** Pull `up` above `a`, keeping `keep` as `a`'s remaining child. */
  private rotate(a: number, up: number, keep: number): number {
    const f = this.child1[up] ?? NIL;
    const g = this.child2[up] ?? NIL;
    const grand = this.parent[a] ?? NIL;

    this.child1[up] = a;
    this.parent[up] = grand;
    this.parent[a] = up;
    if (grand !== NIL) {
      if (this.child1[grand] === a) this.child1[grand] = up;
      else this.child2[grand] = up;
    } else {
      this.root = up;
    }

    // The taller grandchild rises with `up`; the shorter one drops to `a`.
    const tall = (this.height[f] ?? 0) > (this.height[g] ?? 0) ? f : g;
    const short = tall === f ? g : f;
    this.child2[up] = tall;
    this.child2[a] = short;
    this.child1[a] = keep;
    this.parent[short] = a;

    this.union(a, keep, short);
    this.union(up, a, tall);
    const hk = this.height[keep] ?? 0;
    const hs = this.height[short] ?? 0;
    this.height[a] = (hk > hs ? hk : hs) + 1;
    const ha = this.height[a] ?? 0;
    const ht = this.height[tall] ?? 0;
    this.height[up] = (ha > ht ? ha : ht) + 1;
    return up;
  }

  private union(into: number, a: number, b: number): void {
    const t = into * 6;
    const p = a * 6;
    const q = b * 6;
    for (let k = 0; k < 3; k++) {
      const pa = this.bounds[p + k] ?? 0;
      const qb = this.bounds[q + k] ?? 0;
      this.bounds[t + k] = pa < qb ? pa : qb;
      const pc = this.bounds[p + k + 3] ?? 0;
      const qc = this.bounds[q + k + 3] ?? 0;
      this.bounds[t + k + 3] = pc > qc ? pc : qc;
    }
  }

  /** Surface area of the box enclosing two nodes. The heuristic, and only `+ - *`. */
  private unionArea(a: number, b: number): number {
    const p = a * 6;
    const q = b * 6;
    const ax = this.bounds[p] ?? 0;
    const bx = this.bounds[q] ?? 0;
    const ay = this.bounds[p + 1] ?? 0;
    const by = this.bounds[q + 1] ?? 0;
    const az = this.bounds[p + 2] ?? 0;
    const bz = this.bounds[q + 2] ?? 0;
    const cx = this.bounds[p + 3] ?? 0;
    const dx = this.bounds[q + 3] ?? 0;
    const cy = this.bounds[p + 4] ?? 0;
    const dy = this.bounds[q + 4] ?? 0;
    const cz = this.bounds[p + 5] ?? 0;
    const dz = this.bounds[q + 5] ?? 0;
    const w = (cx > dx ? cx : dx) - (ax < bx ? ax : bx);
    const h = (cy > dy ? cy : dy) - (ay < by ? ay : by);
    const d = (cz > dz ? cz : dz) - (az < bz ? az : bz);
    return w * h + h * d + d * w;
  }

  private allocate(): number {
    if (this.free === NIL) this.growNodes();
    const node = this.free;
    this.free = this.parent[node] ?? NIL;
    this.parent[node] = NIL;
    this.child1[node] = NIL;
    this.child2[node] = NIL;
    this.height[node] = 0;
    this.nodeCount++;
    return node;
  }

  private freeNode(node: number): void {
    this.parent[node] = this.free;
    this.child1[node] = NIL;
    this.child2[node] = NIL;
    this.height[node] = -1;
    this.free = node;
    this.nodeCount--;
  }

  private growNodes(): void {
    const old = this.capacity;
    this.capacity *= 2;
    this.bounds = growFloat(this.bounds, this.capacity * 6);
    this.parent = growInt(this.parent, this.capacity);
    this.child1 = growInt(this.child1, this.capacity);
    this.child2 = growInt(this.child2, this.capacity);
    this.proxy = growInt(this.proxy, this.capacity);
    this.height = growInt(this.height, this.capacity);
    this.resetFreeList(old);
  }

  private resetFreeList(from: number): void {
    for (let i = from; i < this.capacity - 1; i++) {
      this.parent[i] = i + 1;
      this.height[i] = -1;
    }
    this.parent[this.capacity - 1] = NIL;
    this.height[this.capacity - 1] = -1;
    this.free = from;
  }
}

function growFloat(a: Float32Array, n: number): Float32Array {
  const out = new Float32Array(n);
  out.set(a);
  return out;
}

function growInt(a: Int32Array, n: number): Int32Array {
  const out = new Int32Array(n);
  out.set(a);
  return out;
}
