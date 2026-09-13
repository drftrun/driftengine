import type {
  AiEvent,
  AiProvider,
  AiProviderCapabilities,
  AiRequest,
  AiSession,
  AiSessionOptions,
} from '../provider/types.ts';

/**
 * A provider that answers after a stated number of ticks, or never.
 *
 * **This is not a mock capability provider.** R1 withdrew mocks standing in for engine
 * capabilities that did not exist, on the reasoning that a mock is a second
 * implementation of a contract with no first implementation to check it against. This
 * stands in for a *provider* — a thing that is genuinely remote, genuinely slow and
 * genuinely variable — and it exists so that timing can be asserted rather than
 * observed.
 *
 * **Nothing here runs on a real timer.** A response is due at an absolute tick, and a
 * tick only happens when a caller says so. Every timing property Track O claims is
 * measured against this, and on a real clock each of those measurements would be a
 * race that passes on a fast machine.
 *
 * *What it costs:* a test must remember to call `advance`, and one that forgets sees
 * an agent that never gets an answer. *What would make it wrong:* if a provider adapter
 * ever needed wall-clock behaviour to be exercised — a retry backoff, say — this could
 * not exercise it, and that adapter would need its own harness rather than a change here.
 */
export interface DeterministicScript {
  /** Ticks between the request and its first event. `'never'` answers nothing, ever. */
  readonly latencyTicks: number | 'never';
  readonly events: readonly AiEvent[];
}

interface Pending {
  dueTick: number;
  events: readonly AiEvent[];
  settled: boolean;
  outcome: 'due' | 'aborted' | null;
  message: string;
  wake: (() => void) | null;
}

const CAPABILITIES: AiProviderCapabilities = {
  text: true,
  streamingText: true,
  structuredOutput: true,
  toolCalling: true,
  realtimeAudio: false,
  imageInput: false,
  local: true,
};

export class DeterministicProvider implements AiProvider {
  readonly id = 'deterministic';
  readonly capabilities = CAPABILITIES;

  /*
   * Reused with a count rather than emptied. `array.length = 0` makes V8 re-grow the
   * backing store, which is a per-iteration allocation in loops this provider is
   * deliberately driven through ten thousand times.
   */
  private readonly pending: Pending[] = [];
  private pendingCount = 0;

  private readonly script: (requestIndex: number) => DeterministicScript;
  private latencyOverride: number | 'never' | null = null;

  private now = 0;
  private requests = 0;
  private aborted = 0;
  private live = 0;
  private peak = 0;

  constructor(script: DeterministicScript | ((requestIndex: number) => DeterministicScript)) {
    this.script = typeof script === 'function' ? script : () => script;
  }

  get requestCount(): number {
    return this.requests;
  }

  get abortedCount(): number {
    return this.aborted;
  }

  /** A high-water mark, never a current count. */
  get peakConcurrency(): number {
    return this.peak;
  }

  /** Applies to requests made after this call, never to one already in flight. */
  setLatencyTicks(ticks: number | 'never'): void {
    this.latencyOverride = ticks;
  }

  /** Drives the fake clock. Nothing resolves without it. */
  advance(tick: number): void {
    this.now = tick;
    for (let i = 0; i < this.pendingCount; i++) {
      const entry = this.pending[i];
      if (entry === undefined || entry.settled) continue;
      if (entry.dueTick > tick) continue;
      entry.settled = true;
      entry.outcome = 'due';
      this.live--;
      entry.wake?.();
    }
  }

  createSession(_options: AiSessionOptions): AiSession {
    const owned: Pending[] = [];

    return {
      run: (request: AiRequest): AsyncIterable<AiEvent> => {
        const entry = this.begin(request);
        owned.push(entry);
        return this.drain(entry);
      },
      abort: (reason?: string): void => {
        for (const entry of owned) this.settleAborted(entry, reason ?? 'aborted');
      },
    };
  }

  /**
   * Registered eagerly, before the generator's body runs.
   *
   * An async generator does not execute until its first `next()`, so building the
   * entry inside `drain` would leave `peakConcurrency` reading zero for a request that
   * had been made — the exact number the one-in-flight tests are asserting against.
   *
   * It is released when the request *settles*, not when the generator is drained. A
   * request that has been answered or aborted is no longer outstanding whether or not
   * its consumer has read it yet, and several fixed steps can run in one frame with no
   * microtask between them — which made an aborted request go on counting.
   */
  private begin(request: AiRequest): Pending {
    const script = this.script(this.requests);
    this.requests++;

    const latency = this.latencyOverride ?? script.latencyTicks;
    const entry: Pending = {
      dueTick: latency === 'never' ? Number.POSITIVE_INFINITY : this.now + latency,
      events: script.events,
      settled: false,
      outcome: null,
      message: '',
      wake: null,
    };

    if (this.pendingCount < this.pending.length) this.pending[this.pendingCount] = entry;
    else this.pending.push(entry);
    this.pendingCount++;

    this.live++;
    if (this.live > this.peak) this.peak = this.live;

    if (request.signal.aborted) this.settleAborted(entry, 'signal');
    else request.signal.addEventListener('abort', () => this.settleAborted(entry, 'signal'));

    return entry;
  }

  private settleAborted(entry: Pending, message: string): void {
    if (entry.settled) return;
    entry.settled = true;
    entry.outcome = 'aborted';
    entry.message = message;
    this.aborted++;
    this.live--;
    entry.wake?.();
  }

  private async *drain(entry: Pending): AsyncIterable<AiEvent> {
    try {
      if (!entry.settled) {
        await new Promise<void>((resolve) => {
          entry.wake = resolve;
        });
      }

      if (entry.outcome === 'aborted') {
        yield { kind: 'done', reason: 'aborted', message: entry.message };
        return;
      }

      for (const event of entry.events) yield event;
    } finally {
      this.forget(entry);
    }
  }

  private forget(entry: Pending): void {
    for (let i = 0; i < this.pendingCount; i++) {
      if (this.pending[i] !== entry) continue;
      const last = this.pending[this.pendingCount - 1];
      if (last !== undefined) this.pending[i] = last;
      this.pendingCount--;
      return;
    }
  }
}
