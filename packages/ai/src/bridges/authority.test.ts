import { describe, expect, it } from 'vitest';
import { AuthoritativeAgent, loopbackDecisionChannel } from './authority.ts';
import { CommandLog } from '../command/log.ts';
import { UtilityPolicy } from '../policy/utility.ts';
import type { Intent, PolicyOption } from '../policy/types.ts';
import { AgentSession } from '../session/agent.ts';
import { ReplaySession } from '../session/replay.ts';
import { DeterministicProvider } from '../testing/deterministic.ts';
import type { AiEvent } from '../provider/types.ts';

/**
 * One machine decides; everybody else replays.
 *
 * **The request count is the evidence and the intents are the consequence**, and every case here is
 * written in that order deliberately. An agent that replayed correctly and an agent that was never
 * asked to replay produce identical worlds, so "the intents match" is a claim satisfied by nothing
 * having happened. `requestCount` is the number that moves only when a provider was actually
 * reached, which is the thing this bridge exists to stop happening twice.
 */

function answering(toolId: string): AiEvent[] {
  return [
    { kind: 'toolCall', callId: 'c1', toolId, args: { to: 'north' } },
    { kind: 'done', reason: 'complete' },
  ];
}

function floor(extentMs = 40): UtilityPolicy {
  const option: PolicyOption = {
    intent: {
      id: 'idle',
      priority: 10,
      toolIds: [],
      args: [],
      expectedExtentMs: extentMs,
      source: 'floor',
    } satisfies Intent,
    score: () => 1,
  };
  return new UtilityPolicy([option]);
}

