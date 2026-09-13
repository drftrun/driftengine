import { compileProgram, uniformLocations } from './shader.ts';
import { FULLSCREEN_VERT } from './shaders/fullscreen.ts';
import { OIT_RESOLVE_FRAG } from './shaders/oitResolve.ts';

/**
 * Order-independent transparency on WebGL2: two targets, two passes over the same geometry, and a
 * resolve.
 *
 * **The accumulation and the revealage are two blend states**, and a single pass cannot hold two.
 * Writing both from one pass needs a second fragment output, which is another `flatFrag`
 * permutation — measured at about 247 KB gzipped and paid by every consumer whether or not they
 * enable this. Submitting the geometry twice costs the frames that asked for the effect and
 * nothing else, which is why `TranslucentQueue` exists.
 *
 * **Both passes depth-test against the opaque scene and neither writes depth.** They borrow the
 * scene target's own depth texture rather than allocating one, so a pane behind a wall is rejected
 * exactly where the wall is — and because both passes share it, they cover precisely the same
 * fragments.
 *
 * **The revealage pass draws with the ordinary shader.** Its blend is `(ZERO,
 * ONE_MINUS_SRC_ALPHA)`, so whatever colour the fragment computed is multiplied away and only its
 * alpha reaches the target. That is deliberate rather than thrifty: both passes run the same code
 * to decide what alpha a fragment has, so they cannot disagree about it. The cost is that the
 * lighting is computed twice for translucent surfaces, which is stated here rather than hidden.
 */
export class OitPass {
  private readonly program: WebGLProgram;
  private readonly uniforms: Record<string, WebGLUniformLocation | null>;
  private readonly vao: WebGLVertexArrayObject;

  private accum: WebGLTexture | null = null;
  private reveal: WebGLTexture | null = null;
  private accumFbo: WebGLFramebuffer | null = null;
  private revealFbo: WebGLFramebuffer | null = null;

  private width = 0;
  private height = 0;
  private depth: WebGLTexture | null = null;

  /**
   * Whether the context will render to a half-float colour target.
   *
   * **Asked here rather than taken from the scene target**, which is a different question: the
   * scene is float only where a consumer asked for `hdrScene`, and this needs one either way. The
   * accumulation is a *sum* of colour times weight and the weight reaches three thousand, so a
   * single bright layer overflows eight bits immediately and every pane comes out white — an
   * eight-bit fallback is not a quieter version of this effect, so where the extension is absent
   * it refuses and says so once.
   */
  private readonly floatColor: boolean;

  constructor(private readonly gl: WebGL2RenderingContext) {
    this.floatColor = gl.getExtension('EXT_color_buffer_float') !== null;
    this.program = compileProgram(gl, FULLSCREEN_VERT, OIT_RESOLVE_FRAG, 'oitResolve');
    this.uniforms = uniformLocations(gl, this.program, 'oitPass');
    const vao = gl.createVertexArray();
    if (vao === null) throw new Error('OitPass: createVertexArray failed');
    this.vao = vao;
  }

  /** Whether this context can run the effect at all. See `floatColor`. */
  get available(): boolean {
    return this.floatColor;
  }

