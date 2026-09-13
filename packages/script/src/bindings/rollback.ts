import type { CapabilityDefinition, OpaqueType } from 'driftscript';
import { defineCapability } from 'driftscript';

export const ROLLBACK_MODULE = 'drift/rollback';

/**
 * `drift/rollback` — what a script can ask about the rewind it is running inside.
 *
 * **Every capability here is `nondeterministic`, and that is the whole design.** The obvious reading
 * is that these are reads and reads are cheap, so they should be as permissive as possible. The
 * opposite is true, and the reason is the thing being read: *whether this tick is a replay*, *how
 * far back the loop can still reach*, *which ticks are settled*. All of them move with packet
 * timing, and a `@deterministic` system that branched on one would take a different path live than
 * on replay — producing a world that differs from the world it is replaying, for a reason that
 * looks nothing like a networking bug.
 *
 * That is the same call `bindings/ui.ts` made for `hovered` and `pressed`, and `bindings/network.ts`
 * makes for the confirmed watermark. Stated once more here because this is the module where getting
 * it wrong would be most tempting and least visible.
 *
 * ## `isReplaying` is the one worth being explicit about
 *
 * A script asking "am I being replayed" is almost always about to do something that should not
 * happen twice — play a sound, spawn a particle, send a message. **That is a legitimate use and it
 * is precisely why the effect is what it is**: the function doing it is not a simulation function,
 * it is a presentation function that happens to run beside one, and the annotation should say so.
 *
 * A script using it to change *simulation* state is writing a bug, and nothing here can stop that.
 * What it can do is make the deterministic annotation refuse to compile over it, which is the
 * difference between a bug that is found by the checker and one that is found by two players
 * disagreeing about who won.
 *
 * ## There is no `rollback.read` effect and this does not add one
 *
 * The language named `behavior.read` and `behavior.write` ahead of their provider precisely so a
 * track would not need a release first, and it named `network.read` and `network.write` the same
 * way — but nothing for rollback. `nondeterministic` is honest for every capability here, so no
 * release is needed. *Reversed by* a consumer who wants a `@deterministic` function to read
 * something in this module, at which point the question is which capability and why, and the answer
 * is a one-line change to the `Effect` union.
 */
export const ROLLBACK_TYPES: readonly OpaqueType[] = [
  {
    module: ROLLBACK_MODULE,
    name: 'Rewind',
    doc: 'The rewind loop: which tick is running, whether this is a replay, and how far back it can reach.',
  },
];

/** What the binding needs of a `RewindLoop`, declared rather than imported. */
interface RewindLike {
  readonly tick: number;
  readonly depth: number;
  readonly earliest: number;
  readonly isReplaying: boolean;
  readonly stats: { readonly replays: number; readonly replayedTicks: number };
}

const define = (name: string, returns: string, doc: string): CapabilityDefinition =>
  defineCapability({
    module: ROLLBACK_MODULE,
    name,
    signature: `fn(rewind: Rewind) -> ${returns}`,
    params: [{ name: 'rewind', type: 'Rewind' }],
    returns,
    effects: ['nondeterministic'],
    deterministic: false,
    doc,
    implementation: `${ROLLBACK_MODULE}.${name}`,
  });

export const ROLLBACK_CAPABILITIES: readonly CapabilityDefinition[] = [
  define('tick', 'i32', 'The last tick that was stepped, or -1 before the first.'),
  define(
    'isReplaying',
    'bool',
    'Whether this tick is being re-run to correct a mispredicted one. Anything that should not happen twice — a sound, a particle, a message — asks this first.',
  ),
  define(
    'depth',
    'i32',
    'How many ticks back a rewind can reach. Eight at 60 Hz is 133 milliseconds of correction.',
  ),
  define(
    'earliest',
    'i32',
    'The oldest tick still retained, or -1. An input older than this cannot be applied and the session cannot be made correct.',
  ),
  define(
    'replays',
    'i32',
    'How many rewinds have happened. A session correcting constantly has a link problem.',
  ),
  define(
    'replayedTicks',
    'i32',
    'How many ticks those rewinds re-ran in total. Divided by `replays`, the average depth of a correction.',
  ),
];

export function rollbackImplementation(): Record<string, unknown> {
  return {
    tick: (rewind: RewindLike) => rewind.tick,
    isReplaying: (rewind: RewindLike) => rewind.isReplaying,
    depth: (rewind: RewindLike) => rewind.depth,
    earliest: (rewind: RewindLike) => rewind.earliest,
    replays: (rewind: RewindLike) => rewind.stats.replays,
    replayedTicks: (rewind: RewindLike) => rewind.stats.replayedTicks,
  };
}
