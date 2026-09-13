import type { KeyValueStore } from './storage.ts';

/**
 * A save that lives somewhere the engine cannot read synchronously — a server, a native shell, a
 * sandbox — behind the synchronous seam every consumer already speaks.
 *
 * **A write-behind queue rather than a second interface, and that is the decision this module
 * exists to record.** `KeyValueStore` is synchronous because preferences are read during *boot*,
 * before the first frame: an await there means a frame drawn with the wrong settings and then
 * corrected, which is a visible flicker on every load. So the choice was between widening the seam
 * to an asynchronous twin, which every consumer and every store integration would then have to
 * learn, or hydrating a cache once and draining writes behind it. Both shipped implementations of
 * the seam that are already asynchronous underneath — a file the shell owns, and a cloud store —
 * chose the second, independently, and neither needed the interface widened. This is that
 * arrangement written once, with the three things a hand-rolled version leaves out.
 *
 * **The three:**
 *
 * 1. **Coalescing.** A settings slider writes on every drag frame. One request per write is sixty
 *    requests for one decision, and it is the reason a naive fire-and-forget backend gets rate
 *    limited. Writes accumulate into a batch, one entry per key, sent after a quiet period.
 * 2. **Retry.** A save that cannot reach the server is a normal condition — a player on a train.
 *    The batch is retried with a growing delay, and giving up on the *attempt* is never giving up
 *    on the *data*: the changes stay queued and go out with the next batch.
 * 3. **A status.** Failure surfaces as something the caller can read, never a throw. A game
 *    showing "saved" over a queue that has been failing for ten minutes is worse than either a
 *    crash or an honest indicator, and it is what fire-and-forget produces by construction.
 *
 * **What it costs.** A write is durable *later*, not now, and a player who closes the tab inside
 * the flush delay loses it. `flush()` is the answer, called from whatever the consumer's platform
 * gives it — `visibilitychange`, a shell's close hook, a menu's exit — and the engine does not
 * register that listener itself, because a DOM listener is a decision about the page rather than
 * about saving. **What would make this wrong** is a consumer needing a write acknowledged before
 * it acts on it, and the honest answer then is `await flush()` at that one site rather than an
 * asynchronous surface everywhere.
 */

/**
 * The asynchronous side, which the consumer implements.
 *
 * **`save` takes a batch rather than one key**, because a network backend wants one round trip for
 * a screen's worth of changes and a per-key interface makes that impossible to build on top. A
 * consumer whose API is per-key loops inside `save`; a consumer whose API is a document writes one
 * request. The reverse adaptation cannot be done at all.
 */
export interface SaveBackend {
  /** Everything this backend holds, read once before the first frame. */
  load(): Promise<Iterable<readonly [string, string]>>;
  /**
   * Apply a batch. A `null` value is a removal, so one call carries both kinds of change.
   *
   * Reject to have the batch retried. Resolving is a promise that it landed: a backend that
   * resolves optimistically turns this store's status into a decoration.
   */
  save(changes: ReadonlyMap<string, string | null>): Promise<void>;
}

/**
 * The delay, taken as a capability rather than reached for.
 *
 * The same rule `KeyValueStore` itself follows: nothing here may assume a browser origin, and a
 * native shell or a test supplies its own. A platform with no timer at all still works — nothing
 * is ever armed, and the consumer drives `flush()`.
 */
export interface SaveTimer {
  schedule(callback: () => void, delayMs: number): number;
  cancel(handle: number): void;
}

/** What the queue is doing, for an indicator a player can read. */
export type SaveStatus = 'idle' | 'pending' | 'saving' | 'failed';

export interface RemoteSaveOptions {
  /** The quiet period a burst of writes is collected over, in milliseconds. Default 250. */
  readonly flushDelayMs?: number;
  /** How many times one batch is attempted before the status goes to `failed`. Default 3. */
  readonly maxAttempts?: number;
  /** The first retry delay, doubled at each further attempt. Default 500. */
  readonly retryDelayMs?: number;
}

