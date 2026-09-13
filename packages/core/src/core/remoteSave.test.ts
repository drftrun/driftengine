import { describe, expect, it, vi } from 'vitest';

import { RemoteSaveStore, type SaveBackend } from './remoteSave.ts';

/**
 * A backend a test drives, with the timer supplied rather than waited for.
 *
 * **Nothing here waits on a real clock.** A write-behind queue is a thing that happens *later*, and
 * a test that slept for it would be slow and would sometimes fail; the timer is a capability the
 * store takes, so a test states when the delay elapsed.
 */
function fakeBackend(initial: readonly (readonly [string, string])[] = []) {
  const batches: Map<string, string | null>[] = [];
  let failures = 0;
  let loadRejects = false;
  let pending: { resolve: () => void; reject: (error: Error) => void } | null = null;
  let hold = false;

  const backend: SaveBackend = {
    load: () =>
      loadRejects
        ? Promise.reject(new Error('the server said no'))
        : Promise.resolve(initial as Iterable<readonly [string, string]>),
    save: (changes) => {
      batches.push(new Map(changes));
      if (hold) {
        return new Promise<void>((resolve, reject) => {
          pending = { resolve, reject };
        });
      }
      if (failures > 0) {
        failures -= 1;
        return Promise.reject(new Error('the server said no'));
      }
      return Promise.resolve();
    },
  };

  return {
    backend,
    batches,
    failNext(count: number): void {
      failures = count;
    },
    rejectLoad(): void {
      loadRejects = true;
    },
    /** Hold the next save open, so a test can write while one is in flight. */
    holdSaves(): void {
      hold = true;
    },
    settle(): void {
      hold = false;
      pending?.resolve();
      pending = null;
    },
    /** Fail the held save, which is what a request in flight when the network drops does. */
    failHeld(): void {
      hold = false;
      pending?.reject(new Error('the server said no'));
      pending = null;
    },
  };
}

/** A timer a test advances by hand. One pending callback at a time is all this store arms. */
function fakeTimer() {
  let armed: { fn: () => void; delayMs: number } | null = null;
  let nextHandle = 1;
  return {
    schedule: (fn: () => void, delayMs: number): number => {
      armed = { fn, delayMs };
      return nextHandle++;
    },
    cancel: (): void => {
      armed = null;
    },
    get delayMs(): number | null {
      return armed?.delayMs ?? null;
    },
    get armedNow(): boolean {
      return armed !== null;
    },
    /** Run whatever is armed, exactly once. */
    fire(): void {
      const now = armed;
      armed = null;
      now?.fn();
    },
  };
}

/** Let every already-resolved promise settle. Four turns covers the deepest chain here. */
async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await Promise.resolve();
}

