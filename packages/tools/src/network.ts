/**
 * Snapshots, rollback depth, and the frame two peers stopped agreeing on.
 *
 * **Nobody else has this panel, because nobody else has the state to put in it.** The one that
 * matters is divergence: `@driftengine/network` already fingerprints every snapshot and reports a
 * `Desync` carrying the tick, the peer and both digests, and nothing has ever shown it to anybody.
 *
 * **An empty divergence list and a missing one must not look the same.** One says the peers agree;
 * the other says nobody checked. Those are the two answers somebody most needs to tell apart, and
 * a panel that renders both as blank space is worse than no panel — it reads as agreement. So no
 * session says "No session", and no divergence says "peers agree" in as many words.
 *
 * **Which component differs is answerable only where somebody hashed per component.** `Fingerprint`
 * digests a whole snapshot, so `Desync` is two sixteen-character strings and nothing finer. Where a
 * caller supplies a per-component breakdown this names the component; where it does not, it says
 * the breakdown is absent rather than showing an empty line that reads as "no component differs".
 */
import { addUiChild, createUiNode } from '@driftengine/ui2d';
import type { UiNode } from '@driftengine/ui2d';
import type { Desync } from '@driftengine/network';
import { divergentComponents } from './divergence.ts';
import type { Command } from './command.ts';
import { createPanelRoot, emptyPanel, type Panel } from './panel.ts';

/**
 * What the panel needs of a session.
 *
 * Supplied rather than read off a `LockstepSession`, for the reason the asset index is supplied:
 * an editor attached to a session, a recording or a replay wants the same panel, and only two of
 * those have a session to read.
 */
export interface NetworkReadout {
  readonly inputDelay: number;
  readonly participants: number;
  /** Bytes in one snapshot slot. */
  readonly snapshotBytes: number;
  /** How many slots the rewind window holds. */
  readonly snapshotCount: number;
  /** Everything the session has seen disagree, oldest first. */
  readonly desyncs: readonly Desync[];
  /** A per-component breakdown, where the caller has one. See the header. */
  readonly componentHashes: {
    readonly ours: ReadonlyMap<string, string>;
    readonly theirs: ReadonlyMap<string, string>;
  } | null;
}

/**
 * Which components two peers hash differently, in the order they are first seen.
 *
 * **The comparison itself lives in `pie/divergence.ts`**, which is where the divergence search
 * needs it too. Two copies of "which of these hashes disagree" is two places for the rule about a
 * component only one side has to be got wrong, and a panel is the wrong owner of a rule — it uses
 * one. This keeps its own shape, returning a fresh array, because a panel builds a line of text
 * from it once per rebuild and an out-parameter would be ceremony for nothing.
 */
export function componentDivergence(
  ours: ReadonlyMap<string, string>,
  theirs: ReadonlyMap<string, string>,
): string[] {
  const out: string[] = [];
  divergentComponents(ours, theirs, out);
  return out;
}

/** A fixed window of how deep each recent frame rewound. */
export interface RollbackHistory {
  readonly depth: Int32Array;
  head: number;
  filled: number;
}

export function createRollbackHistory(capacity: number): RollbackHistory {
  return { depth: new Int32Array(Math.max(1, capacity)), head: 0, filled: 0 };
}

export function pushRollback(history: RollbackHistory, depth: number): void {
  const capacity = history.depth.length;
  history.depth[history.head] = depth;
  history.head = (history.head + 1) % capacity;
  if (history.filled < capacity) history.filled += 1;
}

export function rollbackValues(history: RollbackHistory): number[] {
  const capacity = history.depth.length;
  const first = history.filled < capacity ? 0 : history.head;
  const out: number[] = [];
  for (let at = 0; at < history.filled; at += 1) {
    out.push(history.depth[(first + at) % capacity] as number);
  }
  return out;
}

export interface NetworkWorld {
  /** Null where the editor is not attached to anything. */
  readonly session: NetworkReadout | null;
}

export interface NetworkView {
  readonly root: UiNode;
  readonly rollback: RollbackHistory;
  rowHeight: number;
}

export function createNetworkView(options: {
  rowHeight?: number;
  historyLength?: number;
}): NetworkView {
  return {
    root: createPanelRoot(networkPanel),
    rollback: createRollbackHistory(options.historyLength ?? 60),
    rowHeight: options.rowHeight ?? 18,
  };
}

/** Kilobytes to one decimal, which is the resolution a snapshot budget is argued at. */
function kilobytes(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function lineAt(root: UiNode, index: number, text: string, height: number): void {
  const existing = root.children[index];
  if (existing !== undefined) {
    existing.hidden = false;
    existing.text = text;
    return;
  }
  addUiChild(
    root,
    createUiNode({ width: 'grow', height, text, interactive: false, name: `line:${index}` }),
  );
}

export const networkPanel: Panel<NetworkWorld, NetworkView> = {
  id: 'network',
  title: 'Network',

  build(world, view, root): void {
    const session = world.session;
    if (session === null) {
      emptyPanel(root, 'No session');
      return;
    }

    const lines = [
      `delay  ${session.inputDelay} ticks`,
      `peers  ${session.participants}`,
      `snapshots  ${session.snapshotCount} of ${kilobytes(session.snapshotBytes)} — ${kilobytes(session.snapshotBytes * session.snapshotCount)}`,
      `rollback  ${rollbackValues(view.rollback).join(' ')}`,
    ];

    const first = session.desyncs[0];
    if (first === undefined) {
      lines.push('peers agree on every fingerprint so far');
    } else {
      lines.push(`diverged at tick ${first.tick} against ${first.peer}`);
      lines.push(`  ours ${first.ours}`);
      lines.push(`  theirs ${first.theirs}`);
      const hashes = session.componentHashes;
      if (hashes === null) {
        lines.push('  no per-component hashes were supplied');
      } else {
        const differing = componentDivergence(hashes.ours, hashes.theirs);
        lines.push(
          differing.length === 0
            ? '  every component agrees, so the difference is outside them'
            : `  differing: ${differing.join(', ')}`,
        );
      }
    }

    for (let at = 0; at < lines.length; at += 1) {
      lineAt(root, at, lines[at] as string, view.rowHeight);
    }
    for (let at = lines.length; at < root.children.length; at += 1) {
      (root.children[at] as UiNode).hidden = true;
    }
  },

  route(): Command | null {
    /* Read-only, and deliberately: there is nothing in a session's diagnostics a person should be
       able to edit, and a panel that let them would be editing the evidence. */
    return null;
  },
};
