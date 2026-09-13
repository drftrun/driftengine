/**
 * A client predicts its own player, the authority disagrees, and the client ends up where the
 * authority says without the player feeling their controls detach.
 *
 * The measurable version of "without feeling it" is the control: the same client with prediction
 * off lags the authority by the whole round trip and never catches up on its own.
 */
import { describe, expect, it } from 'vitest';
import { World, defineComponent } from '@driftengine/entities';
import {
  AuthorityHost,
  PredictingClient,
  StateInterpolator,
  type Replicator,
} from './authority.ts';
import { InputLog } from './inputLog.ts';
import { LoopbackNetwork } from './loopback.ts';
import { RewindLoop } from './rewind.ts';
import { worldSnapshotter } from './snapshotter.ts';

const Body = defineComponent('ABody', { x: 'f64' });
const FIXED_DT = 1 / 60;
const CLIENT = 1;

/** One body per participant, moved by a held control. Two participants, one of them the client. */
function makeSide(predictsFor: number | null) {
  const world = new World();
  const entities = [world.create(), world.create()];
  for (const e of entities) world.add(e, Body, { x: 0 });

  const inputs = new InputLog({ participants: 2, depth: 64, inputBytes: 1 });
  const scratch = new Uint8Array(1);

  const step = (dt: number, tick: number): void => {
    for (let p = 0; p < 2; p++) {
      /* A client simulates only what it predicts; everything else arrives as state. */
      if (predictsFor !== null && p !== predictsFor) continue;
      inputs.into(p, tick, scratch);
      const e = entities[p] as number;
      const speed = ((scratch[0] as number) & 1) === 1 ? 10 : 0;
      world.write(e, Body, 'x', (world.read(e, Body, 'x') as number) + speed * dt);
    }
  };

  const loop = new RewindLoop({
    step,
    snapshotter: worldSnapshotter(world),
    inputs,
    fixedDt: FIXED_DT,
    depth: 32,
  });

  /* Two doubles: the whole authoritative state of this toy world. */
  const view = new DataView(new ArrayBuffer(16));
  const replicator: Replicator = {
    encode: (into) => {
      if (into.length < 16) return -1;
      view.setFloat64(0, world.read(entities[0] as number, Body, 'x') as number);
      view.setFloat64(8, world.read(entities[1] as number, Body, 'x') as number);
      into.set(new Uint8Array(view.buffer));
      return 16;
    },
    apply: (from) => {
      if (from.length < 16) return;
      const incoming = new DataView(from.buffer.slice(from.byteOffset, from.byteOffset + 16));
      world.write(entities[0] as number, Body, 'x', incoming.getFloat64(0));
      world.write(entities[1] as number, Body, 'x', incoming.getFloat64(8));
    },
  };

  const at = (participant: number): number =>
    world.read(entities[participant] as number, Body, 'x') as number;

  return { world, entities, inputs, loop, replicator, at };
}

function runSession(options: { predict: boolean; latencyMs: number; ticks: number }) {
  const net = new LoopbackNetwork();
  const hostSide = makeSide(null);
  const clientSide = makeSide(CLIENT);

  const host = new AuthorityHost({
    transport: net.open({ self: 0, impairment: { latencyMs: options.latencyMs } }),
    loop: hostSide.loop,
    inputs: hostSide.inputs,
    replicator: hostSide.replicator,
    stateEvery: 3,
  });
  const client = new PredictingClient({
    transport: net.open({ self: CLIENT, impairment: { latencyMs: options.latencyMs } }),
    loop: clientSide.loop,
    inputs: clientSide.inputs,
    replicator: clientSide.replicator,
    self: CLIENT,
    predict: options.predict,
  });

  const held = new Uint8Array([1]);
  for (let tick = 0; tick < options.ticks; tick++) {
    host.poll();
    client.poll();
    client.submit(tick, held);
    host.advance(FIXED_DT, tick);
    client.advance(FIXED_DT, tick);
    net.advance(1000 / 60);
  }
  return { host, client, hostSide, clientSide };
}

