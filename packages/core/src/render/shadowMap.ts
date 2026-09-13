/**
 * Single-cascade directional shadow map: one depth texture, one extra draw of
 * the static world per update.
 *
 * Filtering belongs to the receiving material shader, so the depth target can
 * stay a single-sample texture shared by every mesh pass.
 *
 * Note this is a depth *render target*, not an art texture: AGENTS.md's
 * "zero textures" rule is about the art direction (no image assets in the
 * payload), and nothing here adds a byte to it.
 */
import { DEFAULT_RENDER_QUALITY } from './renderQuality.ts';

export class ShadowMap {
  readonly size: number;
  readonly texture: WebGLTexture;

  private readonly framebuffer: WebGLFramebuffer;

  constructor(gl: WebGL2RenderingContext, size = DEFAULT_RENDER_QUALITY.directionalShadowMapSize) {
    this.size = size;

    const texture = gl.createTexture();
    if (texture === null) throw new Error('ShadowMap: createTexture failed');
    this.texture = texture;

    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.DEPTH_COMPONENT24, size, size);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    // Clamp so anything outside the light frustum samples the border and is
    // treated as lit, rather than wrapping into a spurious shadow.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    const framebuffer = gl.createFramebuffer();
    if (framebuffer === null) throw new Error('ShadowMap: createFramebuffer failed');
    this.framebuffer = framebuffer;

    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, texture, 0);
    // Depth-only: without this WebGL expects a colour attachment.
    gl.drawBuffers([gl.NONE]);
    gl.readBuffer(gl.NONE);

    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      /*
       * A lost context reports every attachment unusable, and that is not a
       * misconfiguration the caller can fix — see planarReflection.ts. Init still throws,
       * because the context cannot be lost before it exists.
       */
      if (gl.isContextLost()) return;
      throw new Error(`ShadowMap: framebuffer incomplete (0x${status.toString(16)})`);
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  /** Bind as the render target and clear. Caller then draws the casters. */
  begin(gl: WebGL2RenderingContext): void {
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.viewport(0, 0, this.size, this.size);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    /*
     * Store the face nearest the sun. Culling front faces stores the far side
     * and moves a box or limb through its own thickness, which is exactly the
     * detached-shadow failure. A small slope-aware raster offset separates the
     * stored caster from its receiver without moving the receiver differently
     * on each face; receiver-plane compensation handles the PCF taps.
     */
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(1.1, 4);
  }

  end(gl: WebGL2RenderingContext): void {
    gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.cullFace(gl.BACK);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  dispose(gl: WebGL2RenderingContext): void {
    gl.deleteFramebuffer(this.framebuffer);
    gl.deleteTexture(this.texture);
  }
}
