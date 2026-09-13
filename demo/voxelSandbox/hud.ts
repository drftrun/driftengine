/**
 * The hotbar, crosshair and readout, drawn by the engine rather than by the page.
 *
 * **This is the port's first forced departure from the reference.** That one does
 * `new Hud(document.body, hotbar)` and styles it with CSS; `demo/types.ts` forbids a scene the
 * page in one sentence, because a demo needing privileged page access would be advertising an
 * engine nobody else can have. So every pixel here is `fillPanel` and `drawText`, which is what
 * `examples/overlay-text/` exists to demonstrate.
 *
 * **Everything must be drawn before `endFrame`.** An overlay issued after it survives on WebGL2
 * and vanishes on WebGPU — the trap `AGENTS.md` names, and the reason this class has a `draw`
 * the scene calls rather than doing its own frame bookkeeping.
 */
import {
  DEFAULT_TEXT_STYLE,
  textHeightPx,
  type RendererApi,
  type Vec3,
} from '../../packages/core/src/index';

import { Block, blockDef, HOTBAR } from './blocks';
import { hotbarLayout, slotLeft } from './hotbarLayout';

type TextHandle = ReturnType<RendererApi['createText']>;

const PANEL_DIM: Vec3 = [0.04, 0.05, 0.08];
const CROSSHAIR: Vec3 = [0.94, 0.95, 0.98];
const TEXT_DIM: Vec3 = [0.72, 0.77, 0.86];
const TEXT_BRIGHT: Vec3 = [1, 0.92, 0.62];

/** How long a toast stays up, in seconds. */
const TOAST_SEC = 2.4;

export class Hud {
  /** Which slot the input layer has selected. The scene copies it in each frame. */
  selected = 0;

  private readonly renderer: RendererApi;
  /* One handle per line: `drawText` renders a single line and ignores a newline, so a two-line
     readout drawn through one handle lands on top of itself. */
  private readonly debugLines: TextHandle[];
  private readonly slotText: TextHandle;
  /**
   * The digit in each slot's corner, built once because it never changes.
   *
   * `drawText` renders one handle's string, so ten labels are ten handles — the same reason
   * `debugLines` is a pair. Writing one handle ten times a frame would re-upload the glyphs on
   * every draw for a string that is a single character and constant.
   */
  private readonly slotNumbers: TextHandle[];
  private readonly toastText: TextHandle;
  private readonly fpsText: TextHandle;
  private readonly helpText: TextHandle;

  private readonly debug: string[] = ['', ''];
  /** Quantised, so an unchanged figure does not rewrite a text handle sixty times a second. */
  private fps = 0;
  /** The reference shows its controls until the player takes pointer lock. */
  private showHelp = true;
  /** F3, as the reference has it. */
  private showDebug = true;
  private toastMessage = '';
  private toastLeft = 0;
  private elapsed = 0;
  private disposed = false;

  constructor(renderer: RendererApi) {
    this.renderer = renderer;
    this.debugLines = [renderer.createText(), renderer.createText()];
    this.slotText = renderer.createText();
    /* `1`..`9` then `0`, which is the key each slot answers to and what the reference labels. */
    this.slotNumbers = HOTBAR.map((_, index) => {
      const handle = renderer.createText();
      renderer.setText(handle, String((index + 1) % 10));
      return handle;
    });
    this.toastText = renderer.createText();
    this.fpsText = renderer.createText();
    this.helpText = renderer.createText();
  }

  /** One string per line. See `debugLines` for why this is not one string with newlines. */
  setDebug(first: string, second: string): void {
    this.debug[0] = first;
    this.debug[1] = second;
  }

  setFps(fps: number): void {
    this.fps = Math.round(fps);
  }

  /** Hidden once the player is playing, which is when it has served its purpose. */
  hideHelp(): void {
    this.showHelp = false;
  }

  toggleDebug(): void {
    this.showDebug = !this.showDebug;
  }

  toast(message: string): void {
    this.toastMessage = message;
    this.toastLeft = TOAST_SEC;
  }

  update(dtSec: number): void {
    this.elapsed += dtSec;
    if (this.toastLeft > 0) this.toastLeft = Math.max(0, this.toastLeft - dtSec);
  }

