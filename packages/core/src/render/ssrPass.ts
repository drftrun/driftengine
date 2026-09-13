import { mat4 } from 'gl-matrix';
import type { ReadonlyMat4 } from 'gl-matrix';

import { decalScissor } from './decalProjector.ts';
import { DEPTH_01_TO_CLIP } from './lightVolumeDraw.ts';
import type { ReflectionQueue } from './screenSpaceReflection.ts';
import { compileProgram, uniformLocations } from './shader.ts';
import { FULLSCREEN_VERT } from './shaders/fullscreen.ts';
import { SSR_RESOLVE_FRAG } from './shaders/ssrResolve.ts';
import { SSR_TRACE_FRAG } from './shaders/ssrTrace.ts';

/**
 * Screen-space reflection on WebGL2: a scissored trace per surface, then one composite.
 *
 * **The trace writes into a target of its own and that is not an optimisation.** It samples the
 * finished scene colour to find out what a ray hit, so writing into the scene would be a feedback
 * loop — `GL_INVALID_OPERATION` once per draw and undefined rasterisation, which `OitPass` records
 * paying for. One extra full-frame attachment buys the separation, and it also makes several
 * reflective surfaces accumulate as premultiplied layers rather than as independent guesses.
 *
 * **Two passes, and the second is one fetch.** The composite is done by the blend state:
 * `(ONE, ONE_MINUS_SRC_ALPHA)` against premultiplied texels is `over`, so the resolve never samples
 * the colour it is compositing onto either.
 */
export class SsrPass {
  private readonly trace: WebGLProgram;
  private readonly traceUniforms: Record<string, WebGLUniformLocation | null>;
  private readonly resolve: WebGLProgram;
  private readonly resolveUniforms: Record<string, WebGLUniformLocation | null>;
  private readonly vao: WebGLVertexArrayObject;

  private reflection: WebGLTexture | null = null;
  private framebuffer: WebGLFramebuffer | null = null;
  private width = 0;
  private height = 0;

  /** `inverse(viewProjection) * DEPTH_01_TO_CLIP`, rebuilt once a frame rather than per surface. */
  private readonly depthToWorld = new Float32Array(16);
  private readonly scissor = new Int32Array(4);

  constructor(
    private readonly gl: WebGL2RenderingContext,
    /**
     * Whether the scene it reflects is a float target.
     *
     * The reflection buffer matches it. A half-float scene composited through an eight-bit
     * reflection would clip every highlight the reflection carries, which is exactly the part of a
     * scene that shows in a wet floor.
     */
    private readonly floatColor: boolean,
  ) {
    this.trace = compileProgram(gl, FULLSCREEN_VERT, SSR_TRACE_FRAG, 'ssrTrace');
    this.traceUniforms = uniformLocations(gl, this.trace, 'ssrTrace');
    this.resolve = compileProgram(gl, FULLSCREEN_VERT, SSR_RESOLVE_FRAG, 'ssrResolve');
    this.resolveUniforms = uniformLocations(gl, this.resolve, 'ssrResolve');
    const vao = gl.createVertexArray();
    if (vao === null) throw new Error('SsrPass: createVertexArray failed');
    this.vao = vao;
  }

