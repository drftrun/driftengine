import { beforeEach, describe, expect, it } from 'vitest';

import { SPRITE_FLOATS, createSpriteBatch } from './spriteBatch.ts';
import { addUiChild, createUiNode } from './uiNode.ts';
import type { UiNode } from './uiNode.ts';
import { layoutUiTree } from './uiLayout.ts';
import { drawUiTree } from './uiDraw.ts';
import { uiFocusNext, uiFocusOrder, uiFocusPrevious, uiHitTest } from './uiFocus.ts';
import { createUiInput, resetUiInput, routeUiKey, routeUiPointer } from './uiInput.ts';

/** A row of three 20x20 buttons in a 100x40 bar, laid out and ready to be pointed at. */
function bar(): { root: UiNode; buttons: UiNode[] } {
  const root = createUiNode({ direction: 'row', width: 100, height: 40, gap: 10, padding: 5 });
  const buttons = [0, 1, 2].map(() =>
    addUiChild(root, createUiNode({ width: 20, height: 20, interactive: true, focusable: true })),
  );
  layoutUiTree(root, 0, 0, 100, 40);
  return { root, buttons };
}

describe('drawUiTree', () => {
  it("draws a background under an image, and both at the node's box", () => {
    const root = createUiNode({
      width: 40,
      height: 10,
      background: [0, 0, 0, 1],
      texture: 2,
    });
    layoutUiTree(root, 7, 9, 40, 10);
    const batch = createSpriteBatch(16);
    expect(drawUiTree(batch, root, 5, null)).toBe(2);
    // The background is on the white slot and first; the image is on slot 2 and second.
    expect(batch.runs[0]).toBe(5);
    expect(batch.runs[3]).toBe(2);
    expect(batch.instances[12]).toBe(7);
    expect(batch.instances[13]).toBe(9);
    expect(batch.instances[SPRITE_FLOATS + 12]).toBe(7);
  });

  it('draws a parent before its children, so a child lands on top', () => {
    const root = createUiNode({ width: 40, height: 40, background: [0, 0, 0, 1] });
    addUiChild(root, createUiNode({ width: 10, height: 10, texture: 1 }));
    layoutUiTree(root, 0, 0, 40, 40);
    const batch = createSpriteBatch(16);
    drawUiTree(batch, root, 5, null);
    expect([batch.runs[0], batch.runs[3]]).toEqual([5, 1]);
  });

  it('draws neither a hidden node nor anything under it', () => {
    const root = createUiNode({ width: 40, height: 40, background: [0, 0, 0, 1], hidden: true });
    addUiChild(root, createUiNode({ width: 10, height: 10, texture: 1 }));
    layoutUiTree(root, 0, 0, 40, 40);
    const batch = createSpriteBatch(16);
    expect(drawUiTree(batch, root, 5, null)).toBe(0);
    expect(batch.count).toBe(0);
  });

  it('hands a node with text to the sink, in the order it was drawn', () => {
    const root = createUiNode({ width: 40, height: 40, text: 'one' });
    addUiChild(root, createUiNode({ width: 10, height: 10, text: 'two' }));
    addUiChild(root, createUiNode({ width: 10, height: 10 }));
    layoutUiTree(root, 0, 0, 40, 40);
    const seen: string[] = [];
    drawUiTree(createSpriteBatch(16), root, 5, { content: (node) => seen.push(node.text) });
    expect(seen).toEqual(['one', 'two']);
  });
});

describe('uiHitTest', () => {
  it('finds the interactive node under a point', () => {
    const { root, buttons } = bar();
    expect(uiHitTest(root, 10, 10)).toBe(buttons[0]);
    expect(uiHitTest(root, 40, 10)).toBe(buttons[1]);
  });

  it('finds nothing in the gap between two of them', () => {
    const { root } = bar();
    expect(uiHitTest(root, 30, 10)).toBeNull();
  });

  /*
   * A backdrop that swallowed clicks would make every button under a plate dead, which is invisible
   * in a screenshot and costs an afternoon. A caller wanting a modal to swallow them says so by
   * marking the modal interactive.
   */
  it('lets a point through a node that is not interactive', () => {
    const root = createUiNode({ width: 100, height: 100 });
    const button = addUiChild(root, createUiNode({ width: 20, height: 20, interactive: true }));
    layoutUiTree(root, 0, 0, 100, 100);
    expect(uiHitTest(root, 5, 5)).toBe(button);
    expect(uiHitTest(root, 50, 50)).toBeNull();
  });

  it('answers the last-drawn of two that overlap, which is the one on top', () => {
    const root = createUiNode({ width: 100, height: 100 });
    const under = addUiChild(
      root,
      createUiNode({ width: 50, height: 50, absolute: true, interactive: true }),
    );
    const over = addUiChild(
      root,
      createUiNode({ width: 50, height: 50, absolute: true, interactive: true }),
    );
    layoutUiTree(root, 0, 0, 100, 100);
    expect(uiHitTest(root, 10, 10)).toBe(over);
    expect(under).not.toBe(over);
  });

  it('finds nothing inside a hidden node', () => {
    const { root, buttons } = bar();
    (buttons[0] as UiNode).hidden = true;
    expect(uiHitTest(root, 10, 10)).toBeNull();
  });
});

