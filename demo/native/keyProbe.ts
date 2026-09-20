/**
 * Where a keystroke stops: `npm run native:keys`, then press keys in the window it opens.
 *
 * **An instrument, because "the keyboard does not work" has four places to break and a report
 * cannot say which.** A key travels SDL → the window's emitter → `connectDomEvents` → the page's
 * window → an `InputSource`, and each hop is checked here and printed. Whichever line stops
 * appearing is the hop that is wrong.
 *
 * Written 2026-09-20 after a maintainer's keyboard did nothing in `npm run native:scene` while
 * every automated path — a replayed `keyDown` through the same emitter, and a unit test of the
 * whole chain — worked. That difference is the whole reason this file exists: it is the only thing
 * that can tell *SDL is not delivering* from *the engine is not listening*, and only a person at
 * the machine can run it.
 *
 * It draws nothing and needs no GPU. Close the window or press Ctrl+C to stop.
 */
import { EventEmitter } from 'node:events';

import { NativeCanvas } from '../../packages/native-host/src/canvas.ts';
import { connectDomEvents, type EventWindow } from '../../packages/native-host/src/domEvents.ts';
import { HostPage } from '../../packages/native-host/src/page.ts';
import { HostWindow } from '../../packages/native-host/src/window.ts';

const { InputSource } = await import('../../packages/core/src/index.ts');

const host = new HostWindow({ title: 'DriftEngine key probe', width: 640, height: 360 });
const page = new HostPage();
page.install();
host.connectPage(page);

let sdlSeen = 0;
let pageSeen = 0;
let engineSeen = 0;

/*
 * 1. SDL itself, on the window's own emitter — the first hop, and the one nobody can fake.
 *
 * Reached through `replay`'s own door rather than by widening the class: `HostWindow` keeps its SDL
 * window private on purpose, and a probe is not a reason to change that.
 */
(host as unknown as { window: EventEmitter }).window.on(
  'keyDown',
  (event: { scancode: number }) => {
    sdlSeen += 1;
    const raw = event as unknown as { repeat?: unknown };
    console.log(
      `1. SDL      keyDown scancode=${event.scancode} ` +
        `repeat=${String(raw.repeat)} (${typeof raw.repeat})`,
    );
  },
);

/* 3. An `InputSource`, exactly as a scene makes one. Built before the listeners above use it. */
const input = new InputSource(host.canvas as unknown as HTMLElement, [], { autoPoll: false });
console.log(
  `the engine listens to the page's window: ${String(
    (globalThis as { window?: unknown }).window === page.window,
  )}`,
);

/* 2. The page's window, which is where `connectDomEvents` has put it and what the engine listens to. */
page.window.addEventListener('keydown', (event) => {
  pageSeen += 1;
  const key = event as KeyboardEvent;
  console.log(
    `2. page     keydown code=${key.code} key=${key.key} target=${targetOf(key)} ` +
      `repeat=${String(key.repeat)} typing=${String(isTypingLike(key.target))}`,
  );
  /*
   * **Asked in the same turn rather than on a timer.** The first version of this probe polled every
   * hundred milliseconds and printed only while a key was held, so a tapped key never reached line
   * 3 whether the engine had it or not — a gap in the instrument that reads exactly like a gap in
   * the engine.
   */
  input.poll();
  console.log(`3. engine   isDown(${key.code}) = ${String(input.isDown(key.code))}`);
});

page.window.addEventListener('keyup', (event) => {
  const key = event as KeyboardEvent;
  input.poll();
  console.log(`   keyup     ${key.code}, isDown now ${String(input.isDown(key.code))}`);
});

/*
 * **Focus, because losing it clears every key the engine is holding** — deliberately, since a key
 * released in another window is never heard here. That makes a stray `blur` indistinguishable from
 * a keyboard that does not work *for held keys only*: a digit still changes the hotbar, because a
 * press is an edge and the hotbar reads edges, while walking reads a level that has just been
 * wiped. Which is exactly the report this probe is chasing.
 */
(host as unknown as { window: EventEmitter }).window.on('focus', () => {
  console.log('   SDL focus');
});
(host as unknown as { window: EventEmitter }).window.on('blur', () => {
  console.log('   SDL BLUR  <- this clears every held key');
});
page.window.addEventListener('blur', () => {
  console.log('   page blur <- InputSource clears its keys here');
});

/** `isTypingTarget`'s rule, restated here so the probe says what the engine would decide. */
function isTypingLike(target: EventTarget | null): boolean {
  if (target === null) return false;
  const element = target as { tagName?: string; isContentEditable?: boolean };
  if (typeof element.tagName === 'string') {
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName)) return true;
  }
  return element.isContentEditable === true;
}

function targetOf(event: Event): string {
  const target = event.target as { tagName?: string } | null;
  if (target === null) return 'null';
  return target.tagName ?? 'no tagName';
}

/*
 * `--replay` fires a `W` through SDL's own emitter after a moment and exits, so this probe can be
 * run without a person at the machine. **It cannot answer the question the probe exists for** — a
 * replayed key skips SDL's delivery entirely — but it does say whether the hops *after* that are
 * sound, which is the half a maintainer's report cannot separate.
 */
if (process.argv.includes('--replay')) {
  setTimeout(() => {
    (host as unknown as { window: { emit(type: string, event: object): void } }).window.emit(
      'keyDown',
      { scancode: 26, key: 'w', repeat: 0, shift: 0, ctrl: 0, alt: 0, super: 0 },
    );
    setTimeout(() => {
      input.poll();
      console.log(`replayed W: isDown(KeyW) = ${String(input.isDown('KeyW'))}`);
      void host.close().then(() => process.exit(0));
    }, 200);
  }, 400);
}

console.log('press keys in the window. Each hop a key reaches prints a line.');
console.log('nothing at all after "1." means SDL is not delivering keys to this window.\n');

const tick = setInterval(() => {
  input.poll();
  const held = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space'].filter((code) => input.isDown(code));
  if (held.length > 0) {
    engineSeen += 1;
    console.log(`   holding   ${held.join(' ')}`);
  }
  if (host.isClosed) {
    clearInterval(tick);
    console.log(
      `\nSDL saw ${sdlSeen}, the page saw ${pageSeen}, the engine held a key on ${engineSeen} polls.`,
    );
    void host.close().then(() => process.exit(0));
  }
}, 100);
