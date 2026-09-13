/**
 * The two bridges composing, which is the only thing the unit tests cannot show.
 *
 * `navigation.test.ts` proves a guard answers and `authority.test.ts` proves a participant never
 * decides. Neither proves that an agent whose destination is chosen by a model, guarded by a graph,
 * replicated to a second peer and then rewound ends up in the same place on both — and that is the
 * claim a consumer actually cares about.
 *
 * **Nothing is rendered.** The world here is agent positions and a nav graph, because the bridges
 * touch neither a renderer nor a device, and a page that drew something would be asserting about a
 * GPU while claiming to be about agents.
 *
 * `scripts/ai-bridge-check.mjs` reads the result off `globalThis.__aiBridgeCheck`.
 *
 * ## The provider
 *
 * By default this runs `DeterministicProvider`, which answers after a stated number of *ticks*
 * rather than on a wall clock — so every timing property here is asserted rather than observed, and
 * on a real clock each would be a race that passes on a fast machine.
 *
 * `?endpoint=<url>` swaps in the real proxy adapter. **It is a proxy URL and not a key**: this
 * package holds no credential and `packages/ai/src/adapters/proxy.test.mjs` reads the source to
 * prove it, so the credential lives on the consumer's endpoint. That path is written here and has
 * not been run.
 */
import {
  AgentSession,
  AuthoritativeAgent,
  CommandLog,
  DeterministicProvider,
  ReplaySession,
  ToolRegistry,
  UtilityPolicy,
  applyCommand,
  createProxyProvider,
  loopbackDecisionChannel,
  navigationBridge,
} from '@driftengine/ai';
import type {
  AiEvent,
  AiProvider,
  Intent,
  NavigateArgs,
  NavigateResult,
  NavigationAdapter,
  PolicyOption,
} from '@driftengine/ai';
import { NavPath, buildNavGraph, createNavSteer } from '@driftengine/core';
import type { NavGraph } from '@driftengine/core';

const TICKS = 240;
const AGENTS = ['A1', 'A2', 'A3'];
/** Where the guard is exercised: the link cut here strands the far half of the graph. */
const CUT_AT_TICK = 90;

/**
 * Two rows of nodes joined by one link, so the far row can be stranded.
 *
 * ```
 *   0-1-2-3-4-5-6-7   the near row
 *           |         the one link, cut at CUT_AT_TICK
 *   8-9-10-11-12-13   the far row
 * ```
 */
function corridor(linked: boolean): NavGraph {
  const positions: number[] = [];
  for (let i = 0; i < 8; i++) positions.push(i * 4, 0, 0);
  for (let i = 0; i < 6; i++) positions.push(i * 4, 0, 12);
  const edges: { from: number; to: number }[] = [];
  for (let i = 0; i < 7; i++) edges.push({ from: i, to: i + 1 });
  for (let i = 8; i < 13; i++) edges.push({ from: i, to: i + 1 });
  if (linked) edges.push({ from: 3, to: 11 });
  return buildNavGraph(new Float32Array(positions), edges);
}

interface Agent {
  readonly id: string;
  x: number;
  y: number;
  z: number;
  readonly path: NavPath;
}

/** One peer's world: where its agents are, and which graph they navigate. */
class Peer {
  graph: NavGraph;
  readonly agents = new Map<string, Agent>();

  constructor(graph: NavGraph) {
    this.graph = graph;
    for (const id of AGENTS) {
      this.agents.set(id, { id, x: 0, y: 0, z: 0, path: new NavPath(graph, 32) });
    }
  }

  /** Re-cut the graph, and hand every agent a path over the new one. */
  relink(graph: NavGraph): void {
    this.graph = graph;
    for (const id of AGENTS) {
      const was = this.agents.get(id);
      if (was === undefined) continue;
      this.agents.set(id, { ...was, path: new NavPath(graph, 32) });
    }
  }

  /** Walk every agent one step along whatever route it has. */
  advance(metres: number): void {
    const steer = createNavSteer();
    for (const agent of this.agents.values()) {
      if (!agent.path.active) continue;
      agent.path.steer(agent.x, agent.y, agent.z, steer);
      if (steer.arrived) continue;
      const length = Math.hypot(steer.x, steer.y, steer.z) || 1;
      agent.x += (steer.x / length) * metres;
      agent.y += (steer.y / length) * metres;
      agent.z += (steer.z / length) * metres;
    }
  }