  private ensureSize(width: number, height: number): void {
    const { gl } = this;
    if (this.width === width && this.height === height) return;
    this.width = width;
    this.height = height;

    /* Unit 0, chosen rather than inherited: `bindTexture` binds to whichever unit is active, and
       the renderer leaves that wherever its last pass finished. `OitPass` records what leaving it
       there cost — a feedback loop reported once per draw. */
    gl.activeTexture(gl.TEXTURE0);
    if (this.reflection === null) this.reflection = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.reflection);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      this.floatColor ? gl.RGBA16F : gl.RGBA8,
      width,
      height,
      0,
      gl.RGBA,
      this.floatColor ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE,
      null,
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    if (this.framebuffer === null) this.framebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      this.reflection,
      0,
    );
    /* No depth: the trace decides everything from the depth it *samples*, and an attachment here
       would be one more thing to be caught reading. */
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    /* And released, so nothing carries this target into a sampler of another pass. */
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  /**
   * March every recorded surface into the reflection buffer.
   *
   * `viewProjection` is the **raw** camera matrix. `DEPTH_01_TO_CLIP` turns a stored depth back
   * into the clip space that matrix was built in, and the trace projects its samples back through
   * the same matrix — pairing either with the clip-corrected one applies the remap twice.
   */
  traceReflections(
    queue: ReflectionQueue,
    scene: WebGLTexture,
    depth: WebGLTexture,
    viewProjection: ReadonlyMat4,
    eye: ArrayLike<number>,
    width: number,
    height: number,
    edgeFade: number,
  ): void {
    if (queue.length === 0) return;
    const { gl } = this;
    const u = this.traceUniforms;
    this.ensureSize(width, height);

    mat4.invert(this.depthToWorld, viewProjection);
    mat4.multiply(this.depthToWorld, this.depthToWorld, DEPTH_01_TO_CLIP);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.viewport(0, 0, width, height);
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.disable(gl.CULL_FACE);
    /* Cleared whole, then scissored: the resolve reads every pixel and an uncleared one outside
       every box would composite last frame's reflection over this frame's scene. */
    gl.disable(gl.SCISSOR_TEST);
    gl.clearBufferfv(gl.COLOR, 0, [0, 0, 0, 0]);
    gl.enable(gl.BLEND);
    /* Premultiplied `over`, so two overlapping surfaces layer rather than replace. */
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.enable(gl.SCISSOR_TEST);

    gl.useProgram(this.trace);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, depth);
    gl.uniform1i(u['uSsrDepth'] ?? null, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, scene);
    gl.uniform1i(u['uSsrScene'] ?? null, 1);
    gl.uniformMatrix4fv(u['uSsrDepthToWorld'] ?? null, false, this.depthToWorld);
    /* No Y flip on this backend: `gl.scissor` and the framebuffer both count rows from the bottom,
       which is the space the raw matrix already emits. See `CLIP_Y_FLIP`. */
    gl.uniformMatrix4fv(u['uSsrViewProj'] ?? null, false, viewProjection as Float32Array);
    gl.uniform3f(u['uSsrEye'] ?? null, eye[0] ?? 0, eye[1] ?? 0, eye[2] ?? 0);
    gl.uniform1f(u['uSsrEdgeFade'] ?? null, edgeFade);

    queue.replay((surface) => {
      if (
        !decalScissor(viewProjection, surface.surfaceToWorld, width, height, false, this.scissor)
      ) {
        return;
      }
      gl.scissor(
        this.scissor[0] ?? 0,
        this.scissor[1] ?? 0,
        this.scissor[2] ?? 0,
        this.scissor[3] ?? 0,
      );
      gl.uniformMatrix4fv(u['uWorldToSurface'] ?? null, false, surface.worldToSurface);
      gl.uniform3fv(u['uSsrAxis'] ?? null, surface.axis);
      gl.uniform3fv(u['uSsrTint'] ?? null, surface.tint);
      gl.uniform1f(u['uSsrStrength'] ?? null, surface.strength);
      gl.uniform1f(u['uSsrFacingCos'] ?? null, surface.facingCos);
      gl.uniform1f(u['uSsrReach'] ?? null, surface.reachM);
      gl.uniform1f(u['uSsrThickness'] ?? null, surface.thicknessM);
      gl.uniform1f(u['uSsrSteps'] ?? null, surface.steps);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    });

    gl.disable(gl.SCISSOR_TEST);
    gl.scissor(0, 0, width, height);
    gl.bindVertexArray(null);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.disable(gl.BLEND);
    gl.depthMask(true);
    gl.enable(gl.DEPTH_TEST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /** Composite what the trace found over whatever framebuffer is bound. */
  resolveReflections(): void {
    const { gl } = this;
    if (this.reflection === null) return;

    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    /* Premultiplied `over`: the trace already multiplied its colour by the coverage it found. */
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    gl.useProgram(this.resolve);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.reflection);
    gl.uniform1i(this.resolveUniforms['uSsrReflection'] ?? null, 0);

    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);

    /*
     * **Released, and `OitPass` says why at length.** A binding outlives the frame it was made in,
     * so unit 0 would keep the reflection buffer — which the *next* frame then attaches as its own
     * target while a program still declares a sampler on that unit. That is a feedback loop,
     * reported once per draw and rasterising something undefined.
     */
    gl.bindTexture(gl.TEXTURE_2D, null);

    gl.disable(gl.BLEND);
    gl.depthMask(true);
    gl.enable(gl.DEPTH_TEST);
  }

  dispose(): void {
    const { gl } = this;
    if (this.reflection !== null) gl.deleteTexture(this.reflection);
    if (this.framebuffer !== null) gl.deleteFramebuffer(this.framebuffer);
    gl.deleteProgram(this.trace);
    gl.deleteProgram(this.resolve);
    gl.deleteVertexArray(this.vao);
    this.reflection = null;
    this.framebuffer = null;
    this.width = 0;
    this.height = 0;
  }
}
