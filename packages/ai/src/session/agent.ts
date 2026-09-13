import { MessageQueue } from '@driftengine/core';
import type { AiEvent, AiProvider, AiSession } from '../provider/types.ts';
import { LatencyEstimator } from '../provider/latency.ts';
import { hasKnownExtent, UNKNOWN_EXTENT } from '../policy/types.ts';
import type { AgentPolicy, Intent, PolicyContext } from '../policy/types.ts';
import type { Budget } from '../budget/budget.ts';
import type { ToolRegistry } from '../tools/registry.ts';
import type { AiCommand, AiPreemption, CommandLog } from '../command/log.ts';
import { chargeUsage, createUsage, noteAbort, notePreemption } from './usage.ts';
import type { AiUsage } from './usage.ts';
import { continuationPreamble } from '../context/continuation.ts';
import { nextState } from './states.ts';
import type { AgentState } from './states.ts';

export interface AgentSessionOptions<W = unknown> {
  readonly agentId: string;
  readonly policy: AgentPolicy;
  /** Absent is a supported configuration, not a degraded one. The floor is enough. */
  readonly provider?: AiProvider;
  readonly budget?: Budget;
  readonly model?: string;
  /** Tools, and the admission guards they declared. Absent admits everything. */
  readonly tools?: ToolRegistry<W>;
  /** The consumer's world, handed to a guard unchanged. */
  readonly world?: W;
  /**
   * What an observation arriving while a request is out does.
   *
   * `queue` and `replace pending` are deliberately absent. Both described what to do
   * with a *second* request, and there is never one — the state machine has no edge
   * on which it could be issued.
   */
  readonly whileBusy?: WhileBusy;
  readonly maxPendingObservations?: number;
  readonly dedupeWindowMs?: number;
  /** Where accepted model commands are recorded, so a run can be replayed exactly. */
  readonly log?: CommandLog;
  /**
   * A ceiling on how long any one intent may hold the slot, in milliseconds.
   *
   * An intent with an unknown extent ends when the consumer says so, which is the
   * contract — the consumer is the thing that knows whether the walk finished. But a
   * consumer that forgets leaves the agent on one intent forever, which is the blocked
   * agent arriving through the back door.
   *
   * Off by default, because a default here would be a guess about behaviours this
   * package cannot see, and a wrong one would cut short a legitimately long action.
   * *What it costs when set:* a genuinely long intent is reclaimed by the floor.
   * *What would make it wrong:* a consumer whose intents legitimately outlast any
   * figure worth writing down, which should set nothing and call `complete`.
   */
  readonly maxIntentMs?: number;
  /**
   * A second, faster provider asked only when something interrupts.
   *
   * §46's tiering: a small or local model answers "something happened, react now" in
   * well under the strong model's latency, while the strong one is still composing the
   * next intent. Additive — absent, preemption behaves exactly as it does without it.
   *
   * *What it costs:* a second provider to configure and a second bill. *What would
   * make it wrong:* an interrupt model slow enough that the floor beats it to the
   * answer, at which point it is buying nothing the floor did not already give.
   */
  readonly interruptProvider?: AiProvider;
}

export type WhileBusy = 'coalesce' | 'preempt' | 'drop';

const WHILE_BUSY: readonly WhileBusy[] = ['coalesce', 'preempt', 'drop'];

export interface Observation {
  readonly id: string;
  readonly priority: number;
  readonly text: string;
}

/** What `MessageQueue` needs of an observation, which is exactly its own shape. */
interface QueuedObservation extends Observation {
  readonly durationMs: number;
}

/**
 * One agent: a floor that always runs, and one slot holding what comes next.
 *
 * **The current slot is never empty.** When an intent finishes, the buffer drains into
 * it; when the buffer is empty, the policy floor supplies. An agent with no provider
 * configured behaves exactly as one whose provider is slow — less cleverly, and
 * without ever standing still.
 *
 * `tick` is the whole surface a consumer needs inside its fixed step. It returns the
 * intent to execute and never returns null.
 */
export class AgentSession<W = unknown> {
  readonly agentId: string;

