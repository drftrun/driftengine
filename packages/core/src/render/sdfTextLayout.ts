/**
 * A string as quads, in metres, from a font's metrics.
 *
 * **No GL here, for the reason `textLayout.ts` gives:** which quads a string produces is
 * the same arithmetic on either backend, so it lives once and the two renderers own only
 * their buffers. It is also the half worth testing, and testing it needs no context.
 *
 * The local frame is x right, y up from the baseline, z zero. A caller supplies the basis
 * that puts that somewhere -- `billboardMatrixY` for a label that faces the camera, a model
 * matrix for one lying on a surface.
 */
import type { SdfFont } from './sdfFont.ts';

export interface SdfTextStyle {
  /** Cap height to baseline-to-baseline scale, in metres per em. */
  readonly size: number;
  readonly anchorX: 'left' | 'center' | 'right';
  readonly anchorY: 'top' | 'middle' | 'baseline' | 'bottom';
  /** Extra advance between glyphs, in ems. */
  readonly letterSpacing: number;
  /** Multiplier on the font's own line height. */
  readonly lineHeight: number;
}

export const DEFAULT_SDF_TEXT_STYLE: SdfTextStyle = {
  size: 1,
  anchorX: 'left',
  anchorY: 'baseline',
  letterSpacing: 0,
  lineHeight: 1,
};

/** Longest string this lays out. Beyond it, the tail is dropped rather than grown into. */
const MAX_QUADS = 512;

export class SdfTextLayout {
  readonly positions = new Float32Array(MAX_QUADS * 4 * 3);
  readonly uvs = new Float32Array(MAX_QUADS * 4 * 2);
  readonly indices = new Uint32Array(MAX_QUADS * 6);
  quadCount = 0;
  width = 0;
  height = 0;

  private key = '';

  constructor() {
    /* The index pattern never changes; only how much of it is drawn. */
    for (let quad = 0; quad < MAX_QUADS; quad++) {
      const v = quad * 4;
      const i = quad * 6;
      this.indices[i] = v;
      this.indices[i + 1] = v + 1;
      this.indices[i + 2] = v + 2;
      this.indices[i + 3] = v;
      this.indices[i + 4] = v + 2;
      this.indices[i + 5] = v + 3;
    }
  }

  /**
   * Lay a string out. Returns whether anything moved, so a caller can skip the upload.
   *
   * The key covers the style as well as the text, because a size change moves every vertex
   * and a string that only compared its characters would keep the old geometry at the new
   * size -- which reads as the wrong font rather than as a stale buffer.
   *
   * A *piece* is one code point, unless the font carries a pre-shaped run that starts here,
   * in which case it is that run and it draws as a single quad. See `SdfFont.runs`: the
   * engine does no shaping, so a script that joins or reorders its letters has to arrive
   * already shaped, as one cell.
   */
  set(font: SdfFont, text: string, style: SdfTextStyle): boolean {
    const key = `${text}\u0000${style.size}\u0000${style.anchorX}\u0000${style.anchorY}\u0000${style.letterSpacing}\u0000${style.lineHeight}\u0000${font.family}`;
    if (key === this.key) return false;
    this.key = key;

    const scale = style.size / font.unitsPerEm;

    let penX = 0;
    let quads = 0;
    let at = 0;
    let piece = text.length > 0 ? pieceAt(font, text, 0) : '';
    while (at < text.length && quads < MAX_QUADS) {
      const nextAt = at + piece.length;
      const next = nextAt < text.length ? pieceAt(font, text, nextAt) : '';
      const glyph = font.glyph(piece);

      if (glyph !== null) {
        const left = penX + glyph.planeLeft * scale;
        const right = penX + glyph.planeRight * scale;
        const bottom = glyph.planeBottom * scale;
        const top = glyph.planeTop * scale;

        /* A glyph with no area -- a space -- advances and draws nothing. */
        if (right > left && top > bottom) {
          const v = quads * 4;
          write(this.positions, v, left, bottom, right, top);
          writeUv(
            this.uvs,
            v,
            glyph.atlasLeft / font.atlasWidth,
            glyph.atlasBottom / font.atlasHeight,
            glyph.atlasRight / font.atlasWidth,
            glyph.atlasTop / font.atlasHeight,
          );
          quads++;
        }

        penX += (glyph.advance + font.kerning(piece, next)) * scale;
        penX += style.letterSpacing * style.size;
      }

      at = nextAt;
      piece = next;
    }

    this.quadCount = quads;
    this.width = penX;
    this.height = (font.ascender - font.descender) * scale;

    const shiftX = style.anchorX === 'center' ? -penX / 2 : style.anchorX === 'right' ? -penX : 0;
    const shiftY =
      style.anchorY === 'middle'
        ? -((font.ascender + font.descender) / 2) * scale
        : style.anchorY === 'top'
          ? -font.ascender * scale
          : style.anchorY === 'bottom'
            ? -font.descender * scale
            : 0;

    if (shiftX !== 0 || shiftY !== 0) {
      for (let vertex = 0; vertex < quads * 4; vertex++) {
        this.positions[vertex * 3] = (this.positions[vertex * 3] as number) + shiftX;
        this.positions[vertex * 3 + 1] = (this.positions[vertex * 3 + 1] as number) + shiftY;
      }
    }
    return true;
  }
}

/** Four corners of a quad, counter-clockwise from bottom-left, at z = 0. */
function write(
  out: Float32Array,
  vertex: number,
  left: number,
  bottom: number,
  right: number,
  top: number,
): void {
  const at = vertex * 3;
  out[at] = left;
  out[at + 1] = bottom;
  out[at + 2] = 0;
  out[at + 3] = right;
  out[at + 4] = bottom;
  out[at + 5] = 0;
  out[at + 6] = right;
  out[at + 7] = top;
  out[at + 8] = 0;
  out[at + 9] = left;
  out[at + 10] = top;
  out[at + 11] = 0;
}

/**
 * The matching atlas corners. `atlasBottom`/`atlasTop` are already texel space -- not y-up,
 * see `SdfGlyph`'s own comment for the convention and why nothing here flips them.
 */
function writeUv(
  out: Float32Array,
  vertex: number,
  left: number,
  bottom: number,
  right: number,
  top: number,
): void {
  const at = vertex * 2;
  out[at] = left;
  out[at + 1] = bottom;
  out[at + 2] = right;
  out[at + 3] = bottom;
  out[at + 4] = right;
  out[at + 5] = top;
  out[at + 6] = left;
  out[at + 7] = top;
}

/**
 * What to draw at this position: the longest pre-shaped run that starts here, or the single
 * code point that does.
 *
 * Runs arrive longest first (see `SdfFont.runs`), so the first match is the right one. A
 * font with no runs skips the loop entirely and this is the same per-code-point walk the
 * layout has always done, which is the regression that matters: every atlas baked before
 * runs existed has to lay out identically.
 *
 * `startsWith` with an offset rather than a slice, because comparing a substring means
 * building one, and this runs once per character of every label a scene sets.
 */
function pieceAt(font: SdfFont, text: string, at: number): string {
  for (const run of font.runs) {
    if (run.length <= text.length - at && text.startsWith(run, at)) return run;
  }
  const code = text.codePointAt(at);
  return code !== undefined && code > 0xffff ? text.slice(at, at + 2) : text.charAt(at);
}
