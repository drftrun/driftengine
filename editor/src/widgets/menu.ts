/**
 * A menu bar's drop-down and a context menu, which are the same thing opened from different places.
 *
 * **The layer is what makes a menu a menu.** It is owned by the control that opens it and has to
 * cover the panel that control sits in, and tree order cannot express that because ownership and
 * covering point in opposite directions. `uiLayer.ts` exists for exactly this, and a menu is its
 * first real consumer.
 *
 * **The submenu delay is driven by time the caller supplies, never by a timer.** This runs under a
 * host whose clock is the caller's, so there is no `setTimeout` to be correct with — and even in a
 * browser a timer makes the behaviour untestable without waiting for it, which is how a
 * three-hundred-millisecond delay ends up asserted by a test that sleeps for a second. `tickMenu`
 * takes the frame's time and the whole thing is arithmetic.
 */
import { createUiNode } from '@driftengine/ui2d';
import type { UiNode } from '@driftengine/ui2d';

export interface MenuItem {
  readonly id: string;
  readonly label: string;
  /** A rule rather than a command. Not choosable, and does not dismiss the menu. */
  readonly separator?: boolean;
  readonly disabled?: boolean;
  /** Shown beside the label. The editor's own binding text; this file does not parse it. */
  readonly shortcut?: string;
  readonly submenu?: readonly MenuItem[];
}

export interface MenuOptions {
  readonly items: readonly MenuItem[];
  readonly rowHeight?: number;
  readonly width?: number;
  /** How long the pointer must rest on an item before its submenu opens. */
  readonly submenuDelayMs?: number;
  /** What the menu draws above. Anything on a lower layer is covered. */
  readonly layer?: number;
  readonly name?: string;
}

export interface Menu {
  readonly node: UiNode;
  readonly items: readonly MenuItem[];
  rowHeight: number;
  submenuDelayMs: number;
  open: boolean;
  /** Index of the item under the pointer, or -1. */
  hovered: number;
  /** When the pointer arrived on `hovered`, on the caller's clock. */
  hoveredSince: number;
  /** The item whose submenu is showing, or null. */
  openSubmenu: MenuItem | null;
}

/**
 * High enough to clear ordinary panel content, low enough to sit under a drag preview.
 *
 * A number rather than a name because `UiNode.layer` is a number, and the three values that exist
 * — content, menu, drag — are better as three constants somebody can compare than as a scale.
 */
export const MENU_LAYER = 100;

/**
 * A menu is given a width, because it cannot work one out.
 *
 * **A `fit` node whose children all `grow` measures zero**, which is a circularity rather than a
 * bug: the parent is asking the children how wide they are and the children are asking the parent.
 * A menu's natural width is the widest label plus its shortcut, and measuring a label is text
 * layout — which `ui2d` leaves to whoever owns the font, through `contentWidth`. So the honest
 * default is a number, and a caller that has measured its labels passes `width` instead.
 */
export const DEFAULT_MENU_WIDTH = 160;

export function createMenu(options: MenuOptions): Menu {
  const rowHeight = options.rowHeight ?? 20;
  const node = createUiNode({
    direction: 'column',
    width: options.width ?? DEFAULT_MENU_WIDTH,
    height: 'fit',
    absolute: true,
    hidden: true,
    layer: options.layer ?? MENU_LAYER,
    interactive: true,
    name: options.name ?? '',
  });

  for (const item of options.items) {
    const row = createUiNode({
      width: 'grow',
      height: item.separator === true ? 1 : rowHeight,
      text: item.label,
      interactive: item.separator !== true,
      name: item.id,
    });
    row.parent = node;
    node.children.push(row);
  }

  return {
    node,
    items: options.items,
    rowHeight,
    submenuDelayMs: options.submenuDelayMs ?? 300,
    open: false,
    hovered: -1,
    hoveredSince: 0,
    openSubmenu: null,
  };
}

export function openMenu(menu: Menu, x: number, y: number): void {
  menu.open = true;
  menu.node.hidden = false;
  menu.node.x = x;
  menu.node.y = y;
  forget(menu);
}

/**
 * Close, and forget the hover that was in progress.
 *
 * Without the forgetting, a menu closed while the pointer was resting on a branch reopens with its
 * submenu already out — the delay having elapsed while the menu was not even showing.
 */
export function closeMenu(menu: Menu): void {
  menu.open = false;
  menu.node.hidden = true;
  forget(menu);
}

function forget(menu: Menu): void {
  menu.hovered = -1;
  menu.hoveredSince = 0;
  menu.openSubmenu = null;
}

/**
 * The pointer is now on `index`, at `nowMs`.
 *
 * Re-arriving on the same item restarts the clock, because leaving and coming back is a new rest
 * rather than a continuation of the old one — a pointer that crossed three items and returned has
 * not been resting on any of them.
 */
export function menuHover(menu: Menu, index: number, nowMs: number): void {
  if (!menu.open) return;
  menu.hovered = index;
  menu.hoveredSince = nowMs;
  menu.openSubmenu = null;
}

/**
 * Advance the menu to `nowMs`, opening a submenu whose hover has lasted long enough.
 *
 * A `nowMs` earlier than the hover began opens nothing. That cannot happen from a monotonic clock,
 * and this takes whatever the caller hands it.
 */
export function tickMenu(menu: Menu, nowMs: number): void {
  if (!menu.open || menu.hovered < 0) return;
  const item = menu.items[menu.hovered];
  if (item?.submenu === undefined) return;
  const rested = nowMs - menu.hoveredSince;
  if (rested >= menu.submenuDelayMs) menu.openSubmenu = item;
}

/** Which item a position in the menu's own space names, or -1. */
export function menuIndexAt(menu: Menu, x: number, y: number): number {
  const rect = menu.node.rect;
  if (x < rect.x || x >= rect.x + rect.w || y < rect.y) return -1;
  let top = rect.y;
  for (let at = 0; at < menu.items.length; at += 1) {
    const height = menu.items[at]?.separator === true ? 1 : menu.rowHeight;
    if (y < top + height) return at;
    top += height;
  }
  return -1;
}

/**
 * Route one pointer event. Returns the item that was chosen, or null.
 *
 * **A press outside dismisses.** That is the one thing every menu everywhere does, and doing it on
 * the press rather than the release means the click that dismisses does not also activate whatever
 * was underneath — which is what a person means by clicking away.
 */
export function routeMenuPointer(
  menu: Menu,
  phase: 'down' | 'move' | 'up',
  x: number,
  y: number,
): MenuItem | null {
  if (!menu.open) return null;
  const at = menuIndexAt(menu, x, y);

  if (at < 0) {
    if (phase === 'down') closeMenu(menu);
    return null;
  }

  const item = menu.items[at];
  if (item === undefined || item.separator === true || item.disabled === true) return null;
  if (phase !== 'up') return null;

  /* A branch is opened by resting on it, not by clicking it: clicking would close the menu. */
  if (item.submenu !== undefined) return null;
  closeMenu(menu);
  return item;
}
