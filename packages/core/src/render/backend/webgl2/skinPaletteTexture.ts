import { paletteTextureWidth, validateSkinPalette } from '../../skinPalette.ts';

/**
 * The joint palette as a one-row `RGBA32F` texture, on WebGL2.
 *
 * Its own module rather than more lines in a 5,000-line renderer, and because the decision it
 * implements — width, cap, unit — lives in `skinPalette.ts` where both backends read it, per the
 * 2026-08-13 rule. This is only the binding half.
 *
 * **One storage level and `NEAREST` both filters, so there is no mip to select.** That is what
 * makes `texelFetch` in the vertex stage honest: an integer coordinate, no level inferred, and
 * nothing for the 2026-08-07 derivative rule to govern — the same property `pointShadowMap.ts`
 * records for its own allocation.
 *
 * `RGBA32F` is a sized internal format WebGL2 core accepts for `texStorage2D`. It is not
 * texture-filterable without an extension, which costs nothing here because nothing filters it.
 */
export class SkinPaletteTexture {
  private texture: WebGLTexture | null = null;
  private joints = 0;

  /**
   * Upload a palette, reallocating only when the joint count changes.
   *
   * A rig's joint count is fixed for its life, so the reallocation path runs once per skeleton and
   * the steady state is one `texSubImage2D`. Reallocating per frame would be a GPU allocation in
   * the frame loop, which is the same class of mistake as allocating on the CPU there.
   */
  update(gl: WebGL2RenderingContext, palette: Float32Array): void {
    validateSkinPalette(palette);
    const joints = palette.length / 16;
    const width = paletteTextureWidth(joints);

    if (this.texture === null || this.joints !== joints) {
      if (this.texture !== null) gl.deleteTexture(this.texture);
      const created = gl.createTexture();
      if (created === null) throw new Error('skin palette: failed to create the palette texture');
      this.texture = created;
      this.joints = joints;
      gl.bindTexture(gl.TEXTURE_2D, created);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, width, 1);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    } else {
      gl.bindTexture(gl.TEXTURE_2D, this.texture);
    }

    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, 1, gl.RGBA, gl.FLOAT, palette);
  }

  /** Bind to a **vertex-stage** unit. See `SKIN_PALETTE_TEXTURE_UNIT` for why that is free. */
  bind(gl: WebGL2RenderingContext, unit: number): void {
    if (this.texture === null) return;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
  }

  /** Whether anything has been uploaded, which is what decides the skinned draw path. */
  get ready(): boolean {
    return this.texture !== null;
  }

  dispose(gl: WebGL2RenderingContext): void {
    if (this.texture !== null) gl.deleteTexture(this.texture);
    this.texture = null;
    this.joints = 0;
  }
}
