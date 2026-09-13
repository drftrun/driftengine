/**
 * A number list that is already a typed array, so handing it to the GPU is a copy and not a
 * conversion.
 *
 * **Because `build()` was the frame.** `MeshBuilder` accumulated into ten plain `number[]` and
 * turned each into a `Float32Array` in one uninterruptible call at the end. Measured on this
 * machine at **41.9 ms for 110,628 triangles** — two and a half frames — which is what made a
 * consumer streaming a world cap its batches at a triangle count tuned to one laptop, and overshoot
 * that cap by whatever the last object happened to be.
 *
 * The work is the same total work; it moves to where the caller already is. A `number[]` holds
 * boxed doubles that `new Float32Array(list)` must walk and narrow one at a time, while writing
 * into a `Float32Array` as geometry arrives makes the end a `slice` — one memcpy the allocator and
 * the CPU are both good at.
 *
 * **`push` takes six optional numbers rather than a rest parameter**, and that is not a style
 * choice: a rest parameter allocates an array on every call, and this is called sixty-seven times
 * per box across the builder. Six covers every arity the builder uses (one, two, three and six),
 * and the shape means not one of those call sites had to change.
 *
 * **What would make it wrong** is a caller wanting more than six at once, which would silently drop
 * the rest — so `push` is deliberately not variadic-looking, and a seventh argument is a type
 * error rather than a lost vertex.
 */
export class GrowableF32 {
  private buffer: Float32Array;
  /** How many numbers have been written. Not the buffer's capacity. */
  length = 0;
  /**
   * Whether anything other than the default was ever written.
   *
   * **Because `build` used to ask five times, over every vertex.** Specular, emissive colour,
   * roughness, grain and relief are each accumulated always and emitted only when something asked
   * for one, and the asking was a `some()` over the whole list — about 1.5 million predicate calls
   * for a mesh this size, on a path whose entire job is to be cheap. A write knows whether it
   * matters; a scan afterwards is rediscovering it.
   */
  hasOther = false;
  private readonly fallback: number;

  constructor(capacity = 256, fallback = Number.NaN) {
    this.buffer = new Float32Array(capacity);
    this.fallback = fallback;
  }

  push(a: number, b?: number, c?: number, d?: number, e?: number, f?: number): void {
    const count =
      f !== undefined
        ? 6
        : e !== undefined
          ? 5
          : d !== undefined
            ? 4
            : c !== undefined
              ? 3
              : b !== undefined
                ? 2
                : 1;
    if (this.length + count > this.buffer.length) this.grow(this.length + count);
    const at = this.length;
    const buffer = this.buffer;
    buffer[at] = a;
    if (b !== undefined) buffer[at + 1] = b;
    if (c !== undefined) buffer[at + 2] = c;
    if (d !== undefined) buffer[at + 3] = d;
    if (e !== undefined) buffer[at + 4] = e;
    if (f !== undefined) buffer[at + 5] = f;
    this.length = at + count;
    /* A list with no default never answers this, and pays one comparison it can predict. */
    if (!this.hasOther && !Number.isNaN(this.fallback)) {
      for (let i = at; i < this.length; i++) {
        if (buffer[i] !== this.fallback) {
          this.hasOther = true;
          break;
        }
      }
    }
  }

  /** One value, for the few places that read back what they wrote. */
  at(index: number): number {
    return index < this.length ? (this.buffer[index] as number) : 0;
  }

  /** Whether any written value satisfies the predicate. A typed-array walk, not a boxed one. */
  some(predicate: (value: number) => boolean): boolean {
    for (let i = 0; i < this.length; i++) if (predicate(this.buffer[i] as number)) return true;
    return false;
  }

  /**
   * The written range as its own array, which is what a mesh is handed.
   *
   * A copy rather than a `subarray`, deliberately: a view would keep the whole grown buffer alive
   * and would change under anything that kept writing, and a mesh outlives its builder.
   */
  toTyped(): Float32Array {
    return this.buffer.slice(0, this.length);
  }

  /**
   * Doubling, and never to less than what was asked for.
   *
   * A geometry verb can write six numbers at once into an empty list, so growing by a factor alone
   * can still be short — which is a silent one-vertex truncation rather than a throw.
   */
  private grow(needed: number): void {
    let size = this.buffer.length || 1;
    while (size < needed) size *= 2;
    const grown = new Float32Array(size);
    grown.set(this.buffer);
    this.buffer = grown;
  }
}

/** The same, for indices, which are integers and are handed over as a `Uint32Array`. */
export class GrowableU32 {
  private buffer: Uint32Array;
  length = 0;

  constructor(capacity = 256) {
    this.buffer = new Uint32Array(capacity);
  }

  push(a: number, b?: number, c?: number, d?: number, e?: number, f?: number): void {
    const count =
      f !== undefined
        ? 6
        : e !== undefined
          ? 5
          : d !== undefined
            ? 4
            : c !== undefined
              ? 3
              : b !== undefined
                ? 2
                : 1;
    if (this.length + count > this.buffer.length) this.grow(this.length + count);
    const at = this.length;
    const buffer = this.buffer;
    buffer[at] = a;
    if (b !== undefined) buffer[at + 1] = b;
    if (c !== undefined) buffer[at + 2] = c;
    if (d !== undefined) buffer[at + 3] = d;
    if (e !== undefined) buffer[at + 4] = e;
    if (f !== undefined) buffer[at + 5] = f;
    this.length = at + count;
  }

  at(index: number): number {
    return index < this.length ? (this.buffer[index] as number) : 0;
  }

  toTyped(): Uint32Array {
    return this.buffer.slice(0, this.length);
  }

  private grow(needed: number): void {
    let size = this.buffer.length || 1;
    while (size < needed) size *= 2;
    const grown = new Uint32Array(size);
    grown.set(this.buffer);
    this.buffer = grown;
  }
}
