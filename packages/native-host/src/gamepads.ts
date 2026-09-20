/**
 * Pads, as `navigator.getGamepads()` answers them and as Chrome shows them to a page.
 *
 * **The engine polls pads through the browser's API and is not changed for this host.** A
 * controller SDL knows is the W3C's standard gamepad (`standardPad.ts`); a joystick it has no
 * mapping for is a pad with none (`rawPad.ts`), which the engine reads as `mapping: 'unknown'` and
 * by index. Both share Chrome's four slots.
 *
 * **Chrome shows a page no pad until a person uses one, and neither does this.** Chromium's rule,
 * from its source (`device/gamepad/gamepad_user_gesture.cc`) and not measured, since the machine
 * this was written on has no pad and the DevTools protocol cannot fake one: a button pressed, or an
 * axis past 0.5, on any pad. Every pad is then shown and announced on the window with
 * `gamepadconnected`; one arriving later is announced as it arrives, and one leaving with
 * `gamepaddisconnected` and `connected` false. Before that a page sees four empty slots, which is
 * what a game saying "press any button" is waiting out.
 *
 * **Rumble is SDL's** (`dualRumble.ts`): the first thing this host does that a browser cannot be
 * relied on for.
 *
 * What it gives up: SDL is read when the page asks and every sixtieth of a second otherwise, rather
 * than on a thread of its own as Chrome reads it.
 */

import { GamepadEvent } from './eventClasses.ts';
import { type JoystickDevice, type JoystickInstance, RawPad } from './rawPad.ts';
import { type PadController, type PadDevice, StandardPad } from './standardPad.ts';

export type { JoystickDevice, JoystickInstance } from './rawPad.ts';
export type { PadController, PadDevice } from './standardPad.ts';

interface DeviceModule<Device, Opened> {
  readonly devices: readonly Device[];
  openDevice(device: Device): Opened;
  on(event: 'deviceAdd' | 'deviceRemove', listener: (event: { device: Device }) => void): unknown;
}
/** SDL's controller module, and its joystick module, as far as this reads them. */
export type PadModule = DeviceModule<PadDevice, PadController>;
export type JoystickModule = DeviceModule<JoystickDevice, JoystickInstance>;

export interface GamepadOptions {
  readonly joysticks?: JoystickModule;
  /** Where `gamepadconnected` and `gamepaddisconnected` are told: the page's window. */
  readonly events?: EventTarget;
  readonly now?: () => number;
}

type Pad = StandardPad | RawPad;
const SLOTS = 4;
/** Chromium's `kAxisMoveAmountThreshold`: an axis past this is a person, not drift. */
const AXIS_IS_A_PERSON = 0.5;
const POLL_MS = 1000 / 60;

export class HostGamepads {
  private readonly slots: (Pad | null)[] = Array.from({ length: SLOTS }, () => null);
  private readonly empty: null[] = Array.from({ length: SLOTS }, () => null);
  private shown = false;

  constructor(
    private readonly controllers: PadModule,
    private readonly options: GamepadOptions = {},
  ) {
    for (const device of controllers.devices) this.addController(device);
    controllers.on('deviceAdd', ({ device }) => this.addController(device));
    controllers.on('deviceRemove', ({ device }) => this.remove(device.id, StandardPad));
    const joysticks = options.joysticks;
    if (joysticks === undefined) return;
    for (const device of joysticks.devices) this.addJoystick(joysticks, device);
    joysticks.on('deviceAdd', ({ device }) => this.addJoystick(joysticks, device));
    joysticks.on('deviceRemove', ({ device }) => this.remove(device.id, RawPad));
  }

  /** The four slots, each pad read afresh — or four empty ones, until a person has used a pad. */
  readonly getGamepads = (): (Pad | null)[] => {
    this.poll();
    return this.shown ? this.slots : this.empty;
  };

  /** Read every pad, and show them all the first time one has been used. */
  poll(): void {
    const now = (this.options.now ?? (() => performance.now()))();
    for (const pad of this.slots) pad?.read(now);
    if (this.shown || !this.slots.some(used)) return;
    this.shown = true;
    for (const pad of this.slots) if (pad !== null) this.announce('gamepadconnected', pad);
  }

