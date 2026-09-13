import { mat4 } from 'gl-matrix';
import type { ReadonlyMat4 } from 'gl-matrix';

import { decalScissor } from './decalProjector.ts';
import type { DecalQueue } from './decalQueue.ts';
import { DEPTH_01_TO_CLIP } from './lightVolumeDraw.ts';
import { compileProgram, uniformLocations } from './shader.ts';
import { DECAL_PROJECT_FRAG } from './shaders/decalProject.ts';
import { FULLSCREEN_VERT } from './shaders/fullscreen.ts';

/**
 * Drawn decals on WebGL2: one scissored triangle per mark, multiplied into the finished scene.
 *
 * **The whole pass is a blend state and a rectangle.** There is no geometry, no vertex buffer and
 * no depth test: the mark is decided per pixel from the depth copy, so the only thing the
 * rasteriser is asked for is coverage of the part of the screen the projector box can possibly
 * reach. `decalScissor` computes that from the box's eight corners, which is what stands in for
 * drawing the box as a mesh and is argued there.
 *
 * **`(ZERO, SRC_COLOR)` is the effect.** The result is `dst * src`, so a fragment writing white
 * changes nothing and one writing the mark's colour tints what is under it — including the
 * receiver's lighting, which is the reason to multiply and is stated at length in the shader.
 */
export class DecalPass {
  private readonly program: WebGLProgram;
  private readonly uniforms: Record<string, WebGLUniformLocation | null>;
  private readonly vao: WebGLVertexArrayObject;

  /** `inverse(viewProjection) * DEPTH_01_TO_CLIP`, rebuilt once a frame rather than per mark. */
  private readonly depthToWorld = new Float32Array(16);
  private readonly scissor = new Int32Array(4);

  constructor(private readonly gl: WebGL2RenderingContext) {
    this.program = compileProgram(gl, FULLSCREEN_VERT, DECAL_PROJECT_FRAG, 'decalProject');
    this.uniforms = uniformLocations(gl, this.program, 'decalPass');
    const vao = gl.createVertexArray();
    if (vao === null) throw new Error('DecalPass: createVertexArray failed');
    this.vao = vao;
  }

  /**
   * Mark the bound framebuffer with everything the queue recorded.
   *
   * `viewProjection` is the **raw** camera matrix, not the clip-corrected one: `DEPTH_01_TO_CLIP`
   * turns a stored depth back into the clip space that matrix was built in, and pairing it with
   * the corrected one applies the remap twice. `lightVolumeDraw.ts` carries that derivation.
   */
  drawDecals(
    queue: DecalQueue,
    depth: WebGLTexture,
    viewProjection: ReadonlyMat4,
    eye: ArrayLike<number>,
    width: number,
    height: number,
  ): void {
    if (queue.length === 0) return;
    const { gl } = this;
    const u = this.uniforms;

    mat4.invert(this.depthToWorld, viewProjection);
    mat4.multiply(this.depthToWorld, this.depthToWorld, DEPTH_01_TO_CLIP);

    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ZERO, gl.SRC_COLOR);
    gl.enable(gl.SCISSOR_TEST);

    /* Unit 0, chosen rather than inherited: `bindTexture` binds to whichever unit is active, and
       the renderer leaves that wherever its last pass finished. `OitPass` records what leaving it
       there cost. */
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, depth);
    gl.uniform1i(u['uDecalDepth'] ?? null, 0);
    gl.uniformMatrix4fv(u['uDecalDepthToWorld'] ?? null, false, this.depthToWorld);
    gl.uniform3f(u['uDecalEye'] ?? null, eye[0] ?? 0, eye[1] ?? 0, eye[2] ?? 0);

    queue.replay((decal) => {
      /* False when the box is off-screen or wholly behind the eye, and then this mark costs a
         matrix multiply and no fragments at all. */
      if (!decalScissor(viewProjection, decal.decalToWorld, width, height, false, this.scissor)) {
        return;
      }
      gl.scissor(
        this.scissor[0] ?? 0,
        this.scissor[1] ?? 0,
        this.scissor[2] ?? 0,
        this.scissor[3] ?? 0,
      );
      gl.uniformMatrix4fv(u['uWorldToDecal'] ?? null, false, decal.worldToDecal);
      gl.uniform3fv(u['uDecalAxis'] ?? null, decal.axis);
      gl.uniform3fv(u['uDecalColor'] ?? null, decal.color);
      gl.uniform1f(u['uDecalOpacity'] ?? null, decal.opacity);
      gl.uniform1f(u['uDecalFacingCos'] ?? null, decal.facingCos);
      gl.uniform1f(u['uDecalSoftness'] ?? null, decal.softness);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    });

    gl.disable(gl.SCISSOR_TEST);
    /* And the whole viewport back, so a later `enable` inherits a rectangle that is not one mark's
       corner of the screen. */
    gl.scissor(0, 0, width, height);
    gl.bindVertexArray(null);
    /*
     * **Released, and `OitPass` says why at length.** A binding outlives the frame it was made in,
     * so unit 0 would keep the depth copy — which a later pass attaches as its own target while a
     * program still declares a sampler on that unit. That is a feedback loop: reported once per
     * draw and rasterising something undefined.
     */
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.disable(gl.BLEND);
    gl.depthMask(true);
    gl.enable(gl.DEPTH_TEST);
  }

  dispose(): void {
    const { gl } = this;
    gl.deleteProgram(this.program);
    gl.deleteVertexArray(this.vao);
  }
}
