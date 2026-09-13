/**
 * The snapshotters this package ships, and the composition that makes them enough.
 *
 * **A tick's state is rarely one thing.** It is the world, and the generator anything random drew
 * from, and whatever the consumer keeps outside both. Restoring two of those three is not a rewind;
 * it is a rewind plus a source of divergence that will not show up until something draws a random
 * number during a replayed tick. So `combineSnapshotters` exists, and the ordinary shape of a
 * session is a combination rather than a single snapshotter.
 */
import { type WorldSnapshot, type World, createWorldSnapshot } from '@driftengine/entities';
import { Fingerprint, fingerprintSnapshot } from './fingerprint.ts';
import type { Snapshotter } from './rewind.ts';

/** A world, through the identity-preserving snapshot `@driftengine/entities` owns. */
export function worldSnapshotter(world: World): Snapshotter<WorldSnapshot> {
  const shared = new Fingerprint();
  return {
    create: () => createWorldSnapshot(),
    save: (into) => world.saveInto(into),
    restore: (from) => world.loadFrom(from),
    digest: (from) => fingerprintSnapshot(from, shared),
  };
}

/**
 * A seeded generator's position.
 *
 * **The shape is declared here and no core type is named**, which is the seam `present/` in
 * `@driftengine/chemistry` uses for the same reason: this package imports `@driftengine/entities`
 * and nothing else, so that a deterministic host has no renderer in its module graph.
 * `savableMulberry32` from core satisfies this structurally.
 */
export interface SavablePosition {
  save(): number;
  restore(state: number): void;
}

/**
 * A generator, as one number.
 *
 * **Not restoring this is the classic silent rollback bug.** Everything looks correct until a
 * replayed tick draws from the generator, gets the *next* number instead of the one it got the
 * first time, and produces a world that is plausible and different. Nothing in a frame can see it.
 */
export function randomSnapshotter(rng: SavablePosition): Snapshotter<{ state: number }> {
  return {
    create: () => ({ state: rng.save() }),
    save: (into) => {
      into.state = rng.save();
    },
    restore: (from) => rng.restore(from.state),
    /* The position is one integer, so its hash is its hex. Two peers whose generators sit at
       different positions have diverged even when every visible value still matches. */
    digest: (from) => (from.state >>> 0).toString(16).padStart(8, '0'),
  };
}

/**
 * Several snapshotters as one, saving and restoring in the order given.
 *
 * The slot is an array of the parts' slots, so nothing is allocated per save once the ring is
 * built. **Restore runs in the same order as save**, which matters for a consumer whose parts are
 * not independent: state derived from the world has to be restored after it.
 */
export function combineSnapshotters(
  parts: readonly Snapshotter<never>[],
): Snapshotter<readonly unknown[]> {
  const members = parts as readonly Snapshotter<unknown>[];
  return {
    create: () => members.map((part) => part.create()),
    save: (into) => {
      for (let i = 0; i < members.length; i++) {
        (members[i] as Snapshotter<unknown>).save(into[i]);
      }
    },
    restore: (from) => {
      for (let i = 0; i < members.length; i++) {
        (members[i] as Snapshotter<unknown>).restore(from[i]);
      }
    },
    /*
     * Every part's digest, folded into one. A part with none contributes nothing rather than
     * disabling the whole — a consumer combining a world with a scratch buffer they do not care
     * about should still get a comparable hash of the world.
     */
    digest: (from) => {
      const combined = new Fingerprint();
      for (let i = 0; i < members.length; i++) {
        const part = members[i] as Snapshotter<unknown>;
        if (part.digest === undefined) continue;
        const text = part.digest(from[i]);
        combined.int32(i);
        for (let at = 0; at < text.length; at++) combined.byte(text.charCodeAt(at));
      }
      return combined.digest();
    },
  };
}
