/**
 * Occlusion tested against depth from **this** frame rather than the last one.
 *
 * A hierarchical depth buffer is only an occluder if something has already been drawn into it, and
 * the cheap way to have one at the start of a frame is to keep last frame's. That is wrong exactly
 * when the camera moved: the pyramid describes a view nobody is looking from, and geometry the old
 * view happened to hide is culled out of the new one. What it looks like is a wall or a floor
 * disappearing for a frame or two after a cut, a teleport, or a fast turn — and it is intermittent,
 * so it is reported as a streaming fault.
 *
 * **So the frame is drawn in two halves.** Phase one draws only what was visible last frame, which
 * on a continuous camera is nearly everything and is a good occluder for the rest. The pyramid is
 * reduced from *that* depth. Phase two then tests everything else against it and draws whatever
 * phase one missed. Both halves write the same colour and depth, because they are one frame.
 *
 * **The history decides which phase a cluster is judged in and never whether it is judged.** Every
 * cluster is in exactly one of the two lists, whatever the history holds, so a history that is
 * stale — which after a teleport is all of it — costs a phase-two test and never a hole. That
 * invariant is what makes the history safe to keep across a cut, and it is the one this file's
 * tests assert most directly.
 *
 * **One history per view.** A shadow pass and the main camera see different things, and sharing a
 * bit set between them puts one view's visibility into the other's phase one — which is the same
 * defect as a stale history, arriving every frame instead of after a cut.
 *
 * The pass recording here is the frame graph's data rather than device calls: `phaseOnePasses` and
 * `phaseTwoPasses` record what each half reads and writes, and the edge from the reduction's write
 * to phase two's read *is* the guarantee in the first paragraph. Wiring them to a real encoder is
 * Task 14's, against a consumer, for the reason `ARCHITECTURE.md` §3 gives about rendering changes
 * nobody has looked at.
 */

import { recordDeps } from '../frame/deps.ts';
import type { Deps } from '../frame/deps.ts';

/** Which clusters a view drew last frame, one bit each. */
export interface VisibilityHistory {
  /** Thirty-two clusters a word, cluster `n` at bit `n & 31` of word `n >> 5`. */
  bits: Uint32Array;
  /** How many clusters it has room for. A wider one is allocated rather than the old one read. */
  capacity: number;
}

export function createVisibilityHistory(capacity: number): VisibilityHistory {
  return { bits: new Uint32Array(Math.max(1, Math.ceil(capacity / 32))), capacity };
}

/**
 * Whether a cluster was drawn last frame.
 *
 * **Out of range answers false rather than throwing or wrapping.** A cluster index past the end is
 * a scene that grew since the history was made, and the honest answer for one nobody has seen is
 * "not last frame" — which puts it in phase two, where it is tested rather than assumed. Wrapping
 * would put an unrelated cluster's bit in its place, which is a visibility answer for the wrong
 * geometry and is invisible until it is wrong.
 *
 * **A perturbation survives this check and it is kept anyway.** `setHistory` refuses the same
 * range, so no bit above `capacity` can ever be set, and a read past the end of the word array is
 * `undefined` — which `&` coerces to zero and therefore answers false already. What it decides is
 * the case where the two guards disagree, and the reason both are here rather than one is that
 * they are read independently: the write side is the one a test can catch, and it is caught. The
 * bits between `capacity` and the end of the last word are the ones that make the write side
 * matter — forty clusters is two words, so twenty-four of them belong to nobody.
 */
export function historyHas(history: VisibilityHistory, cluster: number): boolean {
  if (cluster < 0 || cluster >= history.capacity) return false;
  return ((history.bits[cluster >> 5] as number) & (1 << (cluster & 31))) !== 0;
}

export function setHistory(history: VisibilityHistory, cluster: number, drawn: boolean): void {
  if (cluster < 0 || cluster >= history.capacity) return;
  const word = cluster >> 5;
  const mask = 1 << (cluster & 31);
  const held = history.bits[word] as number;
  history.bits[word] = drawn ? held | mask : held & ~mask;
}

export function clearHistory(history: VisibilityHistory): void {
  history.bits.fill(0);
}

/** How many of the first `count` clusters the history holds. */
export function historyCount(history: VisibilityHistory, count: number): number {
  let total = 0;
  for (let cluster = 0; cluster < count; cluster += 1) if (historyHas(history, cluster)) total += 1;
  return total;
}

