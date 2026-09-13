import {
  GLYPH_HEIGHT,
  GLYPH_SPACING,
  GLYPH_WIDTH,
  forEachCell,
  measureText,
} from '../geometry/pixelFont.ts';

/**
 * Baking a mark into a still image sized to a video frame.
 *
 * Everything is placed and sized in **fractions of the frame**, never pixels.
 * That is the whole point of the module: the same overlay has to read correctly
 * at 1080x1920 and at 720x1280, and a mark laid out in pixels is either
 * illegible at the smaller size or covers a quarter of the smaller frame. Text
 * scales against the frame's *shorter* side so a portrait and a landscape
 * export get a mark of the same apparent size rather than one that grows with
 * whichever dimension happens to be long.
 *
 * Baked once, drawn once per captured frame. Painting a few hundred glyph cells
 * per frame would be thirty times the work for an image that never changes.
 *
 * Nothing here knows what the mark says. Text, colour and position are the
 * caller's; the font is the engine's 5x7 grid, so a mark needs no asset and
 * cannot fail to load.
 */
export interface OverlayText {
  readonly text: string;
  /** Left edge, as a fraction of frame width. */
  readonly x: number;
  /** Top edge, as a fraction of frame height. */
  readonly y: number;
  /** One glyph cell, as a fraction of the frame's shorter side. */
  readonly cell: number;
  readonly color: string;
  readonly alpha?: number;
}

/** Anything a 2D context can draw and report a natural size for. */
export type OverlayImageSource = HTMLImageElement | HTMLCanvasElement | ImageBitmap;

export interface OverlayImage {
  readonly image: OverlayImageSource;
  readonly x: number;
  readonly y: number;
  /** Drawn height, as a fraction of the frame's shorter side. */
  readonly height: number;
  readonly alpha?: number;
}

export interface FrameOverlay {
  readonly texts?: readonly OverlayText[];
  readonly images?: readonly OverlayImage[];
}

/**
 * How far the shadow sits behind the mark, in cells.
 *
 * A watermark has to survive both a night sky and a noon one. Light type alone
 * disappears against a bright horizon — which in this game is most of the frame
 * — so every glyph is stamped once in near-black first. One cell of offset,
 * because a blur would fight the hard-edged look everything else has.
 */
const SHADOW_CELLS = 1;
const SHADOW_COLOR = 'rgba(2, 5, 10, 0.55)';

/** Lit cells of a string, at a cell size in device pixels. */
export function drawPixelText(
  ctx: CanvasRenderingContext2D,
  text: string,
  left: number,
  top: number,
  cell: number,
  color: string,
): void {
  const height = GLYPH_HEIGHT * cell;
  const paint = (dx: number, dy: number, fill: string): void => {
    ctx.fillStyle = fill;
    forEachCell(text, (cx, cy) => {
      // Cell y counts up from the baseline; a canvas counts down from the top.
      ctx.fillRect(
        left + dx + cx * cell,
        top + dy + height - (cy + 1) * cell,
        // A hair of overlap, or antialiasing draws a seam between adjacent
        // cells and the letters look woven rather than solid.
        cell + 0.5,
        cell + 0.5,
      );
    });
  };

  paint(SHADOW_CELLS * cell, SHADOW_CELLS * cell, SHADOW_COLOR);
  paint(0, 0, color);
}

/** Pixel width and height of a string at a given cell size. */
export function pixelTextSize(text: string, cell: number): { width: number; height: number } {
  return { width: measureText(text) * cell, height: GLYPH_HEIGHT * cell };
}

/** Cells a string occupies horizontally, including inter-glyph gaps. */
export function pixelTextCells(text: string): number {
  return text.length === 0 ? 0 : text.length * (GLYPH_WIDTH + GLYPH_SPACING) - GLYPH_SPACING;
}

/**
 * Paint an overlay into a transparent canvas of exactly the frame's size.
 *
 * Returns null when there is nothing to draw, so a caller can skip the
 * composite entirely rather than blending a blank layer over every frame.
 */
export function bakeOverlay(
  overlay: FrameOverlay,
  width: number,
  height: number,
): HTMLCanvasElement | null {
  const texts = overlay.texts ?? [];
  const images = overlay.images ?? [];
  if (texts.length === 0 && images.length === 0) return null;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (ctx === null) return null;

  const short = Math.min(width, height);
  for (const image of images) {
    const drawHeight = image.height * short;
    const natural = imageAspect(image.image);
    ctx.globalAlpha = image.alpha ?? 1;
    ctx.drawImage(image.image, image.x * width, image.y * height, drawHeight * natural, drawHeight);
  }
  for (const text of texts) {
    ctx.globalAlpha = text.alpha ?? 1;
    /*
     * Snapped to whole pixels. A 5x7 grid drawn on a half-pixel boundary is
     * antialiased on every cell edge, which turns a hard-edged mark into a grey
     * smudge — the one thing a watermark cannot be, since it is small by design.
     */
    drawPixelText(
      ctx,
      text.text,
      Math.round(text.x * width),
      Math.round(text.y * height),
      text.cell * short,
      text.color,
    );
  }
  ctx.globalAlpha = 1;
  return canvas;
}

function imageAspect(image: OverlayImageSource): number {
  const width = image instanceof HTMLImageElement ? image.naturalWidth || image.width : image.width;
  const height =
    image instanceof HTMLImageElement ? image.naturalHeight || image.height : image.height;
  return height > 0 ? width / height : 1;
}
