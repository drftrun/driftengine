import { describe, expect, it } from 'vitest';
import { nextState } from './states.ts';
import type { AgentState, AgentTransition } from './states.ts';

const STATES: AgentState[] = ['idle', 'running', 'ahead', 'ready'];
const TRANSITIONS: AgentTransition[] = [
  'floorSupplied',
  'continuationIssued',
  'responseLanded',
  'intentCompleted',
  'preempted',
];

describe('the agent state machine', () => {
  it('takes every legal transition to the stated state', () => {
    expect(nextState('idle', 'floorSupplied')).toBe('running');
    expect(nextState('running', 'continuationIssued')).toBe('ahead');
    expect(nextState('ahead', 'responseLanded')).toBe('ready');
    expect(nextState('ready', 'intentCompleted')).toBe('running');
    expect(nextState('running', 'intentCompleted')).toBe('idle');
    expect(nextState('ahead', 'intentCompleted')).toBe('idle');
  });

  it('has no edge on which a second request could be issued', () => {
    /*
     * The two ways it could happen: asking again while one is already out, and asking
     * again when one has landed and is sitting in the buffer. Neither is a check that
     * runs — they are simply not in the table, which is what makes the guarantee
     * structural rather than defended.
     */
    expect(nextState('ahead', 'continuationIssued')).toBeNull();
    expect(nextState('ready', 'continuationIssued')).toBeNull();
  });

  it('does not issue a continuation from idle either', () => {
    /* Nothing is executing, so there is no "next" to ask about. The first request of a
       behaviour goes out from `running`, once the floor has said what the agent is
       doing now. */
    expect(nextState('idle', 'continuationIssued')).toBeNull();
  });

  it('completes an ahead intent to idle rather than to ready', () => {
    /* The response has not landed. Going to `ready` would mean draining a buffer that
       is empty, and an agent whose current slot came from nowhere. */
    expect(nextState('ahead', 'intentCompleted')).toBe('idle');
  });

  it('accepts a preemption from all four states', () => {
    for (const state of STATES) expect(nextState(state, 'preempted')).toBe('idle');
  });

  it('is total: all twenty pairs answer with a state or with null', () => {
    /* Enumerated rather than sampled. A partial table that happened to be missing the
       one pair a later task takes would fail at runtime rather than here. */
    let pairs = 0;
    for (const state of STATES) {
      for (const transition of TRANSITIONS) {
        const result = nextState(state, transition);
        expect(result === null || STATES.includes(result)).toBe(true);
        pairs++;
      }
    }
    expect(pairs).toBe(20);
  });
});
