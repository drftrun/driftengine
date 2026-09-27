import { expect, test } from 'vitest';

import { runFrames } from './frameLoop.ts';

/**
 * **What a frame queues on a microtask reaches the screen in that frame**, because a browser
 * presents only after the task's microtask checkpoint and this host has to do the same.
 *
 * The WebGPU renderer submits anything drawn after `endFrame` on a microtask: there is no second
 * `endFrame` to hang it on. The host presented synchronously, straight after the frame returned,
 * so the window's blit went to the device first and the overlay landed in the canvas texture after
 * it. A capture reads that texture back and saw the overlay; the window never showed it. Reported
 * as a courtyard whose loading screen never appeared: the name, the percentage and the bar are all
 * drawn after `endFrame`.
 */
test('A FRAME’S MICROTASKS RUN BEFORE THE PRESENT, chained ones included, as a browser’s do', async () => {
  const order: string[] = [];
  const drawn = await runFrames({
    frames: 1,
    open: () => true,
    clock: () => 0,
    animationFrames: () => order.push('animation frames'),
    errors: () => ({
      open: () => order.push('errors open'),
      close: () => order.push('errors close'),
    }),
    frame: () => {
      order.push('frame');
      /* The overlay's submission, and one more queued from inside it. */
      queueMicrotask(() => {
        order.push('overlay');
        queueMicrotask(() => order.push('overlay, chained'));
      });
    },
    present: () => order.push('present'),
  });

  expect(drawn).toBe(1);
  expect(order).toEqual([
    'animation frames',
    'errors open',
    'frame',
    'overlay',
    'overlay, chained',
    'present',
    'errors close',
  ]);
});

test('the loop stops when the window closes, and counts only what it drew', async () => {
  let frames = 0;
  const drawn = await runFrames({
    frames: 10,
    open: () => frames < 3,
    clock: () => 0,
    animationFrames: () => {},
    errors: () => null,
    frame: () => {
      frames += 1;
    },
    present: () => {},
  });
  expect(drawn).toBe(3);
});

test('A FRAME THAT WAITS IS WAITED FOR, draws nothing, and is not counted as drawn', async () => {
  /*
   * A window between two scenes has nothing to draw until the next one has mounted. A loop that
   * spun meanwhile ran thousands of empty frames a second, burning a core, and a run asked for N
   * frames spent them on nothing and ended before the scene it switched to had drawn once.
   */
  const order: string[] = [];
  let mounted = false;
  let calls = 0;
  const drawn = await runFrames({
    frames: 2,
    open: () => true,
    clock: () => 0,
    animationFrames: () => {},
    errors: () => ({ open: () => order.push('open'), close: () => order.push('close') }),
    frame: () => {
      calls += 1;
      if (mounted) {
        order.push('draw');
        return undefined;
      }
      order.push('wait');
      return new Promise<void>((resolve) =>
        setTimeout(() => {
          mounted = true;
          resolve();
        }, 5),
      );
    },
    present: () => order.push('present'),
  });
  expect(drawn).toBe(2);
  expect(calls).toBe(3);
  /* The waiting frame's scope closes before the wait, and nothing is presented for it. */
  expect(order).toEqual([
    'open',
    'wait',
    'close',
    'open',
    'draw',
    'present',
    'close',
    'open',
    'draw',
    'present',
    'close',
  ]);
});
