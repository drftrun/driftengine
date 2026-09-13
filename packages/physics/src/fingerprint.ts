import type { BodySet } from './bodies.ts';
import type { ColliderSet } from './colliderSet.ts';
import { STRIDE_BYTES } from './colliderSet.ts';

/**
 * A stable hash of the static geometry a simulation ran against.
 *
 * A recording made of a deterministic simulation is only replayable against the
 * world it was recorded in. When world generation changes — a fixed bug, a
 * retuned curve, a new build — recordings from before it desync, and they do it
 * *silently*: the run is reproduced faithfully against geometry that is no longer
 * there, so what appears on screen is a body moving through empty space with
 * nothing to explain it.
 *
 * Storing this alongside a recording lets a caller compare the world it has
 * against the world the recording was made in, and refuse rather than guess.
 *
 * **Determinism is the whole contract.** The same colliders must give the same
 * string on every machine and in every build, so this reads the raw bytes of the
 * bounds array: a float's decimal rendering is a platform question and its bit
 * pattern is not. Nothing here iterates a `Map` or a `Set`, both of which would
 * make the answer depend on insertion order.
 *
 * **No tolerance, deliberately.** A sub-millimetre difference changes the answer.
 * Whether a given difference *matters* is the caller's judgement, and a hash that
 * quietly rounded would take that judgement away from every caller at once.
 *
 * FNV-1a over 64 bits, carried as two 32-bit halves because JavaScript's bitwise
 * operators are 32-bit and a single accumulator would silently lose the top half.
 * Not a cryptographic hash: this detects change, it does not resist forgery, and
 * a caller that needs the second property needs `crypto.subtle` and an await.
 *
 * **On a set that has been mutated, this answers "the same set with the same history" and not
 * "the same world".** A set can take and drop groups now, and a slot freed by one region is
 * refilled by another, so the same geometry sits at different indices depending on the path
 * driven to reach it.
 *
 * *Replay is not what that costs.* The same inputs drive the same path, which produces the same
 * load order and so the same slots, and a recording replays against the set it was recorded
 * against exactly as it always did. What it costs is comparing two *sessions* that arrived at the
 * same world by different routes.
 *
 * **`fingerprintBodies`'s escape hatch does not transfer**, which is worth saying because the two
 * functions are otherwise the same construction. There, a caller wanting the multiset sorts what
 * it feeds in, because it hands over an array. Here a caller hands over an object whose slot order
 * is a load history they neither chose nor can observe, so there is nothing for them to sort. A
 * canonical variant hashing live slots sorted by their packed bytes would answer the cross-session
 * question and is about fifteen lines; it is not here because nothing is asking it yet.
 */
export function fingerprintColliders(set: ColliderSet): string {
  // Two FNV-1a streams, offset-basis and prime per the 32-bit spec.
  let low = 0x811c9dc5;
  let high = 0x811c9dc5;

  /*
   * The count first, so two sets whose float payloads coincide still differ, and
   * four bytes of it rather than one — a set of exactly 256 colliders must not
   * hash as a set of none.
   *
   * The *live* count, which is what `count` has always meant. A set that has dropped a group
   * holds slots it does not use, and hashing those would make the answer depend on how much room
   * happened to be spare.
   */
  const count = set.count >>> 0;
  mix(count & 0xff);
  mix((count >>> 8) & 0xff);
  mix((count >>> 16) & 0xff);
  mix((count >>> 24) & 0xff);

  /*
   * **Live slots only, in index order, and this produces exactly the stream it always did for a
   * set built by the constructor.** Such a set is dense — every slot live, `capacity` equal to
   * `count` — so the walk covers the whole of `data` and skips nothing, which is why the golden
   * strings in the tests beside this file did not move when liveness arrived. Only a set that has
   * grown or dropped a group can differ here, and no recording predates those.
   */
  const bytes = new Uint8Array(set.data.buffer, set.data.byteOffset, set.data.byteLength);
  for (let slot = 0; slot < set.capacity; slot++) {
    if (!set.liveAt(slot)) continue;
    const from = slot * STRIDE_BYTES;
    for (let i = from; i < from + STRIDE_BYTES; i++) mix(bytes[i] ?? 0);
  }

  return hex(high) + hex(low);

  function mix(byte: number): void {
    low ^= byte & 0xff;
    low = Math.imul(low, 0x01000193) >>> 0;
    /*
     * The high half consumes the low half's *current* state rather than the same
     * input byte, so it cannot degenerate into a copy of it. Without this the
     * string would be sixteen characters carrying thirty-two bits of information,
     * which every equality test above would still pass.
     */
    high ^= low & 0xff;
    high = Math.imul(high, 0x01000193) >>> 0;
  }
}

function hex(value: number): string {
  return value.toString(16).padStart(8, '0');
}

/**
 * A stable hash of every body's state, for comparing one run against another.
 *
 * The same FNV-1a construction and the same reasoning as `fingerprintColliders`: the raw bytes of a
 * float, because its decimal rendering is a platform question and its bit pattern is not. No
 * tolerance, deliberately — whether a difference *matters* is the caller's judgement, and a hash
 * that quietly rounded would take that judgement away from every caller at once.
 *
 * **Order matters here and that is the point.** Two runs of the same scene must agree body for
 * body. A caller comparing scenes *built* in different orders wants the multiset instead, and has
 * to sort what it feeds in — see the permutation gate beside the solver baseline, which does.
 */
export function fingerprintBodies(bodies: BodySet): string {
  let low = 0x811c9dc5;
  let high = 0x811c9dc5;
  const channels: readonly Float32Array[] = [
    bodies.posX,
    bodies.posY,
    bodies.posZ,
    bodies.rotX,
    bodies.rotY,
    bodies.rotZ,
    bodies.rotW,
    bodies.velX,
    bodies.velY,
    bodies.velZ,
    bodies.angX,
    bodies.angY,
    bodies.angZ,
  ];
  const scratch = new Float32Array(1);
  const view = new Uint8Array(scratch.buffer);
  for (let i = 0; i < bodies.count; i++) {
    for (const channel of channels) {
      scratch[0] = channel[i] ?? 0;
      for (let b = 0; b < 4; b++) {
        low = Math.imul(low ^ (view[b] ?? 0), 0x01000193) >>> 0;
        high = Math.imul(high ^ (view[3 - b] ?? 0), 0x01000193) >>> 0;
      }
    }
  }
  return `${low.toString(16).padStart(8, '0')}${high.toString(16).padStart(8, '0')}`;
}
