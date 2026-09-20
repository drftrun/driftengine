import { describe, expect, test } from 'vitest';

import { NativeCanvas } from './canvas.ts';
import { HostPage } from './page.ts';

/**
 * **What this file is for: an event reaching a page's listeners in the order a browser's does.**
 * The DOM specification's dispatch — capture from the window down, the target, bubbling back up —
 * over the host's three nodes. Each expectation is that specification's order, derived by hand.
 */

function tree() {
  const page = new HostPage();
  const canvas = new NativeCanvas(4, 4);
  page.attach(canvas);
  return { window: page.window, document: page.document, canvas };
}

describe('dispatch over window, document and canvas', () => {
  test('CAPTURE RUNS FROM THE WINDOW DOWN, then the target, then bubbling back up', () => {
    const { window, document, canvas } = tree();
    const heard: string[] = [];
    const note = (name: string) => (event: Event) => {
      const target = event.target === canvas ? 'canvas' : 'other';
      heard.push(`${name} ${event.eventPhase} ${target} ${String(event.currentTarget !== null)}`);
    };
    window.addEventListener('ping', note('window bubble'));
    window.addEventListener('ping', note('window capture'), true);
    document.addEventListener('ping', note('document bubble'));
    document.addEventListener('ping', note('document capture'), { capture: true });
    canvas.addEventListener('ping', note('canvas'));
    canvas.dispatchEvent(new Event('ping', { bubbles: true }));
    expect(heard).toEqual([
      'window capture 1 canvas true',
      'document capture 1 canvas true',
      'canvas 2 canvas true',
      'document bubble 3 canvas true',
      'window bubble 3 canvas true',
    ]);
  });

  test('AN EVENT THAT DOES NOT BUBBLE IS STILL CAPTURED, and goes no higher than its target', () => {
    const { window, canvas } = tree();
    const heard: string[] = [];
    window.addEventListener('ping', () => heard.push('capture'), true);
    window.addEventListener('ping', () => heard.push('bubble'));
    canvas.dispatchEvent(new Event('ping'));
    expect(heard).toEqual(['capture']);
  });

  test('STOPPING PROPAGATION IN CAPTURE KEEPS IT FROM THE TARGET; stopping it at once, from the next listener', () => {
    const { document, canvas } = tree();
    const heard: string[] = [];
    document.addEventListener('ping', (event) => event.stopPropagation(), true);
    canvas.addEventListener('ping', () => heard.push('canvas'));
    canvas.dispatchEvent(new Event('ping', { bubbles: true }));
    expect(heard).toEqual([]);

    canvas.addEventListener('pong', (event) => {
      heard.push('first');
      event.stopImmediatePropagation();
    });
    canvas.addEventListener('pong', () => heard.push('second'));
    canvas.dispatchEvent(new Event('pong', { bubbles: true }));
    expect(heard).toEqual(['first']);
  });

  test('A PASSIVE LISTENER CANNOT CANCEL; the next listener still can', () => {
    const { canvas } = tree();
    canvas.addEventListener('ping', (event) => event.preventDefault(), { passive: true });
    const quiet = new Event('ping', { cancelable: true });
    expect(canvas.dispatchEvent(quiet)).toBe(true);
    canvas.addEventListener('ping', (event) => event.preventDefault());
    const loud = new Event('ping', { cancelable: true });
    expect(canvas.dispatchEvent(loud)).toBe(false);
  });

  test('ONCE IS ONCE, AND A SIGNAL TAKES A LISTENER AWAY', () => {
    const { canvas } = tree();
    let once = 0;
    let signalled = 0;
    const abort = new AbortController();
    canvas.addEventListener('ping', () => (once += 1), { once: true });
    canvas.addEventListener('ping', () => (signalled += 1), { signal: abort.signal });
    canvas.dispatchEvent(new Event('ping'));
    abort.abort();
    canvas.dispatchEvent(new Event('ping'));
    expect([once, signalled]).toEqual([1, 1]);
  });

  test('A HANDLER ATTRIBUTE IS A LISTENER THAT KEEPS ITS PLACE, and returning false cancels', () => {
    const { canvas } = tree();
    const heard: string[] = [];
    canvas.onclick = () => heard.push('first handler');
    canvas.addEventListener('click', () => heard.push('listener'));
    /* Replaced where it stands, ahead of the listener added after it. */
    canvas.onclick = () => {
      heard.push('second handler');
      return false;
    };
    const click = new Event('click', { cancelable: true });
    expect(canvas.dispatchEvent(click)).toBe(false);
    expect(heard).toEqual(['second handler', 'listener']);
    canvas.onclick = null;
    canvas.dispatchEvent(new Event('click'));
    expect(heard).toEqual(['second handler', 'listener', 'listener']);
  });
});
