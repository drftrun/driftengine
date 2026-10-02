---
title: Agents and behaviour
description: Behaviour trees that pause, interrupt and resume, and agent sessions whose deterministic floor keeps them moving while a model answers late.
packages: ['@driftengine/ai', '@driftengine/script']
areas: ['ai', 'behavior']
---

# Agents and behaviour

Two ways to give a character something to do. A behaviour tree is a routine written as data: a
tree of named steps that can be paused, stepped, interrupted by something more urgent, and picked up
again where it left off. An agent session, from `@driftengine/ai`, is for a character that may also
ask a model what to do next: a deterministic floor that always has an answer, a model asked ahead of
time, and every answer checked against the world before it is acted on.

The example is a village square. Three villagers go about their errands, from their stalls to the
well and home again, run for the awning when it rains and go back to exactly what they were doing
when it stops. The town crier walks the square deciding where to go next. The day is a DriftScript
module that advances the routines, watches them, and tells the crier when the weather turns. Let it
rain, hold the baker where he is, and give the crier a model to ask, a slow one or a quick one.

<!-- run: agents -->

## A behaviour tree

```ts sample=agents/main.ts#tree
/**
 * One villager's day. The first branch is guarded by the rain: while it rains, shelter wins, and
 * the errand it interrupted is suspended where it was, not started again.
 */
const DAY: BehaviorSpec = {
  name: 'day',
  selector: [
    {
      name: 'out of the rain',
      whileTrue: 'raining',
      does: {
        name: 'shelter',
        sequence: [
          { name: 'run to the awning', action: 'toAwning' },
          { name: 'wait it out', action: 'waitOut' },
        ],
      },
    },
    {
      name: 'errands',
      sequence: [
        { name: 'walk to the stall', action: 'toStall' },
        { name: 'trade', action: 'trade' },
        { name: 'walk to the well', action: 'toWell' },
        { name: 'draw water', action: 'drawWater' },
        { name: 'walk home', action: 'toHome' },
        { name: 'rest', action: 'rest' },
      ],
    },
  ],
};
```

A tree is written as a `BehaviorSpec`, every node named:

- `sequence`, children in order: it fails when one fails and succeeds when the last does.
- `selector`, children in order until one does not fail: a list of alternatives.
- `action`, one of your verbs, which takes time and answers `RUNNING` until it is done, then
  `SUCCESS` or `FAILURE`.
- `condition`, one of your questions, answered now.
- A guard, `whileTrue` and `does`, which runs its child only while a condition holds.

A selector of guards is a list of priorities, and it is how a routine is interrupted. When the rain
guard's condition comes true, shelter wins, and the errand that was running is suspended, not
abandoned: its place in every sequence is kept, so when the rain stops each villager carries on
from the step they had reached. A branch is reset only when it finishes. Most behaviour-tree
libraries reset on interruption, and the difference is a villager who goes back to the stall after
a shower against one who goes home and starts the day again.

```ts sample=agents/main.ts#tasks
/** A villager, and the verbs the tree calls by name. */
interface Villager {
  readonly name: string;
  readonly home: Vec3;
  readonly stall: Vec3;
  x: number;
  z: number;
  heading: number;
  /** Seconds left on each timed step, by name: kept while a step is suspended, cleared when done. */
  readonly timers: Map<string, number>;
}
let raining = flag('rain', 'dry') === 'raining';
const DT = 1 / 60;

function walkTo(v: Villager, target: Vec3, pace: number): BehaviorStatus {
  const dx = target[0] - v.x;
  const dz = target[2] - v.z;
  const distance = Math.hypot(dx, dz);
  if (distance < 0.1) return SUCCESS;
  const step = Math.min(distance, pace * DT);
  v.x += (dx / distance) * step;
  v.z += (dz / distance) * step;
  v.heading = Math.atan2(dx, dz);
  return RUNNING;
}

/**
 * Spend a while at a place: walk back to it first, which is what a step resumed after the rain
 * needs, then count down a timer that is kept while the step is suspended.
 */
function spend(v: Villager, place: Vec3, step: string, seconds: number): BehaviorStatus {
  if (walkTo(v, place, 1.4) === RUNNING) return RUNNING;
  const left = (v.timers.get(step) ?? seconds) - DT;
  if (left > 0) {
    v.timers.set(step, left);
    return RUNNING;
  }
  v.timers.delete(step);
  return SUCCESS;
}

/** Where each villager stands at their stall, at the well and at their own door. */
const stallOf = (v: Villager): Vec3 => [v.stall[0], 0, v.stall[2] + 1.4];
const wellOf = (v: Villager): Vec3 => [
  WELL[0] - 1.2 + HOMES.indexOf(v.home) * 1.2,
  0,
  WELL[2] + 1.4,
];
const doorOf = (v: Villager): Vec3 => [v.home[0] - 1.6, 0, v.home[2]];

const tree = buildBehaviorTree(DAY, {
  actions: {
    toAwning: (v: Villager) =>
      walkTo(v, [AWNING[0], 0, AWNING[2] + (HOMES.indexOf(v.home) - 1) * 1.2], 3.2),
    waitOut: () => (raining ? RUNNING : SUCCESS),
    toStall: (v: Villager) => walkTo(v, stallOf(v), 1.4),
    trade: (v: Villager) => spend(v, stallOf(v), 'trade', 4),
    toWell: (v: Villager) => walkTo(v, wellOf(v), 1.4),
    drawWater: (v: Villager) => spend(v, wellOf(v), 'draw', 3),
    toHome: (v: Villager) => walkTo(v, doorOf(v), 1.4),
    rest: (v: Villager) => spend(v, doorOf(v), 'rest', 4),
  },
  conditions: { raining: () => raining },
});
```