/** The global timer where there is one, and a timer that never fires where there is not. */
export function defaultSaveTimer(): SaveTimer {
  const host = globalThis as {
    setTimeout?: (fn: () => void, ms: number) => unknown;
    clearTimeout?: (handle: unknown) => void;
  };
  if (typeof host.setTimeout !== 'function') {
    /* Not a silent no-op: `flush()` still sends, so a platform with no timer saves on demand and
       never in the background. The alternative — throwing at construction — would refuse a store
       that works, on a platform this engine has no business assuming anything about. */
    return { schedule: () => 0, cancel: () => {} };
  }
  const set = host.setTimeout.bind(host);
  const clear = host.clearTimeout?.bind(host);
  let next = 1;
  const handles = new Map<number, unknown>();
  return {
    schedule(callback, delayMs) {
      const id = next++;
      handles.set(id, set(callback, delayMs));
      return id;
    },
    cancel(handle) {
      const native = handles.get(handle);
      handles.delete(handle);
      if (native !== undefined) clear?.(native);
    },
  };
}

export class RemoteSaveStore implements KeyValueStore {
  /** Everything the backend held at boot, plus everything this session has written. */
  private readonly cache = new Map<string, string>();
  /** Changes waiting to go out. Claimed once and swapped with `inFlight`, never rebuilt. */
  private queued = new Map<string, string | null>();
  /** The batch currently being sent. Swapped rather than copied, so a flush allocates nothing. */
  private inFlight = new Map<string, string | null>();
  private readonly listeners: ((status: SaveStatus) => void)[] = [];

  private loadedValue = false;
  private warnedUnloaded = false;
  private statusValue: SaveStatus = 'idle';
  private lastErrorValue: string | null = null;
  private handle = 0;
  private attempt = 0;
  private current: Promise<void> | null = null;

  private readonly flushDelayMs: number;
  private readonly maxAttempts: number;
  private readonly retryDelayMs: number;

  constructor(
    private readonly backend: SaveBackend,
    private readonly timer: SaveTimer = defaultSaveTimer(),
    options: RemoteSaveOptions = {},
  ) {
    this.flushDelayMs = options.flushDelayMs ?? 250;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.retryDelayMs = options.retryDelayMs ?? 500;
  }

  /**
   * Fill the cache from the backend. Await this **before the first frame**.
   *
   * Answers whether it worked rather than rejecting, because a rejected promise nobody caught is
   * an unhandled rejection during boot and a store that cannot load is a store that still has to
   * serve defaults. A failure also says so on the console once: a consumer that ignores both the
   * answer and the status boots on defaults and overwrites the player's real settings with them on
   * the first write, which is the one outcome worse than not loading.
   */
  async load(): Promise<boolean> {
    try {
      const entries = await this.backend.load();
      for (const [key, value] of entries) this.cache.set(key, value);
      this.loadedValue = true;
      return true;
    } catch (error) {
      this.loadedValue = true;
      this.lastErrorValue = messageOf(error);
      this.setStatus('failed');
      console.warn(
        `[driftengine] the save backend could not be read: ${this.lastErrorValue}. ` +
          'The game will boot on defaults, and the first write will overwrite what is stored. ' +
          'Read `status` before writing if that matters.',
      );
      return false;
    }
  }

  /** Whether `load` has completed, either way. */
  get loaded(): boolean {
    return this.loadedValue;
  }

  get status(): SaveStatus {
    return this.statusValue;
  }

  /** How many keys are waiting to be sent, counting a batch that failed and came back. */
  get pending(): number {
    return this.queued.size + this.inFlight.size;
  }

  /** The last failure's message, cleared by the next batch that lands. */
  get lastError(): string | null {
    return this.lastErrorValue;
  }

  /** Told when the status changes, and only when it changes. Returns the unsubscribe. */
  onStatusChange(listener: (status: SaveStatus) => void): () => void {
    this.listeners.push(listener);
    return () => {
      const at = this.listeners.indexOf(listener);
      if (at >= 0) this.listeners.splice(at, 1);
    };
  }

  read(key: string): string | null {
    if (!this.loadedValue && !this.warnedUnloaded) {
      this.warnedUnloaded = true;
      console.warn(
        '[driftengine] a remote save store was read before `load()` resolved, so it answered null. ' +
          'Await `load()` before the first frame, or the game boots on defaults it will then save.',
      );
    }
    return this.cache.get(key) ?? null;
  }

