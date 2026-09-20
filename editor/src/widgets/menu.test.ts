import { describe, expect, it } from 'vitest';
import { addUiChild, createUiNode, layerOrder, layoutUiTree } from '@driftengine/ui2d';
import {
  closeMenu,
  createMenu,
  menuHover,
  openMenu,
  routeMenuPointer,
  tickMenu,
  type MenuItem,
} from './menu.ts';

const ITEMS: MenuItem[] = [
  { id: 'new', label: 'New' },
  { id: 'open', label: 'Open' },
  { id: 'recent', label: 'Open Recent', submenu: [{ id: 'a', label: 'a.drft' }] },
  { id: 'sep', label: '', separator: true },
  { id: 'quit', label: 'Quit' },
];

describe('a menu', () => {
  it('is closed until it is opened, and shows an item per entry', () => {
    const menu = createMenu({ items: ITEMS });
    expect(menu.open).toBe(false);
    expect(menu.node.hidden).toBe(true);

    openMenu(menu, 10, 20);
    expect(menu.open).toBe(true);
    expect(menu.node.hidden).toBe(false);
    expect(menu.node.children.length).toBe(ITEMS.length);
  });

  /**
   * **A menu is owned by the control that opens it and must cover the panel that control sits in.**
   * Tree order cannot say that — ownership and covering point in opposite directions — which is
   * what `uiLayer.ts` exists for. Asserted through `layerOrder`, the thing that actually decides
   * draw order, rather than by reading the number back off the node.
   */
  it('draws over the panel that owns it', () => {
    const panel = createUiNode({ width: 'grow', height: 'grow', name: 'panel' });
    const body = createUiNode({ width: 'grow', height: 40, name: 'body' });
    addUiChild(panel, body);

    const menu = createMenu({ items: ITEMS, name: 'file-menu' });
    addUiChild(body, menu.node);
    openMenu(menu, 0, 0);

    const order: ReturnType<typeof createUiNode>[] = [];
    layerOrder(panel, order);
    expect(order.indexOf(menu.node)).toBeGreaterThan(order.indexOf(body));
    expect(order[order.length - 1]?.parent, 'and its items ride with it').toBe(menu.node);
  });

  it('closes when a click lands outside it', () => {
    const menu = createMenu({ items: ITEMS });
    openMenu(menu, 100, 100);
    layoutUiTree(menu.node, 100, 100, 160, 120);

    expect(routeMenuPointer(menu, 'down', 110, 110), 'inside is not a dismissal').toBe(null);
    expect(menu.open).toBe(true);

    expect(routeMenuPointer(menu, 'down', 5, 5)).toBe(null);
    expect(menu.open, 'outside closes it').toBe(false);
  });

  it('reports the item a click chose, and closes', () => {
    const menu = createMenu({ items: ITEMS, rowHeight: 20 });
    openMenu(menu, 0, 0);
    layoutUiTree(menu.node, 0, 0, 160, 120);

    expect(routeMenuPointer(menu, 'up', 10, 30)?.id, 'the second row').toBe('open');
    expect(menu.open, 'choosing closes the menu').toBe(false);
  });

  /* A separator is a rule and takes one pixel, so the rows are 0, 20, 40, 60, then 61 for Quit. */
  it('chooses nothing from a separator', () => {
    const menu = createMenu({ items: ITEMS, rowHeight: 20 });
    openMenu(menu, 0, 0);
    layoutUiTree(menu.node, 0, 0, 160, 120);
    expect(routeMenuPointer(menu, 'up', 10, 60)).toBe(null);
    expect(menu.open, 'and a separator does not close it either').toBe(true);
    expect(routeMenuPointer(menu, 'up', 10, 61)?.id, 'the row after it is Quit').toBe('quit');
  });

  it('chooses nothing from a disabled item and stays open', () => {
    const menu = createMenu({
      items: [
        { id: 'cut', label: 'Cut', disabled: true },
        { id: 'copy', label: 'Copy' },
      ],
      rowHeight: 20,
    });
    openMenu(menu, 0, 0);
    layoutUiTree(menu.node, 0, 0, 160, 120);
    expect(routeMenuPointer(menu, 'up', 10, 10)).toBe(null);
    expect(menu.open).toBe(true);
    expect(routeMenuPointer(menu, 'up', 10, 30)?.id).toBe('copy');
  });

  /** Clicking a branch would close the menu, which is the opposite of what opening one means. */
  it('chooses nothing from a branch', () => {
    const menu = createMenu({ items: ITEMS, rowHeight: 20 });
    openMenu(menu, 0, 0);
    layoutUiTree(menu.node, 0, 0, 160, 120);
    expect(routeMenuPointer(menu, 'up', 10, 50)).toBe(null);
    expect(menu.open).toBe(true);
  });
});

