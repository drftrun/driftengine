/**
 * Capability and execution policy, refusing in a fixed order.
 *
 * This is the *acceptance* check — it runs when a model proposes a call. The
 * *application* check runs later, at the tick boundary, and re-runs the tool's own
 * guard because a snapshot is never authority.
 */
import { describe, expect, it } from 'vitest';
import { admitToolCall, RateWindows } from './policy.ts';
import { ToolRegistry } from './registry.ts';
import type { ToolDefinition, ToolSchema } from './registry.ts';
import { Budget } from '../budget/budget.ts';
import { createUsage } from '../session/usage.ts';

interface World {
  readonly ok: boolean;
}

const SCHEMA: ToolSchema = { kind: 'object', fields: { target: { kind: 'string' } } };

function registry(...tools: Partial<ToolDefinition<never, never, World>>[]): ToolRegistry<World> {
  const reg = new ToolRegistry<World>();
  for (const extra of tools) {
    reg.register({
      id: 'inspect@1',
      description: 'a tool',
      schema: SCHEMA,
      admits: () => true,
      execute: () => undefined as never,
      ...extra,
    } as ToolDefinition<never, never, World>);
  }
  return reg;
}

const OPEN = new Budget({});
const ARGS = { target: 'D4' };

describe('admitToolCall', () => {
  it('accepts a registered, permitted, valid call', () => {
    const result = admitToolCall(registry({}), {}, OPEN, 'inspect@1', ARGS, 0);
    expect(result.ok).toBe(true);
  });

  it('distinguishes an unknown tool from one that is not permitted', () => {
    const unknown = admitToolCall(registry({}), {}, OPEN, 'ghost@1', ARGS, 0);
    const forbidden = admitToolCall(
      registry({}),
      { allow: ['other@1'] },
      OPEN,
      'inspect@1',
      ARGS,
      0,
    );

    expect(unknown.ok).toBe(false);
    expect(forbidden.ok).toBe(false);
    if (!unknown.ok) expect(unknown.reason).toMatch(/unknown|not registered/i);
    if (!forbidden.ok) expect(forbidden.reason).toMatch(/not permitted|policy/i);

    /* A model calling a tool that does not exist and one calling a tool it may not use
       are different bugs — the first is a stale prompt, the second is a policy the
       prompt does not reflect — and one message for both sends a reader down the
       wrong one half the time. */
    if (!unknown.ok && !forbidden.ok) expect(unknown.reason).not.toBe(forbidden.reason);
  });

  it('passes the validation reason through unchanged, with its field path', () => {
    const result = admitToolCall(registry({}), {}, OPEN, 'inspect@1', { target: 7 }, 0);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('target');
      expect(result.reason).toContain('number');
    }
  });

  it('refuses over a rate limit, naming the class and the limit', () => {
    const reg = registry({ rateClass: 'movement' });
    const policy = { rateLimits: { movement: 2 } };
    const rates = new RateWindows();

    expect(admitToolCall(reg, policy, OPEN, 'inspect@1', ARGS, 0, rates).ok).toBe(true);
    expect(admitToolCall(reg, policy, OPEN, 'inspect@1', ARGS, 100, rates).ok).toBe(true);

    const third = admitToolCall(reg, policy, OPEN, 'inspect@1', ARGS, 200, rates);
    expect(third.ok).toBe(false);
    if (!third.ok) {
      expect(third.reason).toContain('movement');
      expect(third.reason).toContain('2');
    }

    /* A second later the window has moved and the same call is fine again. */
    expect(admitToolCall(reg, policy, OPEN, 'inspect@1', ARGS, 1300, rates).ok).toBe(true);
  });

  it('keeps one agent rate limit away from another', () => {
    const reg = registry({ rateClass: 'movement' });
    const policy = { rateLimits: { movement: 1 } };
    const busy = new RateWindows();
    const quiet = new RateWindows();

    expect(admitToolCall(reg, policy, OPEN, 'inspect@1', ARGS, 0, busy).ok).toBe(true);
    expect(admitToolCall(reg, policy, OPEN, 'inspect@1', ARGS, 10, busy).ok).toBe(false);

    /*
     * The first draft of this module kept rate windows in a module-level map keyed by
     * class name, and this is the assertion that says why it could not stay there: a
     * busy agent would silence a quiet one, and every test would carry state into the
     * next. Per-agent is the only scope a consumer can reason about.
     */
    expect(admitToolCall(reg, policy, OPEN, 'inspect@1', ARGS, 10, quiet).ok).toBe(true);
  });

  it('refuses on an exhausted budget, with the budget own sentence', () => {
    const budget = new Budget({ requests: 1 });
    const usage = createUsage();
    usage.requests = 5;
    budget.charge(usage, 0);

    const result = admitToolCall(registry({}), {}, budget, 'inspect@1', ARGS, 0);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe(budget.reason);
  });

  it('refuses a tool needing approval rather than executing it', () => {
    const result = admitToolCall(
      registry({}),
      { requireApproval: ['inspect@1'] },
      OPEN,
      'inspect@1',
      ARGS,
      0,
    );

    /* The default is never to assume consent. A tool a consumer marked as needing a
       human is not a tool that runs when nobody answered. */
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/approval/i);
  });

  it('refuses in a fixed order, so one call always reports the same reason', () => {
    const budget = new Budget({ requests: 1 });
    const usage = createUsage();
    usage.requests = 5;
    budget.charge(usage, 0);

    /* Unknown *and* over budget. Without a defined order this reports whichever check
       happened to run first, and a consumer chasing an intermittent message finds
       nothing wrong with either. */
    const result = admitToolCall(registry({}), {}, budget, 'ghost@1', ARGS, 0);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/unknown|not registered/i);
  });
});
