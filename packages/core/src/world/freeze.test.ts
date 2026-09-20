import { describe, expect, it } from 'vitest';
import { cellIdFor } from './cell.ts';
import {
  createFrozenCells,
  freezeCell,
  frozenEntities,
  frozenFingerprintContribution,
  isCellFrozen,
  thawCell,
  type FreezableWorld,
  type FrozenCells,
} from './freeze.ts';

const SIZE = 100;
const AWAY = cellIdFor(500, 0, 0, SIZE);
const HOME = cellIdFor(0, 0, 0, SIZE);

/**
 * A world of four entities, two at home and two five cells away.
 *
 * Each carries a position and an accumulator standing in for whatever a constraint solver would be
 * holding mid-interaction. Both advance by fixed amounts, so the whole thing is exactly
 * reproducible and every number below can be written out by hand.
 */
function world(): FreezableWorld & {
  live: Set<number>;
  state: Map<number, [number, number]>;
  cellOf: Map<number, number>;
  step(): void;
} {
  const state = new Map<number, [number, number]>([
    [1, [0, 0.5]],
    [2, [10, 1.5]],
    [3, [500, 2.5]],
    [4, [510, 3.5]],
  ]);
  const cellOf = new Map<number, number>([
    [1, HOME],
    [2, HOME],
    [3, AWAY],
    [4, AWAY],
  ]);
  const live = new Set<number>([1, 2, 3, 4]);

  return {
    live,
    state,
    cellOf,
    step(): void {
      for (const entity of [1, 2, 3, 4]) {
        if (!live.has(entity)) continue;
        const values = state.get(entity) as [number, number];
        values[0] += entity;
        values[1] = values[1] * 0.5 + entity;
      }
    },
    entitiesIn: (cell) => [...cellOf.entries()].filter(([, c]) => c === cell).map(([e]) => e),
    readState: (entity, out) => {
      const values = state.get(entity) as [number, number];
      out[0] = values[0];
      out[1] = values[1];
      return 2;
    },
    writeState: (entity, values) => {
      state.set(entity, [values[0] as number, values[1] as number]);
    },
    simulating: (entity) => live.has(entity),
    setSimulating: (entity, on) => {
      if (on) live.add(entity);
      else live.delete(entity);
    },
  };
}

/** The whole world's fingerprint: every live entity, then every frozen cell's contribution. */
function fingerprint(w: ReturnType<typeof world>, frozen: FrozenCells): string {
  let h = 0x811c9dc5;
  const bytes = new DataView(new ArrayBuffer(8));
  const eat = (value: number): void => {
    bytes.setFloat64(0, value);
    for (let at = 0; at < 8; at += 1) {
      h = Math.imul(h ^ bytes.getUint8(at), 0x01000193) >>> 0;
    }
  };
  for (const entity of [1, 2, 3, 4]) {
    if (!w.live.has(entity)) continue;
    const values = w.state.get(entity) as [number, number];
    eat(entity);
    eat(values[0]);
    eat(values[1]);
  }
  for (const cell of [...frozen.cells.keys()].sort((a, b) => a - b)) {
    eat(frozenFingerprintContribution(frozen, cell));
  }
  return h.toString(16).padStart(8, '0');
}

describe('freezing a cell', () => {
  it('stops its entities simulating and leaves everything else alone', () => {
    const w = world();
    const frozen = createFrozenCells();
    freezeCell(w, frozen, AWAY);

    expect(isCellFrozen(frozen, AWAY)).toBe(true);
    expect(frozenEntities(frozen, AWAY)).toEqual([3, 4]);
    expect(w.live.has(3)).toBe(false);
    expect(w.live.has(1), 'the home cell is untouched').toBe(true);

    const before = [...(w.state.get(3) as [number, number])];
    w.step();
    expect(w.state.get(3), 'a frozen entity does not move').toEqual(before);
    expect((w.state.get(1) as number[])[0], 'a live one does').toBe(1);
  });

  it('is exact through a freeze and a thaw, with nothing in between', () => {
    const w = world();
    const frozen = createFrozenCells();
    const before = new Map([...w.state].map(([e, v]) => [e, [...v]]));

    freezeCell(w, frozen, AWAY);
    thawCell(w, frozen, AWAY);

    expect([...w.state].map(([e, v]) => [e, [...v]])).toEqual([...before]);
    expect(isCellFrozen(frozen, AWAY)).toBe(false);
    expect(w.live.has(3)).toBe(true);
  });

  /**
   * **Thawing puts an entity where it was frozen and never where it would have got to.** An
   * extrapolated thaw is how an unloaded region silently diverges from a loaded one: nothing
   * throws, the numbers are plausible, and the fingerprints stop matching at a frame nobody can
   * point at.
   */
  it('thaws to the frozen state and not to an extrapolated one', () => {
    const w = world();
    const frozen = createFrozenCells();
    freezeCell(w, frozen, AWAY);
    const parked = [...(w.state.get(3) as [number, number])];

    for (let at = 0; at < 50; at += 1) w.step();
    thawCell(w, frozen, AWAY);

    expect(w.state.get(3)).toEqual(parked);
  });

  it('keeps an accumulator that a constraint would be holding, to the last bit', () => {
    const w = world();
    const frozen = createFrozenCells();
    /* Advance into an accumulator value that is not representable as a short decimal. */
    for (let at = 0; at < 7; at += 1) w.step();
    const mid = (w.state.get(4) as [number, number])[1];
    expect(
      Number.isInteger(mid),
      'a value with a fraction, so the round trip has to be exact',
    ).toBe(false);

    freezeCell(w, frozen, AWAY);
    for (let at = 0; at < 20; at += 1) w.step();
    thawCell(w, frozen, AWAY);

    expect((w.state.get(4) as [number, number])[1]).toBe(mid);
  });

  it('refuses to freeze a cell twice, and to thaw one that is not frozen', () => {
    const w = world();
    const frozen = createFrozenCells();
    expect(freezeCell(w, frozen, AWAY)).toBe(true);
    expect(freezeCell(w, frozen, AWAY)).toBe(false);
    expect(thawCell(w, frozen, AWAY)).toBe(true);
    expect(thawCell(w, frozen, AWAY)).toBe(false);
  });
});