/** The clusters phase one draws: exactly what was visible last frame, in index order. */
export function phaseOneClusters(
  history: VisibilityHistory,
  count: number,
  out: Uint32Array,
): number {
  let at = 0;
  for (let cluster = 0; cluster < count; cluster += 1) {
    if (!historyHas(history, cluster)) continue;
    out[at] = cluster;
    at += 1;
  }
  return at;
}

/** The clusters phase two tests: everything the history does not hold. */
export function phaseTwoClusters(
  history: VisibilityHistory,
  count: number,
  out: Uint32Array,
): number {
  let at = 0;
  for (let cluster = 0; cluster < count; cluster += 1) {
    if (historyHas(history, cluster)) continue;
    out[at] = cluster;
    at += 1;
  }
  return at;
}

/**
 * Replace the history with what this frame actually drew.
 *
 * **Replace rather than accumulate**, and that is the half that is easy to leave out: a cluster
 * kept in phase one and then culled in phase two has to leave the set, or it is drawn every frame
 * for ever on the strength of having once been visible. `keep` is the flag buffer
 * `cullClusters` writes, so this is one pass over the same array the draw used.
 */
export function updateHistory(history: VisibilityHistory, keep: Uint32Array, count: number): void {
  for (let cluster = 0; cluster < count; cluster += 1) {
    setHistory(history, cluster, (keep[cluster] ?? 0) !== 0);
  }
}

/** Every view's history, keyed by whatever identifier the caller gives its views. */
export interface VisibilityHistories {
  readonly byView: Map<number, VisibilityHistory>;
}

export function createVisibilityHistories(): VisibilityHistories {
  return { byView: new Map() };
}

/**
 * This view's history, widened in place if the scene grew.
 *
 * **Widened rather than replaced**, because replacing it throws away a frame of visibility every
 * time a cluster is added and puts the whole scene through phase two — which is correct and is
 * also the slow path this feature exists to avoid.
 */
export function historyFor(
  store: VisibilityHistories,
  view: number,
  capacity: number,
): VisibilityHistory {
  const held = store.byView.get(view);
  if (held === undefined) {
    const made = createVisibilityHistory(capacity);
    store.byView.set(view, made);
    return made;
  }
  if (capacity > held.capacity) {
    const widened = new Uint32Array(Math.max(1, Math.ceil(capacity / 32)));
    widened.set(held.bits);
    held.bits = widened;
    held.capacity = capacity;
  }
  return held;
}

/** The virtual resources a two-phase frame moves between its halves. */
export interface TwoPhaseResources {
  readonly colour: number;
  readonly depth: number;
  readonly hzb: number;
  readonly clusters: number;
  readonly keep: number;
}

/** Where phase one's two nodes landed in the dependency table. */
export interface PhaseOneNodes {
  readonly draw: number;
  readonly reduce: number;
}

/** Where phase two's two nodes landed. */
export interface PhaseTwoNodes {
  readonly cull: number;
  readonly draw: number;
}

/**
 * Phase one: draw what was visible, then reduce the depth it produced into the pyramid.
 *
 * The reduction reads the depth the draw wrote, so nothing can reorder them and nothing can alias
 * the depth away between them — which is exactly what `lifetime.ts` and `alias.ts` are reading
 * these edges for.
 */
export function phaseOnePasses(deps: Deps, res: TwoPhaseResources): PhaseOneNodes {
  const draw = recordDeps(deps, [res.clusters], [res.colour, res.depth]);
  const reduce = recordDeps(deps, [res.depth], [res.hzb]);
  return { draw, reduce };
}

/**
 * Phase two: cull everything else against that pyramid, then draw what survived.
 *
 * `cull` reads `hzb`, which `phaseOnePasses` wrote. That one edge is the whole claim of this
 * module — the depth being tested against belongs to this frame — expressed where the scheduler
 * can enforce it rather than in a comment somebody has to obey.
 */
export function phaseTwoPasses(deps: Deps, res: TwoPhaseResources): PhaseTwoNodes {
  const cull = recordDeps(deps, [res.hzb, res.clusters], [res.keep]);
  const draw = recordDeps(deps, [res.keep, res.clusters], [res.colour, res.depth]);
  return { cull, draw };
}
