/**
 * What the browser actually hands over for a locked pointer, measured rather than assumed.
 *
 * **This page exists because the same bug has now been reported twice from the same browser.** A
 * camera that ignores a slow hand and then jumps is the operating system's pointer curve reaching
 * the look, and `input.ts` asks for `unadjustedMovement` to avoid exactly that. The fix was written
 * against a specification that says a browser either honours the option or rejects with
 * `NotSupportedError` — and there is a third case nobody tested, because WebIDL says an unknown
 * dictionary member is **silently ignored**. A browser that has never heard of the option therefore
 * grants an ordinary accelerated lock and says nothing, and if its `requestPointerLock` returns
 * `undefined` rather than a promise there is nothing to inspect either.
 *
 * So this reports the three things that separate the candidate causes, and it reports them for the
 * browser it is opened in rather than for the specification:
 *
 *   - **Acceleration.** A desktop curve scales a slow hand toward nothing and a fast one up, so the
 *     ratio between the mean step when moving slowly and when moving quickly is far larger than the
 *     ratio of the hand speeds. Raw counts scale linearly.
 *   - **Quantisation.** A display delta arrives in whole screen pixels, so every value is an
 *     integer and a slow hand produces a run of zeros and ones. Raw counts are often fractional,
 *     and are in any case far finer.
 *   - **Rate.** A camera can look steppy at 120 fps simply because the events arrive at 60 Hz, in
 *     which case every other frame moves by nothing and neither of the above is involved.
 *
 * **It asks for the lock through the engine's own `askForPointerLock`**, deep-imported, so that
 * what it measures is what a game gets rather than what this page felt like asking for. The first
 * version asked with the option and had no fallback of its own, so on a browser that refuses the
 * option it never took the lock at all and reported an *unlocked* cursor: whole screen pixels that
 * stop dead at the edge of the display, which is a different device and not the one under test.
 *
 * Nothing here is engine API and nothing under `packages/*​/src` may import it.
 */
import { askForPointerLock } from '../../packages/core/src/input/input';

/** What one measurement window holds. Reset by the button. */
interface Window_ {
  events: number;
  firstAt: number;
  lastAt: number;
  /** Absolute movement, for the mean and the extremes. */
  total: number;
  largest: number;
  /** How many carried a fraction, which is the tell for a delta that is not screen pixels. */
  fractional: number;
  /** Small integers, which is what quantisation looks like from underneath. */
  zero: number;
  one: number;
  /** Gaps between consecutive events, for the rate. */
  gapTotal: number;
  gapLargest: number;
}

function empty(): Window_ {
  return {
    events: 0,
    firstAt: 0,
    lastAt: 0,
    total: 0,
    largest: 0,
    fractional: 0,
    zero: 0,
    one: 0,
    gapTotal: 0,
    gapLargest: 0,
  };
}

/**
 * Locked and unlocked events, counted apart.
 *
 * **They are different devices and mixing them made two reports unreadable.** An unlocked cursor
 * reports the travel of an arrow across the desktop: whole screen pixels, stopping dead at the edge
 * of the display, and **no event at all** while a slow hand fails to change the integer pixel it
 * sits on. A locked one reports the movement itself. Reading the numbers means leaving the lock —
 * Escape, or a click to select the text — so any single counter ends up holding both, and the
 * locked figures are the ones that describe a game.
 */
let locked = empty();
let unlocked = empty();

/**
 * The last second of events, so slow and fast can be read one after the other without resetting.
 *
 * The cumulative mean blends them, which is what made the first report unreadable: a hand that
 * moved slowly and then quickly produces one number that describes neither.
 */
const recent: { at: number; size: number }[] = [];

/** Whether the lock has ever been held, so the readout can say what it is showing. */
let everLocked = false;
/** What the lock request itself did, which is half the answer on its own. */
let lockReport = 'not asked yet';

const out = document.getElementById('out') as HTMLElement;

/** Mean absolute movement over the last second, or zero when nothing has arrived. */
function recentMean(): number {
  if (recent.length === 0) return 0;
  let total = 0;
  for (const sample of recent) total += sample.size;
  return total / recent.length;
}

