/**
 * The log's job is that a replayed tick sees what the tick saw the first time, and that nothing it
 * still needs is quietly thrown away.
 *
 * The second half is the one that bit during design. A ring indexed by `tick % depth` is the
 * obvious shape and it evicts a retained past input the moment a peer sends one from ahead of the
 * local simulation, which is the normal condition on any real link.
 */
import { describe, expect, it } from 'vitest';
import { InputLog, repeatLastInput } from './inputLog.ts';

const bytes = (...values: number[]): Uint8Array => new Uint8Array(values);

function log(overrides: Partial<{ participants: number; depth: number; inputBytes: number }> = {}) {
  return new InputLog({
    participants: overrides.participants ?? 2,
    depth: overrides.depth ?? 8,
    inputBytes: overrides.inputBytes ?? 2,
  });
}

describe('an input log', () => {
  it('gives back what was recorded', () => {
    const inputs = log();
    inputs.set(0, 3, bytes(7, 9));

    const out = new Uint8Array(2);
    expect(inputs.into(0, 3, out)).toBe(true);
    expect(Array.from(out)).toEqual([7, 9]);
  });

  /**
   * A guess is written down, which is what makes a replay reproducible.
   *
   * Computing the prediction on each read would be fine while the prediction function is
   * `repeatLast` and a disaster the moment it depends on anything that has since changed — the
   * replay would guess differently from the run it is replaying, and the difference would have
   * nothing to do with the correction being applied.
   */
  it('stores a guess so a replay sees the same guess', () => {
    const inputs = log();
    inputs.set(0, 1, bytes(5, 5));

    const first = new Uint8Array(2);
    expect(inputs.into(0, 2, first)).toBe(false);
    expect(Array.from(first)).toEqual([5, 5]);

    /* Something else confirms a later tick, which moves what "the last input" is. */
    inputs.set(0, 4, bytes(99, 99));

    const again = new Uint8Array(2);
    expect(inputs.into(0, 2, again)).toBe(false);
    expect(Array.from(again)).toEqual([5, 5]);
  });

  /**
   * **The eviction bug the window exists to prevent.**
   *
   * With a depth of eight, tick 12 and tick 4 share a slot. A peer running ahead sends its input
   * for 12 while this end is still at 6, and a `tick % depth` ring would drop tick 4's confirmed
   * input to make room. A rewind to 4 would then re-predict an input it had already been told,
   * and the world would change under a correction that was about something else entirely.
   */
  it('does not let an input from ahead evict a retained one from behind', () => {
    const inputs = log({ depth: 8 });
    inputs.set(0, 4, bytes(1, 1));

    /* Tick 12 is outside [0, 8): refused rather than aliased onto tick 4's slot. */
    expect(inputs.set(0, 12, bytes(2, 2))).toBe(false);

    const out = new Uint8Array(2);
    expect(inputs.into(0, 4, out)).toBe(true);
    expect(Array.from(out)).toEqual([1, 1]);
  });

  it('accepts an input from ahead once the window has room for it', () => {
    const inputs = log({ depth: 8 });
    inputs.retain(6);
    expect(inputs.holds(12)).toBe(true);
    expect(inputs.set(0, 12, bytes(2, 2))).toBe(true);

    const out = new Uint8Array(2);
    expect(inputs.into(0, 12, out)).toBe(true);
    expect(Array.from(out)).toEqual([2, 2]);
  });

  /**
   * A slot that leaves the window is cleared, not left.
   *
   * Its `slotTick` would otherwise match a tick exactly one window later and answer a stale input
   * as a confirmed one — the same class of error as a stale sparse entry, and just as invisible.
   */
  it('clears what falls off the back of the window', () => {
    const inputs = log({ depth: 8 });
    inputs.set(0, 1, bytes(3, 3));
    inputs.retain(9);

    expect(inputs.isConfirmed(0, 1)).toBe(false);
    expect(inputs.isConfirmed(0, 9)).toBe(false);
  });

  it('reports whether every participant has spoken for a tick', () => {
    const inputs = log({ participants: 3 });
    inputs.set(0, 2, bytes(1, 0));
    inputs.set(1, 2, bytes(1, 0));
    expect(inputs.isComplete(2)).toBe(false);
    inputs.set(2, 2, bytes(1, 0));
    expect(inputs.isComplete(2)).toBe(true);
  });

  /**
   * A watermark stops at a gap, and this is the test that says so.
   *
   * Ticks 0, 1 and 3 complete with 2 missing is not a session confirmed to 3. Answering 3 would let
   * a peer discard the snapshot it still needs to correct tick 2.
   */
  it('confirms only up to the first gap', () => {
    const inputs = log({ participants: 2, depth: 8 });
    for (const tick of [0, 1, 3, 4]) {
      inputs.set(0, tick, bytes(1, 1));
      inputs.set(1, tick, bytes(1, 1));
    }
    expect(inputs.confirmedThrough(4)).toBe(1);

    inputs.set(0, 2, bytes(1, 1));
    inputs.set(1, 2, bytes(1, 1));
    expect(inputs.confirmedThrough(4)).toBe(4);
  });

  it('says when a real input changed what was held, and when it did not', () => {
    const inputs = log();
    const out = new Uint8Array(2);

    inputs.set(0, 0, bytes(4, 4));
    /* Predicted for tick 1 by repeating tick 0. */
    inputs.into(0, 1, out);

    expect(inputs.set(0, 1, bytes(4, 4))).toBe(false);
    expect(inputs.set(0, 1, bytes(4, 5))).toBe(true);
  });

  /**
   * An out-of-order arrival must not become "the last input".
   *
   * Packets reorder, so tick 7 can land before tick 6. Letting the later arrival win would make the
   * predictor repeat an older input than the one it has, and the guess for tick 8 would be wrong in
   * a way no test of a single tick could see.
   */
  it('predicts from the newest confirmed input, not the last one to arrive', () => {
    /* Sixteen deep so tick 8 is inside the window; at eight it is one past the end. */
    const inputs = log({ depth: 16 });
    inputs.set(0, 7, bytes(70, 70));
    inputs.set(0, 6, bytes(60, 60));

    const out = new Uint8Array(2);
    expect(inputs.into(0, 8, out)).toBe(false);
    expect(Array.from(out)).toEqual([70, 70]);
  });

  it('zeroes the output and reports unconfirmed for a tick outside the window', () => {
    const inputs = log({ depth: 4 });
    const out = new Uint8Array([9, 9]);
    expect(inputs.into(0, 99, out)).toBe(false);
    expect(Array.from(out)).toEqual([0, 0]);
  });

  it('refuses an unknown participant rather than writing past its own array', () => {
    const inputs = log({ participants: 2 });
    expect(inputs.set(5, 0, bytes(1, 1))).toBe(false);
    expect(inputs.isConfirmed(5, 0)).toBe(false);
  });

  it('takes a replacement predictor', () => {
    const inputs = new InputLog({
      participants: 1,
      depth: 8,
      inputBytes: 1,
      /* A tap rather than a hold: absent means released, whatever was pressed last. */
      predict: (_p, _t, _previous, out) => out.fill(0),
    });
    inputs.set(0, 0, bytes(1));

    const out = new Uint8Array(1);
    expect(inputs.into(0, 1, out)).toBe(false);
    expect(out[0]).toBe(0);

    /* And the default really does the opposite, so the seam is doing something. */
    const held = log({ participants: 1, inputBytes: 1 });
    held.set(0, 0, bytes(1));
    const heldOut = new Uint8Array(1);
    repeatLastInput(0, 1, bytes(1), heldOut);
    held.into(0, 1, heldOut);
    expect(heldOut[0]).toBe(1);
  });
});