  private ensureSize(width: number, height: number, depth: WebGLTexture): void {
    const { gl } = this;
    if (this.width === width && this.height === height && this.depth === depth) return;
    this.width = width;
    this.height = height;
    this.depth = depth;

    /*
     * **Unit 0, chosen rather than inherited.** `bindTexture` binds to whatever unit is active,
     * and the renderer leaves that wherever its last pass finished — unit 7 in practice. Allocating
     * here without setting it left the revealage texture bound to unit 7 for the life of the
     * context, and the pass below then attached that same texture as its render target: a feedback
     * loop, reported once per draw as `GL_INVALID_OPERATION` and rasterising something undefined.
     * It cost 120 pixels of a frame that had to be identical, and it was found by asking which
     * texture was on which unit rather than by reasoning about it.
     */
    gl.activeTexture(gl.TEXTURE0);

    if (this.accum === null) this.accum = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.accum);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, width, height, 0, gl.RGBA, gl.HALF_FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    /* One channel, because revealage is one number. `r8` rather than `r16f`: it holds a product of
       values in 0..1 and never leaves that range, and eight bits of it is a step of 1/255 in how
       much scene shows through — below what a viewer can see against a blended layer. */
    if (this.reveal === null) this.reveal = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.reveal);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, width, height, 0, gl.RED, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    /*
     * **The scene's own depth on both, and that is what makes the two passes agree.** They test
     * against the opaque world and never write, so a pane behind a wall is rejected at the wall on
     * both — and a fragment that reached the accumulation reached the revealage too, which the
     * resolve assumes and could not otherwise rely on.
     */
    if (this.accumFbo === null) this.accumFbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.accumFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.accum, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, depth, 0);

    if (this.revealFbo === null) this.revealFbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.revealFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.reveal, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, depth, 0);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    /* And released, so nothing carries a target of this pass into a sampler of another. */
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  /**
   * Run the translucent set into the two buffers.
   *
   * `submit` is called twice with the weighting flag it should set: once accumulating, once
   * multiplying revealage. Depth writes are off for both and restored after, because a translucent
   * surface that wrote depth would hide the ones behind it and there would be nothing to blend.
   */
  accumulateOit(
    width: number,
    height: number,
    depth: WebGLTexture,
    submit: (weighted: boolean) => void,
  ): void {
    const { gl } = this;
    this.ensureSize(width, height, depth);

    gl.viewport(0, 0, width, height);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.enable(gl.BLEND);

    /* Weighted colour, summed. Cleared to zero: nothing accumulated is a sum of nothing. */
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.accumFbo);
    gl.clearBufferfv(gl.COLOR, 0, [0, 0, 0, 0]);
    gl.blendFunc(gl.ONE, gl.ONE);
    submit(true);

    /*
     * Revealage, multiplied. **Cleared to one**, which is "nothing has covered this pixel yet" —
     * cleared to zero the resolve would show no scene anywhere the effect ran, which is a black
     * frame that looks like the blend rather than like the clear.
     */
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.revealFbo);
    gl.clearBufferfv(gl.COLOR, 0, [1, 1, 1, 1]);
    gl.blendFunc(gl.ZERO, gl.ONE_MINUS_SRC_ALPHA);
    submit(false);

    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /**
   * Composite the two buffers over whatever framebuffer is bound.
   *
   * **The blend does the compositing, not a texture read.** `(ONE_MINUS_SRC_ALPHA, SRC_ALPHA)`
   * against a fragment carrying the average colour and the revealage computes
   * `average * (1 - reveal) + scene * reveal`, which is the resolve — so this pass never samples
   * the target it is writing, and cannot be caught in the feedback loop that would be.
   */
  resolveOit(): void {
    const { gl } = this;
    if (this.accum === null || this.reveal === null) return;

    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE_MINUS_SRC_ALPHA, gl.SRC_ALPHA);

    gl.useProgram(this.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.accum);
    gl.uniform1i(this.uniforms['uOitAccum'] ?? null, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.reveal);
    gl.uniform1i(this.uniforms['uOitReveal'] ?? null, 1);

    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);

    /*
     * **Released, and this is the bug that made it necessary.** A binding outlives the frame it
     * was made in, so unit 0 kept the accumulation texture — which the *next* frame then attaches
     * as its own colour target while the flat program still declares a sampler on that unit. That
     * is a feedback loop: WebGL2 reports `GL_INVALID_OPERATION: Feedback loop formed between
     * Framebuffer and active Texture` once per draw and then rasterises something undefined. It
     * cost 120 pixels of a frame that had to be identical, which is what found it.
     */
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, null);

    gl.disable(gl.BLEND);
    gl.depthMask(true);
    gl.enable(gl.DEPTH_TEST);
  }

  dispose(): void {
    const { gl } = this;
    if (this.accum !== null) gl.deleteTexture(this.accum);
    if (this.reveal !== null) gl.deleteTexture(this.reveal);
    if (this.accumFbo !== null) gl.deleteFramebuffer(this.accumFbo);
    if (this.revealFbo !== null) gl.deleteFramebuffer(this.revealFbo);
    gl.deleteProgram(this.program);
    gl.deleteVertexArray(this.vao);
    this.accum = null;
    this.reveal = null;
    this.accumFbo = null;
    this.revealFbo = null;
    this.width = 0;
    this.height = 0;
    this.depth = null;
  }
}
