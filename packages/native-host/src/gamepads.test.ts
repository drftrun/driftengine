import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, test } from 'vitest';

import { InputSource } from '@driftengine/core';
import { NativeCanvas } from './canvas.ts';
import { HostGamepads } from './gamepads.ts';
import type { JoystickDevice, JoystickInstance, PadController, PadDevice } from './gamepads.ts';
import { HostPage } from './page.ts';

/**
 * **What this file is for: a controller reaching the engine through the path it already polls.**
 * The engine reads pads from `navigator.getGamepads()` in the W3C's standard layout and drives their
 * motors through `vibrationActuator`. SDL's game-controller API reports the same layout by name, so
 * a controller crosses into the standard's indices, and the engine is not told it is not a browser.
 * Rumble is the first thing this host does that a browser does not reliably: Chrome drives the
 * motors of some pads on some platforms, and SDL drives every pad it knows.
 */

const BUTTONS = [
  'dpadLeft',
  'dpadRight',
  'dpadUp',
  'dpadDown',
  'a',
  'b',
  'x',
  'y',
  'guide',
  'back',
  'start',
  'leftStick',
  'rightStick',
  'leftShoulder',
  'rightShoulder',
] as const;

function controller(device: PadDevice, hasRumble = true) {
  const rumbles: number[][] = [];
  const pad = {
    device,
    axes: {
      leftStickX: 0,
      leftStickY: 0,
      rightStickX: 0,
      rightStickY: 0,
      leftTrigger: 0,
      rightTrigger: 0,
    },
    buttons: Object.fromEntries(BUTTONS.map((name) => [name, false])) as Record<string, boolean>,
    hasRumble,
    closed: false,
    rumble: (low: number, high: number, duration: number) => rumbles.push([low, high, duration]),
    stopRumble: () => rumbles.push([0, 0, 0]),
    close() {
      pad.closed = true;
    },
  };
  return { pad, rumbles };
}

const XBOX: PadDevice = {
  id: 7,
  /* No brand in the name, so what kind of pad it is can only come from the vendor. */
  name: 'Wireless Controller',
  vendor: 0x045e,
  product: 0x0b12,
};

/** A joystick SDL has no controller mapping for: axes, a hat, buttons, by index. */
function joystick(device: JoystickDevice) {
  return {
    device,
    axes: [0, 0, 0],
    hats: ['centered'],
    buttons: [false, false, false, false],
    hasRumble: false,
    rumble: () => undefined,
    stopRumble: () => undefined,
    close: () => undefined,
  };
}

function setUp(
  devices: PadDevice[],
  opened: Map<number, ReturnType<typeof controller>>,
  sticks: JoystickDevice[] = [],
) {
  const module = Object.assign(new EventEmitter(), {
    devices,
    openDevice: (device: PadDevice) => {
      const made = controller(device, device.id !== 99);
      opened.set(device.id, made);
      return made.pad as unknown as PadController;
    },
  });
  const openedSticks = new Map<number, ReturnType<typeof joystick>>();
  const joysticks = Object.assign(new EventEmitter(), {
    /* SDL lists every controller among its joysticks too, by the same id. */
    devices: [...devices, ...sticks],
    openDevice: (device: JoystickDevice) => {
      const made = joystick(device);
      openedSticks.set(device.id, made);
      return made as unknown as JoystickInstance;
    },
  });
  const page = new HostPage();
  undo.push(page.install());
  const pads = new HostGamepads(module, { joysticks, events: page.window });
  undo.push(pads.install());
  const input = new InputSource(new NativeCanvas(4, 4) as unknown as HTMLElement, [], {
    autoPoll: false,
  });
  undo.push(() => input.dispose());
  /* A person using a pad, which is what shows a page its pads (see the gesture tests). */
  const use = (id = 7) => {
    const sdl = opened.get(id)?.pad;
    if (sdl === undefined) throw new Error('not opened');
    sdl.buttons['a'] = true;
    pads.getGamepads();
    sdl.buttons['a'] = false;
  };
  return { module, joysticks, openedSticks, pads, input, page, use };
}

