/**
 * The impairment model is a test instrument, so its own reproducibility is the first thing checked.
 *
 * An instrument whose readings vary between runs cannot be used to find a bug that varies between
 * runs, which is the only kind of bug netcode has.
 */
import { describe, expect, it } from 'vitest';
import { LoopbackNetwork } from './loopback.ts';
import { BROADCAST } from './transport.ts';

const bytes = (...values: number[]) => new Uint8Array(values);

function collect(): { sink: (from: number, message: Uint8Array) => void; seen: string[] } {
  const seen: string[] = [];
  return {
    sink: (from, message) => seen.push(`${from}:${Array.from(message).join(',')}`),
    seen,
  };
}

describe('the loopback transport', () => {
  it('delivers after the latency and not before', () => {
    const net = new LoopbackNetwork();
    const a = net.open({ self: 0, impairment: { latencyMs: 50 } });
    const b = net.open({ self: 1 });
    const received = collect();

    a.send(1, bytes(7));
    net.advance(49);
    b.drain(received.sink);
    expect(received.seen).toEqual([]);

    net.advance(2);
    b.drain(received.sink);
    expect(received.seen).toEqual(['0:7']);
  });

  it('does not deliver a message to its own sender', () => {
    const net = new LoopbackNetwork();
    const a = net.open({ self: 0 });
    net.open({ self: 1 });
    const received = collect();

    a.send(BROADCAST, bytes(1));
    net.advance(1);
    a.drain(received.sink);
    expect(received.seen).toEqual([]);
  });

  /**
   * **The property the whole instrument exists for.**
   *
   * Two networks with the same seed and the same sends produce byte-identical delivery, including
   * which messages were dropped and in what order the rest arrived. Without this, a failing rollback
   * test cannot be re-run.
   */
  it('reproduces a delivery schedule exactly from a seed', () => {
    const run = () => {
      const net = new LoopbackNetwork();
      const a = net.open({
        self: 0,
        seed: 20260903,
        impairment: {
          latencyMs: 30,
          jitterMs: 20,
          loss: 0.25,
          reorder: 0.3,
          reorderMs: 40,
          duplicate: 0.1,
        },
      });
      net.open({ self: 1 });
      const b = net.reach(1)[0];
      const received = collect();
      for (let i = 0; i < 60; i++) {
        a.send(1, bytes(i));
        net.advance(16);
        b?.drain(received.sink);
      }
      net.advance(500);
      b?.drain(received.sink);
      return { order: received.seen, dropped: a.dropped, sent: a.sent };
    };

    const first = run();
    const second = run();
    expect(second.order).toEqual(first.order);
    expect(second.dropped).toBe(first.dropped);
    /* And the link really was bad, or the assertion above is about nothing. */
    expect(first.dropped).toBeGreaterThan(5);
    expect(first.order.length).toBeGreaterThan(30);
  });

  it('a different seed gives a different schedule', () => {
    const run = (seed: number) => {
      const net = new LoopbackNetwork();
      const a = net.open({ self: 0, seed, impairment: { loss: 0.3 } });
      net.open({ self: 1 });
      const b = net.reach(1)[0];
      const received = collect();
      for (let i = 0; i < 40; i++) a.send(1, bytes(i));
      net.advance(1);
      b?.drain(received.sink);
      return received.seen;
    };
    expect(run(1)).not.toEqual(run(2));
  });

  /**
   * A message is copied at `send`, and this is the assertion that says so.
   *
   * Every caller in this package sends from a reusable buffer. Holding a reference would deliver
   * whatever was last written into it — a bug that looks exactly like a reordering bug and is not
   * one, which is the sort of thing that costs a day.
   */
  it('copies the bytes, so a reused send buffer cannot rewrite a message in flight', () => {
    const net = new LoopbackNetwork();
    const a = net.open({ self: 0, impairment: { latencyMs: 10 } });
    const b = net.open({ self: 1 });
    const shared = new Uint8Array([1, 2, 3]);
    const received = collect();

    a.send(1, shared);
    shared[0] = 99;
    net.advance(11);
    b.drain(received.sink);

    expect(received.seen).toEqual(['0:1,2,3']);
  });

  it('reordering really reorders, and everything still arrives', () => {
    const net = new LoopbackNetwork();
    const a = net.open({
      self: 0,
      seed: 7,
      impairment: { latencyMs: 10, reorder: 0.5, reorderMs: 60 },
    });
    const b = net.open({ self: 1 });
    const received = collect();

    for (let i = 0; i < 20; i++) a.send(1, bytes(i));
    net.advance(500);
    b.drain(received.sink);

    const order = received.seen.map((entry) => Number(entry.split(':')[1]));
    expect(order.length).toBe(20);
    expect([...order].sort((x, y) => x - y)).toEqual([...Array(20).keys()]);
    expect(order).not.toEqual([...Array(20).keys()]);
  });

  it('duplicates deliver twice', () => {
    const net = new LoopbackNetwork();
    const a = net.open({ self: 0, seed: 3, impairment: { duplicate: 1 } });
    const b = net.open({ self: 1 });
    const received = collect();

    a.send(1, bytes(5));
    net.advance(1);
    b.drain(received.sink);

    expect(received.seen).toEqual(['0:5', '0:5']);
  });

  it('a closed transport sends nothing and receives nothing', () => {
    const net = new LoopbackNetwork();
    const a = net.open({ self: 0 });
    const b = net.open({ self: 1 });
    const received = collect();

    b.close();
    a.send(1, bytes(1));
    net.advance(10);
    b.drain(received.sink);
    expect(received.seen).toEqual([]);
    expect(b.state).toBe('closed');
  });

  it('broadcasts reach everyone but the sender', () => {
    const net = new LoopbackNetwork();
    const a = net.open({ self: 0 });
    const b = net.open({ self: 1 });
    const c = net.open({ self: 2 });
    const toB = collect();
    const toC = collect();

    a.send(BROADCAST, bytes(9));
    net.advance(1);
    b.drain(toB.sink);
    c.drain(toC.sink);

    expect(toB.seen).toEqual(['0:9']);
    expect(toC.seen).toEqual(['0:9']);
  });

  /** A drain hands each message once. A second drain with nothing new is empty, not a repeat. */
  it('drains once', () => {
    const net = new LoopbackNetwork();
    const a = net.open({ self: 0 });
    const b = net.open({ self: 1 });
    const received = collect();

    a.send(1, bytes(1));
    net.advance(1);
    b.drain(received.sink);
    b.drain(received.sink);

    expect(received.seen).toEqual(['0:1']);
  });
});
