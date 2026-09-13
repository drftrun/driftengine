/**
 * 1x1 placeholders for sampler slots a pass declares but does not use.
 *
 * A shader's sampler uniforms exist whether or not the feature behind them is switched
 * on: the flat pass declares three directional shadow maps and twelve cubemaps, and a
 * quality profile with shadows off still compiles every one of them. The obvious way to
 * say "there is nothing here" is to bind `null` to the unit, and it is wrong.
 *
 * A sampler bound to no texture is *incomplete*. The GL spec says sampling one yields
 * zero, which sounds like a safe default and is only safe if the sample never executes.
 * The guards in this engine are runtime values — `uShadowStrength <= 0.0`, an index
 * compared against -1 — so a driver is free to fetch the descriptor before it evaluates
 * the branch that would have skipped it. Descriptor fetches are scalar loads, and a
 * descriptor for a texture that does not exist is not guaranteed to point anywhere.
 *
 * On a Radeon RX 9070 XT (RDNA4, Mesa 25.2.8) that read lands outside the process's GPU
 * address space and faults:
 *
 *   amdgpu: [gfxhub] page fault ... Faulty UTCL2 client ID: SQC (data)
 *   amdgpu: ring gfx_0.0.0 timeout -> Ring gfx_0.0.0 reset -> device wedged
 *
 * The context dies, the compositor stalls for a second or two while the driver resets the
 * card, and nothing in the API reports an error — the page simply loses its context a few
 * seconds in. Binding a real texture costs one 1x1 upload per renderer and removes the
 * question: every declared sampler has something complete behind it, whether the pass
 * reads it or not. three.js keeps an empty texture per target for the same reason.
 *
 * Not a workaround for one card. An incomplete sampler is undefined territory that
 * happens to be survivable on most drivers, and this makes the engine stop relying on
 * that.
 */

/** Opaque black, which is what a shadow lookup should read where nothing occludes. */
const ONE_BLACK_TEXEL = new Uint8Array([0, 0, 0, 255]);

/** Full depth, which is the far plane: an occluder as far away as the light reaches. */
const ONE_WHITE_TEXEL = new Uint8Array([255]);

function allocate(gl: WebGL2RenderingContext, label: string): WebGLTexture {
  const texture = gl.createTexture();
  if (texture === null) throw new Error(`${label}: createTexture failed`);
  return texture;
}

/**
 * A complete 1x1 texture for any unused `sampler2D` slot.
 *
 * `NEAREST` and `CLAMP_TO_EDGE` because a single texel has no mip chain: leaving the
 * default `LINEAR_MIPMAP_LINEAR` minification filter on a texture with only level 0 makes
 * it incomplete again, which is the exact state this exists to avoid.
 */
export function createEmptyTexture2D(gl: WebGL2RenderingContext): WebGLTexture {
  const texture = allocate(gl, 'emptyTexture2D');
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, ONE_BLACK_TEXEL);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return texture;
}

/**
 * The same for an unused `sampler2DArray` slot: one layer, one texel.
 *
 * The point-shadow array exists only once a world has said how many lights it has, and a scene is
 * free to draw before it does. One layer rather than the full pool's worth, because nothing reads
 * it: `uPointShadowLayer` is −1 for every light while this is bound, and the layer index never
 * reaches a fetch. It is here to be *complete*, which is the whole subject of this file.
 *
 * White rather than black, matching the one-texel cube the WebGPU side keeps and for its reason:
 * a full-depth texel reads as an occluder at the far plane, so the worst a lookup that should not
 * have happened can do is find nothing in the way. Zeroes would mean an occluder pressed against
 * every lamp, and every surface in the scene in shadow.
 */
export function createEmptyTexture2DArray(gl: WebGL2RenderingContext): WebGLTexture {
  const texture = allocate(gl, 'emptyTexture2DArray');
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture);
  gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.R8, 1, 1, 1);
  gl.texSubImage3D(
    gl.TEXTURE_2D_ARRAY,
    0,
    0,
    0,
    0,
    1,
    1,
    1,
    gl.RED,
    gl.UNSIGNED_BYTE,
    ONE_WHITE_TEXEL,
  );
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
  return texture;
}

/**
 * The same for an unused `samplerCube` slot.
 *
 * All six faces are supplied: a cubemap missing any one of them is incomplete however
 * complete the other five are.
 */
export function createEmptyTextureCube(gl: WebGL2RenderingContext): WebGLTexture {
  const texture = allocate(gl, 'emptyTextureCube');
  gl.bindTexture(gl.TEXTURE_CUBE_MAP, texture);
  for (let face = 0; face < 6; face++) {
    gl.texImage2D(
      gl.TEXTURE_CUBE_MAP_POSITIVE_X + face,
      0,
      gl.RGBA,
      1,
      1,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      ONE_BLACK_TEXEL,
    );
  }
  gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_CUBE_MAP, null);
  return texture;
}
