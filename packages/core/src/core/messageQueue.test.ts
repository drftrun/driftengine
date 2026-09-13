import { expect, test } from 'vitest';
import { MessageQueue } from './messageQueue.ts';
import type { QueuedMessage } from './messageQueue.ts';

function msg(id: string, priority = 1, durationMs = 1000): QueuedMessage {
  return { id, priority, durationMs };
}

test('a burst shows one message at a time, most important first', () => {
  /*
   * Events arrive together — finishing a run can fire three at once — and
   * three notifications stacking on top of each other is worse than one,
   * because the player reads none of them.
   */
  const q = new MessageQueue();
  q.push(msg('ruin', 1));
  q.push(msg('best', 5));
  q.push(msg('finish', 3));

  expect(q.update(0)?.id).toBe('best');
  expect(q.update(10), 'nothing new while one is showing').toBe(null);
  expect(q.current?.id).toBe('best');

  expect(q.update(1001)?.id).toBe('finish');
  expect(q.update(2002)?.id).toBe('ruin');
  expect(q.update(3003)).toBe(null);
  expect(q.current).toBe(null);
});

test('the same event twice in quick succession fires once', () => {
  /*
   * The realistic source is a caller pushing from a per-frame check rather than
   * an edge — sixty identical toasts a second, which is a bug that looks like
   * the UI freezing on one message.
   */
  const q = new MessageQueue({ dedupeWindowMs: 2000 });
  q.push(msg('ruin'));
  q.push(msg('ruin'));
  expect(q.update(0)?.id).toBe('ruin');
  expect(q.update(1001)).toBe(null);

  // Outside the window it is a genuinely new event again.
  q.push(msg('ruin'));
  expect(q.update(4000)?.id).toBe('ruin');
});

test('something more important interrupts; something less important waits', () => {
  // A personal best landing while "ruin found" is on screen is the moment of
  // the run. Making it wait its turn behind a minor toast buries it.
  const q = new MessageQueue();
  q.push(msg('ruin', 1));
  expect(q.update(0)?.id).toBe('ruin');

  q.push(msg('best', 5));
  expect(q.update(100)?.id).toBe('best');

  q.push(msg('ruin2', 1));
  expect(q.update(200), 'the lesser one waits').toBe(null);
  expect(q.current?.id).toBe('best');
});

test('equally important messages arrive in the order they happened', () => {
  /*
   * The first version peeked by *taking* the best candidate and pushing it back
   * when it lost, which reordered the backlog on every frame — so two events of
   * equal importance came out in whichever order the frame boundary happened to
   * fall. Not wrong often enough to notice, and impossible to reproduce when it
   * is: "3 of 4" arriving before "2 of 4" is nonsense the player has to read
   * twice.
   */
  const q = new MessageQueue({ dedupeWindowMs: 0 });
  q.push({ ...msg('a', 1), id: 'first' });
  q.push({ ...msg('b', 1), id: 'second' });
  q.push({ ...msg('c', 9), id: 'urgent' });

  expect(q.update(0)?.id).toBe('urgent');
  // Many frames pass while the urgent one holds the screen.
  for (let t = 10; t < 1000; t += 16) q.update(t);
  expect(q.update(1001)?.id).toBe('first');
  expect(q.update(2002)?.id).toBe('second');
});

test('an interrupted message is not lost, it goes back in the queue', () => {
  const q = new MessageQueue();
  q.push(msg('ruin', 1));
  q.update(0);
  q.push(msg('best', 5));
  q.update(100);
  expect(q.update(1101)?.id).toBe('ruin');
});

test('the backlog is bounded, and it is the least important that is dropped', () => {
  /*
   * Without a bound, a caller pushing in a loop grows the queue forever and the
   * player spends the next minute watching stale notifications from something
   * that happened once. Dropping the least important keeps the ones that
   * matter.
   */
  const q = new MessageQueue({ maxPending: 3 });
  q.push(msg('low-a', 1));
  q.push(msg('low-b', 1));
  q.push(msg('low-c', 1));
  q.push(msg('important', 9));

  const seen: string[] = [];
  for (let t = 0; t < 6000; t += 1001) {
    const next = q.update(t);
    if (next !== null) seen.push(next.id);
  }
  expect(seen).toContain('important');
  expect(seen.length).toBeLessThanOrEqual(3);
});

test('clearing drops everything, including what is on screen', () => {
  // A restart must not leave the previous run's notifications arriving over the
  // new one.
  const q = new MessageQueue();
  q.push(msg('a'));
  q.push(msg('b'));
  q.update(0);
  q.clear();
  expect(q.current).toBe(null);
  expect(q.update(10)).toBe(null);
});