  private readonly policy: AgentPolicy;
  private readonly provider: AiProvider | null;
  private readonly budget: Budget | null;
  private readonly model: string;
  private readonly tools: ToolRegistry<W> | null;
  private readonly whileBusy: WhileBusy;
  private readonly observations: MessageQueue<QueuedObservation>;
  private readonly log: CommandLog | null;
  private readonly maxIntentMs: number;
  private readonly interruptProvider: AiProvider | null;
  private readonly world: W | undefined;
  private readonly latency = new LatencyEstimator();
  private readonly usageState: AiUsage = createUsage();

  private agentState: AgentState = 'idle';
  private currentIntent: Intent | null = null;
  private bufferedIntent: Intent | null = null;

  private startedAtMs = 0;
  private disposedReason = '';

  private inFlight: AiSession | null = null;
  private inFlightAt = 0;
  /** When the pending response's request went out, or -1 when nothing has landed. */
  private landedAtMs = -1;
  private discarded = 0;
  private issuedAtTick = 0;
  private inFlightGeneration = 0;

  /*
   * One context object, mutated rather than rebuilt. The floor is called every tick
   * for every agent, and a fresh context per call would put an allocation on the one
   * path this package promises has none.
   */
  private readonly context = { tick: 0, agentId: '', elapsedMs: 0 };

  constructor(options: AgentSessionOptions<W>) {
    this.agentId = options.agentId;
    this.policy = options.policy;
    this.provider = options.provider ?? null;
    this.budget = options.budget ?? null;
    this.model = options.model ?? 'default';
    this.tools = options.tools ?? null;
    this.world = options.world;
    this.log = options.log ?? null;
    this.maxIntentMs = options.maxIntentMs ?? Number.POSITIVE_INFINITY;
    this.interruptProvider = options.interruptProvider ?? null;
    this.context.agentId = options.agentId;

    const whileBusy = options.whileBusy ?? 'coalesce';
    if (!WHILE_BUSY.includes(whileBusy)) {
      throw new Error(
        `whileBusy must be one of ${WHILE_BUSY.join(', ')} — there is only ever one ` +
          `request in flight, so "queue" and "replace pending" name no distinct behaviour`,
      );
    }
    this.whileBusy = whileBusy;

    /* R7: backpressure is `MessageQueue`. Its dedupe window collapses a repeat, its
       ceiling drops the least important rather than the oldest, and its priority
       ordering is what a preemption compares against. Writing a second priority queue
       with dedupe and a ceiling, in a package that depends on the one that has one, is
       the trap that reversal was written against. */
    this.observations = new MessageQueue<QueuedObservation>({
      maxPending: options.maxPendingObservations ?? 4,
      dedupeWindowMs: options.dedupeWindowMs ?? 900,
    });
  }

  /**
   * Something happened that the agent may care about.
   *
   * Never acted on here — an observation taken mid-tick would mutate the simulation
   * halfway through a step. It waits for the next `tick`.
   */
  observe(observation: Observation): void {
    if (this.disposedReason !== '') return;
    this.observations.push({ ...observation, durationMs: 0 });
  }

  get state(): AgentState {
    return this.agentState;
  }

  /** Never null once `tick` has run once. */
  get current(): Intent | null {
    return this.currentIntent;
  }

  get buffered(): Intent | null {
    return this.bufferedIntent;
  }

  get usage(): Readonly<AiUsage> {
    return this.usageState;
  }

  /**
   * Advance one fixed step and return the intent to execute.
   *
   * Never returns null. That is the track's whole claim and it is asserted directly.
   */
  tick(tickNumber: number, nowMs: number): Intent {
    if (this.disposedReason !== '') {
      throw new Error(`agent "${this.agentId}" was disposed: ${this.disposedReason}`);
    }

    /*
     * The context is stamped before anything reads it. It was stamped after `take` in
     * the first draft, so the floor scored every decision against the *previous* tick
     * and a recorded command carried the previous tick as the one it was accepted on —
     * which put every replayed model intent one step early.
     */
    this.context.tick = tickNumber;
    this.context.elapsedMs = nowMs - this.startedAtMs;

    this.recordLanding(nowMs);
    this.budget?.charge(this.usageState, nowMs);
    this.drainObservations(nowMs);

    if (this.currentIntent === null) this.take(nowMs);
    else if (this.finished(nowMs)) this.finish(nowMs);

    this.context.elapsedMs = nowMs - this.startedAtMs;
    this.maybeContinue(nowMs);

    const current = this.currentIntent;
    if (current === null) throw new Error('unreachable: take() always sets an intent');
    return current;
  }

