/**
 * What one garment of a set has asked the device for and the device has not yet recorded: a pose, a
 * reset to rest, steps — each with the numbers its round reads, taken when it was asked for.
 *
 * **Taken when asked for, because they change after.** `ClothControl` moves its targets to a step's
 * fraction and calls the device; by the time the set records the step, the next step has moved them
 * again. So each op keeps the head of its record — fraction, blend, the poses it reads, the carry and
 * the wind — as it stood, and the set copies it into the round that runs it.
 *
 * Grows by doubling and never shrinks, so a settled set allocates nothing a frame.
 */

/** Words of a garment's record in a round: the shader's `Pace`. */
export const PACE_WORDS = 44;
/** The head of it, which an op carries: everything before the garment's own constants. */
export const PACE_HEAD_WORDS = 32;

export const CLOTH_OP_POSE = 0;
export const CLOTH_OP_REST = 1;
export const CLOTH_OP_STEP = 2;

export class ClothOps {
  private kinds = new Uint8Array(8);
  private heads = new ArrayBuffer(8 * PACE_HEAD_WORDS * 4);
  private floats = new Float32Array(this.heads);
  private words = new Uint32Array(this.heads);
  private first = 0;
  private end = 0;

  get pending(): number {
    return this.end - this.first;
  }

  /** The kind of the op to run next, or -1 where there is none. */
  get next(): number {
    return this.first < this.end ? (this.kinds[this.first] as number) : -1;
  }

  /** A new op of `kind`, its head zeroed, for the caller to fill: the float and word offset of it. */
  push(kind: number): number {
    if (this.end === this.kinds.length) this.grow();
    const at = this.end * PACE_HEAD_WORDS;
    this.floats.fill(0, at, at + PACE_HEAD_WORDS);
    this.kinds[this.end] = kind;
    this.end++;
    return at;
  }

  get headFloats(): Float32Array {
    return this.floats;
  }

  get headWords(): Uint32Array {
    return this.words;
  }

  /**
   * The next op's head into `out` at `at`, and the op gone. Copied as words, since a head holds
   * integers too, and a word at a time, since a view a call would be an allocation a round.
   */
  take(out: Uint32Array, at: number): void {
    const from = this.first * PACE_HEAD_WORDS;
    for (let w = 0; w < PACE_HEAD_WORDS; w++) out[at + w] = this.words[from + w] as number;
    this.first++;
    if (this.first === this.end) {
      this.first = 0;
      this.end = 0;
    }
  }

  private grow(): void {
    const live = this.end - this.first;
    const capacity = this.kinds.length * 2;
    const kinds = new Uint8Array(capacity);
    kinds.set(this.kinds.subarray(this.first, this.end));
    const heads = new ArrayBuffer(capacity * PACE_HEAD_WORDS * 4);
    const floats = new Float32Array(heads);
    floats.set(this.floats.subarray(this.first * PACE_HEAD_WORDS, this.end * PACE_HEAD_WORDS));
    this.kinds = kinds;
    this.heads = heads;
    this.floats = floats;
    this.words = new Uint32Array(heads);
    this.first = 0;
    this.end = live;
  }
}
