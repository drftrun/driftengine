/** A node of the retained interface tree: what it is, where it wants to be, and what it draws. */

import type { SpriteFrame } from './spriteSheet.ts';

/**
 * How big a node asks to be along one axis.
 *
 * A number is that many units. `fit` is whatever its own contents come to. `grow` takes an equal
 * share of what is left along the parent's main axis, and behaves as `fit` across it.
 *
 * **Three cases rather than a percentage or a flex factor**, and the omission is deliberate: a
 * percentage of a parent that is itself `fit` is a cycle, and a weighted `grow` is a fourth case
 * whose only caller so far would be a two-to-one split that two nested nodes already express.
 */
export type UiSize = number | 'fit' | 'grow';

/** Where children sit across the parent's main axis. `stretch` gives them the whole cross extent. */
export type UiAlign = 'start' | 'center' | 'end' | 'stretch';

/** How the leftover along the main axis is spent when no child asked to `grow`. */
export type UiJustify = 'start' | 'center' | 'end' | 'between';

/** A resolved box, in whatever units the tree is laid out in. Written by `layoutUiTree`. */
export interface UiRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface UiNodeOptions {
  readonly direction?: 'row' | 'column';
  readonly width?: UiSize;
  readonly height?: UiSize;
  /** One number for all four sides. Set the four fields for anything else. */
  readonly padding?: number;
  readonly gap?: number;
  readonly align?: UiAlign;
  readonly justify?: UiJustify;
  /** Taken out of the flow and placed at `x`, `y` inside the parent's content box. */
  readonly absolute?: boolean;
  readonly x?: number;
  readonly y?: number;
  /** What a `fit` node measures when it has no children: a label's text, an icon's size. */
  readonly contentWidth?: number;
  readonly contentHeight?: number;
  readonly hidden?: boolean;
  readonly background?: ArrayLike<number> | null;
  /** The sprite slot this node draws from, or `-1` for none. */
  readonly texture?: number;
  readonly frame?: SpriteFrame | null;
  readonly tint?: ArrayLike<number> | null;
  readonly text?: string;
  readonly interactive?: boolean;
  readonly focusable?: boolean;
  /** For a caller to find its own node again. Not read by anything here. */
  readonly name?: string;
}

/**
 * A node.
 *
 * **An object with mutable fields rather than a row of typed arrays**, and this is the one place in
 * this package where that is the right answer. An interface tree is tens or hundreds of nodes built
 * once and mutated, not thousands rebuilt per frame — the case struct-of-arrays exists for. What
 * the hot path needs is that laying one out and drawing it allocates nothing, and both write into
 * fields that already exist.
 */
export interface UiNode {
  readonly children: UiNode[];
  parent: UiNode | null;

  direction: 'row' | 'column';
  width: UiSize;
  height: UiSize;
  paddingLeft: number;
  paddingTop: number;
  paddingRight: number;
  paddingBottom: number;
  gap: number;
  align: UiAlign;
  justify: UiJustify;
  absolute: boolean;
  x: number;
  y: number;
  contentWidth: number;
  contentHeight: number;
  hidden: boolean;

  /** Where this node ended up. Meaningless until `layoutUiTree` has run over its root. */
  readonly rect: UiRect;
  /** What it measured to along each axis, before the parent distributed anything. */
  measuredWidth: number;
  measuredHeight: number;

  background: Float32Array | null;
  texture: number;
  frame: SpriteFrame | null;
  tint: Float32Array | null;
  text: string;

  interactive: boolean;
  focusable: boolean;
  hovered: boolean;
  pressed: boolean;
  name: string;
}

function rgba(source: ArrayLike<number> | null | undefined): Float32Array | null {
  if (source === null || source === undefined) return null;
  const out = new Float32Array(4);
  out[0] = source[0] as number;
  out[1] = source[1] as number;
  out[2] = source[2] as number;
  out[3] = (source[3] ?? 1) as number;
  return out;
}

export function createUiNode(options: UiNodeOptions = {}): UiNode {
  const padding = options.padding ?? 0;
  return {
    children: [],
    parent: null,
    direction: options.direction ?? 'column',
    width: options.width ?? 'fit',
    height: options.height ?? 'fit',
    paddingLeft: padding,
    paddingTop: padding,
    paddingRight: padding,
    paddingBottom: padding,
    gap: options.gap ?? 0,
    align: options.align ?? 'start',
    justify: options.justify ?? 'start',
    absolute: options.absolute ?? false,
    x: options.x ?? 0,
    y: options.y ?? 0,
    contentWidth: options.contentWidth ?? 0,
    contentHeight: options.contentHeight ?? 0,
    hidden: options.hidden ?? false,
    rect: { x: 0, y: 0, w: 0, h: 0 },
    measuredWidth: 0,
    measuredHeight: 0,
    background: rgba(options.background),
    texture: options.texture ?? -1,
    frame: options.frame ?? null,
    tint: rgba(options.tint),
    text: options.text ?? '',
    interactive: options.interactive ?? false,
    focusable: options.focusable ?? false,
    hovered: false,
    pressed: false,
    name: options.name ?? '',
  };
}

/** Put `child` at the end of `parent`'s children, detaching it from wherever it was. */
export function addUiChild(parent: UiNode, child: UiNode): UiNode {
  if (child.parent !== null) removeUiChild(child.parent, child);
  child.parent = parent;
  parent.children.push(child);
  return child;
}

/** Take `child` out of `parent`. A child that is not there is left alone. */
export function removeUiChild(parent: UiNode, child: UiNode): void {
  const at = parent.children.indexOf(child);
  if (at < 0) return;
  parent.children.splice(at, 1);
  child.parent = null;
}

/** The node named, depth-first from `root`, or `null`. For a caller finding its own tree again. */
export function uiNodeNamed(root: UiNode, name: string): UiNode | null {
  if (root.name === name) return root;
  for (const child of root.children) {
    const hit = uiNodeNamed(child, name);
    if (hit !== null) return hit;
  }
  return null;
}

/** Whether a point is inside a node's resolved box. */
export function uiRectHolds(node: UiNode, x: number, y: number): boolean {
  const r = node.rect;
  return x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
}
