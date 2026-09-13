/**
 * The page for what a captured frame cannot show: a prompt changing device.
 *
 * **A dev page rather than a published scene, and that is the honest place for it.** The visual
 * gate photographs a held frame, and what has to be checked here is a *transition* — the line at
 * the top saying "keyboard" while you type and "controller" the moment you press a button, and
 * **not** flipping back when the mouse is nudged. No still frame can hold that.
 *
 * It draws no 3D at all, because nothing about this feature is rendering. `InputSource` needs an
 * element to listen on and this page gives it the body.
 */

import { ActionMap, type Binding } from '../../packages/core/src/input/actionMap';
import { InputSource } from '../../packages/core/src/input/input';
import { DEFAULT_DEADZONE, type GamepadButton } from '../../packages/core/src/input/gamepadMapping';

const POSITIONS: readonly GamepadButton[] = [
  'faceUp',
  'faceLeft',
  'faceRight',
  'faceDown',
  'l1',
  'r1',
  'l2',
  'r2',
  'select',
  'start',
  'l3',
  'r3',
  'dpadUp',
  'dpadDown',
  'dpadLeft',
  'dpadRight',
  'guide',
];

const hint = document.getElementById('hint') as HTMLElement;
const identity = document.getElementById('identity') as HTMLElement;
const grid = document.getElementById('grid') as HTMLElement;
const axesBox = document.getElementById('axes') as HTMLElement;

const input = new InputSource(document.body, [], { deadzone: DEFAULT_DEADZONE });

/**
 * The actions, and the rebinding control that is the other half of what cannot be captured.
 *
 * A still frame cannot show a prompt following a rebind any more than it can show one following a
 * device change, which is why both live on this page rather than in the gate.
 */
const actions = new ActionMap(input, {
  jump: { keys: ['Space'], buttons: ['faceDown'] },
  fire: { keys: ['KeyF'], buttons: ['r2'] },
  pause: { keys: ['Escape'], buttons: ['start'] },
  move: { stick: 'left', up: 'KeyW', down: 'KeyS', left: 'KeyA', right: 'KeyD' },
});
const DIGITAL = ['jump', 'fire', 'pause'] as const;
const actionsBox = document.getElementById('actions') as HTMLElement;
const rows = new Map<string, { root: HTMLElement; binds: HTMLElement }>();
/** The action waiting for the next input, or null. */
let capturing: string | null = null;

for (const name of DIGITAL) {
  const root = document.createElement('div');
  root.className = 'act';
  const label = document.createElement('span');
  label.textContent = name;
  const binds = document.createElement('span');
  binds.className = 'binds';
  root.append(label, binds);
  root.addEventListener('click', () => {
    capturing = capturing === name ? null : name;
  });
  actionsBox.append(root);
  rows.set(name, { root, binds });
}

/** How a binding reads on screen: a key by its code, a button by what this pad calls it. */
function describe(binding: Binding): string {
  if (binding.device === 'keyboard') return binding.code;
  const pad = input.pad(0);
  return pad === null ? binding.button : pad.identity.label(binding.button);
}

/** Take the first thing pressed and give it to the action waiting for one. */
function captureInto(name: string): boolean {
  const pad = input.pad(0);
  if (pad !== null) {
    for (const button of POSITIONS) {
      if (pad.consumePress(button)) {
        actions.rebind(name, { device: 'gamepad', button });
        return true;
      }
    }
  }
  for (const code of CAPTURABLE_KEYS) {
    if (input.consumeKeyPress(code)) {
      actions.rebind(name, { device: 'keyboard', code });
      return true;
    }
  }
  return false;
}

/** A short list, because this page captures rather than enumerating every key a board has. */
const CAPTURABLE_KEYS = [
  'Space',
  'Escape',
  'Enter',
  'KeyQ',
  'KeyE',
  'KeyF',
  'KeyR',
  'KeyJ',
  'KeyK',
  'KeyL',
];

