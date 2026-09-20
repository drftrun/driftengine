/**
 * A joystick SDL has no controller mapping for — a flight stick, a wheel, an arcade panel, a pad
 * too new or too rare — as Chrome shows a page one it cannot map: `mapping` empty, the device's own
 * axes and buttons in the device's own order, and a name without "STANDARD GAMEPAD".
 *
 * **A hat is two axes**, as a browser on Linux reads one: the device reports it as a pair of
 * absolute axes that are −1, 0 or 1, and SDL folds the pair into a direction, which is unfolded
 * here — left and up negative. They follow the joystick's own axes, which is where their codes put
 * them on a typical device.
 *
 * What it gives up: a device whose other axes sort after its hat in the kernel's numbering has
 * them in a different order than Chrome gives; nothing here has been checked against a device, as
 * there was none to hand.
 */

import { type DualRumble, dualRumble, type Rumbler } from './dualRumble.ts';
import { type HostButton, hex } from './standardPad.ts';

export interface JoystickDevice {
  readonly id: number;
  readonly name: string | null;
  readonly vendor: number | null;
  readonly product: number | null;
}

/** What this reads and drives of one of SDL's open joysticks. */
export interface JoystickInstance extends Rumbler {
  readonly device: JoystickDevice;
  readonly axes: readonly number[];
  readonly hats: readonly string[];
  readonly buttons: readonly boolean[];
  readonly hasRumble: boolean;
  close(): void;
}

/** A hat's direction as the two axes it came from: x, then y, left and up negative. */
const HAT: Readonly<Record<string, readonly [number, number]>> = {
  centered: [0, 0],
  up: [0, -1],
  down: [0, 1],
  left: [-1, 0],
  right: [1, 0],
  leftup: [-1, -1],
  rightup: [1, -1],
  leftdown: [-1, 1],
  rightdown: [1, 1],
};

export class RawPad {
  readonly id: string;
  readonly mapping = '';
  connected = true;
  timestamp = 0;
  readonly buttons: HostButton[];
  readonly axes: number[];
  readonly vibrationActuator: DualRumble | null;

  constructor(
    readonly index: number,
    readonly source: JoystickInstance,
  ) {
    const { name, vendor, product } = source.device;
    this.id = `${name ?? 'Joystick'} (Vendor: ${hex(vendor)} Product: ${hex(product)})`;
    this.buttons = source.buttons.map(() => ({ pressed: false, touched: false, value: 0 }));
    this.axes = Array.from({ length: source.axes.length + source.hats.length * 2 }, () => 0);
    this.vibrationActuator = source.hasRumble ? dualRumble(source) : null;
  }

  read(now: number): void {
    const { axes, hats, buttons } = this.source;
    for (let at = 0; at < axes.length; at += 1) this.axes[at] = axes[at] as number;
    for (let at = 0; at < hats.length; at += 1) {
      const [x, y] = HAT[hats[at] as string] ?? [0, 0];
      this.axes[axes.length + at * 2] = x;
      this.axes[axes.length + at * 2 + 1] = y;
    }
    for (let at = 0; at < buttons.length; at += 1) {
      const button = this.buttons[at] as HostButton;
      button.pressed = buttons[at] === true;
      button.touched = button.pressed;
      button.value = button.pressed ? 1 : 0;
    }
    this.timestamp = now;
  }
}