  /** The consumer says the current intent is over, ahead of its expected extent. */
  complete(nowMs: number): void {
    if (this.currentIntent === null) return;
    this.finish(nowMs);
  }

  /**
   * End the current intent and fill the slot again.
   *
   * **Aborts a request that is still in flight.** `ahead -> intentCompleted -> idle`
   * abandons the question, and a request nobody will read is a request that should
   * stop costing money — but more than that, leaving it open means the next intent
   * issues a second one and two are outstanding at once, which is the guarantee the
   * state machine is shaped to make impossible. The state machine cannot see the
   * provider; this is where the two are kept in agreement.
   */
  private finish(nowMs: number): void {
    if (this.agentState === 'ahead') this.abortInFlight();
    this.transition('intentCompleted');
    this.take(nowMs);
  }

  dispose(reason = 'disposed'): void {
    this.disposedReason = reason;
    this.abortInFlight();
    this.bufferedIntent = null;
  }

  /**
   * Fill the current slot: from the buffer if something is there, from the floor if not.
   *
   * The order matters and only in one direction — a buffered intent is a model's
   * answer to the question the floor would otherwise be answering, so it wins when it
   * exists. There is no case where the floor should override a fresh proposal, because
   * a proposal the floor should override is one the admission guards discard.
   */
  private take(nowMs: number): void {
    const buffered = this.bufferedIntent;
    if (buffered !== null) {
      this.bufferedIntent = null;
      if (this.admits(buffered)) {
        this.currentIntent = buffered;
        this.startedAtMs = nowMs;
        this.record(buffered);
        if (this.agentState === 'ready') this.transition('intentCompleted');
        return;
      }
      /* Discarded, never deferred, and never retried. It falls through to the floor
         on this same tick, which is why a failed guard costs quality rather than
         motion. */
      if (this.agentState === 'ready') this.transition('intentCompleted');
      this.discarded++;
    }

    this.context.elapsedMs = nowMs - this.startedAtMs;
    this.currentIntent = this.policy.select(this.context as PolicyContext);
    this.startedAtMs = nowMs;
    this.transition('floorSupplied');
  }

  /**
   * Whether a buffered intent is still true of the world.
   *
   * Composed from the guards the *tools* declared, never from anything the model
   * wrote. With no registry configured every intent admits: a consumer that has not
   * described its world cannot have its plans checked against it, and pretending
   * otherwise would be a check that always passes wearing the shape of one that means
   * something.
   */
  private admits(intent: Intent): boolean {
    const tools = this.tools;
    if (tools === null) return true;
    return tools.admits(intent.toolIds, intent.args, this.world as W);
  }

  /**
   * Take the most important observation waiting, and act on it if it outranks now.
   *
   * At the tick boundary, never mid-tick. Nothing mutates the simulation halfway
   * through a step, which is the boundary §33 of the parent design already runs.
   */
  private drainObservations(nowMs: number): void {
    const observation = this.observations.update(nowMs);
    if (observation === null) return;
    if (this.whileBusy === 'drop' && this.agentState === 'ahead') return;
    if (this.whileBusy !== 'preempt') return;

    const current = this.currentIntent;
    /* Strictly greater. A tie is not an interruption — otherwise every routine
       observation of the same importance would restart the behaviour it belongs to. */
    if (current !== null && observation.priority <= current.priority) return;

    this.preempt(nowMs);
  }

  /**
   * Throw away the current intent, the buffer and the request, and let the floor cover.
   *
   * *Cost, stated:* one in-flight request is discarded. That is the token price of
   * responsiveness, bounded by the preemption rate, which the consumer sets through
   * priorities — so `usage.preemptedRequests` reports it. A number nobody reports is a
   * number nobody tunes.
   */
  private preempt(nowMs: number): void {
    if (this.inFlight !== null) {
      notePreemption(this.usageState);
      this.abortInFlight();
    }

    this.bufferedIntent = null;
    this.currentIntent = null;

    /* Recorded, because an observation is external input and nothing in the simulation
       derives it. A replay that reran the floor past this moment would diverge from
       here on, and every later decision would be wrong for one reason. */
    const mark: AiPreemption = {
      kind: 'preemption',
      agentId: this.agentId,
      acceptedAtTick: this.context.tick,
    };
    this.log?.record(mark);

    this.transition('preempted');
    this.take(nowMs);

    /*
     * The interrupt question is about *now*, so its answer goes into the current slot
     * rather than the buffer. The floor is already running by the time it lands, which
     * is what makes a slow answer harmless rather than a hole.
     */
    if (this.interruptProvider !== null) this.askInterrupt(nowMs);
  }