  /** Positions, rounded, as the thing two peers are compared on. */
  fingerprint(): string {
    return AGENTS.map((id) => {
      const a = this.agents.get(id);
      return a === undefined ? '-' : `${a.x.toFixed(3)},${a.y.toFixed(3)},${a.z.toFixed(3)}`;
    }).join('|');
  }
}

function adapterFor(peer: Peer): NavigationAdapter<Peer> {
  return {
    graphOf: (world) => world.graph,
    positionOf: (world, agentId, out) => {
      const agent = world.agents.get(agentId);
      if (agent === undefined) return false;
      out[0] = agent.x;
      out[1] = agent.y;
      out[2] = agent.z;
      return true;
    },
    pathOf: (world, agentId) => world.agents.get(agentId)?.path ?? null,
  };
}

/** The floor: stand still. Present so an agent without a decision still has one. */
function floor(): UtilityPolicy {
  const option: PolicyOption = {
    intent: {
      id: 'idle',
      priority: 10,
      toolIds: [],
      args: [],
      expectedExtentMs: 480,
      source: 'floor',
    } satisfies Intent,
    score: () => 1,
  };
  return new UtilityPolicy([option]);
}

/**
 * Destinations the model asks for, alternating between the two rows.
 *
 * The far row is the one the cut strands, so after `CUT_AT_TICK` every other decision is a
 * destination that no longer has a route — which is the guard's case, arriving through the model
 * rather than through a test calling `admits` directly.
 */
function scripted(index: number): { latencyTicks: number; events: AiEvent[] } {
  const far = index % 2 === 1;
  return {
    latencyTicks: 2,
    events: [
      {
        kind: 'toolCall',
        callId: `c${index}`,
        toolId: 'navigate@1',
        args: { agentId: AGENTS[index % AGENTS.length], x: far ? 20 : 28, y: 0, z: far ? 12 : 0 },
      },
      { kind: 'done', reason: 'complete' },
    ],
  };
}

function buildProvider(endpoint: string | null): { provider: AiProvider; real: boolean } {
  if (endpoint === null) {
    return { provider: new DeterministicProvider(scripted), real: false };
  }
  return {
    provider: createProxyProvider({
      endpoint,
      model: 'bridge-check',
      capabilities: {
        text: true,
        streamingText: true,
        structuredOutput: true,
        toolCalling: true,
        realtimeAudio: false,
        imageInput: false,
        local: false,
      },
    }),
    real: true,
  };
}

interface Side {
  peer: Peer;
  agent: AuthoritativeAgent;
  registry: ToolRegistry<Peer>;
  log: CommandLog;
  applied: number;
  refused: number;
}

function side(
  peer: Peer,
  provider: AiProvider | undefined,
  role: 'authority' | 'participant',
  channel: ReturnType<typeof loopbackDecisionChannel>[keyof ReturnType<
    typeof loopbackDecisionChannel
  >],
): Side {
  const registry = new ToolRegistry<Peer>();
  for (const tool of navigationBridge(adapterFor(peer), { snapDistance: 6 }))
    registry.register(tool);
  const log = new CommandLog(512);
  const session = new AgentSession<Peer>({
    agentId: AGENTS[0] as string,
    policy: floor(),
    provider,
    tools: registry,
    world: peer,
    log,
    maxIntentMs: 640,
  });
  const agent = new AuthoritativeAgent(
    session as AgentSession<unknown>,
    new ReplaySession(log, floor(), AGENTS[0] as string),
    { role: () => role, channel: channel as never, log },
  );
  return { peer, agent, registry, log, applied: 0, refused: 0 };
}

