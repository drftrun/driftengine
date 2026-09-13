import { expect, test, vi } from 'vitest';

import { InputSource } from './input.ts';
import { fakeBrowser } from './inputHarness.ts';

function withBrowser(run: (browser: ReturnType<typeof fakeBrowser>) => void): void {
  const browser = fakeBrowser();
  try {
    run(browser);
  } finally {
    browser.restore();
  }
}

/** A pad has to be *used* before the browser reports it, so every test presses something first. */
function connectedPad(browser: ReturnType<typeof fakeBrowser>, input: InputSource) {
  browser.connect();
  input.poll();
  const pad = input.pad(0);
  if (pad === null) throw new Error('the harness did not produce a pad');
  return pad;
}

/**
 * **The refusal is the capability.**
 *
 * A settings screen has to be able to grey the control out, which means a pad with no actuator has
 * to say so rather than accept the call and do nothing. That is the same rule the host seam keeps
 * everywhere, and it is the half of this row that could not be discovered by a player.
 */
test('a pad with no actuator refuses rather than accepting the call quietly', () => {
  withBrowser((browser) => {
    const input = new InputSource(browser.target, [], { autoPoll: false });
    browser.rumbleSupport(false);
    const pad = connectedPad(browser, input);

    expect(pad.canRumble).toBe(false);
    expect(pad.rumble(200, 1, 1)).toBe(false);
    expect(pad.stopRumble()).toBe(false);
  });
});

test('a pad with an actuator answers true and plays a dual-rumble effect', () => {
  withBrowser((browser) => {
    const input = new InputSource(browser.target, [], { autoPoll: false });
    const pad = connectedPad(browser, input);

    expect(pad.canRumble).toBe(true);
    expect(pad.rumble(200, 0.8, 0.25)).toBe(true);
    expect(browser.effects.length).toBe(1);
    expect(browser.effects[0]?.type).toBe('dual-rumble');
    expect(browser.effects[0]?.params.duration).toBe(200);
    expect(browser.effects[0]?.params.strongMagnitude).toBeCloseTo(0.8, 6);
    expect(browser.effects[0]?.params.weakMagnitude).toBeCloseTo(0.25, 6);
  });
});

/*
 * Magnitudes are a fraction of the motor and a duration is milliseconds. Out-of-range numbers are
 * brought into range rather than refused, because a caller ramping a magnitude off a physical
 * quantity will overshoot at the top and the honest answer there is "as hard as it goes".
 */
test('magnitudes are clamped into the range the hardware has', () => {
  withBrowser((browser) => {
    const input = new InputSource(browser.target, [], { autoPoll: false });
    const pad = connectedPad(browser, input);

    pad.rumble(100, 4, -3);
    expect(browser.effects[0]?.params.strongMagnitude).toBe(1);
    expect(browser.effects[0]?.params.weakMagnitude).toBe(0);
  });
});

/*
 * The specification's own ceiling is five seconds and a longer request is not an error the caller
 * can see — it is a promise resolving with a word nobody reads. Clamped here, where it can be
 * documented, rather than left to differ per browser.
 */
test('a duration past the platform ceiling is clamped rather than rejected', () => {
  withBrowser((browser) => {
    const input = new InputSource(browser.target, [], { autoPoll: false });
    const pad = connectedPad(browser, input);

    expect(pad.rumble(60_000, 1, 1)).toBe(true);
    expect(browser.effects[0]?.params.duration).toBe(5000);
  });
});

/* A negative duration is nothing to play, and asking the hardware for it is not this engine's. */
test('a duration at or below zero is refused', () => {
  withBrowser((browser) => {
    const input = new InputSource(browser.target, [], { autoPoll: false });
    const pad = connectedPad(browser, input);

    expect(pad.rumble(0, 1, 1)).toBe(false);
    expect(pad.rumble(-5, 1, 1)).toBe(false);
    expect(browser.effects.length).toBe(0);
  });
});

test('stopping resets the actuator', () => {
  withBrowser((browser) => {
    const input = new InputSource(browser.target, [], { autoPoll: false });
    const pad = connectedPad(browser, input);

    pad.rumble(1000, 1, 1);
    expect(pad.stopRumble()).toBe(true);
    expect(browser.resets).toBe(1);
  });
});

/*
 * An actuator that carries no `reset` is served by a zero-magnitude effect, which preempts whatever
 * is playing. Answering false there would grey out a control the hardware can honour.
 */
test('an actuator without reset is stopped by a zero effect', () => {
  withBrowser((browser) => {
    const input = new InputSource(browser.target, [], { autoPoll: false });
    browser.rumbleSupport(true, { reset: false });
    const pad = connectedPad(browser, input);

    expect(pad.stopRumble()).toBe(true);
    expect(browser.resets).toBe(0);
    expect(browser.effects.length).toBe(1);
    expect(browser.effects[0]?.params.strongMagnitude).toBe(0);
    expect(browser.effects[0]?.params.weakMagnitude).toBe(0);
    expect(browser.effects[0]?.params.duration).toBe(0);
  });
});

/**
 * **A rejected effect must not reach the console as an unhandled rejection, and must not be
 * silent either.**
 *
 * `playEffect` rejects when the pad goes away mid-effect, which is a thing a player does. An
 * unhandled rejection prints a stack trace nobody can act on; silence leaves a player whose pad
 * stopped rumbling with nothing to read. Once per pad, the shape `refuseIfUnvouched` established.
 */
test('an effect that fails warns once per pad rather than throwing', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const browser = fakeBrowser();
    try {
      const input = new InputSource(browser.target, [], { autoPoll: false });
      browser.rumbleSupport(true, { fail: true });
      const pad = connectedPad(browser, input);

      expect(pad.rumble(100, 1, 1)).toBe(true);
      expect(pad.rumble(100, 1, 1)).toBe(true);
      await Promise.resolve();
      await Promise.resolve();
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      browser.restore();
    }
  } finally {
    warn.mockRestore();
  }
});

/*
 * The actuator is re-read at every poll rather than kept from the first one. A `Gamepad` is a fresh
 * snapshot each `getGamepads` call, and a pad unplugged and plugged back in is a different device
 * behind the same slot — holding the first actuator would drive hardware that is no longer there.
 */
test('the actuator follows the pad across a reconnect', () => {
  withBrowser((browser) => {
    const input = new InputSource(browser.target, [], { autoPoll: false });
    const pad = connectedPad(browser, input);
    expect(pad.canRumble).toBe(true);

    browser.rumbleSupport(false);
    input.poll();
    expect(pad.canRumble).toBe(false);
    expect(pad.rumble(100, 1, 1)).toBe(false);
  });
});