`buildBehaviorTree(spec, tasks)` resolves the names once against your `actions` and `conditions`,
each a function of whatever context you hand a tick, and flattens the tree into arrays, so a tick
allocates nothing and reads no clock. A `BehaviorRunner` is one character's place in a tree that any
number share: `tick(context)` advances it, `paused` holds it while the world carries on and
`stepOnce` advances it anyway, `reset()` starts it from the top, and `status` is what the last tick
answered. `activePath(out)` fills in the chain of nodes the last tick was inside, root first, and
`nameOf` turns one into the name it was written with, which is how the example's readout says what
everybody is doing without any of it being kept twice.

## The day, in DriftScript

```drs sample=agents/village.drs#day
// One frame of the village: every routine advanced, then asked what it is doing.
fn day(square: mut Square, first: Behavior, second: Behavior, third: Behavior, crier: Agent) {
    behavior.setPaused(first, square.holdFirst)
    behavior.tick(first)
    behavior.tick(second)
    behavior.tick(third)

    square.sheltering = count(first, "shelter") + count(second, "shelter") + count(third, "shelter")
    square.trading = count(first, "trade") + count(second, "trade") + count(third, "trade")

    // The crier hears about the weather once, when it changes.
    if square.raining != square.wasRaining {
        if square.raining {
            ai.wake(crier, "it started raining", 5)
        } else {
            ai.wake(crier, "the rain stopped", 3)
        }
        square.wasRaining = square.raining
    }
}

fn count(villager: Behavior, node: String) -> u32 {
    if behavior.doing(villager, node) {
        return 1
    }
    return 0
}
```

```ts sample=agents/main.ts#script
/** The village's day, hosted with the routines it drives and the agents it may wake. */
const village = hostScript(villageScript, {
  behavior: {
    context: (routine) => villagers[routines.indexOf(routine as BehaviorRunner<Villager>)],
  },
  ai: { agents: { get: (id) => (id === 'crier' ? session : undefined) } },
});
interface Square {
  raining: boolean;
  wasRaining: boolean;
  holdFirst: boolean;
  sheltering: number;
  trading: number;
}
const square = exported<() => Square>(village, 'createSquare')();
type Day = (
  square: Square,
  first: BehaviorRunner<Villager>,
  second: BehaviorRunner<Villager>,
  third: BehaviorRunner<Villager>,
  crier: AgentSession,
) => void;
if (import.meta.hot) {
  import.meta.hot.accept('./village.drs', (next) => {
    if (next !== undefined)
      patchModule(village, next as Record<string, unknown>, { Square: [square] });
  });
}
```

`drift/behavior` drives a tree its host built; a script does not author one, since the actions a
tree calls are your own verbs in TypeScript. The host hands over a `context` function, which gives
the tick of each runner the thing its actions act on. A module has `tick` and `step`, `restart`,
`setPaused` and `paused`, `status`, `depth`, and `doing(behavior, name)`, whether the character is
inside a node of that name right now. `doing` is what lets a script react to a routine without a
second copy of its state: count who is sheltering, light a lantern while someone walks home, refuse
to talk to someone mid-errand. Watching is deterministic and advancing is not, so a
`@deterministic` system may ask `doing` and not call `tick`.