describe('a remote save store', () => {
  /*
   * **The seam is synchronous and stays synchronous.** Preferences are read during boot, before the
   * first frame, and an await there means a frame drawn with the wrong settings and then corrected.
   * That is why this rides `KeyValueStore` rather than adding a second, asynchronous interface.
   */
  it('reads what the backend loaded, synchronously', async () => {
    const remote = fakeBackend([
      ['volume', '0.4'],
      ['seen-intro', '1'],
    ]);
    const timer = fakeTimer();
    const store = new RemoteSaveStore(remote.backend, timer);

    await store.load();
    expect(store.read('volume')).toBe('0.4');
    expect(store.read('seen-intro')).toBe('1');
    expect(store.read('absent')).toBe(null);
  });

  /*
   * A read before the load resolved answers null, which is a *wrong answer* rather than an error:
   * the game boots on defaults and overwrites the player's real settings with them. So it says so.
   */
  it('warns once when read before it is loaded', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const remote = fakeBackend([['volume', '0.4']]);
      const store = new RemoteSaveStore(remote.backend, fakeTimer());

      expect(store.read('volume')).toBe(null);
      expect(store.read('volume')).toBe(null);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('reads back a write before anything has been flushed', async () => {
    const remote = fakeBackend();
    const store = new RemoteSaveStore(remote.backend, fakeTimer());
    await store.load();

    store.write('volume', '0.9');
    expect(store.read('volume')).toBe('0.9');
    expect(remote.batches.length).toBe(0);
  });

  /*
   * **The coalescing is what a queue is for.** A settings slider writes on every drag frame; one
   * batch per frame would be sixty requests for one decision. Two writes to one key is one entry.
   */
  it('coalesces a burst of writes into one batch', async () => {
    const remote = fakeBackend();
    const timer = fakeTimer();
    const store = new RemoteSaveStore(remote.backend, timer);
    await store.load();

    store.write('volume', '0.1');
    store.write('volume', '0.2');
    store.write('volume', '0.3');
    store.write('gamma', '1');
    timer.fire();
    await settle();

    expect(remote.batches.length).toBe(1);
    expect(remote.batches[0]?.size).toBe(2);
    expect(remote.batches[0]?.get('volume')).toBe('0.3');
    expect(remote.batches[0]?.get('gamma')).toBe('1');
  });

  /* A removal is a null in the batch, so one call carries both kinds of change in order. */
  it('carries a removal as a null', async () => {
    const remote = fakeBackend([['volume', '0.4']]);
    const timer = fakeTimer();
    const store = new RemoteSaveStore(remote.backend, timer);
    await store.load();

    store.remove('volume');
    expect(store.read('volume')).toBe(null);
    timer.fire();
    await settle();
    expect(remote.batches[0]?.get('volume')).toBe(null);
    expect(remote.batches[0]?.has('volume')).toBe(true);
  });

  it('moves through pending and saving and back to idle', async () => {
    const remote = fakeBackend();
    const timer = fakeTimer();
    const store = new RemoteSaveStore(remote.backend, timer);
    await store.load();
    expect(store.status).toBe('idle');

    store.write('volume', '0.5');
    expect(store.status).toBe('pending');
    expect(store.pending).toBe(1);

    remote.holdSaves();
    timer.fire();
    expect(store.status).toBe('saving');

    remote.settle();
    await settle();
    expect(store.status).toBe('idle');
    expect(store.pending).toBe(0);
  });

  /**
   * **Failure is a status the caller can read, never a throw.**
   *
   * A save that cannot reach the server is a normal condition — a player on a train — and it is
   * never worth failing a frame for. What it must not be is silent: a game showing "saved" over a
   * queue that has been failing for ten minutes is the worst of the three outcomes.
   */
  it('retries with a growing backoff and then reports failure', async () => {
    const remote = fakeBackend();
    const timer = fakeTimer();
    const store = new RemoteSaveStore(remote.backend, timer, {
      flushDelayMs: 10,
      retryDelayMs: 100,
      maxAttempts: 3,
    });
    await store.load();

    remote.failNext(3);
    store.write('volume', '0.5');
    expect(timer.delayMs).toBe(10);

    timer.fire();
    await settle();
    /* First retry, at the base delay. */
    expect(timer.delayMs).toBe(100);
    timer.fire();
    await settle();
    /* Second retry, doubled. */
    expect(timer.delayMs).toBe(200);
    timer.fire();
    await settle();

    expect(store.status).toBe('failed');
    expect(store.lastError).toContain('the server said no');
    expect(remote.batches.length).toBe(3);
    /* The changes are kept: giving up on the attempt is not giving up on the data. */
    expect(store.pending).toBe(1);
  });

  it('recovers when a later flush succeeds', async () => {
    const remote = fakeBackend();
    const timer = fakeTimer();
    const store = new RemoteSaveStore(remote.backend, timer, {
      flushDelayMs: 10,
      retryDelayMs: 10,
      maxAttempts: 1,
    });
    await store.load();

    remote.failNext(1);
    store.write('volume', '0.5');
    timer.fire();
    await settle();
    expect(store.status).toBe('failed');

    store.write('gamma', '1');
    timer.fire();
    await settle();
    expect(store.status).toBe('idle');
    expect(store.lastError).toBe(null);
    /* The failed change went out with the new one rather than being dropped. */
    expect(remote.batches[1]?.get('volume')).toBe('0.5');
    expect(remote.batches[1]?.get('gamma')).toBe('1');
  });

  /**
   * **A write during an in-flight save must not be lost, and must not be overwritten by the batch
   * that was already leaving.** This is the classic write-behind defect: the queue is cleared when
   * the save starts, so a write landing mid-flight belongs to the *next* batch — and if that save
   * then fails and its batch is re-queued, the older value must not clobber the newer one.
   */
  it('keeps a write that landed while a save was in flight, and keeps it newest', async () => {
    const remote = fakeBackend();
    const timer = fakeTimer();
    const store = new RemoteSaveStore(remote.backend, timer, { flushDelayMs: 10, maxAttempts: 1 });
    await store.load();

    remote.holdSaves();
    store.write('volume', '0.1');
    timer.fire();
    expect(store.status).toBe('saving');
    expect(remote.batches[0]?.get('volume')).toBe('0.1');

    store.write('volume', '0.9');
    expect(store.read('volume')).toBe('0.9');

    /* The batch already leaving now fails, so its contents come back to the queue — under the
       newer write rather than over it. A merge that overwrote would send 0.1 and lose the drag. */
    remote.failHeld();
    await settle();
    expect(store.status).toBe('failed');

    await store.flush();
    const last = remote.batches[remote.batches.length - 1];
    expect(last?.get('volume')).toBe('0.9');
    expect(remote.batches.length).toBe(2);
  });

  /* A backend that throws rather than rejecting is the same condition and must read the same. */
  it('treats a backend that throws as a failed save', async () => {
    const throwing: SaveBackend = {
      load: () => Promise.resolve([]),
      save: () => {
        throw new Error('no network');
      },
    };
    const timer = fakeTimer();
    const store = new RemoteSaveStore(throwing, timer, { flushDelayMs: 1, maxAttempts: 1 });
    await store.load();

    store.write('volume', '1');
    expect(() => timer.fire()).not.toThrow();
    await settle();
    expect(store.status).toBe('failed');
    expect(store.lastError).toContain('no network');
  });

  /* A load that fails leaves an empty cache and a status, not a rejected promise nobody caught. */
  it('reports a failed load rather than rejecting', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const remote = fakeBackend();
      remote.rejectLoad();
      const store = new RemoteSaveStore(remote.backend, fakeTimer());

      await expect(store.load()).resolves.toBe(false);
      expect(store.status).toBe('failed');
      expect(store.lastError).toContain('the server said no');
      /* Loud rather than silent: a consumer that ignores the status boots on defaults and
         overwrites the player's real settings with them on the first write. */
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  /* `flush` is for a consumer leaving the page: it sends now and resolves when the send is done. */
  it('flushes on demand and resolves when the batch has landed', async () => {
    const remote = fakeBackend();
    const timer = fakeTimer();
    const store = new RemoteSaveStore(remote.backend, timer);
    await store.load();

    store.write('volume', '0.5');
    await store.flush();
    expect(remote.batches.length).toBe(1);
    expect(store.pending).toBe(0);
    expect(timer.armedNow).toBe(false);
  });

  it('tells a listener only when the status changes', async () => {
    const remote = fakeBackend();
    const timer = fakeTimer();
    const store = new RemoteSaveStore(remote.backend, timer);
    await store.load();

    const seen: string[] = [];
    const stop = store.onStatusChange((status) => seen.push(status));

    store.write('a', '1');
    store.write('b', '2');
    timer.fire();
    await settle();

    expect(seen).toEqual(['pending', 'saving', 'idle']);
    stop();
    store.write('c', '3');
    expect(seen.length).toBe(3);
  });
});
