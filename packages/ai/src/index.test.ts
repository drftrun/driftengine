/**
 * The barrel exports what a consumer reaches for.
 *
 * A static namespace import rather than a dynamic one: `await import(...)` inside the
 * test body was timing out under full-suite parallelism while passing in isolation,
 * which is a flake rather than a finding. Nothing here needs the module loaded late.
 *
 * The manifest's shape is asserted in `package.test.mjs` instead, because the workspace
 * tsconfig gives package tests no node types — reading a file is a `node:test` job here,
 * and the split follows `packages/package/src/cli.test.mjs`.
 */
import { describe, expect, it } from 'vitest';
import * as barrel from './index.ts';

describe('the barrel', () => {
  it('exports the provider seam', () => {
    expect(typeof barrel.createAiProvider).toBe('function');
  });

  it('exports the agent loop and its floor', () => {
    expect(typeof barrel.AgentSession).toBe('function');
    expect(typeof barrel.UtilityPolicy).toBe('function');
    expect(typeof barrel.nextState).toBe('function');
  });

  it('exports the tool and context surfaces', () => {
    expect(typeof barrel.ToolRegistry).toBe('function');
    expect(typeof barrel.validateArgs).toBe('function');
    expect(typeof barrel.assembleContext).toBe('function');
  });

  it('exports the recording and replay pair', () => {
    expect(typeof barrel.CommandLog).toBe('function');
    expect(typeof barrel.ReplaySession).toBe('function');
    expect(typeof barrel.applyCommand).toBe('function');
  });

  it('exports the deterministic test provider', () => {
    /* Shipped rather than kept in the test tree: a consumer testing its own agent needs
       the same programmable latency this package's tests do, and asking every one of
       them to write it again is asking for the timing to be got wrong four ways. */
    expect(typeof barrel.DeterministicProvider).toBe('function');
  });
});