## An agent that never waits

```ts sample=agents/main.ts#floor
/** The floor: whichever corner is furthest from him, so he always has somewhere to go next. */
const CORNERS: Vec3[] = [
  [-8, 0, -5],
  [8, 0, -5],
  [-8, 0, 3],
  [8, 0, 3],
];
const floor = new UtilityPolicy(
  CORNERS.map((corner, at): PolicyOption => ({
    intent: {
      id: `walk to corner ${at + 1}`,
      priority: 1,
      toolIds: ['navigate@1'],
      args: [{ agentId: 'crier', x: corner[0], y: 0, z: corner[2] } satisfies NavigateArgs],
      expectedExtentMs: UNKNOWN_EXTENT,
      source: 'floor',
    },
    score: () => Math.hypot(corner[0] - crier.x, corner[2] - crier.z),
  })),
);
```

A model may take fifty milliseconds to answer, or five seconds, or never, and a character that waits
for it visibly stands still. So an `AgentSession` keeps two things. The floor is an `AgentPolicy`,
deterministic and synchronous, that picks an intent whenever the slot is empty; `UtilityPolicy`
scores a fixed list of options and takes the highest, ties to the first. And while the current
intent runs, the next is already being asked for: one request per agent in flight at most, sent when
the time left on the current intent falls to the provider's measured latency, so a fast model is
asked later, against fresher context, and a slow one earlier.

```ts sample=agents/main.ts#session
/** A provider that answers after a stated number of ticks: a stand-in for a model, slow or quick. */
const PLACES: [string, Vec3][] = [
  ['the well', [8, 0, 3]],
  ['the stalls', [0, 0, -5]],
  ['the awning', [-8, 0, 3]],
];
function provider(latencyTicks: number): DeterministicProvider {
  return new DeterministicProvider((index: number) => {
    const [, at] = PLACES[index % PLACES.length] as [string, Vec3];
    const events: AiEvent[] = [
      {
        kind: 'toolCall',
        callId: `c${index}`,
        toolId: 'navigate@1',
        args: { agentId: 'crier', x: at[0], y: 0, z: at[2] },
      },
      { kind: 'done', reason: 'complete' },
    ];
    return { latencyTicks, events };
  });
}

let answering: DeterministicProvider | undefined;
let session = new AgentSession({ agentId: 'crier', policy: floor, tools, world });
function connect(latencyTicks: number | null): void {
  session.dispose('the provider changed');
  answering = latencyTicks === null ? undefined : provider(latencyTicks);
  session = new AgentSession({
    agentId: 'crier',
    policy: floor,
    provider: answering,
    tools,
    world,
  });
}
```

An `Intent` names the tools to call and their arguments, how long it is expected to take, and
whether it came from the `floor` or a `model`. `tick(tick, nowMs)` returns the intent to carry out,
never nothing; `complete(nowMs)` says the current one is done, and `maxIntentMs` reclaims one that
was never completed. `current` and `buffered` are the two slots. `observe` tells the agent
something happened, and `whileBusy` says what happens to news that arrives while a request is out:
fold it into the next, interrupt, or drop it. A provider that is slow, absent or over budget costs
the character quality, never motion: with nobody to ask, the crier walks his corners on the floor
alone, and with a slow model the floor fills the gaps while the model's answers arrive.

## Tools and their guards

```ts sample=agents/main.ts#bridge
/**
 * The crier walks a grid of lanes, and the navigation bridge is the one tool he is given: walk to
 * a point, guarded by there being a route to it from where he is.
 */
const lanes: NavGraph = buildNavGraph(
  [-8, 0, -5, 0, 0, -5, 8, 0, -5, -8, 0, 3, 0, 0, 3, 8, 0, 3],
  [
    { from: 0, to: 1 },
    { from: 1, to: 2 },
    { from: 3, to: 4 },
    { from: 4, to: 5 },
    { from: 0, to: 3 },
    { from: 1, to: 4 },
    { from: 2, to: 5 },
  ],
);
const crier = { x: 0, y: 0, z: 3, heading: 0, path: new NavPath(lanes, 16, { arriveM: 0.3 }) };
const world = { lanes, crier };
const tools = new ToolRegistry<typeof world>();
for (const tool of navigationBridge<typeof world>({
  graphOf: (w) => w.lanes,
  positionOf: (w, _id, out) => {
    out[0] = w.crier.x;
    out[1] = 0;
    out[2] = w.crier.z;
    return true;
  },
  pathOf: (w) => w.crier.path,
})) {
  tools.register(tool);
}
```