describe('focus order', () => {
  it('is tree order', () => {
    const { root, buttons } = bar();
    expect(uiFocusOrder(root, [])).toEqual(buttons);
  });

  it('steps forward and wraps', () => {
    const { root, buttons } = bar();
    expect(uiFocusNext(root, null)).toBe(buttons[0]);
    expect(uiFocusNext(root, buttons[0] as UiNode)).toBe(buttons[1]);
    expect(uiFocusNext(root, buttons[2] as UiNode)).toBe(buttons[0]);
  });

  it('steps back and wraps the other way', () => {
    const { root, buttons } = bar();
    expect(uiFocusPrevious(root, null)).toBe(buttons[2]);
    expect(uiFocusPrevious(root, buttons[0] as UiNode)).toBe(buttons[2]);
  });

  it('skips a node that has been hidden since it was focused, rather than stalling', () => {
    const { root, buttons } = bar();
    (buttons[1] as UiNode).hidden = true;
    expect(uiFocusNext(root, buttons[0] as UiNode)).toBe(buttons[2]);
  });

  it('answers nothing when nothing is focusable', () => {
    const root = createUiNode({ width: 10, height: 10 });
    expect(uiFocusNext(root, null)).toBeNull();
  });
});

describe('pointer routing', () => {
  let input = createUiInput();
  beforeEach(() => {
    input = createUiInput();
  });

  it('marks what is hovered and unmarks what no longer is', () => {
    const { root, buttons } = bar();
    routeUiPointer(input, root, 10, 10, false);
    expect((buttons[0] as UiNode).hovered).toBe(true);
    routeUiPointer(input, root, 40, 10, false);
    expect((buttons[0] as UiNode).hovered).toBe(false);
    expect((buttons[1] as UiNode).hovered).toBe(true);
  });

  it('activates on a press and a release over the same node', () => {
    const { root, buttons } = bar();
    expect(routeUiPointer(input, root, 10, 10, true)).toBeNull();
    expect((buttons[0] as UiNode).pressed).toBe(true);
    expect(routeUiPointer(input, root, 10, 10, false)).toBe(buttons[0]);
    expect((buttons[0] as UiNode).pressed).toBe(false);
  });

  /*
   * The whole reason a press and a release are two events. Somebody who pressed the wrong button
   * slides off it and lets go, and nothing happens — which is what every pointer convention worth
   * copying does.
   */
  it('activates nothing when the release is somewhere else', () => {
    const { root, buttons } = bar();
    routeUiPointer(input, root, 10, 10, true);
    expect(routeUiPointer(input, root, 40, 10, false)).toBeNull();
    expect((buttons[0] as UiNode).pressed).toBe(false);
  });

  it('holds a press across frames while the pointer stays down', () => {
    const { root, buttons } = bar();
    routeUiPointer(input, root, 10, 10, true);
    expect(routeUiPointer(input, root, 10, 10, true)).toBeNull();
    expect(input.pressed).toBe(buttons[0]);
  });

  it('focuses what was pressed', () => {
    const { root, buttons } = bar();
    routeUiPointer(input, root, 40, 10, true);
    expect(input.focused).toBe(buttons[1]);
  });

  it('leaves focus alone when the press was on nothing', () => {
    const { root, buttons } = bar();
    routeUiPointer(input, root, 40, 10, true);
    routeUiPointer(input, root, 40, 10, false);
    routeUiPointer(input, root, 30, 10, true);
    expect(input.focused).toBe(buttons[1]);
  });

  it('forgets everything, and clears what it wrote on the tree', () => {
    const { root, buttons } = bar();
    routeUiPointer(input, root, 10, 10, true);
    resetUiInput(input);
    expect((buttons[0] as UiNode).hovered).toBe(false);
    expect((buttons[0] as UiNode).pressed).toBe(false);
    expect(input.focused).toBeNull();
  });
});

describe('key routing', () => {
  it('moves focus on tab, both ways', () => {
    const { root, buttons } = bar();
    const input = createUiInput();
    routeUiKey(input, root, 'Tab');
    expect(input.focused).toBe(buttons[0]);
    routeUiKey(input, root, 'Tab');
    expect(input.focused).toBe(buttons[1]);
    routeUiKey(input, root, 'Tab', true);
    expect(input.focused).toBe(buttons[0]);
  });

  it('activates what has focus on enter and on space', () => {
    const { root, buttons } = bar();
    const input = createUiInput();
    routeUiKey(input, root, 'Tab');
    expect(routeUiKey(input, root, 'Enter')).toBe(buttons[0]);
    expect(routeUiKey(input, root, ' ')).toBe(buttons[0]);
  });

  it('reports a key it does not handle, so the caller can', () => {
    const { root } = bar();
    const input = createUiInput();
    routeUiKey(input, root, 'Tab');
    expect(routeUiKey(input, root, 'q')).toBeNull();
  });

  it('activates nothing when nothing has focus', () => {
    const { root } = bar();
    const input = createUiInput();
    expect(routeUiKey(input, root, 'Enter')).toBeNull();
  });
});
