import { hasKnownExtent } from '../policy/types.ts';
import type { Intent } from '../policy/types.ts';

/**
 * Tell the model when its answer will be used.
 *
 * Three lines. Without them the model answers as though acting immediately, proposes
 * what is right now and wrong in a second and a half, and the lookahead becomes lag
 * that is still paid for. The whole value of asking early is lost to not saying so.
 *
 * *What it costs:* three lines of every continuation's context budget. *What would
 * make it wrong:* a provider that ignores framing of this kind entirely, at which
 * point the lead should shrink toward zero rather than the preamble being dropped —
 * the fix for a model that cannot reason about the future is to stop asking it to.
 */
export function continuationPreamble(current: Intent, remainingMs: number): string {
  const doing = describeIntent(current);
  const when = hasKnownExtent(current)
    ? `~${(Math.max(0, remainingMs) / 1000).toFixed(1)}s after this snapshot`
    : 'unknown — this action has no predictable duration';

  return [
    `You are currently:    ${doing}`,
    `Expected to finish:   ${when}`,
    `Your answer applies:  when that finishes, not now`,
  ].join('\n');
}

/**
 * What the agent is doing, in the model's terms.
 *
 * A floor intent is described exactly like a model intent. Telling the model the
 * engine improvised would invite it to treat the current behaviour as provisional,
 * and the floor's choice is as real as any other — it is what the agent is doing.
 */
function describeIntent(intent: Intent): string {
  if (intent.toolIds.length === 0) return `${intent.id} (no tool calls)`;
  return `${intent.id} (${intent.toolIds.join(', ')})`;
}
