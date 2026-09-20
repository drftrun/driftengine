/**
 * Button, toggle and icon button.
 *
 * **Why the widget set is here and not in `@driftengine/ui2d`.** A game's interface does not want
 * the editor's buttons, and Wave 1B deliberately stopped at the framework. The boundary is what
 * keeps `ui2d` small enough for a game to import: a node, a layout, a hit test and a pointer state
 * are general; a thing with a hover colour and a press-and-cancel gesture is an editor's taste.
 *
 * **The gesture is the whole of this file.** A press inside followed by a release inside fires; a
 * press inside followed by a release anywhere else fires nothing, because dragging off a button
 * before letting go is the only way a person has of changing their mind, and a button that fires
 * anyway has taken the decision away from them. That requires holding the pointer across the
 * gesture — `capturePointer` — since a framework routing purely by hit test never delivers the
 * release to the button the press began on.
 */
import {
  capturePointer,
  releasePointer,
  themeColour,
  themeRgba,
  uiRectHolds,
  createUiNode,
} from '@driftengine/ui2d';
import type { PointerState, Theme, UiNode, UiSize } from '@driftengine/ui2d';

/** Push fires, toggle holds a state, icon is a push with no label and a square footprint. */
export type ButtonKind = 'push' | 'toggle' | 'icon';

export interface ButtonOptions {
  readonly label?: string;
  readonly kind?: ButtonKind;
  readonly disabled?: boolean;
  /** Toggle only. Ignored by the other kinds. */
  readonly on?: boolean;
  readonly width?: UiSize;
  readonly height?: UiSize;
  /** The sprite slot an icon draws from, or `-1`. */
  readonly texture?: number;
  readonly name?: string;
}

export interface Button {
  readonly node: UiNode;
  readonly kind: ButtonKind;
  disabled: boolean;
  on: boolean;
  /**
   * Whether a press began on this button and has not been let go.
   *
   * Distinct from `node.pressed`, which is what the button *looks* like: a pointer that has
   * wandered off is still armed but no longer drawn pressed, and that pair is exactly what makes
   * coming back before releasing work.
   */
  armed: boolean;
}

export function createButton(options: ButtonOptions = {}): Button {
  const kind = options.kind ?? 'push';
  return {
    node: createUiNode({
      width: options.width ?? 'fit',
      height: options.height ?? 'fit',
      text: options.label ?? '',
      texture: options.texture ?? -1,
      interactive: true,
      focusable: true,
      name: options.name ?? options.label ?? '',
    }),
    kind,
    disabled: options.disabled ?? false,
    on: kind === 'toggle' ? (options.on ?? false) : false,
    armed: false,
  };
}

/** What activation means, reached identically by pointer and by key. */
function activate(button: Button): boolean {
  if (button.kind === 'toggle') button.on = !button.on;
  return true;
}

/**
 * Route one pointer event. Returns true on the event that activates the button.
 *
 * `move` is worth routing even though it never fires: it is what keeps the pressed look honest
 * while the pointer is held down and travelling.
 */
export function routeButtonPointer(
  button: Button,
  pointer: PointerState,
  phase: 'down' | 'move' | 'up',
  x: number,
  y: number,
): boolean {
  if (button.disabled) return false;
  const inside = uiRectHolds(button.node, x, y);

  if (phase === 'down') {
    if (!inside) return false;
    button.armed = true;
    button.node.pressed = true;
    capturePointer(pointer, button.node);
    return false;
  }

  if (phase === 'move') {
    if (button.armed) button.node.pressed = inside;
    return false;
  }

  if (!button.armed) return false;
  button.armed = false;
  button.node.pressed = false;
  releasePointer(pointer);
  return inside ? activate(button) : false;
}

/**
 * Enter and space, and nothing else.
 *
 * **The same path the pointer takes**, deliberately: a keyboard user on a second implementation is
 * a keyboard user on a second set of bugs, and a toggle that flips one way from the mouse and
 * another from the keyboard is the first of them.
 */
export function routeButtonKey(button: Button, key: string): boolean {
  if (button.disabled) return false;
  if (key !== 'Enter' && key !== ' ') return false;
  return activate(button);
}

/**
 * Disable or enable, dropping any press in progress.
 *
 * A button disabled between press and release would otherwise still be armed, and would fire the
 * moment it was enabled again — an activation the person asked for before the button was turned
 * off, arriving after.
 */
export function setButtonDisabled(button: Button, pointer: PointerState, disabled: boolean): void {
  button.disabled = disabled;
  if (!disabled || !button.armed) return;
  button.armed = false;
  button.node.pressed = false;
  releasePointer(pointer);
}

/** Enough that a button is visible against nothing, so a theme is an override rather than a duty. */
const FALLBACKS: Readonly<Record<string, number>> = {
  'button.background': 0x303030ff,
  'button.hover': 0x3c3c3cff,
  'button.press': 0x101010ff,
  'button.on': 0x2060c0ff,
  'button.disabled': 0x282828ff,
};

/**
 * The token this button's current state paints with, written into the node on the way out.
 *
 * **The order is disabled, pressed, on, hovered, and it is a precedence rather than a preference.**
 * A disabled button under the pointer must not light up, because a control that responds to hover
 * and then refuses the click is a control that looks broken rather than unavailable.
 *
 * The array is reused where the node already has one, so a per-frame repaint allocates nothing.
 */
export function paintButton(button: Button, theme: Theme): number {
  const name = button.disabled
    ? 'button.disabled'
    : button.node.pressed
      ? 'button.press'
      : button.on
        ? 'button.on'
        : button.node.hovered
          ? 'button.hover'
          : 'button.background';
  const fallback = FALLBACKS[name] ?? 0x00000000;
  const into = button.node.background ?? new Float32Array(4);
  button.node.background = themeRgba(theme, name, fallback, into);
  return themeColour(theme, name, fallback);
}
