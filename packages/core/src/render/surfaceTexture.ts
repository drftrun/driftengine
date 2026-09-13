/** A GPU image the caller supplies, sampled by the flat shader as surface colour. */

/**
 * How a texture behaves past its edges and between its texels.
 *
 * Deliberately small. Every knob here is one a tiling world actually needs; anything
 * beyond it — swizzles, borders, compressed formats — is a format decision that
 * belongs to whoever is generating the pixels, not to the surface that shows them.
 */
/**
 * Everything the flat pass needs to know about a surface, in one call.
 *
 * **Shaped for what comes after it.** ORM is the next map and emissive the one after; both are a
 * field here rather than a fourth and fifth setter, which is the whole reason this replaced
 * `setSurfaceTexture` rather than sitting beside it. A consumer setting four maps in four calls is
 * four chances to forget one, and four resets `bindMeshPass` has to reason about.
 *
 * **Every field is independent.** A material with a `normal` and no `albedo` is a legitimate one —
 * vertex colour with authored normals — and shades as such rather than as no material at all.
 *
 * **Generic over the texture, for the reason `SurfaceTextureHandle` exists.** The two backends have
 * different texture classes and the public API speaks in an opaque handle; parameterising here lets
 * each renderer take its own concrete type while a consumer sees one shape. Defaulted to the
 * WebGL2 class so the common spelling stays `SurfaceMaterial`.
 */
export interface SurfaceMaterial<Texture = SurfaceTexture> {
  albedo?: Texture | null;
  /**
   * Surface-space directions, turned into world space through the mesh's tangent frame.
   *
   * Read by the flat pass since 2026-08-22, from the attribute at location 10 where the mesh has
   * one and from a per-fragment cotangent frame where it does not. `normalStrength` gates it.
   * See `docs/RENDERING.md` for the normal-map path.
   */
  normal?: Texture | null;
  /**
   * Occlusion in R, roughness in G, metallic in B, in one image.
   *
   * glTF's packing, because that is what an import carries, and one unit for three channels rather
   * than three units for three maps. Sampled linear and never sRGB: these numbers *are* the data.
   */
  orm?: Texture | null;
  /**
   * Where a surface glows, and in what colour.
   *
   * **It modulates the surface's own emission rather than creating it**, which is glTF's rule
   * — emitted colour is `emissiveFactor * emissiveTexture` — and is the one thing about this map
   * that surprises people. A mesh whose `emissive` attribute is 0 emits nothing however bright
   * the image it binds, because there is nothing for the image to scale. An import carries the
   * factor for you: `gltf.ts` puts `max(emissiveFactor)` in the attribute and the factor itself
   * in `emissiveColor`. A procedurally built mesh has to say so the same way it says its colour,
   * which is in vertex data, because that is what makes a whole world one draw call here.
   *
   * Sampled **sRGB**, unlike `normal` and `orm`: this one is a colour a person picked, where
   * those two are numbers. glTF says the same.
   */
  emissive?: Texture | null;
  /** Repeats across the mesh's own UV range, per axis. Applies to every map the material holds. */
  uScale?: number;
  vScale?: number;
  /** Alpha below which a fragment is discarded. See `uAlbedoCutout`. */
  cutout?: number;
  /**
   * How hard the normal map turns the shading normal.
   *
   * **Defaults to 1 when a `normal` is supplied and 0 when it is not**, because binding a map and
   * saying nothing about strength means "use it" rather than "use it at nothing".
   */
  normalStrength?: number;
  /**
   * Scales the ORM map's G channel. glTF's `roughnessFactor`. Default 1.
   *
   * The map *replaces* the mesh's own roughness attribute rather than scaling it, and this is what
   * gives back the scaling. Scaling the attribute was the alternative and it is wrong outside an
   * import: `vertexDefaults.ts` hands an absent roughness **0.4277**, not 1, so every procedurally
   * built mesh would read far glossier than the image it was handed, with nothing in the API to
   * say it would.
   */
  roughnessScale?: number;
  /** Scales the ORM map's B channel. glTF's `metallicFactor`. Default 1. */
  metallicScale?: number;
  /**
   * How much of the ORM map's R channel to apply. glTF's `occlusionTexture.strength`. Default 1.
   *
   * **0 is no occlusion, not full occlusion.** glTF defines it as `1 + strength * (texel - 1)`, so
   * the shader mixes from 1 rather than multiplying — a multiply at 0 would black the surface out,
   * which is the opposite of what the caller asked for.
   */
  occlusionStrength?: number;
  /**
   * Scales the emissive map, per channel. Default 1.
   *
   * The counterpart of `roughnessScale` and `metallicScale`: a factor that multiplies a texture is
   * not a value, and this is where the multiplier lives once an image supplies the shape. A
   * consumer who wants a bound map twice as bright asks here rather than rebuilding the mesh.
   */
  emissiveScale?: readonly [number, number, number];
}

