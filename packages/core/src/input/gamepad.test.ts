import { expect, test, vi } from 'vitest';

import { InputSource } from './input.ts';
import { fakeBrowser } from './inputHarness.ts';

/** Every test drives the poll by hand, so a frame is a statement rather than a wait. */
function withBrowser(run: (browser: ReturnType<typeof fakeBrowser>) => void, id?: string): void {
  const browser = fakeBrowser(id);
  try {
    run(browser);
  } finally {
    browser.restore();
  }
}

/**
 * A pad is invisible until the player uses it, and that is the browser's rule rather than ours.
 *
 * Reporting a connected gamepad before a button has been pressed is a fingerprinting surface, so
 * no browser does it. It happens to be the rule this design wanted anyway: an untouched pad must
 * not be taking the prompts from a player on the keyboard.
 */
test('there is no pad until one is used', () => {
  withBrowser((browser) => {
    const input = new InputSource(browser.target, [], { autoPoll: false });
    input.poll();
    expect(input.pads.length).toBe(0);
    expect(input.pad(0)).toBe(null);

    browser.connect();
    input.poll();
    expect(input.pads.length).toBe(1);
    expect(input.pad(0)?.index).toBe(0);
  });
});

test('a held button reads as down for as long as it is held', () => {
  withBrowser((browser) => {
    const input = new InputSource(browser.target, [], { autoPoll: false });
    browser.connect();
    browser.press('faceDown');
    input.poll();
    expect(input.pad(0)?.down('faceDown')).toBe(true);

    input.poll();
    expect(input.pad(0)?.down('faceDown'), 'still held a frame later').toBe(true);

    browser.release('faceDown');
    input.poll();
    expect(input.pad(0)?.down('faceDown')).toBe(false);
  });
});

/**
 * The edge is latched at the poll, not derived at read.
 *
 * Two readers in one frame must both see the press — a menu and a heads-up display have no
 * business consuming each other's input — and the frame after must not, however long the button
 * stays down.
 */
test('a press is one frame, whoever reads it', () => {
  withBrowser((browser) => {
    const input = new InputSource(browser.target, [], { autoPoll: false });
    browser.connect();
    browser.press('faceDown');
    input.poll();

    const pad = input.pad(0);
    expect(pad?.pressed('faceDown'), 'a menu sees it').toBe(true);
    expect(pad?.pressed('faceDown'), 'and so does a heads-up display').toBe(true);

    input.poll();
    expect(pad?.pressed('faceDown'), 'and the next frame does not').toBe(false);
    expect(pad?.down('faceDown'), 'though it is still held').toBe(true);
  });
});

/**
 * A claimed edge is gone for everybody, which is what makes it worth having beside `pressed`.
 *
 * The hazard is a slow frame: the fixed-step loop runs more than once, and a `pressed` that stayed
 * true across both ticks is a double jump from a single press.
 */
test('a consumed press is taken, not shared', () => {
  withBrowser((browser) => {
    const input = new InputSource(browser.target, [], { autoPoll: false });
    browser.connect();
    browser.press('start');
    input.poll();

    const pad = input.pad(0);
    expect(pad?.consumePress('start'), 'the first tick claims it').toBe(true);
    expect(pad?.consumePress('start'), 'the second finds it gone').toBe(false);
    expect(pad?.pressed('start'), 'and so does anything else asking').toBe(false);
  });
});

test('a stick inside the deadzone is not moving', () => {
  withBrowser((browser) => {
    const input = new InputSource(browser.target, [], { autoPoll: false, deadzone: 0.25 });
    browser.connect();
    browser.axis('leftX', 0.1);
    input.poll();
    expect(input.pad(0)?.axis('leftX')).toBe(0);

    browser.axis('leftX', 1);
    input.poll();
    expect(input.pad(0)?.axis('leftX')).toBeCloseTo(1, 10);
  });
});

/** What a consumer redrawing its prompts listens to. */
test('using a pad flips the hint, once', () => {
  withBrowser((browser) => {
    const input = new InputSource(browser.target, [], { autoPoll: false });
    const heard = vi.fn();
    input.onDeviceChange(heard);

    expect(input.lastDevice).toBe('keyboard');
    browser.connect();
    browser.press('faceDown');
    input.poll();
    input.poll();

    expect(input.lastDevice).toBe('gamepad');
    expect(heard, 'a held button is not a second decision').toHaveBeenCalledTimes(1);
    expect(heard).toHaveBeenCalledWith('gamepad');
  });
});

/**
 * The allocation rule, asserted where it is actually paid.
 *
 * `getGamepads()` hands back a fresh array and fresh button objects on every call. That cost is
 * the browser's and cannot be pooled, so the only lever is calling it once a frame — which means
 * a read must be a lookup on numbers already copied out, never a fresh snapshot.
 */