let undo: (() => void)[] = [];
afterEach(() => {
  for (const step of undo.reverse()) step();
  undo = [];
});

describe('a controller, as the engine reads a gamepad', () => {
  test('A CONTROLLER IS A STANDARD GAMEPAD, named as Chrome names it', () => {
    const opened = new Map<number, ReturnType<typeof controller>>();
    const { input } = setUp([XBOX], opened);
    const sdl = opened.get(7)?.pad;
    if (sdl === undefined) throw new Error('not opened');
    sdl.buttons['a'] = true;
    sdl.buttons['dpadLeft'] = true;
    sdl.axes.leftStickX = 0.5;
    sdl.axes.rightStickY = -1;
    input.poll();
    const pad = input.pad(0);
    expect(pad?.mapping).toBe('standard');
    /* Chrome's form, which is what the engine reads a vendor out of: 045e is Microsoft. */
    expect(pad?.identity.family).toBe('xbox');
    expect(pad?.down('faceDown')).toBe(true);
    expect(pad?.down('dpadLeft')).toBe(true);
    expect(pad?.down('faceRight')).toBe(false);
    expect(pad?.rawAxis(0)).toBe(0.5);
    expect(pad?.rawAxis(3)).toBe(-1);
  });

  test('A TRIGGER IS A BUTTON PAST CHROME’S THRESHOLD, 30 of 255', () => {
    const opened = new Map<number, ReturnType<typeof controller>>();
    const { input } = setUp([XBOX], opened);
    const sdl = opened.get(7)?.pad;
    if (sdl === undefined) throw new Error('not opened');
    sdl.axes.leftTrigger = 0.11;
    sdl.axes.rightTrigger = 0.12;
    input.poll();
    const pad = input.pad(0);
    expect(pad?.down('l2')).toBe(false);
    expect(pad?.down('r2')).toBe(true);
  });

  test('RUMBLE REACHES THE MOTORS: the strong one is the low-frequency one', () => {
    const opened = new Map<number, ReturnType<typeof controller>>();
    const { input, use } = setUp([XBOX, { ...XBOX, id: 99, name: 'No Motors' }], opened);
    use();
    input.poll();
    const pad = input.pad(0);
    expect(pad?.canRumble).toBe(true);
    expect(pad?.rumble(200, 1, 0.25)).toBe(true);
    expect(opened.get(7)?.rumbles).toEqual([[1, 0.25, 200]]);
    expect(pad?.stopRumble()).toBe(true);
    expect(opened.get(7)?.rumbles.at(-1)).toEqual([0, 0, 0]);
    /* A pad with no motors says so, which is what greys a setting out. */
    expect(input.pad(1)?.canRumble).toBe(false);
  });

  test('A CONTROLLER PLUGGED IN LATER TAKES THE FIRST FREE SLOT, and one pulled out leaves its slot', () => {
    const opened = new Map<number, ReturnType<typeof controller>>();
    const { module, pads, use } = setUp([XBOX], opened);
    use();
    const later: PadDevice = { id: 8, name: 'Pro Controller', vendor: 0x057e, product: 0x2009 };
    module.emit('deviceAdd', { device: later });
    expect(pads.getGamepads().map((pad) => pad?.index ?? null)).toEqual([0, 1, null, null]);
    module.emit('deviceRemove', { device: XBOX });
    const slots = pads.getGamepads();
    expect(slots[0]).toBeNull();
    expect(slots[1]?.id).toContain('Vendor: 057e Product: 2009');
    expect(opened.get(7)?.pad.closed).toBe(true);
  });
});

