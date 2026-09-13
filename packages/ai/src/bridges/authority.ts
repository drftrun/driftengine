/**
 * One machine decides what an agent does, and everybody else is replaying it.
 *
 * **A model is not a function of the simulation.** It is slow, variable and metered, and two peers
 * running the same agent loop over the same world do not agree. So a decision is taken on the
 * authority and reaches a participant as a fact it does not re-take.
 *
 * ## There is no second mechanism here, and that is the design
 *
 * `CommandLog` records what a model decided and when it crossed into the simulation;
 * `ReplaySession` reads that log, recomputes floor intents and **calls no provider, ever**. The
 * floor is deterministic and replays by rerunning, so the log carries only what cannot be derived.
 *
 * **A participant is therefore a replay whose log arrives over a network instead of from a
 * recording**, and a rewind is a replay of the same log. Replicating an intent id on the input path
 * instead would have solved a problem this package had already solved, and `inputLog.ts` refuses
 * variable-length payloads in writing anyway.
 *
 * What is left for this file is the part that is genuinely about networking: which side decides,
 * getting decisions onto the wire, and noticing when one arrives for a tick already run.
 *
 * ## A late decision is a rewind, and this file will not perform one
 *
 * A command can land after the participant has already stepped the tick it belongs to. That
 * participant used its floor where the authority used a model, and the two worlds differ. The
 * correction is Track J's rewind and it belongs to the consumer, who owns the `RewindLoop`, the
 * snapshot and the decision about how far back is worth going. `earliestLateTick` reports the
 * oldest such tick and this file does nothing else about it: performing a rewind from inside an
 * agent would be an AI package deciding when a whole simulation goes backwards.
 *
 * ## What a script may not see
 *
 * Nothing here is bound to `drift/ai` beyond `deciding`. A capability handing a script the tools or
 * arguments a model chose would let a `@deterministic` system branch on a provider's answer, and the
 * replay would take the other branch.
 */

import type { AiCommand, CommandLog, LogEntry } from '../command/log.ts';
import type { Intent } from '../policy/types.ts';
import type { AgentSession } from '../session/agent.ts';
import type { ReplaySession } from '../session/replay.ts';

/**
 * The sentinel's own name, exported so the documentation gate fires when this file arrives.
 *
 * `docs/CAPABILITIES.md` matches `AI_NETWORK_AUTHORITY|replicateDecision`, and a bridge named around
 * the pattern would have landed the capability and left the guard quiet — leaving the document
 * refusing in writing a thing that exists, which is worse than the stale prose it replaces.
 */
export const AI_NETWORK_AUTHORITY = 'ai-network-authority@1';

/**
 * How a decision crosses. The consumer's, because packing and transport are theirs.
 *
 * A command is a tool id, structured arguments and two tick numbers. It is **not** a simulation
 * input: `inputLog.ts` is fixed-width per participant per tick and refuses variable-length payloads
 * by design, and an agent's decision is exactly the shape it refuses. So this rides whatever
 * reliable channel the consumer already has.
 */
export interface DecisionChannel {
  /** Authority side. Called once per accepted command, never for a floor intent. */
  replicateDecision(command: AiCommand): void;
  /**
   * Participant side. Hand over everything that has arrived since the last call.
   *
   * Returns how many were delivered. Draining rather than a callback registration so the consumer
   * decides when decisions enter the simulation, which on a fixed step must be at a tick boundary.
   */
  drain(into: (command: AiCommand) => void): number;
}

export type AgentRole = 'authority' | 'participant';

export interface AuthoritativeAgentOptions {
  /**
   * Which side this is, asked every tick.
   *
   * A function and not a flag because authority can move, and a wrapper that cached the answer at
   * construction would keep deciding after it stopped being allowed to.
   */
  role(): AgentRole;
  channel: DecisionChannel;
  /**
   * The log both sides read.
   *
   * On the authority the session writes it and this publishes from it; on a participant the channel
   * fills it and the replay reads it. One structure, because a second one would be a second answer
   * to what the agent decided.
   */
  log: CommandLog;
}

/**
 * An agent whose model decisions are taken in one place.
 *
 * Wraps the two sessions the package already has and picks between them. It adds no policy, no
 * provider handling and no replay logic; all three exist and are reused.
 */
export class AuthoritativeAgent {
  private readonly session: AgentSession<unknown>;
  private readonly replay: ReplaySession;
  private readonly options: AuthoritativeAgentOptions;
  private readonly scratch: LogEntry[] = [];

