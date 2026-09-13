# @driftengine/ai

Provider-neutral intelligence sessions, typed tools, typed context, budgets and policy — and an
agent loop that does not wait.

**It is not an LLM-controlled character.** It is typed intelligence sessions over consumer-defined
capabilities, which is what makes it an engine package rather than a game feature: the same runtime
serves a game exposing movement and dialogue tools, a site exposing camera and material tools, and
an editor exposing selection and transform tools. No engine package acquires a character.

## An agent is never without a purpose

Live inference takes anywhere from fifty milliseconds to five seconds or never. An agent that waits
for it is an agent that visibly stands still. So there are two layers:

- a **policy floor** — deterministic, synchronous, running inside the simulation on the fixed clock,
  allocating nothing per tick. It does not know a provider exists, which is why an agent with none
  still behaves.
- a **one-slot intent buffer** — while the current intent executes, the request for the next is
  already in flight. When the current one finishes the buffer drains; when the buffer is empty the
  floor supplies.

The current slot is never empty. A provider that is slow, absent, or over budget costs quality,
never motion.

```ts
import { AgentSession, UtilityPolicy } from '@driftengine/ai';

const session = new AgentSession({
  agentId: 'A17',
  policy: new UtilityPolicy(options),
  // provider is optional — without one, the floor is the whole behaviour
});

// Inside the fixed step. Returns an intent every tick, forever.
const intent = session.tick({ tick, agentId: 'A17', elapsedMs });
```

## What it costs to ask ahead

Exactly one request is in flight per agent, ever, and it is issued when the current intent's
remaining extent falls to the provider's measured p90 latency. A fast provider is asked late,
against fresher context; a slow one early, because it has to be. That is one request per intent
completed — the same volume a design that waited would pay, moved earlier in time. It buys
continuity, not throughput.

Speculating on branches would buy responsiveness at N times the tokens with most of them discarded.
It is declined, and the reasoning is in the design rather than in a comment here.

## What it will not do

**Model output is never an execution path.** No `eval`, no `new Function`. Tools resolve by stable
id to pre-registered implementations and arguments are schema-validated before anything runs.

**A buffered intent is a proposal, never a decision.** It was authored against a snapshot and
executes later, so every tool declares an admission guard at registration, and an intent whose guard
has gone false is discarded rather than deferred. A plan whose world is gone is not a plan that ran
late.

**The model never writes its own guards.** A model-authored precondition on a model-authored action
is the model marking its own homework.

## The two bridges

**Both were refused in writing until 2026-09-05**, one because no track owned navigation and one
because networking was not built. Both of those stopped being true and the refusals
outlived them, which is why `docs/CAPABILITIES.md` carries the correction as well as the capability.

**`navigationBridge` is a factory over a three-function adapter.** The engine owns the graph, the A*
and the follower; the consumer answers where an agent is, which graph it walks and which route
object it follows. Its one tool, `navigate@1`, **runs the search in `admits`** — which is the first
guard here that says anything stronger than "the entity still exists", and the answer to a buffered
intent being a proposal authored against one snapshot and acted on later. A destination stranded in
between is discarded and the floor covers.

That costs three searches for an intent that is accepted and applied: the buffer's guard, the guard
`applyCommand` runs again on the way in, and the act. Caching between any two would key a route on
nothing stable, since the world changing between them is the reason the guard exists.

**`AuthoritativeAgent` is thinner than it looks, because most of it was already here.** A model is
slow, variable and metered, so two peers running one diverge and a decision is taken in one place.
`CommandLog` already records what a model decided and `ReplaySession` already replays it while
calling no provider — so **a participant is a replay whose log arrives over a network instead of
from a recording**, and a rewind is a replay of the same log. What this adds is which side decides,
getting decisions onto the wire, and reporting a decision that lands for a tick already run. It does
not rewind: that belongs to whoever owns the `RewindLoop`.

```ts
import { AuthoritativeAgent, CommandLog, navigationBridge } from '@driftengine/ai';

for (const tool of navigationBridge(adapter)) tools.register(tool);
const agent = new AuthoritativeAgent(session, replay, {
  role: () => (net.isAuthority ? 'authority' : 'participant'),
  channel,
  log,
});
```

Both reach a script through four `drift/ai` capabilities: `reachable`, `navigate`, `path` and
`deciding`. None duplicates `drift/navigation`, whose twelve all take a `NavPath` or a `NavGraph`
and none of which can be aimed at an agent. **Nothing hands a script the tools or arguments a model
chose**, because a `@deterministic` system branching on a provider's answer would take the other
branch on replay.