describe('what Chrome shows a page of its pads', () => {
  /*
   * **Chromium's rule, from its source, not measured here**: this machine has no pad and the
   * DevTools protocol has no way to fake one. `device/gamepad/gamepad_user_gesture.cc` shows a page
   * no pad until one has a button pressed or an axis past 0.5, and then shows it every pad, each
   * announced with `gamepadconnected`.
   */
  test('A PAD IS HIDDEN UNTIL A PERSON USES ONE, and then every pad is announced', () => {
    const opened = new Map<number, ReturnType<typeof controller>>();
    const second: PadDevice = { id: 8, name: 'Pro Controller', vendor: 0x057e, product: 0x2009 };
    const { page, pads, input } = setUp([XBOX, second], opened);
    const announced: number[] = [];
    page.window.addEventListener('gamepadconnected', (event) =>
      announced.push((event as unknown as { gamepad: Gamepad }).gamepad.index),
    );
    input.poll();
    expect([pads.getGamepads(), input.pad(0)]).toEqual([[null, null, null, null], null]);
    const sdl = opened.get(8)?.pad;
    if (sdl === undefined) throw new Error('not opened');
    sdl.buttons['b'] = true;
    input.poll();
    expect([input.pad(0)?.mapping, announced]).toEqual(['standard', [0, 1]]);
  });

  test('AN AXIS PAST HALFWAY IS A PERSON; ONE NUDGED LESS IS NOT', () => {
    const opened = new Map<number, ReturnType<typeof controller>>();
    const { pads } = setUp([XBOX], opened);
    const sdl = opened.get(7)?.pad;
    if (sdl === undefined) throw new Error('not opened');
    sdl.axes.leftStickX = 0.4;
    const nudged = pads.getGamepads()[0];
    sdl.axes.leftStickX = -0.6;
    expect([nudged, pads.getGamepads()[0]?.axes[0]]).toEqual([null, -0.6]);
  });

  test('A PAD ARRIVING OR LEAVING AFTER THAT IS TOLD TO THE WINDOW', () => {
    const opened = new Map<number, ReturnType<typeof controller>>();
    const { module, page, use } = setUp([XBOX], opened);
    use();
    const told: string[] = [];
    for (const type of ['gamepadconnected', 'gamepaddisconnected']) {
      page.window.addEventListener(type, (event) => {
        const pad = (event as unknown as { gamepad: Gamepad }).gamepad;
        told.push(`${type} ${pad.index} ${String(pad.connected)}`);
      });
    }
    const later: PadDevice = { id: 8, name: 'Pro Controller', vendor: 0x057e, product: 0x2009 };
    module.emit('deviceAdd', { device: later });
    module.emit('deviceRemove', { device: XBOX });
    expect(told).toEqual(['gamepadconnected 1 true', 'gamepaddisconnected 0 false']);
  });

  test('A JOYSTICK SDL CANNOT MAP IS A PAD WITH NO MAPPING: its axes, its hat as two more, its buttons', () => {
    const opened = new Map<number, ReturnType<typeof controller>>();
    const stick: JoystickDevice = {
      id: 30,
      name: 'Flight Stick',
      vendor: 0x044f,
      product: 0xb10a,
    };
    const { openedSticks, pads, input, use } = setUp([XBOX], opened, [stick]);
    use();
    const sdl = openedSticks.get(30);
    if (sdl === undefined) throw new Error('not opened');
    sdl.axes[0] = 0.25;
    sdl.hats[0] = 'leftup';
    sdl.buttons[2] = true;
    const raw = pads.getGamepads()[1];
    /* Chrome's name for a pad it has no mapping for, which leaves "STANDARD GAMEPAD" out. */
    expect([raw?.id, raw?.mapping, raw?.axes, raw?.buttons.map((b) => b.pressed)]).toEqual([
      'Flight Stick (Vendor: 044f Product: b10a)',
      '',
      [0.25, 0, 0, -1, -1],
      [false, false, true, false],
    ]);
    /* The controller is not listed twice for being among SDL's joysticks too. */
    expect(pads.getGamepads().filter((pad) => pad !== null).length).toBe(2);
    input.poll();
    expect(input.pad(1)?.mapping).toBe('unknown');
  });
});

