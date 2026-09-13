import { expect, test, vi } from 'vitest';

import { ActiveDevice } from './activeDevice.ts';

test('it starts on the keyboard and follows what is used', () => {
  const active = new ActiveDevice();
  expect(active.last).toBe('keyboard');
  active.use('gamepad');
  expect(active.last).toBe('gamepad');
});

/** A consumer redrawing its prompts must do it once, not every frame a button is held. */
test('a subscriber hears a change and not a repeat', () => {
  const active = new ActiveDevice();
  const heard = vi.fn();
  active.subscribe(heard);

  active.use('gamepad');
  active.use('gamepad');
  active.use('gamepad');
  expect(heard).toHaveBeenCalledTimes(1);
  expect(heard).toHaveBeenCalledWith('gamepad');

  active.use('keyboard');
  expect(heard).toHaveBeenCalledTimes(2);
});

/**
 * The bug this kind of feature usually ships with, asserted so it cannot arrive.
 *
 * A cursor drifts and a desk gets bumped. A mouse that flipped the hint on the first stray pixel
 * would take the prompts back from a pad the player is holding. A keydown and a touchstart are
 * intentional; a mousemove is not necessarily anything.
 */
test('a nudged mouse does not take the prompts from a pad', () => {
  const active = new ActiveDevice();
  active.use('gamepad');

  active.moved(1, 0);
  expect(active.last, 'one pixel is not a decision').toBe('gamepad');

  active.moved(40, 40);
  expect(active.last, 'and a real movement is').toBe('mouse');
});

test('an unsubscribed listener stops hearing', () => {
  const active = new ActiveDevice();
  const heard = vi.fn();
  active.subscribe(heard)();
  active.use('touch');
  expect(heard).not.toHaveBeenCalled();
});
