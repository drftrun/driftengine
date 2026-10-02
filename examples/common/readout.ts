/**
 * A few lines of figures under the backend label, in the engine's built-in font.
 *
 * Several examples report what the engine is doing as it runs: how many cells are resident, which
 * level each region is drawn at. This draws those lines over the finished frame, laying a line out
 * again only when its text changes.
 */
import { DEFAULT_TEXT_STYLE } from '@driftengine/core';
import type { RendererApi, TextStyle } from '@driftengine/core';

export interface Readout {
  /** Set one line's text. Laid out again only when it differs from what the line holds. */
  set(line: number, text: string): void;
  /** Draw every line. Call between the scene's draws and `endFrame`. */
  draw(seconds: number): void;
}

export function createReadout(renderer: RendererApi, lines: number): Readout {
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
      const size = Math.max(2, Math.round(Math.min(width, height) / 320));
      if (size !== cell) {
        cell = size;
        style = { ...DEFAULT_TEXT_STYLE, cellSize: size, color: [0.92, 0.94, 0.98] };
      }
      /* A glyph is five cells wide and six apart; a line is nine cells deep. */
      const longest = Math.max(...shown.map((text) => text.length));
      const top = 52;
      renderer.fillPanel(
        { left: 14, top, width: (longest * 6 + 5) * size, height: (lines * 9 + 4) * size },
        [0.07, 0.08, 0.1],
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
