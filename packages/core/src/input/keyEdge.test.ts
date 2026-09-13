import { expect, test } from 'vitest';

import { InputSource } from './input.ts';
import { fakeBrowser } from './inputHarness.ts';

/**
 * The keyboard gains the two verbs a pad already had.
 *
 * `isDown` is a level and `onKeyDown` is a callback, and neither is an edge a simulation tick can
 * claim — so an action map bound to a key had nothing uniform to read. Latched at the poll and
 * cleared at the next, exactly as a button's is, which is what lets one action answer for both
 * devices without special-casing either.
 */
test('a key press is one frame, and a claim takes it', () => {
  const browser = fakeBrowser();
  try {
    const input = new InputSource(browser.target, [], { autoPoll: false });
    browser.keyDown('Space');
    input.poll();

    expect(input.isDown('Space'), 'held, as it always was').toBe(true);
    expect(input.keyPressed('Space'), 'and an edge anything may read').toBe(true);
    expect(input.keyPressed('Space'), 'twice, because reading is not claiming').toBe(true);

    expect(input.consumeKeyPress('Space'), 'the first claim takes it').toBe(true);
    expect(input.consumeKeyPress('Space'), 'and the second finds it gone').toBe(false);
    expect(input.keyPressed('Space'), 'for everybody').toBe(false);
  } finally {
    browser.restore();
  }
});

test('an edge does not survive the frame that produced it', () => {
  const browser = fakeBrowser();
  try {
    const input = new InputSource(browser.target, [], { autoPoll: false });
    browser.keyDown('KeyW');
    input.poll();
    expect(input.keyPressed('KeyW')).toBe(true);

    input.poll();
    expect(input.keyPressed('KeyW'), 'the next frame is not a new press').toBe(false);
    expect(input.isDown('KeyW'), 'though it is still held down').toBe(true);
  } finally {
    browser.restore();
  }
});

/**
 * **The claim outlives the frame, because a claimant does not run every frame.**
 *
 * `poll` is on the input source's own animation frame and a fixed-step consumer is not: at 120 Hz
 * against a 60 Hz simulation, about half the display frames run no tick at all. A press that
 * landed in one of those was rotated away before anything could claim it, and the player's jump
 * simply did not happen — intermittently, in proportion to their refresh rate.
 *
 * Found in production: a hand-rolled `onKeyDown` latch, which was immune because it cleared only
 * when the simulation ran, was replaced by `ActionMap.consumePress` and jumping became unreliable
 * on a 120 Hz display.
 *
 * So the *readable* edge stays frame-scoped — that one is for drawing, and a highlight that
 * outlived its frame would be wrong — and the *claimable* one lives until it is claimed or until
 * the key comes back up. Releasing is what makes it stale: a press nobody wanted, whose key is no
 * longer down, describes nothing anybody can still act on.
 */
test('a press waits to be claimed across frames that claim nothing', () => {
  const browser = fakeBrowser();
  try {
    const input = new InputSource(browser.target, [], { autoPoll: false });
    browser.keyDown('Space');
    input.poll();

    /* Three display frames in which the simulation did not run. */
    input.poll();
    input.poll();
    input.poll();

    expect(input.keyPressed('Space'), 'the readable edge is still one frame').toBe(false);
    expect(input.consumeKeyPress('Space'), 'and the claim is still there to take').toBe(true);
    expect(input.consumeKeyPress('Space'), 'once').toBe(false);
  } finally {
    browser.restore();
  }
});

test('a press nobody claimed goes stale when the key comes back up', () => {
  const browser = fakeBrowser();
  try {
    const input = new InputSource(browser.target, [], { autoPoll: false });
    browser.keyDown('Space');
    input.poll();
    browser.keyUp('Space');
    input.poll();

    expect(input.consumeKeyPress('Space'), 'the key is up and the press is spent').toBe(false);
  } finally {
    browser.restore();
  }
});

test('a second press after a claim is a second press', () => {
  const browser = fakeBrowser();
  try {
    const input = new InputSource(browser.target, [], { autoPoll: false });
    browser.keyDown('Space');
    input.poll();
    expect(input.consumeKeyPress('Space')).toBe(true);

    browser.keyUp('Space');
    input.poll();
    browser.keyDown('Space');
    input.poll();
    expect(input.consumeKeyPress('Space'), 'the tap after the first is its own').toBe(true);
  } finally {
    browser.restore();
  }
});
