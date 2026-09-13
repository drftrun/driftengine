/**
 * The parts of SDF font generation that are arithmetic rather than rasterising.
 *
 * Split out so `node --test` can exercise them with no TypeScript, no canvas and no font
 * file — the same reason `wgsl/layout.mjs` is plain JavaScript beside `wgsl.ts`.
 */

/**
 * Shelf packing: fill a row, then start the next one.
 *
 * Not the tightest packer there is, and deliberately: glyphs of one face are close enough
 * in height that shelves waste little, and a packer whose output depends on sort order is
 * a packer whose atlas changes when a glyph is added. Stable beats tight here, because the
 * atlas is committed and diffed.
 */
export function packGlyphs(glyphs, { atlasWidth, padding }) {
  const placed = [];
  let x = padding;
  let y = padding;
  let rowHeight = 0;

  for (const glyph of glyphs) {
    if (glyph.width + padding * 2 > atlasWidth) {
      throw new Error(`sdf-font: glyph "${glyph.char}" is wider than the atlas`);
    }
    if (x + glyph.width + padding > atlasWidth) {
      x = padding;
      y += rowHeight + padding;
      rowHeight = 0;
    }
    placed.push({ char: glyph.char, x, y, width: glyph.width, height: glyph.height });
    x += glyph.width + padding;
    if (glyph.height > rowHeight) rowHeight = glyph.height;
  }
  return placed;
}

/**
 * Runs from a runs file: one per line, blanks dropped, first of a repeat kept.
 *
 * A line rather than a character, which is the whole difference from `glyphSet`. A run is a
 * string that has to be handed to the text stack *as a string* to mean anything — `أبو`
 * joins and reorders, `fi` becomes a ligature — so the only separator that cannot occur
 * inside one is the line ending.
 *
 * A one-character line throws rather than being quietly accepted: it would bake a duplicate
 * cell for a glyph the glyph file already covers, and `SdfFont.runs` matches on length so it
 * would never be reached. Silent dead weight in a committed atlas is worse than a message.
 */
export function runSet(text) {
  const seen = new Set();
  const runs = [];
  for (const line of text.split('\n')) {
    const run = line.trim();
    if (run.length === 0) continue;
    if ([...run].length < 2) {
      throw new Error(
        `sdf-font: run "${run}" is a single character; runs need at least two characters`,
      );
    }
    if (seen.has(run)) continue;
    seen.add(run);
    runs.push(run);
  }
  return runs;
}

/** The committed document, with kerning pairs flattened to NUL-joined keys. */
export function metricsDocument({ family, atlas, metrics, glyphs, kerning }) {
  const pairs = {};
  for (const { left, right, amount } of kerning) pairs[`${left}\u0000${right}`] = amount;
  return { version: 1, family, atlas, metrics, glyphs, kerning: pairs };
}