test('the browser is asked for pads once a frame, however much is read', () => {
  withBrowser((browser) => {
    const input = new InputSource(browser.target, [], { autoPoll: false });
    browser.connect();
    input.poll();

    browser.calls.getGamepads = 0;
    const pad = input.pad(0);
    pad?.down('faceDown');
    pad?.down('faceUp');
    pad?.pressed('start');
    pad?.axis('leftX');
    pad?.axis('rightY');

    expect(browser.calls.getGamepads, 'five reads, no snapshots').toBe(0);

    input.poll();
    expect(browser.calls.getGamepads, 'and one for the frame').toBe(1);
  });
});

/**
 * A pad the browser will not vouch for is served, not refused — and it says so once.
 *
 * Silence would leave a player whose arcade stick does nothing with no way to discover why, which
 * is the silent no-op this repository's rules forbid. A line every frame would flood a console
 * somebody needs to read. Once per device is what `registerCompute` already settled on.
 */
test('a non-standard pad is served by index, and refused in words exactly once', () => {
  withBrowser((browser) => {
    const said = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const input = new InputSource(browser.target, [], { autoPoll: false });
    browser.connect('Some Arcade Stick', '');
    browser.press('faceDown');
    input.poll();
    input.poll();
    input.poll();

    const pad = input.pad(0);
    expect(pad?.mapping).toBe('unknown');
    expect(pad?.identity.family).toBe('generic');
    expect(pad?.button(0), 'reachable by index, which is all that can be trusted').toBe(true);

    expect(said, 'once per device, not once per frame').toHaveBeenCalledTimes(1);
    expect(String(said.mock.calls[0]?.[0])).toContain('Some Arcade Stick');
    said.mockRestore();
  });
}, 10000);

test('a disabled gamepad source is inert, and never asks the browser', () => {
  withBrowser((browser) => {
    const input = new InputSource(browser.target, [], {
      autoPoll: false,
      sources: { gamepad: false },
    });
    browser.connect();
    browser.press('faceDown');
    browser.calls.getGamepads = 0;
    input.poll();

    expect(input.pads.length).toBe(0);
    expect(browser.calls.getGamepads, 'a disabled source costs nothing at all').toBe(0);
    expect(input.lastDevice, 'and cannot take the prompts').toBe('keyboard');
  });
});

/**
 * **A pad press waits to be claimed, exactly as a key press does.**
 *
 * `poll` runs on an animation frame and a fixed-step consumer does not: at 120 Hz against a 60 Hz
 * simulation about half the display frames run no tick at all, and an edge that lived only until
 * the next poll was rotated away before anything could claim it. The keyboard was given a
 * claim-scoped edge for exactly this; the pad kept the frame-scoped one, so a controller's jump
 * went missing on the same displays and in the same proportion — with the added cruelty that
 * pressing two buttons together makes the frame busier and the miss likelier.
 *
 * The *readable* edge stays frame-scoped, because `pressed` is what a UI draws with and a
 * highlight that outlived its frame would be wrong.
 */
test('a pad press waits to be claimed across frames that claim nothing', () => {
  withBrowser((browser) => {
    const input = new InputSource(browser.target, [], { autoPoll: false });
    browser.connect();
    browser.press('faceDown');
    input.poll();

    /* Three display frames in which the simulation did not run. */
    input.poll();
    input.poll();
    input.poll();

    const pad = input.pad(0);
    expect(pad?.pressed('faceDown'), 'the readable edge is still one frame').toBe(false);
    expect(pad?.consumePress('faceDown'), 'and the claim is still there to take').toBe(true);
    expect(pad?.consumePress('faceDown'), 'once').toBe(false);
  });
});

test('a pad press nobody claimed goes stale when the button comes back up', () => {
  withBrowser((browser) => {
    const input = new InputSource(browser.target, [], { autoPoll: false });
    browser.connect();
    browser.press('faceDown');
    input.poll();
    browser.release('faceDown');
    input.poll();

    expect(input.pad(0)?.consumePress('faceDown'), 'the button is up and the press is spent').toBe(
      false,
    );
  });
});

test('two buttons pressed in the same frame are two independent claims', () => {
  /*
   * Reported on a controller: pressing two face buttons at the same instant produced no jump.
   * Two buttons in one frame is two edges, and claiming one must never spend the other.
   */
  withBrowser((browser) => {
    const input = new InputSource(browser.target, [], { autoPoll: false });
    browser.connect();
    browser.press('faceRight');
    browser.press('faceDown');
    input.poll();
    input.poll();

    const pad = input.pad(0);
    expect(pad?.down('faceRight'), 'B is held').toBe(true);
    expect(pad?.consumePress('faceDown'), 'and A still jumps').toBe(true);
  });
});
