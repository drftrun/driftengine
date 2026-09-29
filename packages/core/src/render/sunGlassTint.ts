/**
 * What the sun's light keeps of itself through glass: an RGBA8 array of two layers, static and
 * moving, beside the sun's depth array. RGB is the product of every pane's
 * `transmission × (1 − F) × tint`, A the product of their clarities (`glassShadow.ts`).
 *
 * **Cleared to white and drawn with a multiplying blend and no depth test**, so every pane on a ray
 * contributes and the order they come in cannot matter. **Mipmapped and filtered**, unlike the
 * depths beside it: a frosted pane's colour is read at the level its spread asks for, so a wide
 * spread is smooth rather than a scatter of taps — the chain is rebuilt after every draw of a layer.
 * `'half'` makes it half the depth map's size and nothing else changes: the light matrix is the
 * same, so a texel is a texel of the same place, only larger.
 */
export class SunGlassTint {
  readonly size: number;
  readonly texture: WebGLTexture;
  private readonly framebuffer: WebGLFramebuffer;

  constructor(gl: WebGL2RenderingContext, size: number) {
    this.size = size;
    const texture = gl.createTexture();
    const framebuffer = gl.createFramebuffer();
    if (texture === null || framebuffer === null) {
      throw new Error('SunGlassTint: the tint target could not be created');
    }
    this.texture = texture;
    this.framebuffer = framebuffer;
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, mipLevels(size), gl.RGBA8, size, size, 2);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
    /* Both layers born clear: a layer no pane has reached lets everything through. */
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    for (let layer = 0; layer < 2; layer++) {
      gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, texture, 0, layer);
      gl.clearBufferfv(gl.COLOR, 0, CLEAR);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.fillMips(gl);
  }

  /** Bind `layer` (0 static, 1 moving), clear it to white, and set the multiplying state. */
  begin(gl: WebGL2RenderingContext, layer: number): void {
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, this.texture, 0, layer);
    gl.viewport(0, 0, this.size, this.size);
    gl.clearBufferfv(gl.COLOR, 0, CLEAR);
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    gl.blendFuncSeparate(gl.DST_COLOR, gl.ZERO, gl.DST_ALPHA, gl.ZERO);
  }

  /** Put back what `begin` changed, and rebuild the mip chain the frost reads. */
  end(gl: WebGL2RenderingContext): void {
    gl.disable(gl.BLEND);
    gl.depthMask(true);
    gl.enable(gl.DEPTH_TEST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.fillMips(gl);
  }

  /** Every level from level 0, both layers: bound on the active unit and handed back. */
  private fillMips(gl: WebGL2RenderingContext): void {
    const previous = gl.getParameter(gl.TEXTURE_BINDING_2D_ARRAY) as WebGLTexture | null;
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.texture);
    gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, previous);
  }

  dispose(gl: WebGL2RenderingContext): void {
    gl.deleteFramebuffer(this.framebuffer);
    gl.deleteTexture(this.texture);
  }
}

const CLEAR = new Float32Array([1, 1, 1, 1]);

/** A full chain down to one texel. */
function mipLevels(size: number): number {
  return Math.floor(Math.log2(Math.max(1, size))) + 1;
}
