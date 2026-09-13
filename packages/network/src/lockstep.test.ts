/**
 * Two peers over an impaired link end up in the same world, and a session that cannot be made
 * correct stops rather than carrying on.
 *
 * The convergence test is differential: a lockstep pair against a single simulation given every
 * input on time. Asserting only that the two peers agree with *each other* would pass a pair that
 * agreed on the wrong answer, which is exactly what two peers running the same broken code do.
 */
import { describe, expect, it } from 'vitest';
import { savableMulberry32 } from '@driftengine/core';
import { World, defineComponent } from '@driftengine/entities';
import { InputLog } from './inputLog.ts';
import { LockstepSession } from './lockstep.ts';
import { LoopbackNetwork, type Impairment } from './loopback.ts';
import { RewindLoop } from './rewind.ts';
import type { Transport } from './transport.ts';
import { encodeInput } from './wire.ts';
import { combineSnapshotters, randomSnapshotter, worldSnapshotter } from './snapshotter.ts';

const Body = defineComponent('LBody', { x: 'f64', vx: 'f64' });
const FIXED_DT = 1 / 60;
const PARTICIPANTS = 2;

function makePeer(
  self: number,
  transport: ReturnType<LoopbackNetwork['open']> | null,
  redundancy?: number,
  rewindDepth = 24,
) {
  const world = new World();
  const rng = savableMulberry32(4242);
  const entities = [world.create(), world.create()];
  for (const e of entities) world.add(e, Body, { x: 0, vx: 0 });

  const inputs = new InputLog({ participants: PARTICIPANTS, depth: 64, inputBytes: 1 });
  const scratch = new Uint8Array(1);

  const step = (dt: number, tick: number): void => {
    for (let p = 0; p < PARTICIPANTS; p++) {
      inputs.into(p, tick, scratch);
      const e = entities[p] as number;
      const push = ((scratch[0] as number) & 1) === 1 ? 6 : -1;
      const vx = (world.read(e, Body, 'vx') as number) + push * dt + rng.next() * 1e-6;
      world.write(e, Body, 'vx', vx);
      world.write(e, Body, 'x', (world.read(e, Body, 'x') as number) + vx * dt);
    }
  };

  const loop = new RewindLoop({
    step,
    snapshotter: combineSnapshotters([worldSnapshotter(world), randomSnapshotter(rng)] as never[]),
    inputs,
    fixedDt: FIXED_DT,
    depth: rewindDepth,
  });

  const session =
    transport === null
      ? null
      : new LockstepSession({
          transport,
          loop,
          inputs,
          self,
          participants: PARTICIPANTS,
          inputDelay: 2,
          fingerprintEvery: 4,
          redundancy,
        });

  return { world, entities, inputs, loop, session };
}

/** Participant 0 taps twice; participant 1 holds from tick 30. Neither is predictable by repeating. */
const input = (participant: number, tick: number): Uint8Array =>
  new Uint8Array([
    participant === 0
      ? (tick >= 12 && tick <= 15) || (tick >= 40 && tick <= 43)
        ? 1
        : 0
      : tick >= 30
        ? 1
        : 0,
  ]);

const INPUT_DELAY = 2;

function runPair(impairment: Impairment, ticks: number, redundancy?: number, rewindDepth?: number) {
  const net = new LoopbackNetwork();
  const a = makePeer(0, net.open({ self: 0, seed: 11, impairment }), redundancy, rewindDepth);
  const b = makePeer(1, net.open({ self: 1, seed: 22, impairment }), redundancy, rewindDepth);

  for (let tick = 0; tick < ticks; tick++) {
    a.session?.poll();
    b.session?.poll();
    a.session?.submit(tick, input(0, tick));
    b.session?.submit(tick, input(1, tick));
    a.session?.advance(FIXED_DT, tick);
    b.session?.advance(FIXED_DT, tick);
    net.advance(1000 / 60);
  }
  return { a, b };
}

/**
 * One simulation told everything on time: the answer the pair must agree with.
 *
 * **It applies the same input delay**, because the delay is part of the game's rules and not part
 * of the networking. A player presses at tick *T* and the simulation acts on it at *T + delay* on
 * every peer, so a reference that acted immediately would be a different game — and comparing
 * against it would fail for a reason that has nothing to do with rollback. That mistake is what
 * this comment is here to stop somebody repeating.
 */
