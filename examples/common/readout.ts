/**
 * A few lines of figures under the backend label, in the engine's built-in font.
 *
 * Several examples report what the engine is doing as it runs: how many cells are resident, which
 * level each region is drawn at. This draws those lines over the finished frame, laying a line out
 * again only when its text changes.
 */
import { DEFAULT_TEXT_STYLE, srgbColor } from '@driftengine/core';
import type { RendererApi, TextStyle } from '@driftengine/core';

/** The figures and their backing, picked by eye and so decoded: the renderer grades both. */
const INK = srgbColor(0.92, 0.94, 0.98);
const BACKING = srgbColor(0.07, 0.08, 0.1);

export interface Readout {
  /** Set one line's text. Laid out again only when it differs from what the line holds. */
  set(line: number, text: string): void;
  /** Draw every line. Call between the scene's draws and `endFrame`. */
  draw(seconds: number): void;
}

export interface ReadoutOptions {
  /** Pixels at the frame's right edge the lines must leave clear, asked each frame: a panel there. */
  readonly clearRight?: () => number;
}

export function createReadout(
  renderer: RendererApi,
  lines: number,
  options: ReadoutOptions = {},
): Readout {
  const handles = Array.from({ length: lines }, () => renderer.createText());
  const shown = Array.from({ length: lines }, () => '');
  let cell = 0;
  let style: TextStyle = DEFAULT_TEXT_STYLE;
  return {
    set(line, text) {
      const handle = handles[line];
      if (handle === undefined || shown[line] === text) return;
      shown[line] = text;
      renderer.setText(handle, text);
    },
    draw(seconds) {
      const width = renderer.cssWidth;
      const height = renderer.cssHeight;
      /* A glyph is five cells wide and six apart; a line is nine cells deep. */
      const longest = Math.max(...shown.map((text) => text.length));
      /*
       * The size the frame suggests, made smaller until the longest line fits across it. A
       * manual's frame is about 768 by 432, which suggests the same size as a full window, and at
       * that size the agents' and the models' lines ran off the edge and the input example's ran
       * under its controls panel.
       */
      const suggested = Math.max(2, Math.round(Math.min(width, height) / 320));
      const room = width - 28 - (options.clearRight?.() ?? 0);
      const fits = Math.floor(room / (longest * 6 + 5));
      const size = Math.max(1, Math.min(suggested, fits));
      if (size !== cell) {
        cell = size;
        style = { ...DEFAULT_TEXT_STYLE, cellSize: size, color: INK };
      }
      const top = 52;
      renderer.fillPanel(
        { left: 14, top, width: (longest * 6 + 5) * size, height: (lines * 9 + 4) * size },
        BACKING,
        0.6,
      );
      for (let line = 0; line < lines; line += 1) {
        const handle = handles[line];
        if (handle === undefined) continue;
        renderer.drawText(
          handle,
          width,
          height,
          14 + size * 3,
          top + size * (9 + line * 9),
          style,
          seconds,
        );
      }
    },
  };
}
