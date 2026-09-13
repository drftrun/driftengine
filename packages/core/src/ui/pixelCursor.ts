/**
 * Pixel art from a string grid, as a CSS cursor value.
 *
 * Generated rather than shipped as a PNG. Two reasons, and the second is the
 * one that matters: a generated cursor costs no asset and no request, and it
 * can be recoloured at runtime — so it belongs to whatever palette the game is
 * currently wearing instead of being a fixed image that clashes with half of
 * them.
 *
 * Rendered at the device pixel ratio and declared through `image-set`, so it is
 * crisp on a retina display. A bitmap authored at 1x is upscaled smoothly by
 * the browser, which is precisely the wrong thing to do to pixel art.
 */
export interface PixelCursorOptions {
  /** Device-independent pixels per art pixel. */
  readonly scale?: number;
  /** The art pixel that sits under the pointer. Defaults to the centre. */
  readonly hotspotX?: number;
  readonly hotspotY?: number;
  /** Keyword used when the image cannot be built. */
  readonly fallback?: string;
}

/**
 * @param rows one string per row; each character indexes `palette`.
 * @param palette character → CSS colour. A character absent from it is
 *   transparent, which is what makes `' '` the natural empty cell.
 */
export function pixelCursor(
  rows: readonly string[],
  palette: Readonly<Record<string, string>>,
  options: PixelCursorOptions = {},
): string {
  const fallback = options.fallback ?? 'auto';
  const height = rows.length;
  const width = rows[0]?.length ?? 0;
  if (width === 0 || height === 0) return fallback;

  const scale = Math.max(1, Math.round(options.scale ?? 3));
  const dpr = Math.max(1, Math.round(globalThis.devicePixelRatio ?? 1));

  const cssWidth = width * scale;
  const cssHeight = height * scale;
  const hotspotX = Math.round((options.hotspotX ?? (width - 1) / 2) * scale);
  const hotspotY = Math.round((options.hotspotY ?? (height - 1) / 2) * scale);

  const url = render(rows, palette, cssWidth * dpr, cssHeight * dpr, scale * dpr);
  if (url === null) return fallback;

  /*
   * `image-set` carries the pixel ratio the image was drawn at, so the browser
   * displays it at the right physical size instead of treating device pixels as
   * CSS pixels and rendering a cursor a third of the intended size.
   *
   * The bare `url()` in front is the fallback for engines without image-set in
   * `cursor`; there the image is oversized on retina rather than absent, which
   * is the better of the two failures.
   */
  const hotspot = `${hotspotX} ${hotspotY}`;
  if (dpr === 1) return `url(${url}) ${hotspot}, ${fallback}`;
  return `image-set(url(${url}) ${dpr}x) ${hotspot}, url(${url}) ${hotspot}, ${fallback}`;
}

function render(
  rows: readonly string[],
  palette: Readonly<Record<string, string>>,
  pixelWidth: number,
  pixelHeight: number,
  cellSize: number,
): string | null {
  let canvas: HTMLCanvasElement;
  try {
    canvas = document.createElement('canvas');
  } catch {
    return null;
  }
  canvas.width = pixelWidth;
  canvas.height = pixelHeight;
  const ctx = canvas.getContext('2d');
  if (ctx === null) return null;

  for (let y = 0; y < rows.length; y++) {
    const row = rows[y] ?? '';
    for (let x = 0; x < row.length; x++) {
      const colour = palette[row[x] ?? ''];
      if (colour === undefined) continue;
      ctx.fillStyle = colour;
      // Filled as whole cells rather than drawn small and scaled up: this is
      // what keeps the edges hard at any ratio.
      ctx.fillRect(x * cellSize, y * cellSize, cellSize, cellSize);
    }
  }

  try {
    return canvas.toDataURL('image/png');
  } catch {
    return null;
  }
}