/** Run the accepted command, which is what actually moves anything. */
function apply(target: Side, intent: Intent, tick: number): void {
  if (intent.source !== 'model') return;
  for (let i = 0; i < intent.toolIds.length; i++) {
    const outcome = applyCommand(
      target.registry,
      target.peer,
      {
        kind: 'command',
        toolId: intent.toolIds[i] as string,
        args: intent.args[i] as NavigateArgs,
        agentId: AGENTS[0] as string,
        issuedAtTick: tick,
        acceptedAtTick: tick,
      },
      tick,
    );
    if (outcome.ok) {
      if ((outcome.result as NavigateResult | undefined)?.found === true) target.applied++;
      else target.refused++;
    } else {
      target.refused++;
    }
  }
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function run(): Promise<Record<string, unknown>> {
  const params = new URLSearchParams(location.search);
  const { provider, real } = buildProvider(params.get('endpoint'));

  const wire = loopbackDecisionChannel();
  const linked = corridor(true);
  const host = side(new Peer(linked), provider, 'authority', wire.authority);

  /*
   * The participant is given a provider it must never reach. Handing it none would make "it did not
   * decide" true by there being nothing to decide with, which proves the harness and not the bridge.
   */
  const peerProvider = new DeterministicProvider({
    latencyTicks: 1,
    events: [{ kind: 'done', reason: 'complete' }],
  });
  const guest = side(new Peer(linked), peerProvider, 'participant', wire.participant);

  const hostAt: string[] = [];
  const guestAt: string[] = [];

  for (let tick = 0; tick < TICKS; tick++) {
    if (tick === CUT_AT_TICK) {
      const cut = corridor(false);
      host.peer.relink(cut);
      guest.peer.relink(cut);
    }
    if (provider instanceof DeterministicProvider) provider.advance(tick);
    peerProvider.advance(tick);

    apply(host, host.agent.tick(tick, tick * 16), tick);
    await flush();
    apply(guest, guest.agent.tick(tick, tick * 16), tick);

    host.peer.advance(0.35);
    guest.peer.advance(0.35);
    hostAt.push(host.peer.fingerprint());
    guestAt.push(guest.peer.fingerprint());
  }

  /*
   * A rewind, which on this side is a replay of the log the wire delivered. The request count either
   * side of it is the evidence; the intents matching is the consequence.
   */
  const requestsBeforeRewind = peerProvider.requestCount;
  const replay = new ReplaySession(guest.log, floor(), AGENTS[0] as string);
  const replayed: string[] = [];
  for (let tick = 0; tick < TICKS; tick++) replayed.push(replay.tick(tick, tick * 16).id);
  const requestsAfterRewind = peerProvider.requestCount;

  const live: string[] = [];
  const liveReplay = new ReplaySession(guest.log, floor(), AGENTS[0] as string);
  for (let tick = 0; tick < TICKS; tick++) live.push(liveReplay.tick(tick, tick * 16).id);

  /*
   * Compared at a *confirmed* tick and not the newest one. Track J learned this by going red: the
   * newest tick is speculative on both sides, and comparing live worlds halted a healthy session at
   * tick 32.
   */
  const confirmed = TICKS - 8;

  return {
    provider: real ? 'proxy' : 'deterministic',
    providerRun: real,
    ticks: TICKS,
    modelDecisions: host.agent.publishedDecisions,
    decisionsAccepted: guest.agent.acceptedDecisions,
    hostApplied: host.applied,
    hostRefusedByGuard: host.refused,
    hostMoved: hostAt[confirmed] !== hostAt[0],
    peerRequests: peerProvider.requestCount,
    peerPublished: guest.agent.publishedDecisions,
    requestsBeforeRewind,
    requestsAfterRewind,
    replayedIntents: replay.replayedIntents,
    replayMatches: replayed.join(',') === live.join(','),
    worldsAgree: hostAt[confirmed] === guestAt[confirmed],
    hostAtConfirmed: hostAt[confirmed] ?? '',
    peerAtConfirmed: guestAt[confirmed] ?? '',
  };
}

run().then(
  (result) => {
    (globalThis as { __aiBridgeCheck?: unknown }).__aiBridgeCheck = result;
    const out = document.getElementById('out');
    if (out) out.textContent = JSON.stringify(result, null, 2);
  },
  (error: unknown) => {
    const failed = { error: String((error as Error)?.message ?? error) };
    (globalThis as { __aiBridgeCheck?: unknown }).__aiBridgeCheck = failed;
    const out = document.getElementById('out');
    if (out) out.textContent = JSON.stringify(failed, null, 2);
  },
);