function runReference(ticks: number) {
  const solo = makePeer(0, null);
  for (let tick = 0; tick < ticks; tick++) {
    /*
     * **The window is moved, exactly as a session moves it.** A log that is never told to forget
     * runs out at its depth and then *refuses* every write — correctly, and silently as far as a
     * caller ignoring the return value is concerned. This reference used zeros from tick 64 onward
     * for that reason and blamed the peers for the difference, which is the log's refusal working
     * and the harness not listening.
     */
    solo.inputs.retain(Math.max(0, tick - 20));
    for (let p = 0; p < PARTICIPANTS; p++) {
      if (tick < INPUT_DELAY) continue;
      const accepted = solo.inputs.set(p, tick, input(p, tick - INPUT_DELAY));
      expect(accepted || tick === 0, `reference input for tick ${tick} was refused`).toBe(true);
    }
    solo.loop.advance(FIXED_DT, tick);
  }
  return solo;
}

/**
 * The tick all three runs are compared at, and it is a *past* one on purpose.
 *
 * `digestOf` reads the ring slot, which holds the state as that tick began — final once every input
 * below it is confirmed. The newest tick is speculative on a peer and settled on the reference, so
 * comparing there would fail on healthy runs. Five ticks back is comfortably past the last
 * correction on every link tested here, and well inside the twenty-four-deep ring.
 */
function agreementTick(ticks: number): number {
  return ticks - 5;
}

