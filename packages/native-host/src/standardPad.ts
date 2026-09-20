/**
 * A controller SDL knows, as the W3C's standard gamepad: SDL's game-controller layer reports a
 * controller's buttons and axes by name, in the layout the standard describes by index, so each
 * crosses by name into its index. `a` is button 0, the left stick is axes 0 and 1 with down
 * positive, a trigger is an axis SDL reports from 0 to 1 and a button the standard reports as
 * pressed past Chrome's threshold. A pad is named the way Chrome names one on Linux,
 * `… (STANDARD GAMEPAD Vendor: 045e Product: 0b12)`, which is where the engine reads what kind of
 * pad it is.
 *
 * What it gives up: trigger rumble, which the engine does not reach; and `touched`, which reads as
 * `pressed` because SDL reports no touch.
 */

import { type DualRumble, dualRumble, type Rumbler } from './dualRumble.ts';

type SdlButton =
  | 'a'
  | 'b'
  | 'x'
  | 'y'
  | 'leftShoulder'
  | 'rightShoulder'
  | 'back'
  | 'start'
  | 'leftStick'
  | 'rightStick'
  | 'dpadUp'
  | 'dpadDown'
  | 'dpadLeft'
  | 'dpadRight'
  | 'guide';

type SdlAxis =
  'leftStickX' | 'leftStickY' | 'rightStickX' | 'rightStickY' | 'leftTrigger' | 'rightTrigger';

export interface PadDevice {
  readonly id: number;
  readonly name: string;
  readonly vendor: number | null;
  readonly product: number | null;
}

/** What this reads and drives of one of SDL's open controllers. */
export interface PadController extends Rumbler {
  readonly device: PadDevice;
  readonly axes: Readonly<Record<SdlAxis, number>>;
  readonly buttons: Readonly<Record<string, boolean>>;
  readonly hasRumble: boolean;
  close(): void;
}

/** The standard's buttons in its order, with the two triggers standing in at 6 and 7. */
const STANDARD: readonly (SdlButton | 'leftTrigger' | 'rightTrigger')[] = [
  'a',
  'b',
  'x',
  'y',
  'leftShoulder',
  'rightShoulder',
  'leftTrigger',
  'rightTrigger',
  'back',
  'start',
  'leftStick',
  'rightStick',
  'dpadUp',
  'dpadDown',
  'dpadLeft',
  'dpadRight',
  'guide',
];
const AXES: readonly SdlAxis[] = ['leftStickX', 'leftStickY', 'rightStickX', 'rightStickY'];
/** Chrome's line for an analogue button, 30 of 255 (`kDefaultButtonPressedThreshold`). */
const PRESSED_PAST = 30 / 255;

export const hex = (value: number | null) => (value ?? 0).toString(16).padStart(4, '0');

export interface HostButton {
  pressed: boolean;
  touched: boolean;
  value: number;
}

/** One controller in a slot, its state rewritten in place at every read. */
export class StandardPad {
  readonly id: string;
  readonly mapping = 'standard';
  connected = true;
  timestamp = 0;
  readonly buttons: HostButton[] = STANDARD.map(() => ({
    pressed: false,
    touched: false,
    value: 0,
  }));
  readonly axes = [0, 0, 0, 0];
  readonly vibrationActuator: DualRumble | null;

  constructor(
    readonly index: number,
    readonly source: PadController,
  ) {
    const { name, vendor, product } = source.device;
    this.id = `${name} (STANDARD GAMEPAD Vendor: ${hex(vendor)} Product: ${hex(product)})`;
    this.vibrationActuator = source.hasRumble ? dualRumble(source) : null;
  }

  read(now: number): void {
    const { axes, buttons } = this.source;
    for (let at = 0; at < STANDARD.length; at += 1) {
      const name = STANDARD[at] as SdlButton | 'leftTrigger' | 'rightTrigger';
      const button = this.buttons[at] as HostButton;
      if (name === 'leftTrigger' || name === 'rightTrigger') {
        button.value = axes[name];
        button.pressed = button.value > PRESSED_PAST;
      } else {
        button.pressed = buttons[name] === true;
        button.value = button.pressed ? 1 : 0;
      }
      button.touched = button.pressed;
    }
    for (let at = 0; at < AXES.length; at += 1) {
      this.axes[at] = axes[AXES[at] as SdlAxis];
    }
    this.timestamp = now;
  }
}