function render(): void {
  const held = document.pointerLockElement !== null;
  if (held) everLocked = true;
  out.textContent = [
    `pointer lock      ${held ? 'HELD' : 'not held'}`,
    `the request       ${lockReport}`,
    '',
    'WHILE LOCKED  <- these are the ones that describe a game',
    report(locked),
    '',
    'while not locked  (an arrow on the desktop: whole pixels, stops at the edge)',
    report(unlocked),
    '',
    held
      ? 'Move slowly for five seconds, then quickly for five. Press Escape to read it.'
      : everLocked
        ? 'Lock released. The locked figures above are kept and are the ones to read.'
        : 'Not locked yet. Click Lock, then move.',
  ].join('\n');
}

/** One window, as lines. */
function report(w: Window_): string {
  if (w.events === 0) return '  nothing recorded';
  const seconds = w.events > 1 ? (w.lastAt - w.firstAt) / 1000 : 0;
  const rate = seconds > 0 ? w.events / seconds : 0;
  return [
    `  events ${w.events} over ${seconds.toFixed(2)}s, rate ${rate.toFixed(0)}/s, mean gap ${
      w.events > 1 ? (w.gapTotal / (w.events - 1)).toFixed(1) : '0'
    } ms`,
    `  mean |movement| ${(w.total / w.events).toFixed(3)} px, largest ${w.largest.toFixed(0)}`,
    `  fractional ${w.fractional} of ${w.events}, exactly 0: ${w.zero}, exactly +-1: ${w.one}`,
    `  last 1s mean ${recentMean().toFixed(3)} px`,
  ].join('\n');
}

function onMove(e: MouseEvent): void {
  const w = document.pointerLockElement !== null ? locked : unlocked;
  const dx = e.movementX;
  const dy = e.movementY;
  const size = Math.abs(dx) + Math.abs(dy);
  if (w.events === 0) w.firstAt = e.timeStamp;
  else {
    const gap = e.timeStamp - w.lastAt;
    /*
     * A gap of 9.2e15 ms was reported once, which is not a pause: some events arrive with a
     * timeStamp from another origin. Anything past a second is dropped from the rate rather than
     * averaged into it, because one such value drowns every real figure in the window.
     */
    if (gap >= 0 && gap < 1000) {
      w.gapTotal += gap;
      if (gap > w.gapLargest) w.gapLargest = gap;
    }
  }
  w.lastAt = e.timeStamp;
  recent.push({ at: e.timeStamp, size });
  while (recent.length > 0 && e.timeStamp - (recent[0]?.at ?? 0) > 1000) recent.shift();
  w.events++;
  w.total += size;
  if (size > w.largest) w.largest = size;
  if (!Number.isInteger(dx) || !Number.isInteger(dy)) w.fractional++;
  if (dx === 0 && dy === 0) w.zero++;
  if (Math.abs(dx) === 1 || Math.abs(dy) === 1) w.one++;
  render();
}

/**
 * Ask for the lock exactly as `input.ts` does, and report every branch it can take.
 *
 * The point is the branch, not the lock: a browser that ignores the option reaches the same
 * "held" state as one that honours it, and the only way to tell them apart from outside is what
 * the call returned and whether anything rejected.
 */
function lock(): void {
  const target = document.documentElement as HTMLElement & {
    requestPointerLock: (options?: { unadjustedMovement: boolean }) => Promise<void> | void;
  };
  const seen: string[] = [];
  askForPointerLock((options) => {
    seen.push(options === undefined ? 'plain' : 'with unadjustedMovement');
    lockReport = seen.join(' then ');
    render();
    let pending: Promise<void> | void;
    try {
      pending = target.requestPointerLock(options);
    } catch (error) {
      lockReport = `${seen.join(' then ')} — threw ${String((error as Error)?.name ?? error)}`;
      render();
      return undefined;
    }
    if (pending === undefined) {
      lockReport = `${seen.join(' then ')} — returned undefined`;
      render();
      return undefined;
    }
    /*
     * Reported for the record and handed back unchanged, so the engine's own retry still sees the
     * rejection it keys on. Swallowing it here would measure a fallback that never ran.
     */
    return pending.then(
      () => {
        lockReport = `${seen.join(' then ')} — accepted`;
        render();
      },
      (error: unknown) => {
        const name = (error as { name?: string })?.name ?? String(error);
        lockReport = `${seen.join(' then ')} — rejected ${name}`;
        render();
        throw error;
      },
    );
  });
}

document.getElementById('lock')?.addEventListener('click', lock);
document.getElementById('reset')?.addEventListener('click', () => {
  locked = empty();
  unlocked = empty();
  recent.length = 0;
  render();
});
document.addEventListener('pointerlockchange', render);
window.addEventListener('mousemove', onMove);
render();
