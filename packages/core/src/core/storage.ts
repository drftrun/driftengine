/**
 * Where persisted state goes.
 *
 * The engine must not assume a browser origin. A game may want its saves on a
 * server, in a native shell's own store, in an embedder-provided sandbox, or
 * nowhere at all — so every engine system that persists takes a
 * `KeyValueStore` and the browser is merely the default implementation.
 *
 * **Synchronous by design.** Preferences, one-time flags and a chosen character
 * are all read during boot, before the first frame, and an await there means a
 * frame rendered with the wrong settings and then corrected — a visible flicker
 * on every load. An asynchronous backend (a server, IndexedDB) fits by
 * hydrating a cache first and implementing `write` as fire-and-forget; that is
 * what `MemoryStore.hydrate` exists for.
 *
 * No implementation here throws. Storage failure is a normal condition — Safari
 * private mode and several embedded webviews throw on plain access — and a
 * preference is never worth failing a boot for.
 */
export interface KeyValueStore {
  read(key: string): string | null;
  write(key: string, value: string): void;
  remove(key: string): void;
}

/** Volatile store: the test double, and the fallback when nothing persists. */
export class MemoryStore implements KeyValueStore {
  private readonly entries = new Map<string, string>();

  read(key: string): string | null {
    return this.entries.get(key) ?? null;
  }

  write(key: string, value: string): void {
    this.entries.set(key, value);
  }

  remove(key: string): void {
    this.entries.delete(key);
  }

  /** Seed from an asynchronous backend before anything reads. */
  hydrate(entries: Iterable<readonly [string, string]>): void {
    for (const [key, value] of entries) this.entries.set(key, value);
  }
}

/**
 * `localStorage`, with every access guarded.
 *
 * A blocked store degrades to memory rather than to nothing: settings then last
 * the session instead of resetting between screens, and a first-run prompt
 * fires once per visit instead of on every single load. Never showing it at all
 * would be the worse failure — a player who arrived from a link would have no
 * idea what the controls are.
 */
export class BrowserStore implements KeyValueStore {
  private readonly fallback = new MemoryStore();
  private readonly available: boolean;

  constructor() {
    this.available = probeLocalStorage();
  }

  read(key: string): string | null {
    if (!this.available) return this.fallback.read(key);
    try {
      return localStorage.getItem(key);
    } catch {
      return this.fallback.read(key);
    }
  }

  write(key: string, value: string): void {
    this.fallback.write(key, value);
    if (!this.available) return;
    try {
      localStorage.setItem(key, value);
    } catch {
      // Quota exceeded or blocked mid-session; the memory copy still stands.
    }
  }

  remove(key: string): void {
    this.fallback.remove(key);
    if (!this.available) return;
    try {
      localStorage.removeItem(key);
    } catch {
      // As above.
    }
  }
}

function probeLocalStorage(): boolean {
  try {
    // Reading is not enough of a probe: some browsers allow the read and throw
    // only on write, which would strand a store that reports itself healthy.
    const probe = '__driftengine_probe__';
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    return true;
  } catch {
    return false;
  }
}

let shared: KeyValueStore | null = null;

/** The default store: the browser's when it works, memory when it does not. */
export function defaultStore(): KeyValueStore {
  shared ??= new BrowserStore();
  return shared;
}
