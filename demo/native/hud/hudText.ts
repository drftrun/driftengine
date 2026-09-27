/**
 * What the native harness's interface can write: a string brought into the glyphs the engine's
 * pixel font has, and a readout broken into lines that fit the window.
 *
 * **The pixel font, because it is the engine's only text in screen space.** SDF text is drawn into
 * the world, through the scene's own camera, which the harness neither has nor should reach for. The
 * pixel font is capitals, digits and a little punctuation and draws anything else as its box, so the
 * browser readout's dash, degree sign and ellipsis are spelled with what it does have, and what it
 * cannot draw at all is dropped. What would make that wrong is a readout whose meaning lives in a
 * character this drops.
 */

import { countCells, hasGlyph, textWidthPx } from '../../../packages/core/src/index';

/** Characters the font lacks, spelled with ones it has. */
const SPELLED: Readonly<Record<string, string>> = {
  '—': '-',
  '–': '-',
  '…': '...',
  '°': '',
};

/** `text` in capitals, with every character the font cannot draw spelled or dropped. */
export function pixelText(text: string): string {
  let out = '';
  for (const character of text) {
    const spelled = SPELLED[character];
    if (spelled !== undefined) out += spelled;
    else if (hasGlyph(character)) out += character.toUpperCase();
  }
  return out;
}

/** What goes between two parts of a readout on one line. */
export const SEPARATOR = ' · ';

/**
 * Parts joined on lines no wider than `width` pixels at `cellSize` and lighting no more than
 * `cellLimit` cells, broken only between parts. The limit is the engine's per-text cap
 * (`MAX_TEXT_CELLS`), past which a line is cut mid-glyph. A part too big for either is a line of
 * its own rather than being cut, because a readout that overflows is still read and one that is
 * truncated is not.
 */
export function wrapParts(
  parts: readonly string[],
  width: number,
  cellSize: number,
  separator = SEPARATOR,
  cellLimit = Number.POSITIVE_INFINITY,
): string[] {
  const lines: string[] = [];
  let line = '';
  for (const part of parts) {
    const joined = line === '' ? part : line + separator + part;
    const tooBig = textWidthPx(joined, cellSize) > width || countCells(joined) > cellLimit;
    if (line !== '' && tooBig) {
      lines.push(line);
      line = part;
    } else {
      line = joined;
    }
  }
  if (line !== '') lines.push(line);
  return lines;
}