  /** Answer `navigator.getGamepads`, read pads while nothing asks, and hand back what stops both. */
  install(scope: { navigator?: object } = globalThis as { navigator?: object }): () => void {
    /* Node has a `navigator` of its own, behind a getter, so it is added to rather than replaced. */
    if (scope.navigator === undefined) {
      Object.defineProperty(scope, 'navigator', { value: {}, configurable: true });
    }
    const navigator = scope.navigator as object;
    const had = Object.getOwnPropertyDescriptor(navigator, 'getGamepads');
    Object.defineProperty(navigator, 'getGamepads', {
      value: this.getGamepads,
      configurable: true,
      writable: true,
    });
    const reading = setInterval(() => this.poll(), POLL_MS);
    reading.unref();
    return () => {
      clearInterval(reading);
      if (had === undefined) delete (navigator as Record<string, unknown>)['getGamepads'];
      else Object.defineProperty(navigator, 'getGamepads', had);
    };
  }

  private addController(device: PadDevice): void {
    if (this.slotOf(device.id, StandardPad) >= 0) return;
    /* Listed first as a bare joystick, it is a controller now that SDL has its mapping. */
    this.remove(device.id, RawPad, false);
    this.place((at) => new StandardPad(at, this.controllers.openDevice(device)));
  }

  private addJoystick(joysticks: JoystickModule, device: JoystickDevice): void {
    /* SDL lists every controller among its joysticks too; that one is shown as a controller. */
    if (this.controllers.devices.some((controller) => controller.id === device.id)) return;
    if (this.slotOf(device.id, RawPad) >= 0) return;
    const source = joysticks.openDevice(device);
    /*
     * **A device with nothing to steer by is not a gamepad, whatever SDL lists it among.**
     *
     * A keyboard exposes a second HID endpoint for its power and media keys, and SDL enumerates
     * that among the joysticks: a maintainer's arrived as *"Keychron K8 Pro System Control"*, took
     * the first pad slot, and the engine warned it could not vouch for the layout while the real
     * controller sat behind it. Chrome does not offer a keyboard as a gamepad.
     *
     * **The rule is what a pad can be steered with**, rather than a name or a vendor, which would
     * be a list to maintain forever. No axes *and* no hats is nothing a game can read as a
     * direction — a stick with only buttons still has a hat, which is why it is both and not
     * either. **What would make this wrong** is a pad whose axes SDL reports as absent until it is
     * first moved; none seen, and the tell would be a real controller that never appears.
     */
    if (source.axes.length === 0 && source.hats.length === 0) {
      source.close();
      return;
    }
    this.place((at) => new RawPad(at, source));
  }

  private place(make: (at: number) => Pad): void {
    const at = this.slots.indexOf(null);
    if (at < 0) return;
    const pad = make(at);
    this.slots[at] = pad;
    if (this.shown) this.announce('gamepadconnected', pad);
  }

  private remove(id: number, kind: typeof StandardPad | typeof RawPad, announce = true): void {
    const at = this.slotOf(id, kind);
    const pad = this.slots[at];
    if (pad === undefined || pad === null) return;
    /*
     * **A handle the platform has already taken away must not take the process with it.**
     *
     * SDL lists every controller among its joysticks too, so a pad arrives first as a bare
     * joystick and again as a controller once SDL has a mapping for it — and the promotion closes
     * the joystick handle that SDL has *already* invalidated. Its own `close` then throws
     * `Cannot read properties of undefined (reading 'delete')` from inside `joystick-instance.js`,
     * out of the poll callback, and the process ends: a maintainer turned a pad on and the scene
     * died (`@kmamal/sdl` 0.11.13, Linux, 2026-09-20).
     *
     * **What it gives up:** a close that fails for some *other* reason is swallowed too, and a
     * device handle may leak until the process ends. That is the right trade for a host — after
     * boot the frame loop never throws — and the slot is freed either way, which is the part the
     * engine can see.
     */
    try {
      pad.source.close();
    } catch {
      /* Already gone. The slot below is what matters. */
    }
    pad.connected = false;
    this.slots[at] = null;
    if (this.shown && announce) this.announce('gamepaddisconnected', pad);
  }

  private slotOf(id: number, kind: typeof StandardPad | typeof RawPad): number {
    return this.slots.findIndex((pad) => pad instanceof kind && pad.source.device.id === id);
  }

  private announce(type: string, pad: Pad): void {
    this.options.events?.dispatchEvent(new GamepadEvent(type, { gamepad: pad }));
  }
}

/** Whether a person is using `pad`: a button pressed, or an axis past drift. */
function used(pad: Pad | null): boolean {
  if (pad === null) return false;
  return (
    pad.buttons.some((button) => button.pressed) ||
    pad.axes.some((axis) => Math.abs(axis) > AXIS_IS_A_PERSON)
  );
}