  private askInterrupt(nowMs: number): void {
    const provider = this.interruptProvider;
    if (provider === null) return;
    if (this.budget?.exhausted === true) return;

    const session = provider.createSession({ model: this.model });
    const generation = ++this.inFlightGeneration;
    this.inFlight = session;
    this.inFlightAt = nowMs;
    this.issuedAtTick = this.context.tick;
    this.usageState.requests++;
    /*
     * The interrupt *is* the request in flight. Without this the session would fall
     * through to `maybeContinue` on the same tick, issue a continuation, bump the
     * generation, and drop the interrupt's answer as stale — two requests out, and
     * the faster one thrown away.
     */
    this.transition('continuationIssued');

    void this.consumeInterrupt(
      session.run({
        preamble: 'Something just happened. What should this agent do right now?',
        context: { capturedAtTick: this.context.tick },
        toolIds: this.tools?.ids() ?? [],
        signal: new AbortController().signal,
      }),
      generation,
    );
  }

  private async consumeInterrupt(
    events: AsyncIterable<AiEvent>,
    generation: number,
  ): Promise<void> {
    const toolIds: string[] = [];
    const args: unknown[] = [];
    let landed = false;

    for await (const event of events) {
      chargeUsage(this.usageState, event);
      if (event.kind === 'toolCall') {
        toolIds.push(event.toolId);
        args.push(event.args);
      }
      if (event.kind === 'done') {
        landed = event.reason !== 'aborted';
        break;
      }
    }

    if (generation !== this.inFlightGeneration) return;
    this.inFlight = null;

    /* Out of `ahead` whatever the answer was. A refused or empty interrupt that left
       the session there would mean no continuation could ever be issued again — the
       agent would run on its floor for the rest of the session and nothing would say
       why. */
    this.transition('responseLanded');
    this.transition('intentCompleted');

    if (!landed || toolIds.length === 0) return;

    const intent: Intent = {
      id: `interrupt:${this.issuedAtTick}`,
      priority: 90,
      toolIds,
      args,
      expectedExtentMs: UNKNOWN_EXTENT,
      source: 'model',
    };
    if (!this.admits(intent)) return;

    this.currentIntent = intent;
    this.record(intent);
  }

  /**
   * Write an admitted model intent into the command log.
   *
   * Only model intents. The floor is deterministic and recomputes identically on
   * replay, so recording its decisions would store what can be derived — and a
   * thousand-tick recording would be a thousand entries instead of a handful.
   */
  private record(intent: Intent): void {
    const log = this.log;
    if (log === null || intent.source !== 'model') return;
    for (let i = 0; i < intent.toolIds.length; i++) {
      const toolId = intent.toolIds[i];
      if (toolId === undefined) continue;
      const command: AiCommand = {
        kind: 'command',
        toolId,
        args: intent.args[i],
        agentId: this.agentId,
        issuedAtTick: this.issuedAtTick,
        acceptedAtTick: this.context.tick,
      };
      log.record(command);
    }
  }

  /** True once a budget is exhausted: still moving, no longer asking. */
  get degraded(): boolean {
    return this.budget?.exhausted === true;
  }

  /** The budget's own sentence, or empty while nothing is exhausted. */
  get degradedReason(): string {
    if (this.budget?.exhausted !== true) return '';
    return `agent ${this.agentId}: ${this.budget.reason} — running on policy floor, 0 requests in flight`;
  }

  /** Buffered intents discarded because their guard had gone false. */
  get discardedIntents(): number {
    return this.discarded;
  }

  private finished(nowMs: number): boolean {
    const current = this.currentIntent;
    if (current === null) return false;
    const elapsed = nowMs - this.startedAtMs;
    if (elapsed >= this.maxIntentMs) return true;
    if (!hasKnownExtent(current)) return false;
    return elapsed >= current.expectedExtentMs;
  }

