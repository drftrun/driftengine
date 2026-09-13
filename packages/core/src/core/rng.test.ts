import { expect, test } from 'vitest';
import { mulberry32, pickBySeed, savableMulberry32 } from './rng.ts';

test('the same seed always picks the same item', () => {
  // Whatever a game seeds this with — a day number, a level index — the choice
  // has to be stable, or "we all got the same one" stops being true on reload.
  expect(pickBySeed(214, ['a', 'b', 'c'])).toBe(pickBySeed(214, ['a', 'b', 'c']));
});

test('consecutive seeds use the whole list instead of walking it', () => {
  /*
   * The break worth catching. `seed % length` is the obvious implementation and
   * is technically varied, but it steps through the list in order, so a daily
   * choice becomes a visible rota — and at two items it simply alternates.
   *
   * Two is checked hardest because it is the state a game is actually in while
   * content is being made, and it is where a biased hash shows up most starkly.
   */
  for (const size of [2, 3, 5, 8]) {
    const items = Array.from({ length: size }, (_, i) => `item-${i + 1}`);
    const seen = new Set<string>();
    let inOrder = true;
    for (let seed = 1; seed <= 400; seed++) {
      const picked = pickBySeed(seed, items);
      if (picked !== null) seen.add(picked);
      if (seed > 1 && picked !== items[(seed - 1) % size]) inOrder = false;
    }
    expect(seen.size, `${size} items should all appear`).toBe(size);
    expect(inOrder, `${size} items should not simply cycle`).toBe(false);
  }
});

test('an empty list yields null rather than undefined or a crash', () => {
  // The normal state before any content exists — no tracks, no levels.
  expect(pickBySeed(7, [])).toBe(null);
});

/**
 * The savable generator's sequence *is* mulberry32's, and this is the assertion that keeps it so.
 *
 * `AGENTS.md` makes the seeded sequence a contract about every ghost and replay a consumer has
 * stored, so a second generator is only allowed to exist if it agrees with the first exactly. A
 * drift of one increment would pass every test that read only its own output and would invalidate
 * a consumer's whole library of recordings.
 */
test('the savable generator draws exactly what the closure draws', () => {
  for (const seed of [0, 1, -1, 214, 0x6d2b79f5 | 0, 2147483647]) {
    const closure = mulberry32(seed);
    const savable = savableMulberry32(seed);
    for (let i = 0; i < 200; i++) {
      expect(savable.next(), `seed ${seed}, draw ${i}`).toBe(closure());
    }
  }
});

test('a restored position resumes the same stream', () => {
  const rng = savableMulberry32(99);
  for (let i = 0; i < 10; i++) rng.next();

  const at = rng.save();
  const expected = Array.from({ length: 20 }, () => rng.next());

  rng.restore(at);
  expect(Array.from({ length: 20 }, () => rng.next())).toEqual(expected);
});

/**
 * The property a rollback actually needs: draws made *after* a rewind repeat the draws made before
 * it, so a replayed tick produces the world it produced the first time.
 *
 * Drawing a different number is the failure this exists to prevent, and it is silent — a replay
 * whose randomness diverges is a plausible world that simply is not the one being replayed.
 */
test('a rewind and replay redraws rather than continuing', () => {
  const rng = savableMulberry32(7);
  const first = Array.from({ length: 5 }, () => rng.next());

  const atTick5 = rng.save();
  const ahead = Array.from({ length: 5 }, () => rng.next());

  rng.restore(atTick5);
  const replayed = Array.from({ length: 5 }, () => rng.next());

  expect(replayed).toEqual(ahead);
  expect(replayed).not.toEqual(first);
});

test('a position is one integer, so it stores beside a tick and compares with ===', () => {
  const a = savableMulberry32(3);
  const b = savableMulberry32(3);
  a.next();
  b.next();
  expect(a.save()).toBe(b.save());
  expect(Number.isInteger(a.save())).toBe(true);
});
