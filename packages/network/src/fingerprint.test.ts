/**
 * A fingerprint's job is to disagree exactly when the worlds disagree, and not otherwise.
 *
 * Both halves need testing and the second is the one that gets skipped: a hash that changes when
 * nothing changed is worse than no hash, because it stops a lockstep session that was fine.
 */
import { describe, expect, it } from 'vitest';
import { World, createWorldSnapshot, defineComponent } from '@driftengine/entities';
import { Fingerprint, fingerprintSnapshot } from './fingerprint.ts';

const Position = defineComponent('FPosition', { x: 'f32', y: 'f32' });
const Health = defineComponent('FHealth', { current: 'f32' });

function worldWith(values: readonly number[]) {
  const world = new World();
  for (const value of values) {
    const e = world.create();
    world.add(e, Position, { x: value, y: value * 2 });
  }
  const slot = createWorldSnapshot();
  world.saveInto(slot);
  return { world, slot };
}

describe('a state fingerprint', () => {
  it('agrees for two worlds built the same way', () => {
    const a = worldWith([1, 2, 3]);
    const b = worldWith([1, 2, 3]);
    expect(fingerprintSnapshot(a.slot)).toBe(fingerprintSnapshot(b.slot));
  });

  /**
   * One ulp is the difference this exists to find, so it is the difference the test uses. A hash
   * over rounded or stringified values would pass this while being useless for its actual job.
   */
  it('disagrees over a single unit in the last place', () => {
    const a = worldWith([1, 2, 3]);
    const b = worldWith([1, 2, 3]);
    const column = b.slot.stores.get(Position.id)?.columns.get('x') as Float32Array;
    /* One unit in the last place *of a float32*, which is 2^-22 at this magnitude. `Number.EPSILON`
       is the double's, and vanishes entirely when it lands in an f32 column. */
    column[1] = Math.fround(2 + 2.384185791015625e-7);
    expect(column[1]).not.toBe(2);
    expect(fingerprintSnapshot(a.slot)).not.toBe(fingerprintSnapshot(b.slot));
  });

  it('disagrees when the live set differs', () => {
    const a = worldWith([1, 2, 3]);
    const b = worldWith([1, 2]);
    expect(fingerprintSnapshot(a.slot)).not.toBe(fingerprintSnapshot(b.slot));
  });

  /**
   * Two worlds whose stores were created in different orders hold the same state.
   *
   * A `Map` iterates in insertion order, so hashing in map order would make the answer depend on
   * which component each peer's code happened to touch first — a property of the startup path and
   * not of the simulation. A lockstep session would halt on tick one, blaming a desync that is not
   * there.
   */
  it('does not depend on the order the stores were created in', () => {
    const first = new World();
    const e1 = first.create();
    first.add(e1, Position, { x: 5, y: 6 });
    first.add(e1, Health, { current: 50 });

    const second = new World();
    const e2 = second.create();
    /* The other order, which is the whole of the difference. */
    second.add(e2, Health, { current: 50 });
    second.add(e2, Position, { x: 5, y: 6 });

    const a = createWorldSnapshot();
    const b = createWorldSnapshot();
    first.saveInto(a);
    second.saveInto(b);

    expect(fingerprintSnapshot(a)).toBe(fingerprintSnapshot(b));
  });

  it('notices a generation that differs even when every value matches', () => {
    const a = new World();
    const b = new World();
    const keep = a.create();
    a.add(keep, Position, { x: 1, y: 1 });

    /* The same handle index in b, but reached after a destroy, so its generation has moved. */
    const throwaway = b.create();
    b.destroy(throwaway);
    const recycled = b.create();
    b.add(recycled, Position, { x: 1, y: 1 });

    const slotA = createWorldSnapshot();
    const slotB = createWorldSnapshot();
    a.saveInto(slotA);
    b.saveInto(slotB);

    expect(fingerprintSnapshot(slotA)).not.toBe(fingerprintSnapshot(slotB));
  });

  it('is sixteen hex characters', () => {
    const { slot } = worldWith([1]);
    expect(fingerprintSnapshot(slot)).toMatch(/^[0-9a-f]{16}$/);
  });

  it('reuses one instance without carrying state between digests', () => {
    const shared = new Fingerprint();
    const a = worldWith([1, 2, 3]);
    const first = fingerprintSnapshot(a.slot, shared);
    const second = fingerprintSnapshot(a.slot, shared);
    expect(second).toBe(first);
  });

  it('separates its two streams, so the halves are not the same hash twice', () => {
    const fp = new Fingerprint();
    fp.int32(1).int32(2).float(3.5);
    const digest = fp.digest();
    expect(digest.slice(0, 8)).not.toBe(digest.slice(8));
  });

  it('tells -0 from +0, because two peers holding different zeroes have diverged', () => {
    expect(new Fingerprint().float(0).digest()).not.toBe(new Fingerprint().float(-0).digest());
  });
});