describe('a lockstep session', () => {
  /**
   * **Differential, against a run that never networked anything.**
   *
   * Two peers agreeing with each other proves they ran the same code; agreeing with a reference
   * proves they ran it on the right inputs.
   */
  it('converges on the world a single simulation would have produced', () => {
    const ticks = 90;
    const { a, b } = runPair({ latencyMs: 40, jitterMs: 10 }, ticks);
    const reference = runReference(ticks);

    const at = agreementTick(ticks);
    expect(a.session?.status).toBe('running');
    expect(b.session?.status).toBe('running');
    expect(a.loop.digestOf(at)).toBe(reference.loop.digestOf(at));
    expect(b.loop.digestOf(at)).toBe(reference.loop.digestOf(at));
    /* And the digest is of something, rather than null on all three. */
    expect(reference.loop.digestOf(at)).not.toBe(null);
  });

  /**
   * Inside the input delay's budget nobody predicts, so nobody rewinds.
   *
   * Two ticks of delay is 33 ms; a 10 ms link fits inside it comfortably. If this ever starts
   * rewinding, the delay has stopped buying what the header says it buys.
   */
  it('does not rewind at all when the link fits inside the input delay', () => {
    const { a, b } = runPair({ latencyMs: 10 }, 60);
    expect(a.loop.stats.replays).toBe(0);
    expect(b.loop.stats.replays).toBe(0);
  });

  /** And past that budget it does rewind, and still lands in the right place. */
  it('rewinds on a link past the budget, and still converges', () => {
    const ticks = 90;
    const { a, b } = runPair({ latencyMs: 120, jitterMs: 30 }, ticks);
    const reference = runReference(ticks);

    const at = agreementTick(ticks);
    expect(a.loop.stats.replays).toBeGreaterThan(0);
    expect(a.loop.digestOf(at)).toBe(reference.loop.digestOf(at));
    expect(b.loop.digestOf(at)).toBe(reference.loop.digestOf(at));
  });

  it('survives loss, reordering and duplication and still converges', () => {
    const ticks = 120;
    const { a, b } = runPair(
      { latencyMs: 60, jitterMs: 25, loss: 0.15, reorder: 0.25, reorderMs: 50, duplicate: 0.05 },
      ticks,
    );
    const reference = runReference(ticks);

    const at = agreementTick(ticks);
    expect(a.session?.status).toBe('running');
    expect(a.loop.digestOf(at)).toBe(reference.loop.digestOf(at));
    expect(b.loop.digestOf(at)).toBe(reference.loop.digestOf(at));
  });

  /**
   * **The control for the test above, and it is what says redundancy is doing the work.**
   *
   * With one input per packet, a dropped one is gone: an input is only useful for the tick it
   * names, so asking for it again and waiting a round trip delivers it after that tick has passed.
   * The peer's world is then permanently different, and either the fingerprint exchange notices or
   * the worlds simply disagree. Either way it must not quietly converge, or the test above is
   * passing for a reason that has nothing to do with the feature.
   */
  it('does not survive the same loss without redundancy', () => {
    const ticks = 120;
    const impaired = {
      latencyMs: 60,
      jitterMs: 25,
      loss: 0.15,
      reorder: 0.25,
      reorderMs: 50,
      duplicate: 0.05,
    };
    const { a, b } = runPair(impaired, ticks, 1);
    const reference = runReference(ticks);

    const at = agreementTick(ticks);
    const halted = a.session?.status === 'halted' || b.session?.status === 'halted';
    const diverged =
      a.loop.digestOf(at) !== reference.loop.digestOf(at) ||
      b.loop.digestOf(at) !== reference.loop.digestOf(at);
    expect(halted || diverged).toBe(true);
  });

  /**
   * A planted divergence is caught, and the tick it names is the tick it began at.
   *
   * One peer's world is nudged directly, which is what a determinism bug looks like from the
   * outside: identical inputs, different state. The fingerprint exchange is the only thing that can
   * see it.
   */
  it('halts on a disagreement and names the tick', () => {
    const net = new LoopbackNetwork();
    const a = makePeer(0, net.open({ self: 0, seed: 11 }));
    const b = makePeer(1, net.open({ self: 1, seed: 22 }));

    for (let tick = 0; tick < 40; tick++) {
      a.session?.poll();
      b.session?.poll();
      a.session?.submit(tick, input(0, tick));
      b.session?.submit(tick, input(1, tick));
      /* At tick 20, peer b's world quietly becomes a different world. */
      if (tick === 20) b.world.write(b.entities[0] as number, Body, 'x', 999);
      a.session?.advance(FIXED_DT, tick);
      b.session?.advance(FIXED_DT, tick);
      net.advance(1000 / 60);
    }

    expect(a.session?.status).toBe('halted');
    expect(a.session?.desync?.tick).toBeGreaterThanOrEqual(20);
    expect(a.session?.desync?.ours).not.toBe(a.session?.desync?.theirs);
    expect(a.session?.reason).toMatch(/diverged at tick/);
  });

  /** The control for the test above: no nudge, no halt, over the same run. */
  it('does not halt when nothing diverges', () => {
    const { a, b } = runPair({}, 40);
    expect(a.session?.status).toBe('running');
    expect(b.session?.status).toBe('running');
    expect(a.session?.desync).toBe(null);
  });

  /**
   * An input too late to apply halts, rather than being dropped.
   *
   * A dropped one leaves this peer's world permanently different from the world that input
   * describes, and nothing local can repair it. Carrying on would show a plausible world with no
   * relationship to anybody else's.
   */
  it('halts when an input arrives past the rewind window', () => {
    const net = new LoopbackNetwork();
    const a = makePeer(0, net.open({ self: 0, seed: 1, impairment: { latencyMs: 2000 } }));
    const b = makePeer(1, net.open({ self: 1, seed: 2 }));

    /* Two seconds of one-way delay is 120 ticks, so a run has to be long enough for one of those
       inputs to actually arrive — outside a twenty-four-deep window, which is the point. */
    for (let tick = 0; tick < 200; tick++) {
      a.session?.poll();
      b.session?.poll();
      a.session?.submit(tick, input(0, tick));
      b.session?.submit(tick, input(1, tick));
      if (a.session?.status === 'running') a.session.advance(FIXED_DT, tick);
      if (b.session?.status === 'running') b.session.advance(FIXED_DT, tick);
      net.advance(1000 / 60);
    }

    expect(b.session?.status).toBe('halted');
    expect(b.session?.reason).toMatch(/rewind window/);
  });

  it('records the local input as well as sending it, so a peer does not predict its own controls', () => {
    const net = new LoopbackNetwork();
    const a = makePeer(0, net.open({ self: 0 }));
    net.open({ self: 1 });

    a.session?.submit(10, new Uint8Array([1]));
    expect(a.inputs.isConfirmed(0, 12)).toBe(true);
  });

  it('reports how far every input has been confirmed', () => {
    const { a } = runPair({ latencyMs: 20 }, 50);
    expect(a.session?.confirmed).toBeGreaterThan(30);
  });

  it('a halted session takes no further ticks', () => {
    const net = new LoopbackNetwork();
    const a = makePeer(0, net.open({ self: 0 }));
    net.open({ self: 1 });

    a.session?.advance(FIXED_DT, 0);
    a.session?.halt('by hand');
    a.session?.advance(FIXED_DT, 1);

    expect(a.loop.tick).toBe(0);
    expect(a.session?.status).toBe('halted');
  });
});

/**
 * **A copy of a tick this world has already applied is not evidence of anything.**
 *
 * Redundancy exists so a lost input arrives anyway, which means most of what a session receives is
 * a repeat of something it has. The guard for that asks the log whether the tick is confirmed, and
 * the log answers for the window it currently holds — a window the session itself moves forward
 * every tick, because everything below the oldest snapshot a rewind can reach is never needed
 * again. The moment retention passes a tick, a redundant copy of it reads as an input this peer
 * never had, and the session halts on a link that lost nothing.
 *
 * Reported from outside with a configuration that reaches it on the eleventh frame of every match.
 */