function flush(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

/** An authority and a participant over one channel, sharing nothing else. */
function pair(): {
  host: AuthoritativeAgent;
  peer: AuthoritativeAgent;
  provider: DeterministicProvider;
  peerProvider: DeterministicProvider;
  hostLog: CommandLog;
  peerLog: CommandLog;
  wire: ReturnType<typeof loopbackDecisionChannel>;
} {
  const wire = loopbackDecisionChannel();
  const provider = new DeterministicProvider({ latencyTicks: 1, events: answering('navigate@1') });
  const hostLog = new CommandLog(64);
  const host = new AuthoritativeAgent(
    new AgentSession({ agentId: 'A17', policy: floor(), provider, log: hostLog, maxIntentMs: 64 }),
    new ReplaySession(hostLog, floor(), 'A17'),
    { role: () => 'authority', channel: wire.authority, log: hostLog },
  );

  /*
   * The participant is given a provider it must never reach. Handing it none would make "it did not
   * ask" true by there being nothing to ask, which proves the harness rather than the bridge.
   */
  const peerProvider = new DeterministicProvider({ latencyTicks: 1, events: answering('never@1') });
  const peerLog = new CommandLog(64);
  const peer = new AuthoritativeAgent(
    new AgentSession({
      agentId: 'A17',
      policy: floor(),
      provider: peerProvider,
      log: peerLog,
      maxIntentMs: 64,
    }),
    new ReplaySession(peerLog, floor(), 'A17'),
    { role: () => 'participant', channel: wire.participant, log: peerLog },
  );

  return { host, peer, provider, peerProvider, hostLog, peerLog, wire };
}

/** Step both sides through a tick, letting the provider's scripted answer land. */
async function step(
  parts: ReturnType<typeof pair>,
  tick: number,
): Promise<{ host: Intent; peer: Intent }> {
  parts.provider.advance(tick);
  parts.peerProvider.advance(tick);
  const host = parts.host.tick(tick, tick * 16);
  await flush();
  const peer = parts.peer.tick(tick, tick * 16);
  return { host, peer };
}

describe('an agent whose decisions are taken in one place', () => {
  /**
   * **The claim everything else rests on.** A participant with a provider wired in, stepped for
   * fifty ticks, must not have reached it once.
   */
  it('never reaches a provider on a participant', async () => {
    const parts = pair();
    for (let tick = 0; tick < 50; tick++) await step(parts, tick);

    expect(parts.provider.requestCount).toBeGreaterThan(0);
    expect(parts.peerProvider.requestCount).toBe(0);
    expect(parts.peer.publishedDecisions).toBe(0);
  });

  /** And the decisions the authority took reached it, so the case above is not empty. */
  it('carries the authority’s decisions to the participant', async () => {
    const parts = pair();
    for (let tick = 0; tick < 30; tick++) await step(parts, tick);

    expect(parts.host.publishedDecisions).toBeGreaterThan(0);
    expect(parts.peer.acceptedDecisions).toBe(parts.host.publishedDecisions);
  });

  /**
   * **The rollback rule.** Re-running ticks must issue nothing: a rewind is exactly the case that
   * re-runs a function, and an inference call is neither idempotent nor free.
   *
   * The count is asserted before the intents, because two agents that both did nothing also agree.
   */
  it('issues nothing when ticks are re-run, and replays the same intents', async () => {
    const parts = pair();
    const first: string[] = [];
    for (let tick = 0; tick < 20; tick++) first.push((await step(parts, tick)).peer.id);

    const beforeRewind = parts.peerProvider.requestCount;
    /*
     * Replayed from the start rather than from a midpoint. A `ReplaySession` recomputes floor
     * intents, and the floor's own clock begins where the session does — so replaying a suffix
     * scores the floor against an elapsed time the first run never had, and the two disagree for a
     * reason that has nothing to do with the decisions. A consumer rewinding does the same: back to
     * a snapshot, then forward.
     */
    const replay = new ReplaySession(parts.peerLog, floor(), 'A17');
    const again: string[] = [];
    for (let tick = 0; tick < 20; tick++) again.push(replay.tick(tick, tick * 16).id);

    /* The evidence: nothing was asked, on either run. */
    expect(parts.peerProvider.requestCount).toBe(beforeRewind);
    expect(beforeRewind).toBe(0);
    /* The consequence. */
    expect(again).toEqual(first);
    /* And there was something to replay, or the two agree about nothing. */
    expect(replay.replayedIntents).toBeGreaterThan(0);
  });

  /** The authority replaying its own log must not ask again either, which is a rewind on the host. */
  it('does not re-ask when the authority replays its own log', async () => {
    const parts = pair();
    for (let tick = 0; tick < 20; tick++) await step(parts, tick);

    const before = parts.provider.requestCount;
    expect(before).toBeGreaterThan(0);

    const replay = new ReplaySession(parts.hostLog, floor(), 'A17');
    for (let tick = 0; tick < 20; tick++) replay.tick(tick, tick * 16);

    expect(parts.provider.requestCount).toBe(before);
    expect(replay.replayedIntents).toBeGreaterThan(0);
  });

  /**
   * **A decision arriving for a tick already run is a rewind, and this bridge only reports it.**
   * Performing one from inside an agent would be an AI package deciding when a whole simulation
   * goes backwards.
   */
  it('reports the oldest tick a late decision landed on, and nothing else', () => {
    const wire = loopbackDecisionChannel();
    const log = new CommandLog(64);
    const peer = new AuthoritativeAgent(
      new AgentSession({ agentId: 'A17', policy: floor(), log }),
      new ReplaySession(log, floor(), 'A17'),
      { role: () => 'participant', channel: wire.participant, log },
    );

    for (let tick = 0; tick < 6; tick++) peer.tick(tick, tick * 16);
    expect(peer.earliestLateTick).toBe(-1);

    wire.authority.replicateDecision({
      kind: 'command',
      toolId: 'navigate@1',
      args: {},
      agentId: 'A17',
      issuedAtTick: 2,
      acceptedAtTick: 4,
    });
    wire.authority.replicateDecision({
      kind: 'command',
      toolId: 'navigate@1',
      args: {},
      agentId: 'A17',
      issuedAtTick: 1,
      acceptedAtTick: 3,
    });

    peer.tick(6, 96);
    /* The older of the two, so a consumer rewinds far enough on the first read. */
    expect(peer.earliestLateTick).toBe(3);

    peer.clearLate();
    expect(peer.earliestLateTick).toBe(-1);
  });

  /** A decision for the tick about to run is not late, or every ordinary delivery would be. */
  it('does not call an on-time decision late', () => {
    const wire = loopbackDecisionChannel();
    const log = new CommandLog(64);
    const peer = new AuthoritativeAgent(
      new AgentSession({ agentId: 'A17', policy: floor(), log }),
      new ReplaySession(log, floor(), 'A17'),
      { role: () => 'participant', channel: wire.participant, log },
    );
    peer.tick(0, 0);
    wire.authority.replicateDecision({
      kind: 'command',
      toolId: 'navigate@1',
      args: {},
      agentId: 'A17',
      issuedAtTick: 0,
      acceptedAtTick: 1,
    });
    peer.tick(1, 16);
    expect(peer.earliestLateTick).toBe(-1);
    expect(peer.acceptedDecisions).toBe(1);
  });

  /**
   * **Authority can move**, which is why the role is a function. A wrapper that read it once would
   * keep deciding after it stopped being allowed to.
   */
  it('stops deciding the moment the role changes', async () => {
    const wire = loopbackDecisionChannel();
    const provider = new DeterministicProvider({
      latencyTicks: 1,
      events: answering('navigate@1'),
    });
    const log = new CommandLog(64);
    let role: 'authority' | 'participant' = 'authority';
    const agent = new AuthoritativeAgent(
      new AgentSession({ agentId: 'A17', policy: floor(), provider, log, maxIntentMs: 64 }),
      new ReplaySession(log, floor(), 'A17'),
      { role: () => role, channel: wire.authority, log },
    );

    for (let tick = 0; tick < 10; tick++) {
      provider.advance(tick);
      agent.tick(tick, tick * 16);
      await flush();
    }
    const whileAuthority = provider.requestCount;
    expect(whileAuthority).toBeGreaterThan(0);

    role = 'participant';
    for (let tick = 10; tick < 30; tick++) {
      provider.advance(tick);
      agent.tick(tick, tick * 16);
      await flush();
    }
    expect(provider.requestCount).toBe(whileAuthority);
  });

  /**
   * Delivery is deferred to the next drain rather than immediate. A channel that delivered inside
   * `replicateDecision` would let a decision reach a participant on the tick it was taken, which no
   * real link does and which would hide every late-arrival case above.
   */
  it('does not deliver inside the call that publishes', async () => {
    const parts = pair();
    parts.provider.advance(0);
    parts.host.tick(0, 0);
    await flush();
    parts.provider.advance(1);
    parts.host.tick(1, 16);
    await flush();

    expect(parts.wire.pending()).toBe(parts.host.publishedDecisions);
    expect(parts.peer.acceptedDecisions).toBe(0);
  });
});