```ts sample=snippets/agents.ts#tool
/** A tool is a versioned id, a schema its arguments are checked against, a guard and an act. */
const sell: ToolDefinition<{ item: string; count: number }, { sold: number }, Shop> = {
  id: 'sell@1',
  description: 'Sell some of one item from the shop.',
  schema: {
    kind: 'object',
    fields: {
      item: { kind: 'enum', values: ['bread', 'nails', 'cloth'] },
      count: { kind: 'number' },
    },
  },
  /* Asked when the intent is proposed and again when it is acted on: still open, still in stock. */
  admits: (args, shop) => shop.open && (shop.stock.get(args.item) ?? 0) >= args.count,
  execute: (args, shop) => {
    shop.stock.set(args.item, (shop.stock.get(args.item) ?? 0) - args.count);
    return { sold: args.count };
  },
};
const tools = new ToolRegistry<Shop>();
tools.register(sell);
```

A model never runs code. A tool is registered under a versioned id, `navigate@1`, with a schema its
arguments are validated against, an `admits` guard and an `execute`. An intent buffered ahead of time
was decided against an older world, so it is a proposal: its guard is asked again when it would
start, and one whose guard has gone false is discarded and the floor covers. A model never writes its
own guards. `applyCommand(tools, world, command, tick)` runs one tool call through the same checks,
which is how the example starts each intent's walk.

`navigationBridge(adapter)` gives an agent the one tool every game needs, walking to a point over a
`NavGraph`, guarded by a route existing from where it is; the adapter answers which graph, where the
agent is, and which `NavPath` it follows. `AuthoritativeAgent` decides an agent's model intents on
one peer and replays them on the others, so a networked game asks one model once.

## Providers, budgets and replay

```ts sample=snippets/agents.ts#provider
/** A model behind your own endpoint, which holds the key; this package never sees one. */
const provider = createProxyProvider({
  endpoint: '/api/model',
  model: 'shopkeeper',
  capabilities: {
    text: true,
    streamingText: true,
    structuredOutput: true,
    toolCalling: true,
    realtimeAudio: false,
    imageInput: false,
    local: false,
  },
});

/** The floor: mind the shop. Over budget, the agent runs on this alone and says it is degraded. */
const floor = new UtilityPolicy([
  {
    intent: {
      id: 'mind the shop',
      priority: 0,
      toolIds: [],
      args: [],
      expectedExtentMs: 5000,
      source: 'floor',
    },
    score: () => 1,
  },
]);
const log = new CommandLog(512);
export const shopkeeper = new AgentSession<Shop>({
  agentId: 'shopkeeper',
  policy: floor,
  provider,
  tools,
  world: { stock: new Map([['bread', 12]]), open: true },
  budget: new Budget({ requests: 120, costMicros: 50_000 }),
  log,
  maxIntentMs: 20_000,
});
```

```ts sample=snippets/agents.ts#replay
/** What the model decided is in the log, so a replay or a rewind asks no provider at all. */
export function replay(ticks: number): string[] {
  const again = new ReplaySession(log, floor, 'shopkeeper');
  const intents: string[] = [];
  for (let tick = 0; tick < ticks; tick += 1) intents.push(again.tick(tick, tick * 16).id);
  return intents;
}
```

`createProxyProvider` talks to an endpoint you run, which holds the key; the package itself never
holds a credential. `createLocalProvider` wraps a model running on the device, accepted only once it
has answered a probe, and a failed probe is refused and never falls back to a remote one, since that
would quietly move where a player's data goes. `DeterministicProvider` answers after a set number of
ticks, which is what the example and every timing test use. A `Budget` caps requests, tokens, cost and wall time, and an agent over it runs on
its floor alone and says so in `degraded`. `interruptProvider` is a second, faster model asked only
when something interrupts.

Every model decision that is accepted is written to a `CommandLog`, and a `ReplaySession` plays a
run back from it without asking any provider, which is also what a rewind is.

## The crier, from a script

`drift/ai` reaches an agent a host registered: `agent(id)` resolves one; `wake(agent, reason,
priority)` tells it something happened and `consider` asks it to think; `intentId` and `degraded`
read it; `reachable`, `navigate` and `path` reach the navigation bridge; and `deciding` says whether
this peer decides its model intents. The village's day wakes the crier when the rain starts and when
it stops. Nothing hands a script the tools or arguments a model chose, since a deterministic system
branching on a model's answer would take the other branch on replay.