  /** Call between the scene's last geometry and `endFrame`, never after it. */
  draw(width: number, height: number): void {
    if (width <= 0 || height <= 0) return;
    const cell = Math.max(2, Math.round(Math.min(width, height) / 260));

    this.drawCrosshair(width, height, cell);
    this.drawHotbar(width, height, cell);
    if (this.showDebug) this.drawReadout(width, height, cell);
    this.drawFps(width, height, cell);
    if (this.showHelp) this.drawHelp(width, height, cell);
    this.drawToast(width, height, cell);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const handle of [
      ...this.debugLines,
      ...this.slotNumbers,
      this.slotText,
      this.toastText,
      this.fpsText,
      this.helpText,
    ]) {
      this.renderer.disposeText(handle);
    }
  }

  /** Two strokes rather than a texture, since a screen-space quad takes no image. See GAPS.md. */
  private drawCrosshair(width: number, height: number, cell: number): void {
    const cx = Math.round(width / 2);
    const cy = Math.round(height / 2);
    const arm = cell * 4;
    const thick = Math.max(1, Math.round(cell / 2));
    this.renderer.fillPanel(
      { left: cx - arm, top: cy - Math.round(thick / 2), width: arm * 2, height: thick },
      CROSSHAIR,
      0.75,
    );
    this.renderer.fillPanel(
      { left: cx - Math.round(thick / 2), top: cy - arm, width: thick, height: arm * 2 },
      CROSSHAIR,
      0.75,
    );
  }

  /**
   * Ten slots, each filled with its block's representative colour.
   *
   * The reference shows the tile itself. Nothing on the public surface draws a *textured*
   * screen-space quad — `fillPanel` takes a colour — so the slots carry `blockColor`, which
   * exists for tinting debris and turns out to be a usable palette: grass green, dirt brown,
   * stone grey, sand pale. Recorded in `GAPS.md` rather than worked around silently.
   */
  private drawHotbar(width: number, height: number, cell: number): void {
    /* Shared with `hotbarIcons.ts`, which draws the tiles into these same rectangles. */
    const { slot, gap, total, left, top } = hotbarLayout(width, height);

    this.renderer.fillPanel(
      { left: left - gap, top: top - gap, width: total + gap * 2, height: slot + gap * 2 },
      PANEL_DIM,
      0.55,
    );

    /*
     * **A border around every slot, not a block behind one.**
     *
     * The tiles are drawn after this and cover their slot exactly, so a filled rectangle inset
     * by `border` on each side shows only as an outline. That is what the reference does — a
     * 2 px edge on a 50 px slot, dim on every slot and white on the chosen one — and it is what
     * says which slot is live without the bar having to carry a second colour.
     *
     * The first version filled `slot + gap * 2`, a `gap` of `cell * 2` proud of the tile on
     * every side. At a 42 px slot that is a six-pixel slab rather than an outline, and it read
     * as the selection being a different *shape* rather than a different *edge*.
     */
    const border = Math.max(1, Math.round(cell * 0.7));
    for (let i = 0; i < HOTBAR.length; i++) {
      const x = slotLeft(hotbarLayout(width, height), i);
      const chosen = i === this.selected;
      this.renderer.fillPanel(
        {
          left: x - border,
          top: top - border,
          width: slot + border * 2,
          height: slot + border * 2,
        },
        CROSSHAIR,
        chosen ? 0.92 : 0.22,
      );
    }

    const def = blockDef(HOTBAR[this.selected] ?? Block.AIR);
    this.renderer.setText(this.slotText, (def?.name ?? '').toUpperCase());
    this.renderer.drawText(
      this.slotText,
      width,
      height,
      left,
      top - cell * 6,
      { ...DEFAULT_TEXT_STYLE, cellSize: cell, color: TEXT_BRIGHT, glow: 0, alpha: 1, reveal: 1 },
      this.elapsed,
    );
  }

  /**
   * The key each slot answers to, over the tile rather than behind it.
   *
   * **Called after `hotbarIcons`, which is why it is not part of `draw`.** The tiles are world
   * geometry drawn last so they land on top of the bar's panel and inside its border, so a
   * number drawn with the rest of the overlay is *under* its own tile — which is where the first
   * version put it, visible only as a smudge above each slot. The reference draws its number
   * over the icon, so this is the one piece of the bar that has to follow them.
   */
  drawSlotNumbers(width: number, height: number): void {
    if (width <= 0 || height <= 0) return;
    const layout = hotbarLayout(width, height);
    const cell = Math.max(2, Math.round(Math.min(width, height) / 260));
    const border = Math.max(1, Math.round(cell * 0.7));

    /*
     * **`originY` is a baseline measured from the top**, so a glyph hangs *above* the number
     * given rather than below it. Passing the slot's own top put every digit in the gap above
     * the bar; the baseline has to be a glyph's height further down for the digit to sit inside
     * the slot it labels.
     */
    /*
     * **A fifth of the slot, which is what the reference's 11 px on a 50 px slot is.**
     *
     * The glyph is seven cells tall, so the cell size is the slot's share divided by seven and
     * not the HUD's own `cell` — at `cell * 0.9` a digit came out half the height of the tile it
     * labels, which reads as a number with a block behind it rather than a block with a number
     * in its corner.
     */
    const cellSize = Math.max(1, Math.round(cell * 0.45));
    const digit = textHeightPx(cellSize);
    for (let i = 0; i < HOTBAR.length; i++) {
      const chosen = i === this.selected;
      this.renderer.drawText(
        this.slotNumbers[i] as TextHandle,
        width,
        height,
        slotLeft(layout, i) + border * 2,
        layout.top + border + digit,
        {
          ...DEFAULT_TEXT_STYLE,
          cellSize,
          color: chosen ? TEXT_BRIGHT : TEXT_DIM,
          glow: 0,
          alpha: chosen ? 1 : 0.9,
          reveal: 1,
        },
        this.elapsed,
      );
    }
  }

  private drawReadout(width: number, height: number, cell: number): void {
    for (let i = 0; i < this.debugLines.length; i++) {
      const line = this.debug[i] ?? '';
      if (line.length === 0) continue;
      this.renderer.setText(this.debugLines[i]!, line);
      this.renderer.drawText(
        this.debugLines[i]!,
        width,
        height,
        cell * 4,
        /* Clear of the top edge, then one line height per row. */
        cell * 10 + i * cell * 9,
        { ...DEFAULT_TEXT_STYLE, cellSize: cell, color: TEXT_DIM, glow: 0, alpha: 0.9, reveal: 1 },
        this.elapsed,
      );
    }
  }

  /** Top right, as the reference puts it. */
  private drawFps(width: number, height: number, cell: number): void {
    const label = `${this.fps} FPS`;
    this.renderer.setText(this.fpsText, label);
    this.renderer.drawText(
      this.fpsText,
      width,
      height,
      Math.round(width - cell * 4 - label.length * cell * 6),
      cell * 10,
      { ...DEFAULT_TEXT_STYLE, cellSize: cell, color: TEXT_DIM, glow: 0, alpha: 0.9, reveal: 1 },
      this.elapsed,
    );
  }

  /** The controls, until the player takes pointer lock and no longer needs them. */
  private drawHelp(width: number, height: number, cell: number): void {
    /* The reference's line, in its order, plus the one binding this port adds: F to fly. */
    const label =
      'CLICK TO PLAY - WASD MOVE - SPACE JUMP - SHIFT SPRINT - MOUSE LOOK - ' +
      'L-CLICK BREAK - R-CLICK PLACE - 1-0 / TAB SELECT - F FLY - ' +
      'CTRL+S SAVE - CTRL+O LOAD - F3 DEBUG';
    this.renderer.setText(this.helpText, label);
    const w = label.length * cell * 6;
    this.renderer.fillPanel(
      {
        left: Math.round((width - w) / 2) - cell * 2,
        top: cell * 6,
        width: w + cell * 4,
        height: cell * 10,
      },
      PANEL_DIM,
      0.5,
    );
    this.renderer.drawText(
      this.helpText,
      width,
      height,
      Math.round((width - w) / 2),
      cell * 12,
      { ...DEFAULT_TEXT_STYLE, cellSize: cell, color: CROSSHAIR, glow: 0, alpha: 1, reveal: 1 },
      this.elapsed,
    );
  }

  private drawToast(width: number, height: number, cell: number): void {
    if (this.toastLeft <= 0 || this.toastMessage.length === 0) return;
    /* Fades over its last half-second rather than blinking out. */
    const alpha = Math.min(1, this.toastLeft / 0.5);
    this.renderer.setText(this.toastText, this.toastMessage.toUpperCase());
    this.renderer.drawText(
      this.toastText,
      width,
      height,
      Math.round(width / 2 - this.toastMessage.length * cell * 3),
      Math.round(height * 0.3),
      { ...DEFAULT_TEXT_STYLE, cellSize: cell * 2, color: TEXT_BRIGHT, glow: 1, alpha, reveal: 1 },
      this.elapsed,
    );
  }
}
