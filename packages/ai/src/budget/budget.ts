import type { AiUsage } from '../session/usage.ts';

export interface BudgetLimits {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly requests?: number;
  readonly costMicros?: number;
  readonly wallMs?: number;
}

const COUNTED = ['inputTokens', 'outputTokens', 'requests', 'costMicros'] as const;

/**
 * A ceiling on what an agent may spend, enforced here rather than asked for in a prompt.
 *
 * **Exhaustion degrades.** `charge` past a limit returns normally and latches
 * `exhausted`; the session stops issuing continuations and the policy floor keeps
 * producing intents. Throwing would put an exception inside a fixed step, which is
 * worse than the overspend it prevents.
 *
 * *What it costs:* an agent that goes over is quietly less capable, and a consumer
 * that never reads `reason` will not know why. *What would make it wrong:* if a
 * consumer needs to know at the moment it happens rather than by polling, this needs
 * a callback — deliberately not added until something asks, because a callback firing
 * inside a fixed step has the same hazard the throw did.
 */
export class Budget {
  private readonly limits: BudgetLimits;
  private latched = false;
  private latchedReason = '';
  private startedAtMs = -1;

  constructor(limits: BudgetLimits) {
    this.limits = limits;
  }

  get exhausted(): boolean {
    return this.latched;
  }

  /** The sentence a consumer reports. Empty while not exhausted. */
  get reason(): string {
    return this.latchedReason;
  }

  charge(usage: Readonly<AiUsage>, nowMs: number): void {
    if (this.startedAtMs < 0) this.startedAtMs = nowMs;
    if (this.latched) return;

    for (const key of COUNTED) {
      const limit = this.limits[key];
      if (limit !== undefined && usage[key] > limit) {
        this.latch(key, limit, usage[key]);
        return;
      }
    }

    const wall = this.limits.wallMs;
    if (wall !== undefined && nowMs - this.startedAtMs > wall) {
      this.latch('wallMs', wall, nowMs - this.startedAtMs);
    }
  }

  /*
   * Latched rather than recomputed. A budget derived from current usage comes back to
   * life the moment a consumer resets a counter, and the agent resumes spending
   * against a limit somebody has already hit.
   */
  private latch(name: string, limit: number, actual: number): void {
    this.latched = true;
    this.latchedReason = `budget exhausted: ${name} limit ${limit}, reached ${actual}`;
  }
}
