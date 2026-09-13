/**
 * What an agent is doing, and the seam that decides it when nothing else can.
 */

/** An intent whose extent is unknown. The watermark reads it as "ask immediately". */
export const UNKNOWN_EXTENT = -1;

export interface Intent {
  readonly id: string;
  readonly priority: number;
  readonly toolIds: readonly string[];
  readonly args: readonly unknown[];
  /**
   * How long this is expected to take, in milliseconds, or `UNKNOWN_EXTENT`.
   *
   * The continuation watermark subtracts the provider's measured p90 from this to
   * decide when to ask what comes next. An unknown extent asks immediately, which is
   * the behaviour a design that waited would have had and is correct for a one-shot.
   */
  readonly expectedExtentMs: number;
  readonly source: 'floor' | 'model';
}

export interface PolicyContext {
  readonly tick: number;
  readonly agentId: string;
  /** Milliseconds the current intent has been running. */
  readonly elapsedMs: number;
}

export interface PolicyOption {
  /**
   * Pre-built and reused, never constructed per tick.
   *
   * The floor claims it allocates nothing per tick, and selecting among N existing
   * objects makes that true by construction rather than by care.
   */
  readonly intent: Intent;
  score(context: PolicyContext): number;
}

export interface AgentPolicy {
  select(context: PolicyContext): Intent;
}

export function hasKnownExtent(intent: Intent): boolean {
  return intent.expectedExtentMs > UNKNOWN_EXTENT;
}

export type IntentCheck = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/**
 * Whether an intent is internally coherent.
 *
 * Only the pairing of tools to arguments, because that is the one an intent can get
 * wrong on its own. Whether the tools *exist* is the registry's question and whether
 * the call is *permitted* is the policy's; asking all three here would put three
 * failures behind one message.
 */
export function validateIntent(intent: Intent): IntentCheck {
  if (intent.toolIds.length !== intent.args.length) {
    return {
      ok: false,
      reason:
        `intent "${intent.id}" names ${intent.toolIds.length} tools but carries ` +
        `${intent.args.length} argument sets`,
    };
  }
  return { ok: true };
}
