import { defaultStore } from './storage.ts';
import type { KeyValueStore } from './storage.ts';

/**
 * Persisted player preferences: a validated record in a `KeyValueStore`.
 *
 * Generic on purpose. A game declares *which* preferences exist and what their
 * legal values are; everything below — reading, validating field by field,
 * clamping, writing and announcing changes — is the same work in any game.
 *
 * Where the bytes actually live is the store's problem, not this module's, so a
 * game can persist to the browser, a server or nothing at all without any of
 * this changing. See `storage.ts` for why that seam is synchronous.
 */
export interface PreferenceSchema<T extends object> {
  /** Storage key. Namespace it — the store is shared with everything else. */
  readonly key: string;
  /** The complete set of fields, and the value each falls back to. */
  readonly defaults: T;
  /** Inclusive `[min, max]` for numeric fields. Values outside are clamped. */
  readonly ranges?: Partial<Record<keyof T, readonly [number, number]>>;
  /** Legal values for string fields. Anything else falls back to the default. */
  readonly options?: Partial<Record<keyof T, readonly string[]>>;
}

/**
 * The field types a preference record can hold. A default of any other shape is refused.
 *
 * **Refused loudly, and that is the whole point of this function.** `validate` below answers
 * `undefined` for anything that is not one of these, and `undefined` means "the stored value was
 * unusable, keep the default" — which is exactly right for *data* and exactly wrong for a
 * *schema*. A field the schema declares as an array took that path and cost a consumer a
 * afternoon: `loadPreferences` handed back the default every time, and `update` skipped the field
 * without ever setting `changed`, so writing one was a no-op that persisted nothing, notified
 * nobody and reported no error. It was found by a failing test rather than by anything here.
 *
 * **The two paths are deliberately not symmetrical.** A stored record always lags the code that
 * reads it, so one field of the wrong shape is the normal case and is tolerated field by field.
 * A schema is written by a developer and is wrong at compile time or never, so it fails at init,
 * where the engine's rule says a fault belongs.
 */
const SUPPORTED = ['number', 'boolean', 'string'] as const;

function assertSupportedSchema<T extends object>(schema: PreferenceSchema<T>): void {
  for (const key of Object.keys(schema.defaults) as (keyof T)[]) {
    const fallback = schema.defaults[key];
    if ((SUPPORTED as readonly string[]).includes(typeof fallback)) continue;
    const shape = Array.isArray(fallback) ? 'an array' : `a ${typeof fallback}`;
    throw new Error(
      `preferences: "${schema.key}.${String(key)}" defaults to ${shape}, and a preference field ` +
        `may only be a number, a boolean or a string. Anything else is written to the store and ` +
        `silently dropped on the way back, so it is refused here rather than at the next boot.`,
    );
  }
}

/** Coerce one field, returning undefined when the candidate is unusable. */
function validate<T extends object>(
  schema: PreferenceSchema<T>,
  key: keyof T,
  value: unknown,
): T[keyof T] | undefined {
  const fallback = schema.defaults[key];

  if (typeof fallback === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
    const range = schema.ranges?.[key];
    if (range === undefined) return value as T[keyof T];
    return Math.min(Math.max(value, range[0]), range[1]) as T[keyof T];
  }
  if (typeof fallback === 'boolean') {
    return typeof value === 'boolean' ? (value as T[keyof T]) : undefined;
  }
  if (typeof fallback === 'string') {
    if (typeof value !== 'string') return undefined;
    const allowed = schema.options?.[key];
    if (allowed !== undefined && !allowed.includes(value)) return undefined;
    return value as T[keyof T];
  }
  return undefined;
}

export function loadPreferences<T extends object>(
  schema: PreferenceSchema<T>,
  store: KeyValueStore = defaultStore(),
): T {
  assertSupportedSchema(schema);
  const result: T = { ...schema.defaults };

  const raw = store.read(schema.key);
  if (raw === null) return result;

  let stored: unknown;
  try {
    stored = JSON.parse(raw);
  } catch {
    return result;
  }
  if (typeof stored !== 'object' || stored === null) return result;

  /*
   * Field by field rather than all or nothing. A stored record always lags the
   * code that reads it, so one field of the wrong shape is the normal case —
   * and discarding the record over it would wipe every other preference the
   * player had ever set.
   */
  const source = stored as Record<string, unknown>;
  for (const key of Object.keys(schema.defaults) as (keyof T)[]) {
    const value = validate(schema, key, source[key as string]);
    if (value !== undefined) result[key] = value;
  }
  return result;
}

export function savePreferences<T extends object>(
  schema: PreferenceSchema<T>,
  value: T,
  store: KeyValueStore = defaultStore(),
): void {
  /* Checked here too: a caller that only ever saves would otherwise write a record that
     nothing can read back, and find out one boot later in somebody else's session. */
  assertSupportedSchema(schema);
  store.write(schema.key, JSON.stringify(value));
}

/**
 * A live preference record: the loaded value, validated updates, persistence
 * and change notification for whatever applies them to running systems.
 */
export class PreferenceStore<T extends object> {
  private current: T;
  private readonly listeners = new Set<(value: Readonly<T>) => void>();

  constructor(
    private readonly schema: PreferenceSchema<T>,
    private readonly store: KeyValueStore = defaultStore(),
  ) {
    this.current = loadPreferences(schema, store);
  }

  get value(): Readonly<T> {
    return this.current;
  }

  /**
   * Apply a partial change. Every field goes through the same validation as a
   * stored one — a control that can produce an illegal value would otherwise
   * write it, leaving the read path as the only thing catching it, one boot too
   * late.
   */
  update(patch: Partial<T>): void {
    let changed = false;
    for (const key of Object.keys(patch) as (keyof T)[]) {
      if (!(key in this.schema.defaults)) continue;
      const next = validate(this.schema, key, patch[key]);
      if (next === undefined || next === this.current[key]) continue;
      this.current[key] = next;
      changed = true;
    }
    // Silent when nothing moved: subscribers apply settings to live systems and
    // some of those write back, which without this is a loop.
    if (!changed) return;
    savePreferences(this.schema, this.current, this.store);
    for (const listener of this.listeners) listener(this.current);
  }

  /** Returns an unsubscribe function. */
  subscribe(listener: (value: Readonly<T>) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Back to the declared defaults, persisted and announced like any change. */
  reset(): void {
    this.update({ ...this.schema.defaults });
  }
}
