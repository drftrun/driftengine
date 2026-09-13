/**
 * The façade a script holds, and the slot table under it.
 *
 * Everything here is total: a slot out of range does nothing on a write and answers zero on a read,
 * because the caller is a frame loop and `drift/network`'s capabilities have no way to report a
 * refusal — the language has no optional to answer a miss with.
 */
import { describe, expect, it } from 'vitest';
import { ScriptSession } from './scriptSession.ts';

describe('a script session', () => {
  it('publishes and reads back a slot', () => {
    const session = new ScriptSession({ self: 1, participants: 3, slots: 4 });
    session.replicate(2, 42.5);
    expect(session.replicated(1, 2)).toBe(42.5);
  });

  it('keeps each participant separate', () => {
    const session = new ScriptSession({ self: 0, participants: 2, slots: 2 });
    session.replicate(0, 7);
    expect(session.replicated(0, 0)).toBe(7);
    expect(session.replicated(1, 0)).toBe(0);
  });

  it('is total at both ends of the range', () => {
    const session = new ScriptSession({ self: 0, participants: 2, slots: 2 });
    session.replicate(99, 5);
    session.replicate(-1, 5);
    expect(session.replicated(0, 99)).toBe(0);
    expect(session.replicated(9, 0)).toBe(0);
    expect(session.replicated(-1, -1)).toBe(0);
  });

  it('reports nothing about a driver it has not been pointed at', () => {
    const session = new ScriptSession({ self: 0, participants: 2 });
    expect(session.confirmed).toBe(-1);
    expect(session.halted).toBe(false);
    expect(session.haltReason).toBe('');
  });

  it('reflects the driver it follows', () => {
    const session = new ScriptSession({ self: 0, participants: 2 });
    session.follow({ confirmed: 412, status: 'halted', reason: 'state diverged at tick 400' });
    expect(session.confirmed).toBe(412);
    expect(session.halted).toBe(true);
    expect(session.haltReason).toMatch(/tick 400/);
  });

  /** It is its own `Replicator`, so an authority can publish the slot table with no extra code. */
  it('round-trips its whole table through encode and apply', () => {
    const host = new ScriptSession({ self: 0, participants: 2, slots: 3 });
    host.replicate(0, 1.5);
    host.replicate(2, -9.25);

    const bytes = new Uint8Array(1024);
    const length = host.encode(bytes, 0);
    expect(length).toBeGreaterThan(0);

    const client = new ScriptSession({ self: 1, participants: 2, slots: 3 });
    client.apply(bytes.subarray(0, length), 0);

    expect(client.replicated(0, 0)).toBe(1.5);
    expect(client.replicated(0, 2)).toBe(-9.25);
  });

  /**
   * **An unaligned payload, which is the case a transport actually hands over.**
   *
   * A decoded state's bytes are a subarray starting seven bytes into the message, and a
   * `Float64Array` view over an offset that is not a multiple of eight throws. This is why `apply`
   * copies through a `DataView` a byte at a time rather than taking a typed-array view.
   */
  it('applies a payload whose byte offset is not eight-aligned', () => {
    const host = new ScriptSession({ self: 0, participants: 1, slots: 2 });
    host.replicate(0, 3.25);

    const framed = new Uint8Array(64);
    const length = host.encode(framed.subarray(7), 0);
    expect(length).toBeGreaterThan(0);

    const client = new ScriptSession({ self: 0, participants: 1, slots: 2 });
    expect(() => client.apply(framed.subarray(7, 7 + length), 0)).not.toThrow();
    expect(client.replicated(0, 0)).toBe(3.25);
  });

  it('refuses to encode into a buffer that cannot hold the table', () => {
    const session = new ScriptSession({ self: 0, participants: 4, slots: 8 });
    expect(session.encode(new Uint8Array(4), 0)).toBe(-1);
  });
});