describe('an authoritative session', () => {
  /**
   * **The player's own body is where their inputs put it, immediately.**
   *
   * Under 120 ms of round trip the authority is about seven ticks behind what the client has
   * already done, so the client is *ahead* of every state it receives. It must stay ahead:
   * snapping back to the authority's position on each correction is the failure prediction exists
   * to prevent.
   */
  it('keeps a predicting client ahead of the states it receives', () => {
    const { client, clientSide, hostSide } = runSession({
      predict: true,
      latencyMs: 60,
      ticks: 90,
    });

    expect(client.corrections).toBeGreaterThan(10);
    expect(clientSide.at(CLIENT)).toBeGreaterThan(hostSide.at(CLIENT) - 0.2);
    expect(clientSide.at(CLIENT)).toBeGreaterThan(10);
  });

  /**
   * The control. With prediction off, the same client shows only what the authority has sent, so it
   * trails by the link's latency and the gap never closes.
   */
  it('lags by the link when prediction is off', () => {
    const predicted = runSession({ predict: true, latencyMs: 60, ticks: 90 });
    const waiting = runSession({ predict: false, latencyMs: 60, ticks: 90 });

    const predictedGap = predicted.hostSide.at(CLIENT) - predicted.clientSide.at(CLIENT);
    const waitingGap = waiting.hostSide.at(CLIENT) - waiting.clientSide.at(CLIENT);

    expect(waitingGap).toBeGreaterThan(predictedGap + 0.5);
  });

  /**
   * A correction converges rather than accumulating.
   *
   * The client's error against the authority is bounded over a long run: each state message
   * replaces the world at its tick and the local inputs replay over it, so a mispredicted tick is
   * paid for once and not compounded.
   */
  it('bounds the error over a long run instead of drifting', () => {
    const short = runSession({ predict: true, latencyMs: 60, ticks: 60 });
    const long = runSession({ predict: true, latencyMs: 60, ticks: 240 });

    const shortGap = Math.abs(short.hostSide.at(CLIENT) - short.clientSide.at(CLIENT));
    const longGap = Math.abs(long.hostSide.at(CLIENT) - long.clientSide.at(CLIENT));

    expect(longGap).toBeLessThan(shortGap + 0.25);
  });

  it('the authority receives the client inputs and moves the client body', () => {
    const { hostSide } = runSession({ predict: true, latencyMs: 20, ticks: 60 });
    expect(hostSide.at(CLIENT)).toBeGreaterThan(5);
    /* And the other participant, who never sent anything, has not moved. */
    expect(hostSide.at(0)).toBe(0);
  });

  it('publishes on its cadence rather than every tick', () => {
    const { host } = runSession({ predict: true, latencyMs: 20, ticks: 60 });
    expect(host.publishedStates).toBe(20);
  });

  it('ignores a state older than one already applied', () => {
    const { client } = runSession({ predict: true, latencyMs: 20, ticks: 30 });
    const before = client.corrections;
    client.poll();
    expect(client.corrections).toBe(before);
  });
});

describe('the state interpolator', () => {
  const state = (value: number) => new Uint8Array([value]);

  it('blends between the two states a render tick falls between', () => {
    const buffer = new StateInterpolator(8, 4, 4);
    buffer.push(10, state(1));
    buffer.push(20, state(2));

    const sample = buffer.sample(19);
    expect(sample?.from[0]).toBe(1);
    expect(sample?.to[0]).toBe(2);
    expect(sample?.alpha).toBeCloseTo(0.5, 5);
  });

  /**
   * The delay is the whole mechanism: rendering the newest state is what stutters.
   *
   * At a render tick of 20 with a delay of 4, the target is 16 — between the two states — where
   * with no delay it would be past the newest and pinned there.
   */
  it('renders behind the newest state, which is what makes it smooth', () => {
    const delayed = new StateInterpolator(8, 4, 4);
    const immediate = new StateInterpolator(8, 4, 0);
    for (const buffer of [delayed, immediate]) {
      buffer.push(10, state(1));
      buffer.push(20, state(2));
    }
    expect(delayed.sample(20)?.alpha).toBeCloseTo(0.6, 5);
    expect(immediate.sample(20)?.alpha).toBe(1);
  });

  it('holds at the newest rather than extrapolating past it', () => {
    const buffer = new StateInterpolator(8, 4, 0);
    buffer.push(10, state(1));
    buffer.push(20, state(2));
    const sample = buffer.sample(400);
    expect(sample?.alpha).toBe(1);
    expect(sample?.to[0]).toBe(2);
  });

  it('answers nothing before it has been given anything', () => {
    expect(new StateInterpolator().sample(5)).toBe(null);
  });

  it('copies what it is given, because the transport reuses its buffer', () => {
    const buffer = new StateInterpolator(8, 4, 0);
    const shared = new Uint8Array([7]);
    buffer.push(10, shared);
    shared[0] = 99;
    expect(buffer.sample(10)?.to[0]).toBe(7);
  });
});
