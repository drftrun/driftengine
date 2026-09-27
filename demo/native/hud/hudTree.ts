/**
 * The native harness's interface as a `ui2d` tree: a scene menu, the player, the reveal scrubber,
 * the readout and an error line, laid out over the whole window.
 *
 * **The browser harness's controls, one for one**, because the window has nothing but its canvas:
 * the browser lays these out in HTML beside it. `ui2d` decides where each goes and what a pointer
 * is on; `hudPaint.ts` draws it. The only change of shape is the scene list, which the browser
 * shows as a strip above the canvas: over a native window that strip would cover the top of every
 * scene, three rows of it at a legible size, so it is a menu behind a `SCENES` button instead.
 *
 * Laid out every frame, which allocates nothing (`layoutUiTree`); the strings change only when
 * `setReadout` and `setError` are handed new ones.
 */

import { MAX_TEXT_CELLS, textHeightPx, textWidthPx } from '../../../packages/core/src/index';
import { addUiChild, createUiNode, layoutUiTree } from '../../../packages/ui2d/src/index.ts';
import type { UiNode } from '../../../packages/ui2d/src/index.ts';

import { SEPARATOR, pixelText, wrapParts } from './hudText.ts';

/** Pixels per cell of the pixel font: whole, so every stroke lands on a pixel. */
export const HUD_CELL = 2;
const PAD = 6;
const GAP = 6;
const MARGIN = 8;
const TRACK_W = 360;
const TRACK_H = 14;
/** How many lines the readout may wrap to before the window is too narrow to be worth reading. */
const READOUT_LINES = 4;
/** And an error, which is read once rather than watched. */
const ERROR_LINES = 3;
/** A button's height: a line of text and its padding on both sides. */
const BUTTON_H = textHeightPx(HUD_CELL) + 8;

export interface HudTree {
  readonly root: UiNode;
  readonly menuButton: UiNode;
  readonly menu: UiNode;
  /** One entry per scene, in the order the harness lists them. */
  readonly entries: readonly UiNode[];
  readonly transport: UiNode;
  readonly play: UiNode;
  readonly stop: UiNode;
  readonly timeline: UiNode;
  readonly clock: UiNode;
  readonly reveal: UiNode;
  readonly revealTrack: UiNode;
  readonly readout: UiNode;
  readonly lines: readonly UiNode[];
  readonly error: UiNode;
  readonly errorLines: readonly UiNode[];
  /** Where the playhead and the reveal are, 0 to 1, for the painter's fills. */
  timelineAt: number;
  revealAt: number;
  /** Which scene is showing, for the menu's mark. */
  current: number;
}

/** A leaf that says `text`, sized to it. */
function label(text: string, options: { interactive?: boolean; name?: string } = {}): UiNode {
  const node = createUiNode({
    padding: options.interactive === true ? 4 : 0,
    interactive: options.interactive ?? false,
    name: options.name ?? '',
  });
  setLabel(node, text);
  return node;
}

/** Change what a leaf says, in the pixel font's glyphs, and what it measures to. */
export function setLabel(node: UiNode, text: string): void {
  const spelled = pixelText(text);
  if (node.text === spelled) return;
  node.text = spelled;
  node.contentWidth = textWidthPx(spelled, HUD_CELL);
  node.contentHeight = textHeightPx(HUD_CELL);
}

/** `count` empty, hidden lines of text in `parent`, for a readout that wraps. */
function linesIn(parent: UiNode, count: number): UiNode[] {
  const lines: UiNode[] = [];
  for (let at = 0; at < count; at += 1) {
    const line = label('');
    line.hidden = true;
    addUiChild(parent, line);
    lines.push(line);
  }
  return lines;
}

function track(name: string): UiNode {
  return createUiNode({ width: TRACK_W, height: TRACK_H, interactive: true, name });
}

/** Build the tree for these scene titles. */
export function createHudTree(titles: readonly string[]): HudTree {
  const root = createUiNode({
    width: 'grow',
    height: 'grow',
    direction: 'column',
    justify: 'end',
    align: 'start',
    padding: MARGIN,
  });

  const menuButton = label('Scenes', { interactive: true, name: 'menu-button' });
  /* Absolute children sit inside the root's padding, so its margin is already their origin. */
  const menuButtonBox = createUiNode({ absolute: true, x: 0, y: 0 });
  addUiChild(menuButtonBox, menuButton);

  /* Interactive so a click on its backdrop stays in the menu rather than turning the camera. */
  const menu = createUiNode({
    absolute: true,
    x: 0,
    y: BUTTON_H + 4,
    direction: 'column',
    align: 'stretch',
    padding: PAD,
    gap: 2,
    interactive: true,
    hidden: true,
    name: 'menu',
  });
  const entries = titles.map((title, index) => {
    const entry = label(title, { interactive: true, name: `scene:${index}` });
    addUiChild(menu, entry);
    return entry;
  });

  const transport = createUiNode({
    direction: 'row',
    align: 'center',
    gap: GAP,
    padding: PAD,
    hidden: true,
  });
  const play = label('Play', { interactive: true, name: 'play' });
  const stop = label('Stop', { interactive: true, name: 'stop' });
  const timeline = track('timeline');
  const clock = label('');
  for (const child of [play, stop, timeline, clock]) addUiChild(transport, child);

  const reveal = createUiNode({
    direction: 'row',
    align: 'center',
    gap: GAP,
    padding: PAD,
    hidden: true,
  });
  const revealTrack = track('reveal');
  addUiChild(reveal, label('Load'));
  addUiChild(reveal, revealTrack);

  const readout = createUiNode({ direction: 'column', gap: 3, padding: PAD });
  const lines = linesIn(readout, READOUT_LINES);
  const error = createUiNode({ direction: 'column', gap: 3, padding: PAD, hidden: true });
  const errorLines = linesIn(error, ERROR_LINES);

  const bottom = createUiNode({ direction: 'column', gap: 4, align: 'start' });
  for (const child of [transport, reveal, readout, error]) addUiChild(bottom, child);
  for (const child of [bottom, menuButtonBox, menu]) addUiChild(root, child);

  return {
    root,
    menuButton,
    menu,
    entries,
    transport,
    play,
    stop,
    timeline,
    clock,
    reveal,
    revealTrack,
    readout,
    lines,
    error,
    errorLines,
    timelineAt: 0,
    revealAt: 1,
    current: 0,
  };
}

/** Fill `lines` from `wrapped`, hiding the ones it does not reach. */
function fill(lines: readonly UiNode[], wrapped: readonly string[]): void {
  lines.forEach((line, at) => {
    const text = wrapped[at] ?? '';
    setLabel(line, text);
    line.hidden = text === '';
  });
}

/** The readout, broken between its parts into as many lines as the window needs. */
export function setReadout(tree: HudTree, parts: readonly string[], width: number): void {
  const room = width - 2 * (MARGIN + PAD);
  fill(tree.lines, wrapParts(parts.map(pixelText), room, HUD_CELL, SEPARATOR, MAX_TEXT_CELLS));
}

/** An error, or none: broken between words to the window's width, its first lines shown. */
export function setError(tree: HudTree, message: string, width: number): void {
  const words = pixelText(message.replace(/\s+/g, ' ')).split(' ');
  const room = width - 2 * (MARGIN + PAD);
  fill(tree.errorLines, wrapParts(words, room, HUD_CELL, ' ', MAX_TEXT_CELLS));
  tree.error.hidden = message === '';
}

/** Lay the whole tree out over a window `width` by `height`. */
export function layoutHud(tree: HudTree, width: number, height: number): void {
  layoutUiTree(tree.root, 0, 0, width, height);
}
