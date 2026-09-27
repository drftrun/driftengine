/**
 * The simplifier's queue: candidate edge collapses, cheapest first.
 *
 * A binary min-heap in parallel typed arrays grown by doubling, because a scene's meshes queue
 * millions of candidates and an object each would be most of the bake's memory. A candidate carries
 * the version its vertex had when it was costed; the caller discards one whose vertex has moved on
 * since, rather than the heap finding and removing it.
 */
export class CollapseHeap {
  private costs = new Float64Array(1024);
  private us = new Int32Array(1024);
  private vs = new Int32Array(1024);
  private versions = new Uint32Array(1024);
  size = 0;

  push(cost: number, u: number, v: number, version: number): void {
    if (this.size === this.costs.length) this.grow();
    let i = this.size++;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.costs[parent]! <= cost) break;
      this.move(parent, i);
      i = parent;
    }
    this.costs[i] = cost;
    this.us[i] = u;
    this.vs[i] = v;
    this.versions[i] = version;
  }

  topCost(): number {
    return this.costs[0]!;
  }

  pop(): { u: number; v: number; version: number } {
    const top = { u: this.us[0]!, v: this.vs[0]!, version: this.versions[0]! };
    const last = --this.size;
    const cost = this.costs[last]!;
    const u = this.us[last]!;
    const v = this.vs[last]!;
    const version = this.versions[last]!;
    let i = 0;
    for (;;) {
      const left = i * 2 + 1;
      if (left >= last) break;
      const right = left + 1;
      const child = right < last && this.costs[right]! < this.costs[left]! ? right : left;
      if (this.costs[child]! >= cost) break;
      this.move(child, i);
      i = child;
    }
    this.costs[i] = cost;
    this.us[i] = u;
    this.vs[i] = v;
    this.versions[i] = version;
    return top;
  }

  private move(from: number, to: number): void {
    this.costs[to] = this.costs[from]!;
    this.us[to] = this.us[from]!;
    this.vs[to] = this.vs[from]!;
    this.versions[to] = this.versions[from]!;
  }

  private grow(): void {
    const size = this.costs.length * 2;
    const costs = new Float64Array(size);
    costs.set(this.costs);
    const us = new Int32Array(size);
    us.set(this.us);
    const vs = new Int32Array(size);
    vs.set(this.vs);
    const versions = new Uint32Array(size);
    versions.set(this.versions);
    this.costs = costs;
    this.us = us;
    this.vs = vs;
    this.versions = versions;
  }
}
