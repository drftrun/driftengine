import { describe, expect, test } from 'vitest';

import { NativeCanvas } from './canvas.ts';
import { HostPage } from './page.ts';

/**
 * **What this file is for: the page a scene expects around its canvas.** The engine's input listens
 * on `window` and `document` and polls from `requestAnimationFrame`, and the published scenes add
 * listeners of their own. Node has none of the three, so the host supplies them: what they read,
 * behaving as a browser's does, and a refusal by name for what they do not.
 */
describe('a page for a host with none', () => {
  test('A FRAME RUNS WHAT WAS ASKED BEFORE IT, in order; what those ask for waits for the next', () => {
    const page = new HostPage();
    const ran: string[] = [];
    page.requestAnimationFrame((now) => {
      ran.push(`first at ${now}`);
      page.requestAnimationFrame(() => ran.push('asked during the frame'));
    });
    page.requestAnimationFrame(() => ran.push('second'));
    page.runFrame(16);
    expect(ran).toEqual(['first at 16', 'second']);
    page.runFrame(32);
    expect(ran).toEqual(['first at 16', 'second', 'asked during the frame']);
  });

  test('A CANCELLED FRAME DOES NOT RUN, even from inside the frame it was due in', () => {
    const page = new HostPage();
    const ran: string[] = [];
    let later = 0;
    page.requestAnimationFrame(() => {
      ran.push('first');
      page.cancelAnimationFrame(later);
    });
    later = page.requestAnimationFrame(() => ran.push('cancelled'));
    const gone = page.requestAnimationFrame(() => ran.push('never'));
    page.cancelAnimationFrame(gone);
    page.runFrame(0);
    expect(ran).toEqual(['first']);
  });

  test('HIDING THE WINDOW HIDES THE DOCUMENT, and says so once', () => {
    const page = new HostPage();
    const heard: string[] = [];
    page.document.addEventListener('visibilitychange', () => {
      heard.push(page.document.visibilityState);
    });
    page.setVisible(false);
    page.setVisible(false);
    page.setVisible(true);
    expect(heard).toEqual(['hidden', 'visible']);
    expect(page.document.hidden).toBe(false);
  });

  test('POINTER LOCK IS THE CANVAS’S TO ASK FOR and the document’s to report and release', async () => {
    const page = new HostPage();
    const canvas = new NativeCanvas(4, 4);
    page.attach(canvas);
    const told: boolean[] = [];
    page.onPointerLock((locked) => told.push(locked));
    let changes = 0;
    page.document.addEventListener('pointerlockchange', () => {
      changes += 1;
    });

    /* A person's gesture, which a lock needs (`gesture.test.ts`). */
    page.userActivation.notify();
    await canvas.requestPointerLock();
    expect(page.document.pointerLockElement).toBe(canvas);
    page.document.exitPointerLock();
    expect(page.document.pointerLockElement).toBeNull();
    expect(changes).toBe(2);
    expect(told).toEqual([true, false]);
  });

  test('A LOCK THE PLATFORM CANNOT TAKE IS REFUSED, as a browser refuses one without focus', async () => {
    const page = new HostPage();
    const canvas = new NativeCanvas(4, 4);
    page.attach(canvas);
    page.setPointerLocker(() => false);
    let errors = 0;
    page.document.addEventListener('pointerlockerror', () => {
      errors += 1;
    });
    page.userActivation.notify();
    await expect(canvas.requestPointerLock()).rejects.toThrow(/could not/);
    expect(page.document.pointerLockElement).toBeNull();
    expect(errors).toBe(1);
  });

  test('A CANVAS NO PAGE HOLDS CANNOT LOCK THE POINTER, and says why', async () => {
    await expect(new NativeCanvas(4, 4).requestPointerLock()).rejects.toThrow(/no window/);
  });

  test('WHAT IT DOES NOT MAKE, IT REFUSES BY NAME', () => {
    expect(() => new HostPage().document.createElement('div')).toThrow(/<div>/);
  });

  test('INSTALLED AND TAKEN AWAY AGAIN, leaving the globals as they were', () => {
    const page = new HostPage();
    const scope = globalThis as Record<string, unknown>;
    const before = scope['window'];
    const remove = page.install();
    expect(scope['window']).toBe(page.window);
    expect(scope['document']).toBe(page.document);
    expect(typeof scope['requestAnimationFrame']).toBe('function');
    remove();
    expect(scope['window']).toBe(before);
    expect('document' in scope).toBe(false);
    expect('requestAnimationFrame' in scope).toBe(false);
  });
});
