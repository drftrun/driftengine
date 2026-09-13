import { defaultStore } from './storage.ts';
import type { KeyValueStore } from './storage.ts';

/**
 * A persisted set of one-time flags: tutorial prompts, first-run hints,
 * "you have seen this" markers.
 *
 * One key holding a set rather than a key per flag, because a game accumulates
 * dozens of these and a key each turns a player's save into a junk drawer that
 * cannot be cleared in one action.
 *
 * Where it persists is the store's problem. When the store cannot keep
 * anything, flags last the session — showing a tutorial once per visit is mildly
 * annoying, while never showing it strands a player who arrived from a link
 * with no idea what the controls are.
 */
export class OnceSet {
  private readonly seen: Set<string>;

  constructor(
    private readonly key: string,
    private readonly store: KeyValueStore = defaultStore(),
  ) {
    this.seen = new Set(readIds(store, key));
  }

  has(id: string): boolean {
    return this.seen.has(id);
  }

  /** True the first time only. Marks the flag as a side effect. */
  claim(id: string): boolean {
    if (this.seen.has(id)) return false;
    this.mark(id);
    return true;
  }

  mark(id: string): void {
    if (this.seen.has(id)) return;
    this.seen.add(id);
    this.persist();
  }

  /** Forget everything — "show me the tutorial again". */
  clear(): void {
    this.seen.clear();
    this.persist();
  }

  private persist(): void {
    this.store.write(this.key, JSON.stringify([...this.seen]));
  }
}

function readIds(store: KeyValueStore, key: string): string[] {
  const raw = store.read(key);
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === 'string');
  } catch {
    return [];
  }
}