  /**
   * Issue the continuation, if this is the tick to issue it on.
   *
   * The watermark itself is `leadMs`. This only decides whether the state machine
   * has an edge available, which is where one-request-in-flight actually lives.
   */
  private maybeContinue(nowMs: number): void {
    if (this.provider === null) return;
    if (this.budget?.exhausted === true) return;
    if (nextState(this.agentState, 'continuationIssued') === null) return;

    const current = this.currentIntent;
    if (current === null) return;

    const lead = this.leadMs;
    if (hasKnownExtent(current)) {
      const remaining = current.expectedExtentMs - (nowMs - this.startedAtMs);
      if (lead >= 0 && remaining > lead) return;
    }

    this.issue(nowMs);
  }

  /** The lead the watermark uses: the provider's measured p90, or -1 before it knows. */
  get leadMs(): number {
    return this.latency.p90;
  }

  /**
   * Charge the latency of a response, measured to the tick that observed it.
   *
   * A response lands in a microtask, where there is no simulation clock to read. So
   * the landing is flagged and priced on the next `tick`, which measures the latency a
   * fixed-step consumer *experiences* rather than the one a wall clock would report.
   * Those differ by up to one step, and the one that matters for deciding when to ask
   * again is this one.
   *
   * *What it costs:* a response landing just after a tick is charged nearly a whole
   * step more than it took. *What would make it wrong:* a consumer stepping far more
   * slowly than its provider answers, where a step's rounding would dominate the
   * measurement — at which point the session needs a clock rather than a flag.
   */
  private recordLanding(nowMs: number): void {
    if (this.landedAtMs < 0) return;
    this.latency.record(Math.max(0, nowMs - this.landedAtMs));
    this.usageState.latencyMsP90 = Math.max(0, this.latency.p90);
    this.landedAtMs = -1;
  }

  private issue(nowMs: number): void {
    const provider = this.provider;
    if (provider === null) return;

    const session = provider.createSession({ model: this.model });
    const controller = new AbortController();
    const generation = ++this.inFlightGeneration;

    this.inFlight = session;
    this.inFlightAt = nowMs;
    this.issuedAtTick = this.context.tick;
    this.usageState.requests++;
    this.transition('continuationIssued');

    /* A first request, from `idle`, has no "currently" to describe — the agent is
       being asked what to do now. A continuation, from `running`, must say when its
       answer will be used or the model answers about the wrong moment. */
    const current = this.currentIntent;
    const remaining = current === null ? 0 : current.expectedExtentMs - (nowMs - this.startedAtMs);
    const preamble = current === null ? '' : continuationPreamble(current, remaining);

    void this.consume(
      session.run({
        preamble,
        context: { capturedAtTick: this.context.tick },
        toolIds: this.tools?.ids() ?? [],
        signal: controller.signal,
      }),
      generation,
    );
  }

  private async consume(events: AsyncIterable<AiEvent>, generation: number): Promise<void> {
    const toolIds: string[] = [];
    const args: unknown[] = [];
    let landed = false;

    for await (const event of events) {
      chargeUsage(this.usageState, event);

      if (event.kind === 'toolCall') {
        toolIds.push(event.toolId);
        args.push(event.args);
      }
      if (event.kind === 'done') {
        landed = event.reason !== 'aborted';
        break;
      }
    }

    /* A response for a request the session has moved past. Dropping it is the point:
       `ahead -> intentCompleted -> idle` abandoned this question, and buffering the
       answer would put a stale intent in the slot behind a fresh one. */
    if (generation !== this.inFlightGeneration) return;
    this.inFlight = null;
    if (!landed) return;

    /* Priced on the next tick, where there is a simulation clock to read. */
    this.landedAtMs = this.inFlightAt;

    /* Named by the tick the model was asked, not by a generation counter, because that
       is the one identifier the command log preserves — so a replayed intent carries
       the same name as the recorded one without the log having to store it. */
    this.bufferedIntent = {
      id: `model:${this.issuedAtTick}`,
      priority: 50,
      toolIds,
      args,
      expectedExtentMs: UNKNOWN_EXTENT,
      source: 'model',
    };
    this.transition('responseLanded');
  }

  private abortInFlight(): void {
    const session = this.inFlight;
    if (session === null) return;
    this.inFlightGeneration++;
    this.inFlight = null;
    noteAbort(this.usageState);
    session.abort('aborted');
  }

  private transition(name: Parameters<typeof nextState>[1]): void {
    const next = nextState(this.agentState, name);
    if (next !== null) this.agentState = next;
  }
}
