/**
 * Seeded PRNG (mulberry32). The only randomness source allowed in simulation
 * and world generation — `Math.random()` is banned there (see AGENTS.md).
 * Same seed ⇒ same sequence on every platform.
 */
/**
 * Deterministically choose one item from a list.
 *
 * The seed is hashed before the modulo rather than used raw. `seed % length`
 * walks the list in order, so consecutive seeds — day numbers, level indices —
 * produce a visible cycle; multiplying by the golden-ratio constant first
 * scatters them, which is the difference between "today's track" feeling picked
 * and feeling like a rota.
 */
export function pickBySeed<T>(seed: number, items: readonly T[]): T | null {
  if (items.length === 0) return null;
  const scrambled = Math.abs(Math.imul(seed | 0, 0x9e3779b1)) % items.length;
  return items[scrambled] ?? null;
}

/**
 * A single well-mixed value in `[0, 1)` from one integer seed.
 *
 * `mulberry32`'s mixer without the stream: the same avalanche, applied once, for the
 * very common case of "one deterministic value per index" — a per-particle jitter, a
 * per-node displacement — where allocating a generator per lookup is absurd.
 *
 * It exists because the obvious alternative is wrong in a way that is hard to see.
 * `fract(sin(x) * 43758.5453)` is the reflex GPU hash and it degrades badly on the CPU
 * for large `x`: `sin` of a number in the millions has lost most of its precision to
 * argument reduction, so nearby seeds correlate and *whole families of values collapse
 * onto each other*. That is what an effect seeded from a tick count hands it. Measured
 * as lightning whose every bolt came out the same shape however much variation the
 * caller thought it was asking for: still visibly deterministic where the caller
 * expected a fresh shape on every strike.
 *
 * Integer mixing has no such failure: every bit of the input reaches every bit of the
 * output, at any magnitude, and it is bit-identical on every platform, which the
 * replay contract requires.
 */
export function hashToUnit(seed: number): number {
  let t = (seed | 0) + 0x6d2b79f5;
  t = Math.imul(t ^ (t >>> 15), 1 | t);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export function mulberry32(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A generator whose position can be read and written.
 *
 * **The closure above cannot be rewound, and a resimulation has to be.** A rollback loop restores
 * a past tick and steps forward again; anything the replayed ticks draw from a generator must draw
 * the same numbers they drew the first time, or the replay produces a different world from the run
 * it is replaying. `mulberry32` keeps its position in a closed-over variable, which is the right
 * shape for every other caller and unreachable for this one.
 *
 * **The whole position is one int32**, which is why this is an interface over a number and not a
 * buffer: mulberry32 mixes a counter and holds nothing else. A `save()` is a number a caller can
 * put in a snapshot beside the rest of a tick's state, and comparing two of them is `===`.
 *
 * The sequence is `mulberry32`'s, unchanged and asserted against it. **That is the promise, not an
 * implementation note**: `AGENTS.md` makes the seeded sequence a contract about stored replays and
 * ghosts, so a second generator that drifted from the first by an increment would invalidate every
 * one of them while passing every test that only read this file.
 */
export interface SavableRandom {
  /** The next value in `[0, 1)`. */
  next(): number;
  /** The position, as one integer. */
  save(): number;
  /** Resume from a position `save` returned. */
  restore(state: number): void;
}

export function savableMulberry32(seed: number): SavableRandom {
  let state = seed | 0;
  return {
    next(): number {
      state = (state + 0x6d2b79f5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
    save(): number {
      return state;
    },
    restore(next: number): void {
      state = next | 0;
    },
  };
}