  /** Ticks whose commands have been put on the wire. Nothing before this is published twice. */
  private publishedThrough = -1;
  private lastTick = -1;
  private late = -1;
  private published = 0;
  private accepted = 0;

  constructor(
    session: AgentSession<unknown>,
    replay: ReplaySession,
    options: AuthoritativeAgentOptions,
  ) {
    this.session = session;
    this.replay = replay;
    this.options = options;
  }

  /** Decisions this peer put on the wire. Zero on a participant, always. */
  get publishedDecisions(): number {
    return this.published;
  }

  /** Decisions taken off the wire. Zero on the authority, always. */
  get acceptedDecisions(): number {
    return this.accepted;
  }

  /**
   * The oldest tick a decision arrived for after that tick had already run, or -1.
   *
   * A consumer holding a `RewindLoop` reads this, rewinds to it and replays. Cleared by
   * `clearLate` once they have.
   */
  get earliestLateTick(): number {
    return this.late;
  }

  clearLate(): void {
    this.late = -1;
  }

  /**
   * Advance one tick and return what the agent is doing.
   *
   * Arriving decisions are drained **before** the tick runs, so a command for this tick is in the
   * log by the time the replay reads it. A command for an earlier tick is recorded anyway — the log
   * is keyed by acceptance tick, so it lands where a later rewind will find it — and noted in
   * `earliestLateTick`.
   */
  tick(tickNumber: number, nowMs: number): Intent {
    this.drain(tickNumber);
    this.lastTick = tickNumber;

    if (this.options.role() === 'participant') {
      /* No provider is reachable from here. `ReplaySession` has none, which is the property that
         makes "a participant never decides" true by construction rather than by care. */
      return this.replay.tick(tickNumber, nowMs);
    }

    const intent = this.session.tick(tickNumber, nowMs);
    this.publish(tickNumber);
    return intent;
  }

  private drain(tickNumber: number): void {
    this.options.channel.drain((command) => {
      this.options.log.record(command);
      this.accepted++;
      if (command.acceptedAtTick < tickNumber && this.lastTick >= command.acceptedAtTick) {
        if (this.late < 0 || command.acceptedAtTick < this.late) this.late = command.acceptedAtTick;
      }
    });
  }

  /**
   * Put this tick's accepted commands on the wire.
   *
   * Read back out of the log rather than intercepted on the way in, so what crosses is exactly what
   * a replay of this authority would see. A second path that built its own message could disagree
   * with the log, and the disagreement would only show up as a participant that drifts.
   */
  private publish(tickNumber: number): void {
    if (tickNumber <= this.publishedThrough) return;
    const count = this.options.log.at(tickNumber, this.scratch);
    for (let i = 0; i < count; i++) {
      const entry = this.scratch[i];
      if (entry === undefined || entry.kind !== 'command') continue;
      this.options.channel.replicateDecision(entry);
      this.published++;
    }
    this.publishedThrough = tickNumber;
  }
}

/**
 * A channel with both ends in this process, for a test or a single-process host.
 *
 * **Not a mock.** R1 withdrew mocks standing in for engine capabilities that did not exist; this
 * stands in for a *transport*, which is a thing `AGENTS.md` says is a caller's to supply, and it
 * delivers real commands with a real ordering. `packages/network`'s seeded loopback is the same
 * shape of object for the same reason.
 *
 * Delivery is deferred to the next `drain` rather than immediate, because a channel that delivered
 * inside `replicateDecision` would let a decision reach a participant in the same tick it was taken,
 * which no real link does and which would hide every late-arrival bug this bridge exists to notice.
 */
export function loopbackDecisionChannel(): {
  authority: DecisionChannel;
  participant: DecisionChannel;
  /** How many are waiting. A test asserting a decision has *not* arrived yet reads this. */
  pending(): number;
} {
  const queue: AiCommand[] = [];
  return {
    authority: {
      replicateDecision(command: AiCommand): void {
        queue.push(command);
      },
      drain(): number {
        return 0;
      },
    },
    participant: {
      replicateDecision(): void {
        /* A participant never publishes. Silent rather than throwing, because this is reached from
           a fixed step and `AGENTS.md` forbids throwing in one; `AuthoritativeAgent` never calls
           it, so a call arriving here is a consumer's own wiring and their assertion to make. */
      },
      drain(into: (command: AiCommand) => void): number {
        const count = queue.length;
        for (let i = 0; i < count; i++) into(queue[i] as AiCommand);
        queue.length = 0;
        return count;
      },
    },
    pending(): number {
      return queue.length;
    },
  };
}
