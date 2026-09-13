/**
 * `drift/ai` — what this engine lets a script ask of an agent.
 *
 * **Deliberately small, and deliberately not a way to call a model.** A script wakes an
 * agent, asks it to consider, and reads what it is doing. It never awaits a provider,
 * because a script that could would be a script that can stall a fixed step for five
 * seconds — and the whole of Track O is the argument that nothing should.
 *
 * Three constraints this surface inherits:
 *
 * - **`ai` is outside the determinism boundary.** A `@deterministic` function may not
 *   call any of it. The floor is deterministic and runs inside the simulation; asking a
 *   provider is not, and the compiler is making a line that already exists visible.
 * - **Nothing here returns a model's answer.** `wake` and `consider` are requests that
 *   an agent think, and they return immediately. What the agent decided arrives as the
 *   intent its session hands the consumer on a later tick.
 * - **Reading is cheap and stays inside the boundary.** `intentId` and `degraded` are
 *   `@deterministic`-safe: the current intent is state the simulation already owns,
 *   because a deterministic floor put it there and a replay recomputes it.
 */
import { type CapabilityDefinition, type OpaqueType, defineCapability } from 'driftscript';
import type { AgentSession, NavigateArgs, NavigateResult, ToolDefinition } from '@driftengine/ai';
import type { NavPath } from '@driftengine/core';

export const AI_MODULE = 'drift/ai';

/**
 * A live agent session, held by a script and passed back to the engine.
 *
 * Opaque, for the reason `Sound` is: a script that could read its fields would be a
 * script depending on a representation this package cannot then change.
 */
export const AI_TYPES: readonly OpaqueType[] = [
  {
    module: AI_MODULE,
    name: 'Agent',
    doc: 'A live agent session. Held and passed back; never read into.',
  },
];

const define = (
  name: string,
  params: readonly { name: string; type: string }[],
  returns: string,
  effects: CapabilityDefinition['effects'],
  deterministic: boolean,
  doc: string,
  implementation: string,
): CapabilityDefinition =>
  defineCapability({
    module: AI_MODULE,
    name,
    signature: `fn(${params.map((p) => `${p.name}: ${p.type}`).join(', ')}) -> ${returns}`,
    params: [...params],
    returns,
    effects,
    deterministic,
    doc,
    implementation,
  });

export const AI_CAPABILITIES: readonly CapabilityDefinition[] = [
  define(
    'agent',
    [{ name: 'id', type: 'String' }],
    /*
     * `Agent?`, and the `?` is the point, exactly as it is for `audio.sound`.
     *
     * A consumer registers the agents a script may talk to, and a script naming one
     * that was not registered is ordinary rather than exceptional — a scene loaded
     * without its agents, a name that moved. Returning a bare `Agent` would make every
     * script that forgot to check talk to nothing and report success.
     */
    'Agent?',
    ['pure'],
    true,
    'Resolve an agent by the id the consumer registered it under. Absent when there is none.',
    'AgentRegistry.get',
  ),
  define(
    'wake',
    [
      { name: 'agent', type: 'Agent' },
      { name: 'reason', type: 'String' },
      { name: 'priority', type: 'i32' },
    ],
    'void',
    ['ai'],
    false,
    'Tell an agent something happened. Returns immediately; the agent acts at its next tick.',
    'AgentSession.observe',
  ),
  define(
    'consider',
    [{ name: 'agent', type: 'Agent' }],
    'void',
    ['ai'],
    false,
    'Ask an agent to think, at ordinary priority. Returns immediately.',
    'AgentSession.consider',
  ),
  define(
    'intentId',
    [{ name: 'agent', type: 'Agent' }],
    'String',
    ['pure'],
    /*
     * Readable from a `@deterministic` function, unlike everything else here.
     *
     * The current intent is state the simulation already owns — the floor put it there
     * and a replay recomputes it — so reading it is reading the simulation rather than
     * reaching outside it. Asking a provider is the part that is nondeterministic, and
     * that is what `wake` and `consider` carry `ai` for.
     */
    true,
    'What the agent is doing now. Empty before its first tick.',
    'AgentSession.intentId',
  ),
  define(
    'degraded',
    [{ name: 'agent', type: 'Agent' }],
    'bool',
    ['pure'],
    true,
    'Whether the agent is over budget and running on its policy floor alone.',
    'AgentSession.degraded',
  ),

  /*
   * The two bridges, and every effect below is inherited rather than invented.
   *
   * **None of these duplicates `drift/navigation`.** That module binds twelve capabilities and
   * every one takes a `NavPath` or a `NavGraph`; what a script could not do is aim any of them at
   * an `Agent`, which is a session keyed by an id the consumer registered. `path` is the join, so
   * one capability makes all twelve work on an agent instead of any being bound a second time.
   */
  define(
    'reachable',
    [
      { name: 'agent', type: 'Agent' },
      { name: 'x', type: 'float' },
      { name: 'y', type: 'float' },
      { name: 'z', type: 'float' },
    ],
    'bool',
    ['navigation.read'],
    /*
     * Deterministic, and it is the admission guard as a question. `navigation.route` computes *and
     * writes*, so a script wanting to score a destination before committing to it had to route and
     * then undo — which is a write a `@deterministic` system would have had to make and take back.
     */
    true,
    'Whether a route exists from where this agent is to a point, without writing one.',
    'navigationBridge.admits',
  ),
  define(
    'navigate',
    [
      { name: 'agent', type: 'Agent' },
      { name: 'x', type: 'float' },
      { name: 'y', type: 'float' },
      { name: 'z', type: 'float' },
    ],
    'bool',
    ['navigation.write'],
    /*
     * **Deterministic, and safe on every peer, which only looks like it contradicts `deciding`.**
     * The authority rule is about *model*-authored intents: a provider is nondeterministic, slow
     * and metered, so two peers running one diverge. A script's own command is a function of the
     * simulation — DriftScript 1.12.0 admitted `navigation.write` to `DETERMINISTIC_EFFECTS` on
     * exactly that argument, since a route is a function of the graph and two endpoints and
     * `navSearch` breaks ties on the node index — so every peer computes the same route and it
     * replicates itself by being re-run.
     */
    true,
    'Route this agent to a point. False when no route exists, and then it clears the old one.',
    'navigationBridge.execute',
  ),
  define(
    'path',
    [{ name: 'agent', type: 'Agent' }],
    /*
     * `NavPath?`, from `drift/navigation`. Cross-module opaque types are ordinary here:
     * `drift/editor.rebuildTree` takes a `drift/scene.Node` and `drift/ui.draw` takes a
     * `drift/2d.SpriteBatch`.
     *
     * Optional because an agent the consumer never gave a route object to is ordinary rather than
     * exceptional, and a bare `NavPath` would hand every script that forgot to check a handle to
     * nothing.
     */
    'NavPath?',
    ['navigation.read'],
    true,
    'The route object this agent follows, for `drift/navigation` to read or steer along.',
    'AgentNavigation.pathOf',
  ),
  define(
    'deciding',
    [{ name: 'agent', type: 'Agent' }],
    'bool',
    /*
     * `network.read`, and inside `DETERMINISTIC_EFFECTS`, on the same narrowing
     * `drift/network.authority` already uses: which participant this is, and whether it is the
     * authority, are facts that cannot vary with packet timing. This is that fact per agent.
     */
    ['network.read'],
    true,
    'Whether this peer decides this agent’s model intents. Elsewhere they arrive already taken.',
    'AuthoritativeAgent.deciding',
  ),
];