describe("a frozen cell's contribution to the fingerprint", () => {
  it('is the same every time it is asked', () => {
    const w = world();
    const frozen = createFrozenCells();
    freezeCell(w, frozen, AWAY);
    const once = frozenFingerprintContribution(frozen, AWAY);
    for (let at = 0; at < 10; at += 1) w.step();
    expect(frozenFingerprintContribution(frozen, AWAY), 'frozen means frozen').toBe(once);
  });

  it('differs when the state that was frozen differs', () => {
    const a = world();
    const b = world();
    (b.state.get(3) as [number, number])[0] += 1e-9;

    const fa = createFrozenCells();
    const fb = createFrozenCells();
    freezeCell(a, fa, AWAY);
    freezeCell(b, fb, AWAY);
    expect(frozenFingerprintContribution(fa, AWAY)).not.toBe(
      frozenFingerprintContribution(fb, AWAY),
    );
  });

  it('is zero for a cell nothing froze', () => {
    expect(frozenFingerprintContribution(createFrozenCells(), AWAY)).toBe(0);
  });
});

/**
 * **The most important test in the wave.**
 *
 * A run that streamed a region and one that never did must agree at *every* frame and not merely
 * at the end. Agreeing only at the end would mean the two diverged and came back, which is a
 * simulation that produced different numbers for a while — and in a rollback netcode those numbers
 * have already been sent.
 *
 * What makes it possible is that **freezing is a simulation decision and unloading is a memory
 * one**. A frozen cell does not simulate whether or not its contents are resident, and only a
 * frozen cell may be unloaded. So streaming cannot change what the simulation computes; it can
 * only change where the bytes live.
 */
describe('a run that streamed against a run that did not', () => {
  function run(unload: boolean, nudge = 0): string[] {
    const w = world();
    if (nudge !== 0) (w.state.get(3) as [number, number])[0] += nudge;
    const frozen = createFrozenCells();
    const prints: string[] = [];
    let parked: FrozenCells | null = null;

    for (let tick = 0; tick < 40; tick += 1) {
      if (tick === 10) {
        freezeCell(w, frozen, AWAY);
        if (unload) {
          /* Unloading: the world forgets the entities entirely and the snapshot is all there is. */
          for (const entity of frozenEntities(frozen, AWAY)) {
            w.state.delete(entity);
            w.cellOf.delete(entity);
          }
          parked = frozen;
        }
      }
      if (tick === 30) {
        if (unload && parked !== null) {
          for (const entity of frozenEntities(parked, AWAY)) w.cellOf.set(entity, AWAY);
        }
        thawCell(w, frozen, AWAY);
      }
      w.step();
      prints.push(fingerprint(w, frozen));
    }
    return prints;
  }

  it('produces the same fingerprint at every single frame', () => {
    const loaded = run(false);
    const streamed = run(true);
    expect(streamed.length).toBe(40);
    expect(streamed).toEqual(loaded);
  });

  it('is a test that could fail, which the run either side of the window proves', () => {
    const loaded = run(false);
    /* The frozen window really does hold those entities still, so the two halves differ. */
    expect(loaded[9]).not.toBe(loaded[29]);
    expect(loaded[31]).not.toBe(loaded[29]);
  });

  /**
   * **What the frozen contribution is actually for**, and the perturbation that shows it. Two runs
   * that froze *different* state must be seen to disagree at the frame they froze, not twenty
   * frames later when they thaw. Without the contribution they agree for the whole window — the
   * frozen entities are invisible to the fingerprint while frozen — and the divergence surfaces
   * at the thaw, pointing at a frame where nothing happened. In a rollback netcode those twenty
   * frames of agreement have already been sent.
   */
  it('shows a divergence at the frame the cell froze, not at the frame it thawed', () => {
    const clean = run(true);
    const nudged = run(true, 1e-9);

    expect(nudged[9], 'they were already different before the freeze').not.toBe(clean[9]);
    expect(nudged[10], 'and stay different through the window').not.toBe(clean[10]);
    expect(nudged[20]).not.toBe(clean[20]);
    expect(nudged[35], 'and after it').not.toBe(clean[35]);
  });
});