describe('a redundant copy of an applied tick', () => {
  /** The reported configuration: redundancy reaching further back than the rewind window does. */
  const REDUNDANCY = 8;
  const REWIND_DEPTH = 8;

  it('does not halt a session that lost nothing', () => {
    const { a, b } = runPair({ latencyMs: 60 }, 40, REDUNDANCY, REWIND_DEPTH);
    expect(a.session?.reason, 'peer 0').toBe('');
    expect(b.session?.reason, 'peer 1').toBe('');
    expect(a.session?.status).toBe('running');
    expect(b.session?.status).toBe('running');
  });

  /**
   * And the worlds are still right, which is the claim a status of `running` does not make on its
   * own: a session that skipped an input it needed would also be running.
   */
  it('and the pair still lands where a single simulation would have', () => {
    const ticks = 90;
    const { a, b } = runPair({ latencyMs: 60 }, ticks, REDUNDANCY, REWIND_DEPTH);
    const reference = runReference(ticks);
    const at = agreementTick(ticks);
    expect(reference.loop.digestOf(at)).not.toBe(null);
    expect(a.loop.digestOf(at)).toBe(reference.loop.digestOf(at));
    expect(b.loop.digestOf(at)).toBe(reference.loop.digestOf(at));
  });
});

/**
 * **And the same copy after the peer went quiet long enough for retention to pass the watermark.**
 *
 * The session's own `confirmed` is what the log can currently say, and the log is asked for a window
 * the session keeps moving forward. When a peer stops sending for longer than the rewind window is
 * deep, retention walks past the last tick everybody had an input for and the live watermark drops
 * to nothing — while the world that was built from those inputs is still the world. A redundant copy
 * arriving on the peer's first packet back is then the reported halt again, on a session that is
 * about to recover.
 *
 * Driven by hand rather than over the loopback, because the point is a peer that says nothing for a
 * stretch and then says something old, which no static impairment produces.
 */
describe('a redundant copy after a silence', () => {
  /** A transport that delivers exactly what the test hands it, and remembers what was sent. */
  class Wire implements Transport {
    readonly state = 'open' as const;
    readonly self: number;
    private readonly inbox: Uint8Array[] = [];
    constructor(self: number) {
      this.self = self;
    }
    send(): void {}
    deliver(message: Uint8Array): void {
      this.inbox.push(message);
    }
    drain(into: (from: number, message: Uint8Array) => void): void {
      for (const m of this.inbox) into(1, m);
      this.inbox.length = 0;
    }
    close(): void {}
  }

  /** Peer 1's input for one tick, as it would ride in on a packet. */
  function packetFor(tick: number): Uint8Array {
    const out = new Uint8Array(32);
    const length = encodeInput(out, 1, tick, new Uint8Array([1]), 1, 1);
    expect(length).toBeGreaterThan(0);
    return out.subarray(0, length);
  }

  const SPEAKING = 20;
  const SILENT = 60;

  function runUntilSilence() {
    const wire = new Wire(0);
    const peer = makePeer(0, wire as never, 4, 8);
    const session = peer.session as NonNullable<typeof peer.session>;
    /*
     * Long enough that the rewind ring fills and retention starts: nothing is forgotten before
     * that, and the whole subject here is what forgetting does.
     */
    for (let tick = 0; tick < SPEAKING; tick++) {
      wire.deliver(packetFor(tick + INPUT_DELAY));
      session.poll();
      session.submit(tick, input(0, tick));
      session.advance(FIXED_DT, tick);
    }
    const applied = session.confirmed;
    /* Then peer 1 says nothing at all for longer than the rewind window is deep. */
    for (let tick = SPEAKING; tick < SILENT; tick++) {
      session.poll();
      session.submit(tick, input(0, tick));
      session.advance(FIXED_DT, tick);
    }
    return { session, applied, wire };
  }

  it('the live watermark really does fall behind what was applied', () => {
    const { session, applied } = runUntilSilence();
    expect(applied, 'ticks were confirmed before the silence').toBeGreaterThan(0);
    expect(session.confirmed, 'and the log can no longer say so').toBeLessThan(applied);
  });

  it('does not halt the session that is about to recover', () => {
    const { session, applied, wire } = runUntilSilence();
    /* The peer's first packet back carries a redundant copy of a tick this world already applied. */
    wire.deliver(packetFor(applied));
    session.poll();
    expect(session.reason).toBe('');
    expect(session.status).toBe('running');
  });

  /** And an old tick this world never had is still fatal, which is the half worth keeping. */
  it('still halts on an input for a tick it never had', () => {
    const { session, wire } = runUntilSilence();
    /*
     * Above the last tick peer 1 ever sent, so this world never had it, and far below the window
     * the log now holds, so it can never be applied either. Both halves are the halt's premise.
     */
    const neverHad = SPEAKING + INPUT_DELAY + 8;
    expect(neverHad, 'inside the silence').toBeLessThan(SILENT - 8);
    wire.deliver(packetFor(neverHad));
    session.poll();
    expect(session.status).toBe('halted');
    expect(session.reason).toMatch(/rewind window/);
  });
});
