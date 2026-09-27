import { expect, test } from 'vitest';

import { bindHudInput, type HudActions } from './hudInput.ts';
import { createHudTree, layoutHud } from './hudTree.ts';

/**
 * The native window's controls take the pointers that land on them, and only those.
 *
 * The camera binder listens on the same canvas, so a control that let its click through would turn
 * the camera as well, and a drag along the timeline would swing the view with it. The HUD is bound
 * first and stops what it takes; everything else reaches the camera untouched. Laid out at the
 * harness's own size, 1280 by 608: the `SCENES` button is 8 in from the corner and 22 high, so its
 * middle is at (47, 19), and the scene is everywhere nothing is drawn.
 */

function pointer(type: string, x: number, y: number): Event {
  return Object.assign(new Event(type, { bubbles: true, cancelable: true }), {
    offsetX: x,
    offsetY: y,
  });
}

function rig() {
  const tree = createHudTree(['First', 'Second']);
  const calls: string[] = [];
  const actions: HudActions = {
    toggleMenu: () => {
      calls.push('menu');
      tree.menu.hidden = !tree.menu.hidden;
      layoutHud(tree, 1280, 608);
    },
    closeMenu: () => {
      calls.push('close');
      tree.menu.hidden = true;
    },
    pick: (index) => calls.push(`pick ${index}`),
    playPause: () => calls.push('play'),
    stop: () => calls.push('stop'),
    seek: (fraction) => calls.push(`seek ${fraction.toFixed(2)}`),
    reveal: (fraction) => calls.push(`reveal ${fraction.toFixed(2)}`),
  };
  const canvas = new EventTarget();
  bindHudInput(canvas, tree, actions);
  /* The camera, bound after the HUD as every scene's is. */
  const camera: string[] = [];
  for (const type of ['pointerdown', 'pointermove', 'pointerup']) {
    canvas.addEventListener(type, () => camera.push(type));
  }
  layoutHud(tree, 1280, 608);
  const click = (x: number, y: number): void => {
    canvas.dispatchEvent(pointer('pointerdown', x, y));
    canvas.dispatchEvent(pointer('pointerup', x, y));
  };
  return { tree, calls, camera, canvas, click };
}

test('A CLICK ON A CONTROL IS THE CONTROL’S AND NEVER REACHES THE CAMERA', () => {
  const { calls, camera, click, tree } = rig();
  click(47, 19);
  expect(calls).toEqual(['menu']);
  expect(camera).toEqual([]);

  /* The menu's first entry, under the button: picked, and the menu closed with it. */
  const first = tree.entries[0];
  if (first === undefined) throw new Error('no entry');
  click(first.rect.x + 4, first.rect.y + first.rect.h / 2);
  expect(calls).toEqual(['menu', 'close', 'pick 0']);
  expect(camera).toEqual([]);
});

test('a click on the scene is the camera’s, and closes a menu left open', () => {
  const { calls, camera, click } = rig();
  click(640, 300);
  expect(calls).toEqual([]);
  expect(camera).toEqual(['pointerdown', 'pointerup']);

  click(47, 19);
  click(640, 300);
  expect(calls).toEqual(['menu', 'close']);
  expect(camera).toEqual(['pointerdown', 'pointerup', 'pointerdown', 'pointerup']);
});

test('A DRAG ALONG THE TIMELINE SEEKS, and never turns the camera, even off the track', () => {
  const { tree, calls, camera, canvas } = rig();
  tree.transport.hidden = false;
  layoutHud(tree, 1280, 608);
  const { x, y, w, h } = tree.timeline.rect;
  canvas.dispatchEvent(pointer('pointerdown', x + w / 4, y + h / 2));
  /* Along, then off the top of the track and past its end: held, and clamped to the end. */
  canvas.dispatchEvent(pointer('pointermove', x + w / 2, y + h / 2));
  canvas.dispatchEvent(pointer('pointermove', x + w * 2, y - 200));
  canvas.dispatchEvent(pointer('pointerup', x + w * 2, y - 200));
  expect(calls).toEqual(['seek 0.25', 'seek 0.50', 'seek 1.00']);
  expect(camera).toEqual([]);
});
