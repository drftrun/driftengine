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
}

export const DEFAULT_SPRITE_TEXTURE_OPTIONS: SpriteTextureOptions = {
  colorSpace: 'srgb',
  filter: 'nearest',
};
