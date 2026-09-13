import type { AiEvent } from '../provider/types.ts';

/**
 * What an agent has spent.
 *
 * Mutated in place. A session charges per event, and allocating a usage object per
 * event would put an allocation on the path a streaming response takes hundreds of
 * times per request.
 */
export interface AiUsage {
  inputTokens: number;
  outputTokens: number;
  requests: number;
  /**
   * Requests aborted because a higher-priority observation arrived.
   *
   * The token price of responsiveness, and the number a consumer tunes its priority
   * thresholds against. Separate from `abortedRequests` because disposal and hot
   * reload also abort, and no threshold a consumer can set changes those.
   */
  preemptedRequests: number;
  abortedRequests: number;
  costMicros: number;
  latencyMsP90: number;
}

export function createUsage(): AiUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    requests: 0,
    preemptedRequests: 0,
    abortedRequests: 0,
    costMicros: 0,
    latencyMsP90: 0,
  };
}

/** Tokens only. Who aborted, and why, is something the session knows and an event does not. */
export function chargeUsage(usage: AiUsage, event: AiEvent): void {
  if (event.kind !== 'usage') return;
  usage.inputTokens += event.inputTokens;
  usage.outputTokens += event.outputTokens;
}

/**
 * Record an abort, whatever caused it.
 *
 * Counted where the session aborts rather than where the `done` event arrives. Reading
 * it off the event double-counts every abort the session also has a reason for, and an
 * aborted request produces a `done` *and* a decision — one abort, two places that
 * could increment.
 */
export function noteAbort(usage: AiUsage): void {
  usage.abortedRequests++;
}

/**
 * Record that the abort being taken is a preemption.
 *
 * Only the narrow counter. `noteAbort` moves the broad one, so a preemption increments
 * both by going through both — and neither function has to know what the other did.
 */
export function notePreemption(usage: AiUsage): void {
  usage.preemptedRequests++;
}
