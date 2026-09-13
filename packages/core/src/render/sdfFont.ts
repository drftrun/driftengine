/**
 * An SDF font's metrics, parsed once and asked many times.
 *
 * The atlas image is the consumer's business — it arrives as a `TexImageSource` like every
 * other texture this engine takes, and the engine still fetches nothing. This owns only
 * the numbers that turn a string into quads.
 */

export interface SdfGlyph {
  readonly advance: number;
  /** The glyph's ink box in font units, y-up: `planeTop` is above `planeBottom`. */
  readonly planeLeft: number;
  readonly planeBottom: number;
  readonly planeRight: number;
  readonly planeTop: number;
  /**
   * The glyph's cell in the atlas texture, in texels.
   *
   * **The single statement of this convention — nowhere else should restate it, only rely on
   * it.** These run the same direction the atlas PNG's own rows do, and the same direction
   * `createSurfaceTexture` actually uploads: `SurfaceTexture` (both backends) does not flip an
   * `ImageBitmap` source, so texture `v = 0` samples the PNG's own row 0, its top. `atlasTop`
   * is therefore the *smaller* number — nearer row 0 — and `atlasBottom` the larger one,
   * unlike `planeTop`/`planeBottom` above, which are a world-space quantity and stay y-up.
   * `writeUv` in `sdfTextLayout.ts` divides these by `atlasWidth`/`atlasHeight` and uses the
   * result as `v` directly: no flip, because these already agree with what the texture does.
   *
   * A version that flipped these to be y-up — matching the plane box's own sign, so that
   * "a texel and a plane coordinate agree on which way is up" — shipped for two days
   * (2026-08-16) and flipped every glyph onto the wrong row of its atlas, because
   * `SurfaceTexture` had already stopped flipping the upload two days earlier. Two
   * conventions that each sound reasonable alone cancelled into a bug neither side's unit
   * tests could see, because neither one renders a real texture.
   */
  readonly atlasLeft: number;
  readonly atlasBottom: number;
  readonly atlasRight: number;
  readonly atlasTop: number;
}

export interface SdfFont {
  readonly family: string;
  readonly unitsPerEm: number;
  readonly ascender: number;
  readonly descender: number;
  readonly lineHeight: number;
  readonly distanceRange: number;
  readonly atlasWidth: number;
  readonly atlasHeight: number;
  /**
   * Keys in the glyph table that are more than one character, longest first.
   *
   * A *pre-shaped run*: a string the generator handed to the platform's own text stack,
   * which joined, reordered and shaped it, baked as one atlas cell. The runtime draws
   * quads from metrics and does no shaping at all, so a script that joins its letters or
   * reads right to left cannot be assembled from single glyphs at draw time. `أبو` came
   * out as three disconnected isolated forms marching the wrong way; as one run it comes
   * out as the word.
   *
   * Longest first because `sdfTextLayout.ts` takes the first match at the pen, and a
   * shorter run that is a prefix of a longer one must not win.
   */
  readonly runs: readonly string[];
  glyph(character: string): SdfGlyph | null;
  kerning(left: string, right: string): number;
}

const SUPPORTED_VERSION = 1;

/**
 * Validate and index a metrics document.
 *
 * **Throws on a version it does not recognise**, which is the fail-fast-at-init rule
 * earning its keep: the alternative is reading a field that moved and drawing text that is
 * subtly misplaced, and misplaced text looks like a layout bug for as long as it takes to
 * suspect the file.
 *
 * Required numeric fields fail at load, not draw: `unitsPerEm` scales every plane and atlas
 * coordinate, so a missing one produces wrong sizes that look plausible until a frame lands
 * beside a reference and they do not match. Every other required field is checked the same way.
 */
export function parseSdfFont(document: unknown): SdfFont {
  if (typeof document !== 'object' || document === null) {
    throw new Error('parseSdfFont: expected a metrics object');
  }
  const source = document as Record<string, unknown>;
  if (source['version'] !== SUPPORTED_VERSION) {
    throw new Error(
      `parseSdfFont: metrics version ${String(source['version'])}, this build reads ${SUPPORTED_VERSION}`,
    );
  }

  if (typeof source['atlas'] !== 'object' || source['atlas'] === null) {
    throw new Error('parseSdfFont: atlas field must be an object');
  }
  const atlas = source['atlas'] as Record<string, unknown>;

  if (typeof source['metrics'] !== 'object' || source['metrics'] === null) {
    throw new Error('parseSdfFont: metrics field must be an object');
  }
  const metrics = source['metrics'] as Record<string, unknown>;

  if (typeof source['glyphs'] !== 'object' || source['glyphs'] === null) {
    throw new Error('parseSdfFont: glyphs field must be an object');
  }
  const glyphs = source['glyphs'] as Record<string, SdfGlyph>;

  const kerning = (source['kerning'] ?? {}) as Record<string, number>;

  // Validate required numeric fields
  const requiredMetricsFields = ['unitsPerEm', 'ascender', 'descender', 'lineHeight'] as const;
  for (const field of requiredMetricsFields) {
    if (typeof metrics[field] !== 'number') {
      throw new Error(`parseSdfFont: metrics.${field} is required and must be a number`);
    }
  }

  const requiredAtlasFields = ['distanceRange', 'width', 'height'] as const;
  for (const field of requiredAtlasFields) {
    if (typeof atlas[field] !== 'number') {
      throw new Error(`parseSdfFont: atlas.${field} is required and must be a number`);
    }
  }

  return {
    family: String(source['family'] ?? 'unnamed'),
    unitsPerEm: metrics['unitsPerEm'] as number,
    ascender: metrics['ascender'] as number,
    descender: metrics['descender'] as number,
    lineHeight: metrics['lineHeight'] as number,
    distanceRange: atlas['distanceRange'] as number,
    atlasWidth: atlas['width'] as number,
    atlasHeight: atlas['height'] as number,
    runs: multiCharacterKeys(glyphs),
    glyph(character: string): SdfGlyph | null {
      return glyphs[character] ?? null;
    },
    kerning(left: string, right: string): number {
      return kerning[`${left}\u0000${right}`] ?? 0;
    },
  };
}

/**
 * Every key that spans more than one UTF-16 unit, longest first.
 *
 * Length in UTF-16 units rather than code points, because the one consumer of this order
 * is `String.prototype.startsWith`, which counts the same way. Ties break lexicographically
 * so that the order is a property of the table and not of the order it was written in: an
 * atlas is committed and diffed, and a list that reshuffled when a glyph was added would
 * make every rebake look like a change.
 */
function multiCharacterKeys(glyphs: Record<string, SdfGlyph>): readonly string[] {
  return Object.keys(glyphs)
    .filter((key) => key.length > 1)
    .sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0));
}