/**
 * **The delay is driven by time the caller supplies, never by a timer.**
 *
 * This runs under a host whose clock is the caller's, so `setTimeout` is not available to be
 * correct with — and even in a browser a timer makes the behaviour untestable without waiting for
 * it. `tickMenu` takes the frame's time and the whole thing is arithmetic.
 */
describe('a submenu', () => {
  it('opens only after the hover has lasted the delay', () => {
    const menu = createMenu({ items: ITEMS, rowHeight: 20, submenuDelayMs: 300 });
    openMenu(menu, 0, 0);

    menuHover(menu, 2, 1000);
    tickMenu(menu, 1000);
    expect(menu.openSubmenu, 'not yet').toBe(null);

    tickMenu(menu, 1299);
    expect(menu.openSubmenu, 'still not').toBe(null);

    tickMenu(menu, 1300);
    expect(menu.openSubmenu?.id).toBe('recent');
  });

  it('forgets the hover when the pointer moves to another item before the delay', () => {
    const menu = createMenu({ items: ITEMS, rowHeight: 20, submenuDelayMs: 300 });
    openMenu(menu, 0, 0);

    menuHover(menu, 2, 1000);
    tickMenu(menu, 1200);
    menuHover(menu, 1, 1200);
    tickMenu(menu, 1600);
    expect(menu.openSubmenu, 'the clock restarted on an item that has no submenu').toBe(null);
  });

  it('restarts the clock when the pointer comes back', () => {
    const menu = createMenu({ items: ITEMS, rowHeight: 20, submenuDelayMs: 300 });
    openMenu(menu, 0, 0);

    menuHover(menu, 2, 1000);
    menuHover(menu, 0, 1100);
    menuHover(menu, 2, 1200);
    tickMenu(menu, 1450);
    expect(menu.openSubmenu, 'measured from the second arrival, not the first').toBe(null);
    tickMenu(menu, 1500);
    expect(menu.openSubmenu?.id).toBe('recent');
  });

  it('opens nothing for an item that has no submenu', () => {
    const menu = createMenu({ items: ITEMS, rowHeight: 20, submenuDelayMs: 300 });
    openMenu(menu, 0, 0);
    menuHover(menu, 0, 1000);
    tickMenu(menu, 9999);
    expect(menu.openSubmenu).toBe(null);
  });

  /** Closing the menu has to forget the pending hover, or reopening pops a submenu at once. */
  it('is forgotten when the menu closes', () => {
    const menu = createMenu({ items: ITEMS, rowHeight: 20, submenuDelayMs: 300 });
    openMenu(menu, 0, 0);
    menuHover(menu, 2, 1000);
    closeMenu(menu);

    openMenu(menu, 0, 0);
    tickMenu(menu, 5000);
    expect(menu.openSubmenu).toBe(null);
  });

  /** A clock that goes backwards must not open everything at once. It cannot here: time is given. */
  it('does not open on a time earlier than the hover began', () => {
    const menu = createMenu({ items: ITEMS, rowHeight: 20, submenuDelayMs: 300 });
    openMenu(menu, 0, 0);
    menuHover(menu, 2, 1000);
    tickMenu(menu, 500);
    expect(menu.openSubmenu).toBe(null);
  });
});
