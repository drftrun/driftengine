/**
 * A hash of simulation state, so a divergence has a tick number attached to it.
 *
 * **The value is not detection, it is *localisation*.** Two peers whose worlds have drifted apart
 * will notice eventually, because something visible will differ; what they cannot do without this is
 * say *when* it started. A fingerprint per confirmed tick turns "we are out of sync" into "we
 * disagreed first at tick 4,182", and the tick is the whole of the debugging: it names the inputs
 * that were live, the entities that moved, and the one step to re-run under a debugger.
 *
 * Two FNV-1a streams over the bytes, which is the shape `fingerprintColliders` and
 * `fingerprintChemistry` already use here. Sixty-four bits from two thirty-two-bit streams rather
 * than one, because a thirty-two-bit hash collides at about seventy thousand samples by the birthday
 * bound and a session is sixty samples a second.
 *
 * ---
 *
 * ## Floats are hashed as bits, and that is the point
 *
 * A hash of `x.toString()` or of a rounded value would agree across a difference of one ulp, which
 * is exactly the difference this exists to find. So every number goes in as its eight bytes.
 *
 * **A consequence worth stating: `-0` and `+0` hash differently, and `NaN` hashes as whatever
 * payload produced it.** Both are correct — two peers holding different zeroes have genuinely
 * diverged, and a simulation that has produced a NaN has a bigger problem than a fingerprint.
 */
import type { WorldSnapshot } from '@driftengine/entities';

const OFFSET_BASIS = 0x811c9dc5;
const PRIME = 0x01000193;

/**
 * An FNV-1a pair, fed bytes and numbers, answering sixteen hex characters.
 *
 * A class rather than a function over one buffer, because state worth fingerprinting is rarely one
 * buffer: a consumer combines a world, a generator's position and whatever they keep beside both,
 * and the order they feed it in is theirs to fix.
 */
export class Fingerprint {
  private low = OFFSET_BASIS;
  private high = OFFSET_BASIS;
  private readonly scratch = new DataView(new ArrayBuffer(8));

  /** Start again, so one instance serves a whole session without allocating. */
  reset(): this {
    this.low = OFFSET_BASIS;
    this.high = OFFSET_BASIS;
    return this;
  }

  byte(value: number): this {
    const b = value & 0xff;
    this.low = Math.imul(this.low ^ b, PRIME) >>> 0;
    /*
     * The high stream consumes the low stream's *current* state rather than the same byte, which is
     * what makes the two halves independent. Two streams fed identical input with different bases
     * stay correlated and the pair is worth barely more than one of them.
     */
    this.high = Math.imul(this.high ^ (this.low & 0xff), PRIME) >>> 0;
    return this;
  }

  /** A 32-bit integer, low byte first. */
  int32(value: number): this {
    const v = value | 0;
    this.byte(v);
    this.byte(v >>> 8);
    this.byte(v >>> 16);
    this.byte(v >>> 24);
    return this;
  }

  /** A double, as its eight bytes. See the header for why not as text. */
  float(value: number): this {
    this.scratch.setFloat64(0, value);
    for (let i = 0; i < 8; i++) this.byte(this.scratch.getUint8(i));
    return this;
  }

  /** A typed array's bytes, up to `count` elements, or all of them. */
  array(values: ArrayLike<number> & { BYTES_PER_ELEMENT?: number }, count = values.length): this {
    const limit = Math.min(count, values.length);
    this.int32(limit);
    if (values instanceof Float64Array || values instanceof Float32Array) {
      for (let i = 0; i < limit; i++) this.float(values[i] as number);
      return this;
    }
    for (let i = 0; i < limit; i++) this.int32(values[i] as number);
    return this;
  }

  /** Sixteen lowercase hex characters. */
  digest(): string {
    return hex(this.high) + hex(this.low);
  }
}

function hex(value: number): string {
  return (value >>> 0).toString(16).padStart(8, '0');
}

/**
 * A world snapshot's fingerprint.
 *
 * **The stores are walked in id order rather than in map order.** A `Map` iterates in insertion
 * order, and two peers create their stores in whatever order their code first asked for them —
 * which is a property of the load path, not of the world. Sorting makes the hash a function of the
 * state instead of a function of the state and the startup sequence.
 *
 * The allocator goes in first, and `highWater` with it: two worlds holding identical components on
 * identical handles but differing in how many slots have ever been used are genuinely different,
 * because the next spawn differs.
 */
export function fingerprintSnapshot(slot: WorldSnapshot, into = new Fingerprint()): string {
  into.reset();

  const allocator = slot.allocator;
  into.int32(allocator.highWater);
  into.int32(allocator.aliveCount);
  into.array(allocator.generations, allocator.highWater);
  into.array(allocator.live, allocator.highWater);
  into.array(allocator.free, allocator.freeCount);

  const ids = [...slot.stores.keys()].sort((a, b) => a - b);
  into.int32(ids.length);
  for (const id of ids) {
    const store = slot.stores.get(id);
    if (store === undefined) continue;
    into.int32(id);
    into.int32(store.count);
    into.array(store.dense, store.count);

    /* Columns by name, sorted, for the reason the stores are: a schema's field order is a property
       of the declaration and a map's order is a property of construction. */
    const fields = [...store.columns.keys()].sort();
    for (const field of fields) {
      const column = store.columns.get(field);
      if (column === undefined || Array.isArray(column)) continue;
      into.array(column, store.count);
    }
  }

  return into.digest();
}
