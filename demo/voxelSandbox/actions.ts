/**
 * Every binding this demo has, in one table.
 *
 * A demo that scattered `KeyW` through its movement code would be a demo nobody could rebind, and
 * one that reads as if the engine had no input layer. `ActionMap` keeps the defaults, the current
 * bindings, and the save and load; this is only the names and what they start as.
 *
 * **Movement is one analog action rather than four digital ones.** That is what `AnalogAction` is
 * for: it carries a magnitude, so a gamepad stick works without a line of code here, and a
 * half-pushed stick walks at half speed instead of at nothing or at full.
 */
import type { ActionDefinition } from '../../packages/core/src/index';

/**
 * Note the vertical convention: **up is negative**, which is the stick's and the specification's.
 * `move`'s `y` is therefore negative when walking forward, and `playerInput.ts` negates it once.
 */
export const VOXEL_ACTIONS: Readonly<Record<string, ActionDefinition>> = {
  move: {
    stick: 'left',
    up: ['KeyW', 'ArrowUp'],
    down: ['KeyS', 'ArrowDown'],
    left: ['KeyA', 'ArrowLeft'],
    right: ['KeyD', 'ArrowRight'],
  },
  jump: { keys: ['Space'], buttons: ['faceDown'] },
  sprint: { keys: ['ShiftLeft', 'ShiftRight'], buttons: ['l1'] },
  toggleFly: { keys: ['KeyF'], buttons: ['faceUp'] },
  break: { keys: ['KeyE'], buttons: ['r1'] },
  place: { keys: ['KeyQ'], buttons: ['faceLeft'] },
  slotNext: { keys: ['Tab'], buttons: ['r2'] },
  slotPrev: { keys: ['Backquote'], buttons: ['l2'] },
  /* Save and load are bindings like any other, rather than raw key listeners bolted on. */
  toggleDebug: { keys: ['F3'] },
  /*
   * **The reference's `Ctrl+S` and `Ctrl+O`, and the modifier is not part of the binding.**
   * `ActionDefinition` carries `keys`, `stick` and `buttons` and has no notion of a chord, so
   * the plain key is bound here and `voxelSandbox.ts` asks `input.isDown('ControlLeft')` before
   * acting on the press. `KeyS` is `move.down` as well, which is true of the reference too: S
   * walks backwards and Ctrl+S saves.
   */
  save: { keys: ['KeyS'] },
  load: { keys: ['KeyO'] },
} as const;

/** Slot keys are positional rather than named actions: nine of them would be nine bindings. */
export const SLOT_CODES: readonly string[] = [
  'Digit1',
  'Digit2',
  'Digit3',
  'Digit4',
  'Digit5',
  'Digit6',
  'Digit7',
  'Digit8',
  'Digit9',
  'Digit0',
];
