import { expect, test } from 'vitest';
import { PreferenceStore, loadPreferences } from './preferences.ts';
import type { PreferenceSchema } from './preferences.ts';
import { MemoryStore } from './storage.ts';

interface Prefs {
  volume: number;
  invert: boolean;
  quality: string;
}

const SCHEMA: PreferenceSchema<Prefs> = {
  key: 'test.prefs',
  defaults: { volume: 0.8, invert: false, quality: 'high' },
  ranges: { volume: [0, 1] },
  options: { quality: ['low', 'high'] },
};

function storeWith(stored: unknown): MemoryStore {
  const store = new MemoryStore();
  store.write(SCHEMA.key, typeof stored === 'string' ? stored : JSON.stringify(stored));
  return store;
}

test('a stored field of the wrong shape costs only that field', () => {
  /*
   * The load-bearing property. A stored record always lags the code that reads
   * it, so one field of the wrong type is the normal case rather than an
   * exception. If that discarded the whole record, every returning player would
   * silently lose every preference the first time a field changed shape.
   */
  const loaded = loadPreferences(
    SCHEMA,
    storeWith({ volume: 0.3, invert: 'yes', quality: 'ultra', gone: 4 }),
  );

  expect(loaded.volume).toBe(0.3);
  expect(loaded.invert).toBe(SCHEMA.defaults.invert);
  expect(loaded.quality).toBe(SCHEMA.defaults.quality);
  expect('gone' in loaded).toBe(false);
});

test('numbers are clamped to their declared range', () => {
  // Stored values are editable by anyone who opens devtools. A sensitivity of
  // 1e6 makes a game unplayable and unrecoverable without knowing where the key
  // lives.
  expect(loadPreferences(SCHEMA, storeWith({ volume: 1e6 })).volume).toBe(1);
  expect(loadPreferences(SCHEMA, storeWith({ volume: -3 })).volume).toBe(0);
});

test('malformed or absent data yields the defaults', () => {
  expect(loadPreferences(SCHEMA, storeWith('{not json'))).toEqual(SCHEMA.defaults);
  expect(loadPreferences(SCHEMA, new MemoryStore())).toEqual(SCHEMA.defaults);
});

test('a store validates what it is given, persists it and reports the change', () => {
  const backing = new MemoryStore();
  const store = new PreferenceStore(SCHEMA, backing);
  const seen: number[] = [];
  store.subscribe((value) => seen.push(value.volume));

  store.update({ volume: 4, quality: 'nonsense' });

  // A slider cannot push a value out of range, and an unknown option is refused
  // rather than stored — otherwise the next boot loads it back and validation
  // on read is the only thing standing between the player and it.
  expect(store.value.volume).toBe(1);
  expect(store.value.quality).toBe('high');
  expect(loadPreferences(SCHEMA, backing).volume).toBe(1);
  expect(seen).toEqual([1]);
});

test('an update that changes nothing notifies nobody', () => {
  // Subscribers apply settings to live systems, and some of those write back.
  // Without this, one redundant update is an infinite loop.
  const store = new PreferenceStore(SCHEMA, new MemoryStore());
  let calls = 0;
  store.subscribe(() => calls++);

  store.update({ volume: SCHEMA.defaults.volume });
  expect(calls).toBe(0);

  store.update({ volume: 0.2 });
  expect(calls).toBe(1);
});

/*
 * A field type this layer cannot round-trip is refused at init rather than dropped in silence.
 *
 * Reported from a consumer that declared an array and lost it both ways: `loadPreferences`
 * handed back the default, and `update` skipped the field without setting `changed`, so writing
 * one persisted nothing and notified nobody. Nothing threw, nothing warned, and it was found by
 * a failing test in another repository.
 */
interface WithArray {
  played: string[];
}

const ARRAY_SCHEMA: PreferenceSchema<WithArray> = {
  key: 'test.array',
  defaults: { played: [] },
};

test('a schema field this layer cannot round-trip is refused, by name', () => {
  expect(() => loadPreferences(ARRAY_SCHEMA, new MemoryStore())).toThrow(/test\.array\.played/);
  expect(() => loadPreferences(ARRAY_SCHEMA, new MemoryStore())).toThrow(/an array/);
  /* Constructing a live store goes the same way, because it loads in its constructor. */
  expect(() => new PreferenceStore(ARRAY_SCHEMA, new MemoryStore())).toThrow(/may only be/);
});

test('an object default is refused for the same reason as an array', () => {
  const schema = { key: 'test.obj', defaults: { pos: { x: 0 } } } as PreferenceSchema<{
    pos: { x: number };
  }>;
  expect(() => loadPreferences(schema, new MemoryStore())).toThrow(/test\.obj\.pos/);
});

/*
 * The other half of the same rule, and the reason the check is on the schema rather than in
 * `validate`: a *record* of the wrong shape stays lenient, because a stored record always lags
 * the code reading it and discarding it would wipe every preference a player had set.
 */
test('an array arriving in stored data costs that field and nothing else', () => {
  const store = storeWith({ volume: ['nonsense'], invert: true, quality: 'low' });
  const loaded = loadPreferences(SCHEMA, store);
  expect(loaded.volume).toBe(0.8);
  expect(loaded.invert).toBe(true);
  expect(loaded.quality).toBe('low');
});