export interface SurfaceTextureOptions {
  /**
   * `repeat` tiles the image, `clamp` stretches its edge texels.
   *
   * Repeat is the default because the case this exists for is a wall: one small image
   * covering a large surface, with `uvScale` deciding how often it lands. Clamp is for
   * an image that is a *picture* — a portrait, a sign — where a second copy of it
   * appearing past the edge is a bug rather than a pattern.
   */
  wrap?: 'repeat' | 'clamp';
  /**
   * How the image's values are encoded, so the shader can sample light rather than pixels.
   *
   * `linear` is the default and the old behaviour: the bytes are handed to the shader as
   * they are. That is right for a mask, a height field, anything whose numbers *are* the
   * data.
   *
   * `srgb` is right for anything that was authored to be looked at — a photo, a painted
   * canvas, a biome tile. Those bytes are display values, and shading maths is linear, so
   * multiplying a light into them without decoding first is a category error: mid-greys
   * come out roughly twice as bright as they should, and the mistake is invisible until an
   * output transform is applied and everything blows out at once. The GPU decodes
   * `SRGB8_ALPHA8` in the sampler, so this costs nothing per fetch and, unlike decoding in
   * the shader, it happens *before* filtering — which is the only place it is correct.
   */
  colorSpace?: 'linear' | 'srgb';
  /**
   * How a texel is chosen when the image is magnified: smoothed between texels, or taken whole.
   *
   * **`linear` is the default and is every surface that shipped before this**, which is right for
   * anything photographic: a wall, a painted canvas, a biome tile, where the texel grid is an
   * artefact of resolution rather than the subject.
   *
   * `nearest` is for an image whose *pixels are the subject* — pixel art, an icon atlas, a
   * hand-authored tile. **Reported by a consumer whose block atlas is exactly that**: linear
   * magnification turns an authored tile into a smear as the camera approaches, and there was no
   * way to ask for anything else. They composed their atlas with `imageSmoothingEnabled = false`
   * and kept tiles at twice the resolution they wanted, and neither touches magnification — the
   * smoothing happens in the sampler, after everything a caller controls.
   *
   * **Minification still blends between mip levels**, and that is not the option being ignored. A
   * tiled floor at a grazing angle minifies far past one texel per pixel, which is what mips exist
   * for; taking the nearest *level* as well would trade a smear for a visible pop as the camera
   * pulls back. So the choice applies where it was asked about, and within a level either way.
   *
   * `@driftengine/ui2d` takes the same option and defaults it the other way, because a sprite sheet
   * is usually pixel art and a world surface usually is not.
   */
  filter?: 'linear' | 'nearest';
  /**
   * Build a mip chain. On by default, and it is not a quality preference.
   *
   * A tiled surface seen at a grazing angle — which is every floor and every corridor
   * wall — minifies far past one texel per pixel, and without mips that undersampling
   * is aliasing that *crawls* as the camera moves. It is the single most visible
   * artefact a textured world can have. Off is for a texture drawn at roughly its own
   * size, where the chain is memory spent on levels nothing will sample.
   */
  mipmap?: boolean;
  /**
   * Anisotropic samples, when the extension is present. 1 disables it.
   *
   * Mips fix the crawling and cost sharpness: a floor stretching to the horizon picks
   * its mip from the *worse* of the two axes, so it blurs along the one that was still
   * well sampled. Anisotropy is the standard repair, it is cheap at these sizes, and
   * on a machine without the extension the clamp below silently leaves it at 1.
   */
  anisotropy?: number;
}

const DEFAULT_ANISOTROPY = 4;

/**
 * An image uploaded once and bound per draw.
 *
 * The engine ships no image assets and fetches nothing — that payload rule is intact
 * and this does not weaken it. What it takes is a `TexImageSource` the *consumer*
 * already has: a canvas it generated procedurally at runtime, an `ImageBitmap` it
 * decoded, a video frame. The engine owns the GPU object and the sampler state; where
 * the pixels came from is the caller's business and stays that way.
 */
export class SurfaceTexture {
  private texture: WebGLTexture | null;
  private readonly mipmapped: boolean;
  /** Whether the sampler decodes sRGB on fetch. See `colorSpace`. */
  private readonly srgb: boolean;