/**
 * A consumer's agents, by the id a script may name them with.
 *
 * The registry is the consumer's, exactly as `SoundRegistry` is: this package owns the
 * loop and the floor, and which agents exist in a scene is not something an engine can
 * know.
 */
export interface AgentRegistry {
  get(id: string): AgentSession | undefined;
}

/**
 * What the navigation bridge needs from the host to answer for an agent.
 *
 * The world and the tools are the consumer's: `navigationBridge` is a factory over their adapter,
 * and this is where the result of that factory meets a script.
 */
export interface AgentNavigation<W = unknown> {
  readonly world: W;
  readonly tools: readonly ToolDefinition<NavigateArgs, NavigateResult, W>[];
  pathOf(agentId: string): NavPath | undefined;
}

/** Which agents this peer decides for. One method, because that is the whole script-visible fact. */
export interface AgentAuthority {
  deciding(agentId: string): boolean;
}

export interface AiServices<W = unknown> {
  readonly agents: AgentRegistry;
  /** Absent means `reachable`, `navigate` and `path` fail at the call saying what to provide. */
  readonly navigation?: AgentNavigation<W>;
  /** Absent means `deciding` fails at the call. */
  readonly authority?: AgentAuthority;
}

/**
 * Missing wiring fails at the call, naming what is absent.
 *
 * **Not a falsy default**, for the reason `HostServices` already gives about `drift/behavior`: a
 * stub makes an agent whose routine never runs look exactly like one standing about with nothing to
 * do. `navigate` returning `false` because nobody wired a bridge is indistinguishable from `false`
 * because there is no route, and the second is a thing a script is meant to handle.
 */
function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) {
    throw new Error(
      `drift/ai: this host provides no ${what}, so that capability cannot answer. Pass it in ` +
        `\`services.ai\` — see \`navigationBridge\` in @driftengine/ai.`,
    );
  }
  return value;
}

/** The implementations the host supplies at link time, keyed by capability name. */
export function aiImplementation(services: AiServices): Readonly<Record<string, unknown>> {
  const { agents } = services;
  const navigate = (
    agent: AgentSession,
    x: number,
    y: number,
    z: number,
    act: boolean,
  ): boolean => {
    const nav = required(services.navigation, 'navigation bridge');
    const tool = nav.tools.find((candidate) => candidate.id === 'navigate@1');
    if (tool === undefined) return false;
    const args = { agentId: agent.agentId, x, y, z };
    /* `admits` is the guard and `execute` is the act, and `reachable` is deliberately the first
       without the second — the whole point of exposing it is not having to route and undo. */
    return act ? tool.execute(args, nav.world).found : tool.admits(args, nav.world);
  };

  return {
    agent: (id: string): AgentSession | undefined => agents.get(id),
    wake: (agent: AgentSession, reason: string, priority: number): void => {
      agent.observe({ id: reason, priority, text: reason });
    },
    consider: (agent: AgentSession): void => {
      agent.observe({ id: 'consider', priority: 0, text: 'consider' });
    },
    intentId: (agent: AgentSession): string => agent.current?.id ?? '',
    degraded: (agent: AgentSession): boolean => agent.degraded,

    reachable: (agent: AgentSession, x: number, y: number, z: number): boolean =>
      navigate(agent, x, y, z, false),
    navigate: (agent: AgentSession, x: number, y: number, z: number): boolean =>
      navigate(agent, x, y, z, true),
    path: (agent: AgentSession): NavPath | undefined =>
      required(services.navigation, 'navigation bridge').pathOf(agent.agentId),
    deciding: (agent: AgentSession): boolean =>
      required(services.authority, 'authority bridge').deciding(agent.agentId),
  };
}