/**
 * **Closing a device SDL has already taken away must not take the process with it.**
 *
 * SDL lists every controller among its joysticks too, so a pad appears first as a bare joystick and
 * again as a controller once SDL has a mapping for it. Promoting it closes the joystick handle —
 * and SDL has already invalidated that handle, so its own `close` throws
 * `Cannot read properties of undefined (reading 'delete')` from inside
 * `joystick-instance.js`. That threw out of the poll callback and **killed the process**: a
 * maintainer turned a pad on and the scene died.
 *
 * Reported 2026-09-20 against `@kmamal/sdl` 0.11.13 on Linux, with a Keychron keyboard enumerating
 * as a pad beside a real one. `AGENTS.md`: after boot, the frame loop never throws.
 */
test('A HANDLE SDL HAS ALREADY CLOSED DOES NOT TAKE DOWN THE POLL LOOP', () => {
  const opened = new Map<number, ReturnType<typeof controller>>();
  const stick: JoystickDevice = {
    id: 7,
    name: 'Wireless Controller',
    vendor: 0x045e,
    product: 0x0b12,
  };
  const { module, joysticks, openedSticks, input, use } = setUp([], opened, [stick]);

  /* Listed as a bare joystick first, which is what SDL does before it has a mapping. */
  joysticks.emit('deviceAdd', { device: stick });
  const made = openedSticks.get(7);
  expect(made).toBeDefined();
  if (made === undefined) return;
  /* SDL's own object, already invalidated by the time the promotion closes it. */
  made.close = () => {
    throw new TypeError("Cannot read properties of undefined (reading 'delete')");
  };

  expect(() => module.emit('deviceAdd', { device: XBOX })).not.toThrow();

  /* And the promotion still happened: the pad is a standard one now, not a raw joystick.
     A pad is hidden until somebody uses one, which is what `use` is. */
  use(7);
  input.poll();
  const pads = navigator.getGamepads().filter((one) => one !== null);
  expect(pads.length).toBe(1);
  expect(pads[0]?.mapping).toBe('standard');
});

/**
 * **A device with no stick and no hat is not a gamepad, whatever SDL lists it among.**
 *
 * A keyboard exposes a second HID endpoint for its power and media keys, and SDL enumerates that
 * among the joysticks: a maintainer's Keychron arrived as
 * *"Keychron K8 Pro System Control (Vendor: 3434 Product: 0280)"*, took the first pad slot, and the
 * engine warned that it could not vouch for its layout — while the real controller sat behind it.
 * Chrome does not offer a keyboard as a gamepad and neither should this.
 *
 * **The rule is what a pad can be steered with**, not a name or a vendor: no axes and no hats means
 * nothing a game can read as a direction. A fight stick with only buttons still has a hat, which is
 * why the rule is both and not either.
 */
test('A HID ENDPOINT WITH NO AXES AND NO HAT IS NOT OFFERED AS A PAD', () => {
  const opened = new Map<number, ReturnType<typeof controller>>();
  const keyboard: JoystickDevice = {
    id: 11,
    name: 'Keychron K8 Pro System Control',
    vendor: 0x3434,
    product: 0x0280,
  };
  /*
   * The joystick module answers this device with nothing to steer by. A real pad is beside it, so
   * the gesture that shows a page its pads can still be made.
   */
  const { joysticks, pads, use } = setUp([XBOX], opened);
  const bare = joysticks.openDevice.bind(joysticks);
  joysticks.openDevice = (device: JoystickDevice): JoystickInstance => {
    const made = bare(device);
    const bare2 = made as unknown as { axes: number[]; hats: string[] };
    if (device.id === 11) {
      bare2.axes = [];
      bare2.hats = [];
    }
    return made;
  };
  joysticks.emit('deviceAdd', { device: keyboard });
  use();

  /* The controller is there; the keyboard's HID endpoint is not offered beside it. */
  const shown = pads.getGamepads().filter((one) => one !== null);
  expect(shown.length).toBe(1);
  expect(shown[0]?.id).toContain('Wireless Controller');
});