/** One cell per position, built once: the frame loop only toggles a class and a label. */
const cells = new Map<GamepadButton, { root: HTMLElement; label: HTMLElement }>();
for (const position of POSITIONS) {
  const root = document.createElement('div');
  root.className = 'cell';
  const pos = document.createElement('div');
  pos.className = 'pos';
  pos.textContent = position;
  const label = document.createElement('div');
  label.className = 'lbl';
  label.textContent = '—';
  root.append(pos, label);
  grid.append(root);
  cells.set(position, { root, label });
}

/** Two sticks and two triggers, also built once. */
function stick(): { root: HTMLElement; dot: HTMLElement } {
  const root = document.createElement('div');
  root.className = 'stick';
  const dead = document.createElement('div');
  dead.className = 'dead';
  const size = `${DEFAULT_DEADZONE * 100}%`;
  dead.style.width = size;
  dead.style.height = size;
  dead.style.left = `${50 - DEFAULT_DEADZONE * 50}%`;
  dead.style.top = `${50 - DEFAULT_DEADZONE * 50}%`;
  const dot = document.createElement('div');
  dot.className = 'dot';
  root.append(dead, dot);
  return { root, dot };
}
const left = stick();
const right = stick();
const leftTrigger = document.createElement('i');
const rightTrigger = document.createElement('i');
for (const [s, t] of [
  [left, leftTrigger],
  [right, rightTrigger],
] as const) {
  const column = document.createElement('div');
  const bar = document.createElement('div');
  bar.className = 'bar';
  bar.append(t);
  column.append(s.root, bar);
  axesBox.append(column);
}

/**
 * The hint, redrawn only when it changes.
 *
 * `onDeviceChange` fires on a change and not on a repeat, which is the whole reason a consumer can
 * afford to redraw a whole prompt set here rather than diffing one every frame.
 */
function showDevice(device: string): void {
  hint.textContent =
    device === 'gamepad'
      ? 'Press a button — controller'
      : device === 'keyboard'
        ? 'Press a key — keyboard'
        : device === 'touch'
          ? 'Touch — touchscreen'
          : 'Move the mouse — mouse';
}
showDevice(input.lastDevice);
input.onDeviceChange(showDevice);

function frame(): void {
  requestAnimationFrame(frame);
  const pad = input.pad(0);

  if (capturing !== null && captureInto(capturing)) capturing = null;
  for (const name of DIGITAL) {
    const row = rows.get(name);
    if (row === undefined) continue;
    row.root.classList.toggle('on', actions.down(name));
    row.root.classList.toggle('capturing', capturing === name);
    row.binds.textContent =
      capturing === name
        ? 'press anything…'
        : actions.bindingsFor(name).map(describe).join('  or  ');
  }

  if (pad === null) {
    identity.textContent =
      'No pad seen yet. Press a button on one — a browser reports none until you do.';
    for (const { root, label } of cells.values()) {
      root.classList.remove('on');
      label.textContent = '—';
    }
    return;
  }

  identity.textContent =
    `family ${pad.identity.family}   mapping ${pad.mapping}   browser slot ${String(pad.index)}\n` +
    `faceDown is "${pad.identity.label('faceDown')}", glyph key ${pad.identity.glyph('faceDown')}`;

  for (const [position, { root, label }] of cells) {
    root.classList.toggle('on', pad.down(position));
    label.textContent = pad.identity.label(position);
  }

  left.dot.style.left = `${50 + pad.axis('leftX') * 50}%`;
  left.dot.style.top = `${50 + pad.axis('leftY') * 50}%`;
  right.dot.style.left = `${50 + pad.axis('rightX') * 50}%`;
  right.dot.style.top = `${50 + pad.axis('rightY') * 50}%`;
  leftTrigger.style.width = `${pad.trigger('l2') * 100}%`;
  rightTrigger.style.width = `${pad.trigger('r2') * 100}%`;
}
requestAnimationFrame(frame);
