/**
 * Four states, and a second request that has no edge to arrive on.
 *
 * ```text
 *             intent completes, buffer empty
 *         ┌───────────────────────────────────────┐
 *         ▼                                       │
 *       IDLE ── floor supplies ──▶ RUNNING ───────┤
 *                                     │           │
 *                     remaining ≈ p90 latency     │
 *                                     ▼           │
 *                                   AHEAD         │
 *                                     │           │
 *                         response lands          │
 *                                     ▼           │
 *                                   READY ────────┘
 *                                           intent completes,
 *                                           buffer drains
 * ```
 *
 * **`continuationIssued` is legal only from `running`.** That is the whole of the
 * one-request-in-flight guarantee: a counter can be violated by any path that forgets
 * to check it, where an edge that does not exist cannot be taken.
 */
export type AgentState = 'idle' | 'running' | 'ahead' | 'ready';

export type AgentTransition =
  'floorSupplied' | 'continuationIssued' | 'responseLanded' | 'intentCompleted' | 'preempted';

const TABLE: Readonly<Record<AgentState, Partial<Record<AgentTransition, AgentState>>>> = {
  idle: {
    floorSupplied: 'running',
    preempted: 'idle',
  },
  running: {
    continuationIssued: 'ahead',
    /* Nothing is buffered and no request is out, so the next intent has to come from
       the floor — which is what `idle` means here: not "doing nothing", but "owing
       the floor a decision on the next tick". */
    intentCompleted: 'idle',
    preempted: 'idle',
  },
  ahead: {
    responseLanded: 'ready',
    /*
     * To `idle`, not to `ready`. The response has not landed, so the floor supplies
     * the next intent — and the request is still outstanding against an intent that
     * is now over. The session abandons it rather than buffering an answer to a
     * question nobody is asking any more.
     */
    intentCompleted: 'idle',
    preempted: 'idle',
  },
  ready: {
    intentCompleted: 'running',
    preempted: 'idle',
  },
};

/** The next state, or `null` when the transition is illegal from here. */
export function nextState(state: AgentState, transition: AgentTransition): AgentState | null {
  return TABLE[state][transition] ?? null;
}