  constructor(
    gl: WebGL2RenderingContext,
    source: TexImageSource,
    options: SurfaceTextureOptions = {},
  ) {
    const texture = gl.createTexture();
    if (texture === null) throw new Error('SurfaceTexture: createTexture failed');
    this.texture = texture;
    this.mipmapped = options.mipmap ?? true;
    this.srgb = (options.colorSpace ?? 'linear') === 'srgb';

    const wrap = (options.wrap ?? 'repeat') === 'repeat' ? gl.REPEAT : gl.CLAMP_TO_EDGE;

    gl.bindTexture(gl.TEXTURE_2D, texture);
    /*
     * **Not flipped, and this used to be, which is the bug it is written down for.**
     *
     * The flip was here with a comment saying every source is a 2D drawing surface whose Y
     * runs down from the top-left, so without it "every texture arrives mirrored". That is
     * true of a canvas and **WebGL ignores `UNPACK_FLIP_Y_WEBGL` entirely for an
     * `ImageBitmap`**, which carries its own orientation. So the two source types the same
     * method accepts arrived the opposite way up from each other, and nothing caught it
     * because every canvas-sourced texture in this repository was symmetric under a vertical
     * flip: eroded noise, a radial halo, a sleeve blurred to 24 pixels and back. One consumer
     * painted lettering to a canvas beside a sleeve decoded as a bitmap and the text was
     * upside down.
     *
     * **Made to agree by dropping the flip rather than by extending it**, and the direction
     * is a deliberate choice about blast radius rather than a coin toss: `drftLoader` builds
     * every model texture from an `ImageBitmap`, so flipping bitmaps to match canvases would
     * turn over every painted surface on every loaded model. Dropping it changes only
     * canvas-sourced textures, and every one of those that exists today is symmetric.
     *
     * A caller that was mirroring its own canvas to cancel this must stop.
     */
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      this.srgb ? gl.SRGB8_ALPHA8 : gl.RGBA,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      source,
    );

    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
    /* Nearest where the caller said their pixels are the subject; see `filter`. The mip chain is
       still blended between levels, because that is minification and this option is about
       magnification. */
    const nearest = options.filter === 'nearest';
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, nearest ? gl.NEAREST : gl.LINEAR);
    gl.texParameteri(
      gl.TEXTURE_2D,
      gl.TEXTURE_MIN_FILTER,
      this.mipmapped
        ? nearest
          ? gl.NEAREST_MIPMAP_LINEAR
          : gl.LINEAR_MIPMAP_LINEAR
        : nearest
          ? gl.NEAREST
          : gl.LINEAR,
    );

    if (this.mipmapped) gl.generateMipmap(gl.TEXTURE_2D);
    applyAnisotropy(gl, options.anisotropy ?? DEFAULT_ANISOTROPY);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  /**
   * Replace the pixels, keeping the GPU object and its sampler state.
   *
   * For a source that changes — a canvas being redrawn, a decoded frame. Re-uploading
   * beats constructing a second texture because the binding the caller already handed
   * to a draw stays valid, and because a texture created per frame is a leak in every
   * case where the caller forgets the matching dispose.
   *
   * Not a hot path: it re-uploads the whole image and regenerates the chain. A caller
   * doing this every frame at any size wants to know that it costs what it costs.
   */
  update(gl: WebGL2RenderingContext, source: TexImageSource): void {
    if (this.texture === null) return;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    /* Unflipped, matching the constructor. See it for why, and for what it cost. */
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      this.srgb ? gl.SRGB8_ALPHA8 : gl.RGBA,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      source,
    );
    if (this.mipmapped) gl.generateMipmap(gl.TEXTURE_2D);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  /** Bind to a unit for sampling. Engine-internal: the renderer owns unit assignment. */
  bind(gl: WebGL2RenderingContext, unit: number): void {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
  }

  dispose(gl: WebGL2RenderingContext): void {
    if (this.texture === null) return;
    gl.deleteTexture(this.texture);
    this.texture = null;
  }
}

/**
 * Set anisotropic filtering when the driver offers it, and stay silent when it does not.
 *
 * Silent because the extension is an enhancement with an exact fallback — the same
 * texture, filtered isotropically — so a machine without it renders a slightly softer
 * floor rather than a broken one. Nothing here should fail init over that.
 */
function applyAnisotropy(gl: WebGL2RenderingContext, requested: number): void {
  if (requested <= 1) return;
  const ext =
    gl.getExtension('EXT_texture_filter_anisotropic') ??
    gl.getExtension('WEBKIT_EXT_texture_filter_anisotropic');
  if (ext === null) return;
  const max = gl.getParameter(ext.MAX_TEXTURE_MAX_ANISOTROPY_EXT) as number;
  gl.texParameterf(gl.TEXTURE_2D, ext.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(requested, max));
}
