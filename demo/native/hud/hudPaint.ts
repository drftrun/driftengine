/**
 * The HUD tree painted with the engine: panels for plates and tracks, the pixel font for words.
 *
 * **After the scene's `endFrame`, in the overlay pass**, because the harness does not own the frame:
 * a scene's `frame` opens and closes it. That pass is where a game's own interface lands, clear of
 * the scene's grade, and the native host presents only after the microtask that submits it (see
 * `runFrames` in the host), which is what puts it on the screen and not only in the canvas texture.
 *
 * **Frugal with panels.** WebGPU draws sixty-four a frame and skips the rest, and a scene spends its
 * own, so plates are drawn for groups rather than for every word: at most fourteen with the menu
 * open. Text draws have a budget of their own, also sixty-four; the open menu is its biggest spend,
 * one draw a scene. What would make this wrong is a scene that already spends most of either.
 */

import { DEFAULT_TEXT_STYLE } from '../../../packages/core/src/index';
import type { RendererApi, TextHandle, TextStyle, Vec3 } from '../../../packages/core/src/index';
import type { UiNode } from '../../../packages/ui2d/src/index.ts';

import { HUD_CELL, type HudTree } from './hudTree.ts';

type Writable<T> = { -readonly [K in keyof T]: T[K] };

const PLATE: Vec3 = [0.04, 0.05, 0.06];
const HOVER: Vec3 = [0.2, 0.24, 0.3];
const PRESS: Vec3 = [0.3, 0.36, 0.45];
const INK: Vec3 = [0.84, 0.87, 0.9];
const ACCENT: Vec3 = [0.55, 0.85, 0.65];
const TRACK: Vec3 = [0.22, 0.24, 0.27];
const THUMB: Vec3 = [0.92, 0.94, 0.96];
const WARNING: Vec3 = [0.4, 0.07, 0.07];

function styled(color: Vec3): Writable<TextStyle> {
  return { ...DEFAULT_TEXT_STYLE, cellSize: HUD_CELL, color, glow: 0, alpha: 1, reveal: 1 };
}

export class HudPainter {
  private readonly renderer: RendererApi;
  private readonly texts: TextHandle[] = [];
  private used = 0;
  private readonly ink = styled(INK);
  private readonly accent = styled(ACCENT);
  /* One rectangle, rewritten per panel, so a frame of plates allocates nothing. */
  private readonly rect = { left: 0, top: 0, width: 0, height: 0 };

  constructor(renderer: RendererApi) {
    this.renderer = renderer;
  }

  paint(tree: HudTree): void {
    this.used = 0;
    this.button(tree.menuButton);
    this.words(tree.menuButton, this.ink);

    if (!tree.menu.hidden) {
      this.plate(tree.menu, PLATE, 0.9);
      for (let index = 0; index < tree.entries.length; index += 1) {
        const entry = tree.entries[index] as UiNode;
        const current = index === tree.current;
        if (entry.hovered || entry.pressed) this.plate(entry, entry.pressed ? PRESS : HOVER, 0.9);
        if (current) this.panel(entry.rect.x - 4, entry.rect.y, 2, entry.rect.h, ACCENT, 1);
        this.words(entry, current ? this.accent : this.ink);
      }
    }

    if (!tree.transport.hidden) {
      this.plate(tree.transport, PLATE, 0.72);
      this.button(tree.play);
      this.button(tree.stop);
      this.words(tree.play, this.ink);
      this.words(tree.stop, this.ink);
      this.slider(tree.timeline, tree.timelineAt, true);
      this.words(tree.clock, this.ink);
    }

    if (!tree.reveal.hidden) {
      this.plate(tree.reveal, PLATE, 0.72);
      for (const child of tree.reveal.children) if (child.text !== '') this.words(child, this.ink);
      this.slider(tree.revealTrack, tree.revealAt, false);
    }

    if (!(tree.lines[0]?.hidden ?? true)) {
      this.plate(tree.readout, PLATE, 0.72);
      for (const line of tree.lines) if (!line.hidden) this.words(line, this.ink);
    }

    if (!tree.error.hidden) {
      this.plate(tree.error, WARNING, 0.9);
      for (const line of tree.errorLines) if (!line.hidden) this.words(line, this.ink);
    }
  }

  /** Let go of every text handle; the renderer they came from is going. */
  dispose(): void {
    for (const text of this.texts) this.renderer.disposeText(text);
    this.texts.length = 0;
  }

  /** A button's plate: only when a pointer is on it, so a still interface costs no panels. */
  private button(node: UiNode): void {
    if (node.pressed) this.plate(node, PRESS, 0.95);
    else if (node.hovered) this.plate(node, HOVER, 0.9);
    else this.plate(node, PLATE, 0.72);
  }

  private slider(node: UiNode, at: number, thumb: boolean): void {
    const { x, y, w, h } = node.rect;
    const along = Math.max(0, Math.min(1, at)) * w;
    this.panel(x, y + h / 2 - 2, w, 4, TRACK, 1);
    this.panel(x, y + h / 2 - 2, along, 4, ACCENT, 1);
    if (thumb) this.panel(x + along - 3, y, 6, h, THUMB, node.hovered || node.pressed ? 1 : 0.85);
  }

  private plate(node: UiNode, color: Vec3, alpha: number): void {
    const { x, y, w, h } = node.rect;
    this.panel(x, y, w, h, color, alpha);
  }

  private panel(x: number, y: number, w: number, h: number, color: Vec3, alpha: number): void {
    if (w <= 0 || h <= 0) return;
    this.rect.left = x;
    this.rect.top = y;
    this.rect.width = w;
    this.rect.height = h;
    this.renderer.fillPanel(this.rect, color, alpha);
  }

  /** A node's words, on its content box: the baseline is the glyphs' foot, seven cells down. */
  private words(node: UiNode, style: TextStyle): void {
    if (node.text === '') return;
    let text = this.texts[this.used];
    if (text === undefined) {
      text = this.renderer.createText();
      this.texts.push(text);
    }
    this.used += 1;
    this.renderer.setText(text, node.text);
    this.renderer.drawText(
      text,
      this.renderer.cssWidth,
      this.renderer.cssHeight,
      node.rect.x + node.paddingLeft,
      node.rect.y + node.paddingTop + 7 * HUD_CELL,
      style,
      0,
    );
  }
}
