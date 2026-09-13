import type { AgentPolicy, Intent, PolicyContext } from '../policy/types.ts';
import type { LogEntry } from '../command/log.ts';

export interface ReplaySource {
  at(tick: number, out: LogEntry[]): number;
}

/**
 * Replay accepted commands at their original boundaries. Calls no provider, ever.
 *
 * **A buffered agent replays exactly**, and the floor is why. Model decisions are
 * replayed from the log; floor decisions are *recomputed*, because the floor is
 * deterministic and runs inside the simulation. So the log carries only what could not
 * be derived, and a thousand-tick recording is a handful of entries rather than a
 * thousand.
 *
 * The design that waited could not promise this. There, the *timing* of a response was
 * itself part of the behaviour — an agent stood still for however long the provider
 * took — and timing is the one thing a live provider will not reproduce.
 */
export class ReplaySession {
  private readonly source: ReplaySource;
  private readonly policy: AgentPolicy;
  private readonly scratch: LogEntry[] = [];
  private readonly context = { tick: 0, agentId: '', elapsedMs: 0 };

  private currentIntent: Intent | null = null;
  private startedAtMs = 0;
  private replayed = 0;

  constructor(source: ReplaySource, policy: AgentPolicy, agentId: string) {
    this.source = source;
    this.policy = policy;
    this.context.agentId = agentId;
  }

  get current(): Intent | null {
    return this.currentIntent;
  }

  /** Model intents taken from the log rather than recomputed. */
  get replayedIntents(): number {
    return this.replayed;
  }

  tick(tickNumber: number, nowMs: number): Intent {
    this.context.tick = tickNumber;
    this.context.elapsedMs = nowMs - this.startedAtMs;

    const count = this.source.at(tickNumber, this.scratch);
    const toolIds: string[] = [];
    const args: unknown[] = [];
    let issuedAt = tickNumber;
    let preempted = false;

    for (let i = 0; i < count; i++) {
      const entry = this.scratch[i];
      if (entry === undefined) continue;
      if (entry.kind === 'preemption') {
        preempted = true;
        continue;
      }
      toolIds.push(entry.toolId);
      args.push(entry.args);
      issuedAt = entry.issuedAtTick;
    }

    if (preempted) {
      /* The intent was cut short by external input. Force the floor to choose again
         on this tick, exactly as the recording did. */
      this.currentIntent = null;
    }

    if (toolIds.length > 0) {
      this.replayed++;
      this.currentIntent = {
        id: `model:${issuedAt}`,
        priority: 50,
        toolIds,
        args,
        expectedExtentMs: -1,
        source: 'model',
      };
      this.startedAtMs = nowMs;
      return this.currentIntent;
    }

    const current = this.currentIntent;
    if (current !== null && current.expectedExtentMs < 0) return current;
    if (current !== null && nowMs - this.startedAtMs < current.expectedExtentMs) return current;

    this.currentIntent = this.policy.select(this.context as PolicyContext);
    this.startedAtMs = nowMs;
    return this.currentIntent;
  }
}