  write(key: string, value: string): void {
    this.cache.set(key, value);
    this.queued.set(key, value);
    this.arm(this.flushDelayMs);
  }

  remove(key: string): void {
    this.cache.delete(key);
    this.queued.set(key, null);
    this.arm(this.flushDelayMs);
  }

  /**
   * Send everything queued now, and resolve when that attempt has settled.
   *
   * For a consumer leaving the page. It never rejects: read `status` afterwards to find out
   * whether it landed. A batch already in flight is awaited first, so two flushes cannot overlap.
   */
  async flush(): Promise<void> {
    this.disarm();
    if (this.current !== null) await this.current;
    if (this.queued.size === 0) return;
    /* A deliberate flush starts the attempt count over: the caller is asking now, and a previous
       exhaustion should not make this call a no-op. */
    this.attempt = 0;
    await this.send();
  }

  /**
   * Throw away everything waiting to be sent.
   *
   * The escape hatch that makes "a failed batch is kept forever" acceptable: a consumer that has
   * decided the queue is stale — a player signing out, a save slot deleted — says so, rather than
   * this store guessing after some number of failures. The cache is untouched, so reads still
   * answer what the session wrote.
   */
  discardPending(): void {
    this.disarm();
    this.queued.clear();
    this.inFlight.clear();
    this.setStatus(this.statusValue === 'saving' ? 'saving' : 'idle');
  }

  /**
   * One attempt at the queued batch. **Never rejects**, because it is reachable from a timer and
   * from a frame, and the house rule is that neither throws.
   */
  private async send(): Promise<void> {
    if (this.current !== null) return this.current;

    /* Swap rather than copy: the queue that was accumulating becomes the batch, and the empty one
       that just went out becomes the queue. A write landing during the send goes into the new
       queue and belongs to the next batch. */
    const outgoing = this.queued;
    this.queued = this.inFlight;
    this.inFlight = outgoing;
    this.attempt += 1;
    this.setStatus('saving');

    const run = this.attemptSave();
    this.current = run;
    try {
      await run;
    } finally {
      this.current = null;
    }
  }

  private async attemptSave(): Promise<void> {
    try {
      /* Awaited inside the `try` so a backend that throws synchronously reads the same as one that
         rejects — they are the same condition to a caller, and only one of them is catchable by a
         plain `.catch`. */
      await this.backend.save(this.inFlight);
      this.inFlight.clear();
      this.attempt = 0;
      this.lastErrorValue = null;
      if (this.queued.size > 0) {
        this.setStatus('pending');
        this.arm(this.flushDelayMs);
        return;
      }
      this.setStatus('idle');
    } catch (error) {
      this.lastErrorValue = messageOf(error);
      this.returnToQueue();
      if (this.attempt >= this.maxAttempts) {
        /* Reset, so a later write or an explicit flush starts a fresh run of attempts rather than
           being refused by a counter left at the ceiling. */
        this.attempt = 0;
        this.setStatus('failed');
        return;
      }
      this.setStatus('pending');
      // determinism: build-time — a network retry backoff, which is wall-clock and not simulation
      this.arm(this.retryDelayMs * 2 ** (this.attempt - 1));
    }
  }

  /**
   * Put a failed batch back **under** whatever arrived while it was away.
   *
   * The direction is the whole of it. A player dragging a slider writes 0.1, the batch leaves, they
   * drag to 0.9, the batch fails — and a merge that overwrote would send 0.1 and silently undo the
   * drag. Newer always wins, which is why this checks before it sets.
   */
  private returnToQueue(): void {
    for (const [key, value] of this.inFlight) {
      if (!this.queued.has(key)) this.queued.set(key, value);
    }
    this.inFlight.clear();
  }

  private arm(delayMs: number): void {
    if (this.statusValue !== 'saving') this.setStatus('pending');
    this.disarm();
    this.handle = this.timer.schedule(() => {
      this.handle = 0;
      void this.send();
    }, delayMs);
  }

  private disarm(): void {
    if (this.handle === 0) return;
    this.timer.cancel(this.handle);
    this.handle = 0;
  }

  private setStatus(status: SaveStatus): void {
    if (status === this.statusValue) return;
    this.statusValue = status;
    for (let i = 0; i < this.listeners.length; i++) this.listeners[i]?.(status);
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
