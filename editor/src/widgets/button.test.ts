import { describe, expect, it } from 'vitest';
import { createPointerState, createTheme, layoutUiTree } from '@driftengine/ui2d';
import {
  createButton,
  paintButton,
  routeButtonKey,
  routeButtonPointer,
  setButtonDisabled,
} from './button.ts';

/** Every button here is 100 wide and 20 tall at the origin, so the geometry is arithmetic. */
function laidOut(button: ReturnType<typeof createButton>): ReturnType<typeof createButton> {
  layoutUiTree(button.node, 0, 0, 100, 20);
  return button;
}

describe('a button', () => {
  it('fires once when it is pressed and released over itself', () => {
    const button = laidOut(createButton({ label: 'Save', width: 100, height: 20 }));
    const pointer = createPointerState();

    expect(routeButtonPointer(button, pointer, 'down', 10, 10)).toBe(false);
    expect(button.node.pressed, 'it looks pressed while it is held').toBe(true);
    expect(routeButtonPointer(button, pointer, 'up', 10, 10)).toBe(true);
    expect(button.node.pressed).toBe(false);

    /* A second release with nothing held is not a second activation. */
    expect(routeButtonPointer(button, pointer, 'up', 10, 10)).toBe(false);
  });

  /**
   * **The case every hand-rolled button gets wrong.** Pressing a button and dragging off it before
   * letting go is how a person changes their mind, and it is the only way they can. A button that
   * fires anyway has taken the decision away from them.
   */
  it('fires nothing when it is released somewhere else', () => {
    const button = laidOut(createButton({ label: 'Delete', width: 100, height: 20 }));
    const pointer = createPointerState();

    routeButtonPointer(button, pointer, 'down', 10, 10);
    routeButtonPointer(button, pointer, 'move', 400, 400);
    expect(button.node.pressed, 'and it stops looking pressed on the way out').toBe(false);
    expect(routeButtonPointer(button, pointer, 'up', 400, 400)).toBe(false);
  });

  /** Coming back before letting go is changing your mind again, which also has to work. */
  it('fires when the pointer wanders off and comes back', () => {
    const button = laidOut(createButton({ label: 'Save', width: 100, height: 20 }));
    const pointer = createPointerState();

    routeButtonPointer(button, pointer, 'down', 10, 10);
    routeButtonPointer(button, pointer, 'move', 400, 400);
    routeButtonPointer(button, pointer, 'move', 12, 12);
    expect(button.node.pressed).toBe(true);
    expect(routeButtonPointer(button, pointer, 'up', 12, 12)).toBe(true);
  });

  /**
   * The press is held through `capturePointer`, so motion outside the rectangle still arrives.
   * Without it the release lands on whatever is under the pointer and this button never hears it.
   */
  it('holds the pointer from press to release', () => {
    const button = laidOut(createButton({ label: 'Save', width: 100, height: 20 }));
    const pointer = createPointerState();

    routeButtonPointer(button, pointer, 'down', 10, 10);
    expect(pointer.captured).toBe(button.node);
    routeButtonPointer(button, pointer, 'up', 10, 10);
    expect(pointer.captured, 'and gives it back').toBe(null);
  });

  it('fires nothing while it is disabled, and does not hold the pointer either', () => {
    const button = laidOut(createButton({ label: 'Save', width: 100, height: 20, disabled: true }));
    const pointer = createPointerState();

    routeButtonPointer(button, pointer, 'down', 10, 10);
    expect(pointer.captured).toBe(null);
    expect(routeButtonPointer(button, pointer, 'up', 10, 10)).toBe(false);
    expect(routeButtonKey(button, 'Enter')).toBe(false);
  });

  /** Disabling mid-press has to drop the press, or the button fires after it was turned off. */
  it('drops a press in progress when it is disabled', () => {
    const button = laidOut(createButton({ label: 'Save', width: 100, height: 20 }));
    const pointer = createPointerState();

    routeButtonPointer(button, pointer, 'down', 10, 10);
    setButtonDisabled(button, pointer, true);
    expect(pointer.captured).toBe(null);
    expect(routeButtonPointer(button, pointer, 'up', 10, 10)).toBe(false);
  });

  /** One activation path, reached two ways. A keyboard user is not on a second implementation. */
  it('activates from the keyboard through the same path', () => {
    const button = laidOut(createButton({ label: 'Save', width: 100, height: 20 }));
    expect(routeButtonKey(button, 'Enter')).toBe(true);
    expect(routeButtonKey(button, ' ')).toBe(true);
    expect(routeButtonKey(button, 'a')).toBe(false);
  });
});

describe('a toggle', () => {
  it('flips on activation and not on the press', () => {
    const toggle = laidOut(createButton({ label: 'Grid', kind: 'toggle', width: 100, height: 20 }));
    const pointer = createPointerState();

    routeButtonPointer(toggle, pointer, 'down', 10, 10);
    expect(toggle.on, 'pressing is not yet deciding').toBe(false);
    routeButtonPointer(toggle, pointer, 'up', 10, 10);
    expect(toggle.on).toBe(true);

    routeButtonPointer(toggle, pointer, 'down', 10, 10);
    routeButtonPointer(toggle, pointer, 'up', 10, 10);
    expect(toggle.on).toBe(false);
  });

  it('does not flip when the release lands elsewhere', () => {
    const toggle = laidOut(createButton({ label: 'Grid', kind: 'toggle', width: 100, height: 20 }));
    const pointer = createPointerState();

    routeButtonPointer(toggle, pointer, 'down', 10, 10);
    routeButtonPointer(toggle, pointer, 'up', 400, 400);
    expect(toggle.on).toBe(false);
  });

  it('flips from the keyboard too', () => {
    const toggle = laidOut(createButton({ label: 'Grid', kind: 'toggle', width: 100, height: 20 }));
    expect(routeButtonKey(toggle, ' ')).toBe(true);
    expect(toggle.on).toBe(true);
  });
});

describe("a button's colour", () => {
  const theme = createTheme({
    'button.background': 0x303030ff,
    'button.hover': 0x404040ff,
    'button.press': 0x101010ff,
    'button.on': 0x2060c0ff,
    'button.disabled': 0x282828ff,
  });

  it('reports the state it is in, and disabled outranks every other', () => {
    const button = laidOut(createButton({ label: 'Save', width: 100, height: 20 }));
    expect(paintButton(button, theme)).toBe(0x303030ff);

    button.node.hovered = true;
    expect(paintButton(button, theme)).toBe(0x404040ff);

    button.node.pressed = true;
    expect(paintButton(button, theme), 'pressed outranks hovered').toBe(0x101010ff);

    button.disabled = true;
    expect(paintButton(button, theme), 'and disabled outranks pressed').toBe(0x282828ff);
  });

  /** An engaged toggle reads as on even when the pointer is nowhere near it. */
  it('shows a toggle that is on', () => {
    const toggle = laidOut(createButton({ label: 'Grid', kind: 'toggle', width: 100, height: 20 }));
    toggle.on = true;
    expect(paintButton(toggle, theme)).toBe(0x2060c0ff);
  });

  it('writes the colour into the node, so a caller does not', () => {
    const button = laidOut(createButton({ label: 'Save', width: 100, height: 20 }));
    paintButton(button, theme);
    expect(button.node.background?.[0]).toBeCloseTo(0x30 / 255, 6);
    expect(button.node.background?.[3]).toBe(1);
  });
});
