/** What a caller hands over as a sprite texture, and what it says about it. */

/**
 * The three sources both backends take without a conversion.
 *
 * Narrower than `TexImageSource` on purpose. WebGPU's `copyExternalImageToTexture` refuses an
 * `ImageData` outright, and an `HTMLImageElement` is accepted by only some implementations — so
 * the union that is honestly portable is a bitmap and the two canvases. A caller with an `<img>`
 * reaches this through one `createImageBitmap`, which is also where the decode's own orientation
 * and premultiply options live, and those are decisions worth making in the open.
 *
 * All three carry their own `width` and `height`, which is the other reason: nothing here has to
 * ask the caller how big the image it just handed over is.
 */
export type SpriteImage = ImageBitmap | HTMLCanvasElement | OffscreenCanvas;

export interface SpriteTextureOptions {
  /**
   * `srgb` is right for anything painted to be looked at, which is every sprite sheet — the
   * sampler decodes and the pass's own output transform re-encodes, so the blend happens in
   * linear light where it belongs. `linear` is for a sheet carrying data rather than colour: a
   * mask, a height, a flow field.
   *
   * The same name and the same two values `SurfaceTexture` already takes, so a consumer that has
   * uploaded a texture to the mesh path does not meet a second vocabulary here.
   */
  readonly colorSpace?: 'linear' | 'srgb';
  /**
   * `nearest` by default, and the default is the argument.
   *
   * A sprite sheet is usually pixel art, where linear filtering is the thing that makes it look
   * wrong; and a sheet that is *not* pixel art is normally drawn near its authored size, where
   * the two filters differ by very little. So the default costs the smooth case almost nothing
   * and saves the sharp case from a blur nobody asked for.
   */
  readonly filter?: 'nearest' | 'linear';
  /**
   * Whether to build a mip chain and sample it. `false` by default, which is the sheet above.
   *
   * **The case it exists for is type baked into an atlas.** The comment on `filter` says a sheet
   * that is not pixel art "is normally drawn near its authored size, where the two filters differ
   * by very little" — a glyph page is the sheet where that is not true. A consumer baking one page
   * per weight at 96 px and drawing body copy at 11 is minifying **7x**, and `linear` reads four
   * texels of a footprint that covers dozens: a `t` crossbar two texels tall lands on about a
   * quarter of a pixel, and whether it survives depends on where the sample falls. Reported by a
   * player as `Step-In Uppercut` reading `Slep-In Uppercul`, with different strokes lost per
   * glyph and per position, so the line looks unevenly spaced as well as misread.
   *
   * Neither workaround available to a consumer is good: baking nearer the drawn size blurs the
   * headings, because one atlas cannot serve an 8x range of sizes, and baking a second atlas for
   * small text doubles the pages and the uploads and moves a sampling decision into the game where
   * it has to be re-tuned whenever a size changes.
   *
   * **Off by default because the chain is wrong for pixel art**, which is what most sheets are: it
   * is memory nothing samples, and at a distance it dissolves art whose whole point is the pixel.
   *
   * With `filter: 'linear'` this is trilinear — blended within a level and between levels. With
   * `filter: 'nearest'` the levels are still blended, because that is minification and `filter` is
   * about magnification; `SurfaceTexture` makes the same split and for the same reason.
   *
   * **Padding cells against bleed is the caller's problem**, and it has to be: a lower level mixes
   * texels the atlas packer put next to each other, so a sheet whose frames touch will show its
   * neighbours. How much padding depends on how far the chain is allowed to go, which is a fact
   * about the sheet rather than about the sampler.
   */
  readonly mipmap?: boolean;
}

export const DEFAULT_SPRITE_TEXTURE_OPTIONS: SpriteTextureOptions = {
  colorSpace: 'srgb',
  filter: 'nearest',
  mipmap: false,
};
