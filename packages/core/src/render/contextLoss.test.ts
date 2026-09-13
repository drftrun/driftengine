import { expect, test } from 'vitest';
import { attachContextLoss } from './contextLoss.ts';

/** A canvas that only records what was subscribed to, so a test can fire it by hand. */
function fakeCanvas(): {
  canvas: HTMLCanvasElement;
  listeners: Map<string, (event: { preventDefault(): void }) => void>;
} {
  const listeners = new Map<string, (event: { preventDefault(): void }) => void>();
  const canvas = {
    addEventListener: (type: string, cb: (event: { preventDefault(): void }) => void) =>
      listeners.set(type, cb),
  } as unknown as HTMLCanvasElement;
  return { canvas, listeners };
}

test('a lost context tells the listener and asks for it back', () => {
  /*
   * A lost context is a black screen the game does not notice on its own. It is also
   * recoverable — but only if something calls `preventDefault`, which is the browser's
   * signal that the page intends to restore rather than to die.
   */
  const { canvas, listeners } = fakeCanvas();

  let told = 0;
  let prevented = 0;
  attachContextLoss(
    canvas,
    () => told++,
    () => {},
  );
  listeners.get('webglcontextlost')?.({ preventDefault: () => prevented++ });

  expect(told).toBe(1);
  expect(prevented).toBe(1);
});

test('a context that comes back tells its own listener, not the lost one', () => {
  /*
   * `webglcontextrestored` fires on the same canvas and is the good news. Routing it to
   * `onLost` would report a fault at the moment the fault ended, which reads in a bug
   * report as a device that lost its context twice — so the two have separate sinks.
   */
  const { canvas, listeners } = fakeCanvas();

  let lost = 0;
  let restored = 0;
  attachContextLoss(
    canvas,
    () => lost++,
    () => restored++,
  );

  listeners.get('webglcontextlost')?.({ preventDefault: () => {} });
  expect(lost).toBe(1);
  expect(restored).toBe(0);

  listeners.get('webglcontextrestored')?.({ preventDefault: () => {} });
  expect(lost).toBe(1);
  expect(restored).toBe(1);
});

test('the restore listener does not preventDefault', () => {
  /*
   * `preventDefault` on the *loss* is what asks for the context back. On the restore
   * there is nothing to prevent, and calling it there is meaningless rather than
   * harmful — this pins the asymmetry so a later edit cannot make the two symmetric out
   * of tidiness.
   */
  const { canvas, listeners } = fakeCanvas();

  let prevented = 0;
  attachContextLoss(
    canvas,
    () => {},
    () => {},
  );

  listeners.get('webglcontextrestored')?.({ preventDefault: () => prevented++ });
  expect(prevented).toBe(0);
});
