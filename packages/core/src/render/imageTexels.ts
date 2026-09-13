/**
 * An image's texels, exactly as they were encoded — which a canvas cannot give you.
 *
 * **Every ordinary way of reading an image back in a browser is lossy where alpha varies, and this
 * was measured rather than assumed.** A 2D canvas stores colour *premultiplied*: `drawImage`
 * multiplies each channel by the alpha and `getImageData` divides it back out, so every value
 * round-trips through `round(round(c * a / 255) * 255 / a)`. WebCodecs is no better — Chrome
 * decodes a WebP with alpha to a premultiplied `BGRA` frame, and `VideoFrame.copyTo` un-premultiplies
 * it, arriving at the same arithmetic. Both were run against a lossless WebP whose values are known:
 * worst channel off by **3 of 255**, and every deviation predicted exactly by that expression.
 *
 * The one route that is exact is a texture upload with the unpack flag off and a read back, and
 * that is what this is: 0 of 255 on the same file.
 *
 * **For a picture none of this matters and for data it is a corruption.** The case it was found on
 * is a `.sog` Gaussian capture, whose `sh0` image carries three *codebook indices* in RGB beside an
 * opacity in alpha — so a premultiplying read lands the index several entries away wherever a
 * Gaussian is transparent, and the capture's colours come back tied to its own transparency. Any
 * image used as a lookup rather than as a picture has the same problem.
 *
 * **Here rather than in the package that needed it**, because `AGENTS.md` allows raw WebGL only
 * under `packages/core/src/render/` and this is raw WebGL. `@driftengine/splats` takes a decoder as
 * a parameter for exactly this reason and a consumer hands it this one.
 *
 * **What it costs, stated because the driver says it out loud**: `readPixels` synchronises the
 * pipeline, and Chrome logs *"GPU stall due to ReadPixels"* once per image. That is the price of
 * exactness and it is paid at load rather than per frame — five stalls for a Gaussian capture,
 * none afterwards. Nothing here belongs in a frame, and `AGENTS.md`'s rule about the hot path is
 * the reason this is a loader and not a per-frame utility.
 */

/** One decoded image: 8-bit RGBA, row-major from the top left, unpremultiplied. */
export interface ImageTexels {
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8Array;
}

/** What turns an encoded image's bytes into texels. */
export type ImageTexelDecoder = (bytes: Uint8Array, type?: string) => Promise<ImageTexels>;

/**
 * A decoder that reads texels back exactly, over a context of its own.
 *
 * **One context for every image it decodes**, created on the first call and kept: a WebGL context
 * is a scarce resource — browsers cap them somewhere around sixteen — and one per image is a
 * capture that stops decoding partway through with a context-lost warning.
 *
 * `preserveDrawingBuffer` is not set and nothing is ever drawn: the texture is attached to a
 * framebuffer and read, which is the whole pipeline. `antialias: false` and `depth: false` because
 * neither is allocated for a path that rasterises nothing.
 */
export function createImageTexelDecoder(): ImageTexelDecoder {
  let gl: WebGL2RenderingContext | null = null;
  let texture: WebGLTexture | null = null;
  let framebuffer: WebGLFramebuffer | null = null;

  return async (bytes: Uint8Array, type = 'image/webp'): Promise<ImageTexels> => {
    const bitmap = await createImageBitmap(new Blob([bytes as unknown as BlobPart], { type }), {
      /* Both off, and both matter. Premultiplying here is the loss this module exists to avoid;
         a colour-space conversion would rewrite values that are not colours at all. */
      premultiplyAlpha: 'none',
      colorSpaceConversion: 'none',
    });

    if (gl === null) {
      const canvas =
        typeof OffscreenCanvas === 'undefined'
          ? (document.createElement('canvas') as HTMLCanvasElement)
          : new OffscreenCanvas(1, 1);
      gl = canvas.getContext('webgl2', {
        alpha: true,
        antialias: false,
        depth: false,
        stencil: false,
      }) as WebGL2RenderingContext | null;
      if (gl === null) {
        bitmap.close();
        throw new Error(
          'createImageTexelDecoder: no WebGL2 context, and no other browser API reads an ' +
            'image back without premultiplying it. Supply a decoder of your own.',
        );
      }
      texture = gl.createTexture();
      framebuffer = gl.createFramebuffer();
    }

    const width = bitmap.width;
    const height = bitmap.height;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
    bitmap.close();

    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      throw new Error('createImageTexelDecoder: this driver will not read back an RGBA8 texture.');
    }
    const rgba = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    return { width, height, rgba };
  };
}
