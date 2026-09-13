import type { Budget } from '../budget/budget.ts';
import type { ToolRegistry } from './registry.ts';
import { validateArgs } from './validate.ts';

export interface ExecutionPolicy {
  /** Tool ids this agent may call at all. Absent means every registered tool. */
  readonly allow?: readonly string[];
  /** Calls per rate class, per second. */
  readonly rateLimits?: Readonly<Record<string, number>>;
  /** Tools a human has to say yes to. Refused here rather than queued. */
  readonly requireApproval?: readonly string[];
}

export type Admission = { readonly ok: true } | { readonly ok: false; readonly reason: string };

const OK: Admission = { ok: true };

/**
 * Rate state, owned by whoever owns the agent.
 *
 * **Not module-level.** A shared map keyed by class name would make two unrelated
 * agents share one limit, so a busy one would silence a quiet one — and worse, a test
 * would carry state into the next test. The session owns one of these; the limit is
 * per agent, which is the only scope a consumer can reason about.
 *
 * Timestamps live in a reused array with a count, because `array.length = 0` re-grows
 * V8's backing store and this is touched on every accepted call.
 */
export class RateWindows {
  private readonly byClass = new Map<string, { at: number[]; count: number }>();

  /** Records the call and reports whether it fits. */
  admit(rateClass: string, limit: number, nowMs: number): boolean {
    let window = this.byClass.get(rateClass);
    if (window === undefined) {
      window = { at: [], count: 0 };
      this.byClass.set(rateClass, window);
    }

    let kept = 0;
    for (let i = 0; i < window.count; i++) {
      const stamp = window.at[i];
      if (stamp !== undefined && nowMs - stamp < 1000) window.at[kept++] = stamp;
    }
    window.count = kept;

    if (window.count >= limit) return false;

    if (window.count < window.at.length) window.at[window.count] = nowMs;
    else window.at.push(nowMs);
    window.count++;
    return true;
  }

  clear(): void {
    this.byClass.clear();
  }
}

/**
 * Whether a proposed tool call may be accepted.
 *
 * **The order is fixed and the first failure wins.** A call that is both unknown and
 * over budget always reports that it is unknown, because a consumer chasing a message
 * that changes between runs finds nothing wrong with either check. Order: exists,
 * permitted, needs approval, arguments valid, within rate, within budget — cheapest
 * and most specific first, so the message names the thing a reader can act on.
 *
 * This is the *acceptance* check. It does not run the tool's own `admits` guard: that
 * runs at the tick boundary where the call is applied, because a snapshot is never
 * authority and a buffered intent widens the gap between the two moments.
 */
export function admitToolCall<W>(
  registry: ToolRegistry<W>,
  policy: ExecutionPolicy,
  budget: Budget,
  toolId: string,
  args: unknown,
  nowMs: number,
  rates: RateWindows = new RateWindows(),
): Admission {
  const tool = registry.get(toolId);
  if (tool === undefined) {
    return { ok: false, reason: `unknown tool "${toolId}" — it is not registered` };
  }

  if (policy.allow !== undefined && !policy.allow.includes(toolId)) {
    return { ok: false, reason: `tool "${toolId}" is not permitted by this agent's policy` };
  }

  if (policy.requireApproval?.includes(toolId) === true) {
    return { ok: false, reason: `tool "${toolId}" requires approval, which was not given` };
  }

  const validation = validateArgs(tool.schema, args);
  if (!validation.ok) {
    return { ok: false, reason: `${validation.path}: ${validation.reason}` };
  }

  const rateClass = tool.rateClass;
  const limit = rateClass === undefined ? undefined : policy.rateLimits?.[rateClass];
  if (rateClass !== undefined && limit !== undefined) {
    if (!rates.admit(rateClass, limit, nowMs)) {
      return {
        ok: false,
        reason: `rate class "${rateClass}" is over its limit of ${limit} per second`,
      };
    }
  }

  if (budget.exhausted) return { ok: false, reason: budget.reason };

  return OK;
}
