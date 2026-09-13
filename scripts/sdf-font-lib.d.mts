/** A box to place: a glyph's cell size, before it has a position. */
export interface GlyphBox {
  readonly char: string;
  readonly width: number;
  readonly height: number;
}

/** A box after `packGlyphs` has given it a position in the atlas. */
export interface PlacedGlyph extends GlyphBox {
  readonly x: number;
  readonly y: number;
}

export function packGlyphs(
  glyphs: readonly GlyphBox[],
  options: { atlasWidth: number; padding: number },
): PlacedGlyph[];

/** One kerning adjustment, in font units, applied when `right` follows `left`. */
export interface KerningPair {
  readonly left: string;
  readonly right: string;
  readonly amount: number;
}

/**
 * A single glyph's entry in the committed metrics document. `atlasBottom`/`atlasTop` are
 * texel space, not y-up -- see `SdfGlyph` in `src/render/sdfFont.ts`, the one place that
 * convention is stated.
 */
export interface GlyphMetric {
  readonly advance: number;
  readonly planeLeft: number;
  readonly planeBottom: number;
  readonly planeRight: number;
  readonly planeTop: number;
  readonly atlasLeft: number;
  readonly atlasBottom: number;
  readonly atlasRight: number;
  readonly atlasTop: number;
}

export interface AtlasInfo {
  readonly width: number;
  readonly height: number;
  readonly distanceRange: number;
}

export interface FontMetrics {
  readonly unitsPerEm: number;
  readonly ascender: number;
  readonly descender: number;
  readonly lineHeight: number;
}

export interface MetricsInput {
  readonly family: string;
  readonly atlas: AtlasInfo;
  readonly metrics: FontMetrics;
  readonly glyphs: Readonly<Record<string, GlyphMetric>>;
  readonly kerning: readonly KerningPair[];
}

/** The shape written to `metrics.json`. `kerning` keys join left and right with a NUL byte. */
export interface MetricsDocument {
  readonly version: 1;
  readonly family: string;
  readonly atlas: AtlasInfo;
  readonly metrics: FontMetrics;
  readonly glyphs: Readonly<Record<string, GlyphMetric>>;
  readonly kerning: Readonly<Record<string, number>>;
}

export function metricsDocument(input: MetricsInput): MetricsDocument;

/** Runs from a runs file: one per line, blanks dropped, first of a repeat kept. */
export function runSet(text: string): string[];
