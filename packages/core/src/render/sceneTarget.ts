import { glSceneDepthFormat } from './depthConvention.ts';
import { AmbientOcclusionPass } from './ambientOcclusionPass.ts';
import { BloomPass } from './bloomPass.ts';
import {
  type ColourGradeLut,
  GRADE_PLACEHOLDER_SIZE,
  identityGradeLut,
  validateGradeLut,
} from './colourGrade.ts';
import { compileProgram, uniformLocations } from './shader.ts';
import { TemporalPass } from './temporalPass.ts';
import { FULLSCREEN_VERT } from './shaders/fullscreen.ts';
import { RUSH_FRAG } from './shaders/rush.ts';
import type { Vec3 } from '../math/color.ts';

/** No veil, so a caller that omits the argument gets exactly the frame it always got. */
const NO_VEIL: Vec3 = [0, 0, 0];

/**
 * An off-screen colour target for the frame, and the pass that resolves it to the canvas.
 *
 * The renderer drew straight to the canvas, which is the right default and is why this is
 * opt-in: with nothing to sample a finished frame from, no screen-space effect can exist at
 * all. A speed blur faked with a compositor filter over the canvas gets the boundary
 * wrong in both directions: it is too strong, and it cannot leave the HUD alone. The
 * effect belongs to the 3D scene, so the scene needs somewhere to land before it is shown.
 *
 * **It resolves to the canvas, always.** Two consumers depend on that and neither is
 * optional: a frame recorder reads the canvas to build a clip, and a still is a canvas
 * copy. Leaving the scene in a framebuffer would produce a black export while the screen
 * looked correct, which is the worst shape a bug can have.
 *
 * Sized from the drawing buffer and rebuilt when that changes, so a resize, a DPR change
 * and an export lock all land on an exactly-sized target rather than a stretched one. The
 * depth buffer lives here too: a scene drawn into a colour attachment with the canvas's
 * depth buffer would have no depth at all.
 */
export class SceneTarget {
  private framebuffer: WebGLFramebuffer | null = null;
  private texture: WebGLTexture | null = null;
  /**
   * Depth as a *texture* rather than a renderbuffer, so the composite pass can read it.
   *
   * A renderbuffer is write-only from a shader's point of view, and every screen-space
   * effect worth having needs the depth back: motion blur reconstructs a world position
   * from it to reproject through the previous view, and ambient occlusion is nothing but
   * depth compared against its neighbours. Costing the same memory and being sampleable,
   * there is no reason for it to be anything else.
   */
  private depth: WebGLTexture | null = null;
  /**
   * A copy of the frame's depth taken mid-pass, for anything that must read it while drawing.
   *
   * **Not `depth` itself, and the distinction is the whole reason this exists.** `depth` is the
   * attachment the frame is testing against, and sampling a texture that is attached to the
   * bound framebuffer is undefined in WebGL2 — it draws something plausible on this driver and
   * something else on the next. So a volume of light, which has to know where the opaque scene
   * is in order to stop marching at it, reads this instead.
   *
   * Filled by `snapshotDepth`, on demand, and only in frames that ask.
   */
  private depthCopy: WebGLTexture | null = null;
  private depthCopyFramebuffer: WebGLFramebuffer | null = null;
  /** Whether this frame has filled it. One snapshot serves every volume in a frame. */
  private depthCopyFilled = false;
  /**
   * The colour the frame had already drawn when something first asked for it.
   *
   * **A copy and never the attachment**, which is the difference `colorAttachment` documents from
   * the other side: that one returns null while multisampling, because the frame lives in a
   * renderbuffer until `resolve` blits into it. A blit from a multisampled source to a
   * single-sampled destination *is* a resolve, so this answers in exactly the configuration where
   * reading the attachment cannot.
   *
   * Filled by `snapshotColor`, on demand, and only in frames that ask.
   */
  private colorCopy: WebGLTexture | null = null;
  private colorCopyFramebuffer: WebGLFramebuffer | null = null;
  /** Whether this frame has filled it. One snapshot serves every refracting draw in a frame. */
  private colorCopyFilled = false;
  /**
   * The colour grade, as a 3D texture on unit 4, and the table it was built from.
   *
   * **The source is kept to compare identities, not to read.** A grade is set every frame by a
   * consumer that has one, and re-uploading a 32-lattice table is 131 kilobytes of `texImage3D`
   * sixty times a second for bytes that did not change. Comparing the object is what makes
   * `setColourGrade` free to call from a frame loop — and a consumer crossfading between two
   * grades holds two objects, which compare unequal and upload once each on the swap.
   */
  private gradeTexture: WebGLTexture | null = null;
  private gradeSource: ColourGradeLut | null = null;
  private gradeSize = GRADE_PLACEHOLDER_SIZE;
  private gradeStrength = 0;
  private width = 0;
  private height = 0;

  /**
   * The multisampled pair, present only when a caller asked for samples.
   *
   * Two framebuffers rather than one, because a multisampled attachment cannot be sampled
   * by a shader: the scene is drawn into `msaaFramebuffer`, blitted down into the ordinary
   * texture, and the post chain reads that exactly as it always has. Everything downstream
   * of the blit is unchanged, which is what keeps this a quality option rather than a
   * second rendering path.
   */
  private msaaFramebuffer: WebGLFramebuffer | null = null;
  private msaaColor: WebGLRenderbuffer | null = null;
  private msaaDepth: WebGLRenderbuffer | null = null;
  /** What was actually allocated, after clamping to what the driver reports. */
  private samples = 1;
  /** Whether anything actually reads the resolved depth. Nothing is copied if not. */
  private depthWanted = false;
  /** Set once if the driver refuses the depth copy, so it is attempted once and not per frame. */
  private depthBlitRefused = false;

  private readonly program: WebGLProgram;
  private readonly uniforms: Record<string, WebGLUniformLocation | null>;
  private readonly vao: WebGLVertexArrayObject;
  /**
   * Built the first time a caller asks for occlusion, and never for one that does not.
   *
   * Two programs and two full-frame targets is not a thing to allocate on the chance somebody
   * turns the option on later: the option is construction-time, so a renderer that was not
   * asked for it will never be.
   */
  private ao: AmbientOcclusionPass | null = null;
  /** Built the first time a caller asks for bloom, on the same terms as the occlusion pass. */
  private bloom: BloomPass | null = null;
  /** Built on the first frame that asks for it, like `bloom` beside it. */
  private temporal: TemporalPass | null = null;
  /** Whether the colour attachments hold half floats. See the constructor. */
  private floatColor = false;

  constructor(
    private readonly gl: WebGL2RenderingContext,
    requestedSamples = 1,
    wantsRange = false,
    /**
     * Whether the multisampled buffers may be thrown away once blitted down.
     *
     * True is correct and saves a full attachment write per frame on a tiler. It is a switch
     * because, like WebGPU's `storeOp: 'discard'`, it is invisible on an immediate-mode desktop
     * part and therefore cannot be verified by a screenshot: see
     * `RenderQuality.discardResolvedAttachments`.
     */
    private readonly discardResolved = true,
  ) {
    /*
     * Clamped to MAX_SAMPLES rather than trusted. Asking for more than the part supports
     * produces a framebuffer that never completes, and an incomplete framebuffer is a black
     * frame with no GL error attached to explain it.
     */
    const maximum = gl.getParameter(gl.MAX_SAMPLES) as number;
    this.samples = Math.max(
      1,
      Math.min(Math.round(requestedSamples), Number.isFinite(maximum) ? maximum : 1),
    );

    /*
     * A float colour target where the part will render to one, and eight bits where it will not.
     *
     * **The reason it matters is what a composite can still tell apart.** With an eight-bit
     * target the scene has already been squashed into 0 to 1 by the time anything downstream
     * looks at it, so a star at five times white and a sheet of white paper arrive identical and
     * nothing can treat them differently. Half floats keep the difference, which is what makes a
     * bloom threshold mean brightness rather than mean whiteness, and it is why the tone curve
     * moved from the mesh pass to the resolve: a curve applied before the buffer throws away the
     * range the buffer exists to keep.
     *
     * `EXT_color_buffer_float` is required for this in WebGL2 and is absent on some parts, so it
     * is asked for rather than assumed. Without it the target stays eight-bit and everything
     * still draws: values clip where they always clipped.
     */
    this.floatColor = wantsRange && gl.getExtension('EXT_color_buffer_float') !== null;

    this.program = compileProgram(gl, FULLSCREEN_VERT, RUSH_FRAG, 'rush');
    this.uniforms = uniformLocations(gl, this.program, 'sceneTarget');
    /*
     * A VAO with no attributes: the fullscreen triangle is built from `gl_VertexID`, so
     * there is nothing to bind. WebGL2 still requires *a* vertex array to be bound for a
     * draw, and binding one with no state is cheaper than leaving whatever the previous
     * pass left attached.
     */
    const vao = gl.createVertexArray();
    if (vao === null) throw new Error('SceneTarget: createVertexArray failed');
    this.vao = vao;
  }

  /** Match the target to the drawing buffer. Cheap when unchanged. */
  private ensureSize(width: number, height: number): void {
    if (this.width === width && this.height === height && this.framebuffer !== null) return;
    const { gl } = this;
    this.width = width;
    this.height = height;

    if (this.texture === null) this.texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    if (this.floatColor) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, width, height, 0, gl.RGBA, gl.HALF_FLOAT, null);
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    }
    // Linear, because the blur samples between texels; clamped, because a tap that
    // wrapped would pull the opposite edge of the screen into the corner.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    const sceneDepth = glSceneDepthFormat(gl);
    if (this.depth === null) this.depth = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.depth);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      sceneDepth.internalFormat,
      width,
      height,
      0,
      gl.DEPTH_COMPONENT,
      sceneDepth.type,
      null,
    );
    /* NEAREST, and not a preference: a depth texture with no compare mode cannot be
       linearly filtered, and asking for it makes the sample come back undefined. */
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    /* The mid-pass copy, same format as the depth it is blitted from — `blitFramebuffer`
       refuses a depth copy between formats that do not match exactly. See `depthCopy`. */
    if (this.depthCopy === null) this.depthCopy = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.depthCopy);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      sceneDepth.internalFormat,
      width,
      height,
      0,
      gl.DEPTH_COMPONENT,
      sceneDepth.type,
      null,
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    /*
     * The colour copy, and its format follows the scene texture exactly.
     *
     * **`blitFramebuffer` refuses a copy between formats that do not match**, which is the same
     * constraint the depth copy above is built under — so an HDR profile copies `RGBA16F` and an
     * LDR one `RGBA8`, chosen by the flag the scene texture itself reads.
     *
     * `LINEAR` filtering, because a refracting draw samples at an offset that lands between
     * texels; `CLAMP_TO_EDGE`, because a sample that wrapped would pull the opposite edge of the
     * screen into a pane at the frame's border, which reads as a tear.
     */
    if (this.colorCopy === null) this.colorCopy = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.colorCopy);
    if (this.floatColor) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, width, height, 0, gl.RGBA, gl.HALF_FLOAT, null);
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    }
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    /*
     * Colour only, and no depth attachment at all — the mirror image of the depth copy below,
     * which attaches depth and switches the colour buffers off by name. **They are kept apart
     * deliberately**: this file records a combined colour-and-depth blit losing the colour
     * because the driver disliked the depth, and the depth-only path losing the depth for a
     * missing colour target. One blit, one buffer bit, each time.
     */
    if (this.colorCopyFramebuffer === null) this.colorCopyFramebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.colorCopyFramebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.colorCopy, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      /* Loud, once, at allocation. A refracting draw then shades as an ordinary translucent one
         and says why, rather than quietly disagreeing with the other backend. */
      console.warn(
        'SceneTarget: this driver will not give a colour-only framebuffer, so a refracting ' +
          'surface cannot read the scene behind it and will draw as ordinary glass.',
      );
      gl.deleteFramebuffer(this.colorCopyFramebuffer);
      this.colorCopyFramebuffer = null;
    }

    if (this.depthCopyFramebuffer === null) this.depthCopyFramebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.depthCopyFramebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, this.depthCopy, 0);
    /*
     * **Depth only, and the colour buffers have to be switched off by name.**
     *
     * A framebuffer with a depth attachment and no colour one still advertises
     * `COLOR_ATTACHMENT0` as its draw and read buffer, and a `blitFramebuffer` into it is
     * refused for the missing colour target — taking the depth half of the copy with it, since
     * the call fails whole. `resolve` documents the same trap from the other direction, where a
     * combined colour+depth blit lost the colour because the driver disliked the depth.
     *
     * Without these two lines the copy silently never happened: `snapshotDepth` returned null,
     * `uSceneDepthEnabled` stayed 0, and WebGL2 kept marching through the floor while WebGPU
     * clamped. Two backends doing different things with nothing said about it, which is the
     * 2026-08-13 rule exactly — and it was found from a capture pair whose only disagreement
     * was the band of floor the clamp acts on.
     */
    gl.drawBuffers([gl.NONE]);
    gl.readBuffer(gl.NONE);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      /* Loud, once, at allocation. A volume then draws unclamped on this driver and says why,
         rather than quietly disagreeing with the other backend. */
      console.warn(
        'SceneTarget: this driver will not give a depth-only framebuffer, so light volumes ' +
          'cannot clamp to the scene and will march through it. The frame is unaffected.',
      );
      gl.deleteFramebuffer(this.depthCopyFramebuffer);
      this.depthCopyFramebuffer = null;
    }

    if (this.framebuffer === null) this.framebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.texture, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, this.depth, 0);

    if (this.samples > 1) {
      if (this.msaaColor === null) this.msaaColor = gl.createRenderbuffer();
      gl.bindRenderbuffer(gl.RENDERBUFFER, this.msaaColor);
      gl.renderbufferStorageMultisample(
        gl.RENDERBUFFER,
        this.samples,
        this.floatColor ? gl.RGBA16F : gl.RGBA8,
        width,
        height,
      );

      if (this.msaaDepth === null) this.msaaDepth = gl.createRenderbuffer();
      gl.bindRenderbuffer(gl.RENDERBUFFER, this.msaaDepth);
      /*
       * **Must match the resolve target's format exactly**, or `blitFramebuffer` refuses the depth
       * half of the copy — so it follows the same convention the depth texture does rather than
       * naming a format of its own. It said 24-bit here for as long as the texture was 24-bit;
       * making the texture float and leaving this behind produced
       * `GL_INVALID_OPERATION: glBlitFramebuffer: Depth/stencil buffer format combination not
       * allowed for blit` on every scene with MSAA, which is what the pixel gate reported first.
       */
      gl.renderbufferStorageMultisample(
        gl.RENDERBUFFER,
        this.samples,
        glSceneDepthFormat(gl).internalFormat,
        width,
        height,
      );

      if (this.msaaFramebuffer === null) this.msaaFramebuffer = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.msaaFramebuffer);
      gl.framebufferRenderbuffer(
        gl.FRAMEBUFFER,
        gl.COLOR_ATTACHMENT0,
        gl.RENDERBUFFER,
        this.msaaColor,
      );
      gl.framebufferRenderbuffer(
        gl.FRAMEBUFFER,
        gl.DEPTH_ATTACHMENT,
        gl.RENDERBUFFER,
        this.msaaDepth,
      );

      /*
       * Checked here rather than discovered as a black frame. A multisampled attachment can
       * be refused for a combination the driver does not support even after the sample count
       * was clamped, and the honest response is to fall back to no multisampling and carry
       * on drawing, rather than to render nothing.
       */
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
        this.releaseMultisample();
        this.samples = 1;
      }
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.bindRenderbuffer(gl.RENDERBUFFER, null);
  }

  private releaseMultisample(): void {
    const { gl } = this;
    if (this.msaaFramebuffer !== null) gl.deleteFramebuffer(this.msaaFramebuffer);
    if (this.msaaColor !== null) gl.deleteRenderbuffer(this.msaaColor);
    if (this.msaaDepth !== null) gl.deleteRenderbuffer(this.msaaDepth);
    this.msaaFramebuffer = null;
    this.msaaColor = null;
    this.msaaDepth = null;
  }

  /** Bind the off-screen target for a frame. The caller clears as it normally would. */
  begin(width: number, height: number): void {
    this.ensureSize(width, height);
    /* Last frame's snapshot is last frame's scene. See `snapshotDepth`. */
    this.depthCopyFilled = false;
    this.colorCopyFilled = false;
    this.bind();
  }

  /**
   * Point drawing back at this target, at its own size.
   *
   * Needed because every borrowing pass — the shadow maps, the planar reflection — hands
   * the framebuffer back by binding `null`, which is the *canvas*, not the frame's target.
   * Without somewhere to come back to, everything drawn after a reflection would land on
   * the canvas and then be overwritten by the resolve of a half-empty target: a black
   * frame from a renderer that looked correct in isolation.
   */
  bind(): void {
    const { gl } = this;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.msaaFramebuffer ?? this.framebuffer);
    gl.viewport(0, 0, this.width, this.height);
  }

  /**
   * Whether this target keeps values above 1, which decides where the tone curve belongs.
   *
   * False on a part without `EXT_color_buffer_float`, where the scene is squashed into 0 to 1 on
   * the way in exactly as it always was.
   */
  get keepsRange(): boolean {
    return this.floatColor;
  }

  /** How many samples the scene is actually being drawn with. 1 means no multisampling. */
  get sampleCount(): number {
    return this.samples;
  }

  /** The frame's depth, resolved and sampleable, for screen-space effects that need it. */
  get depthTexture(): WebGLTexture | null {
    return this.depth;
  }

  /**
   * Copy the depth drawn so far, so something still drawing can read it. Returns what to bind.
   *
   * **Once per frame however many callers ask**, because they all want the same thing: where
   * the opaque scene is. `begin` clears the latch.
   *
   * The blit is from whichever framebuffer the frame is actually rendering into — the
   * multisampled one where there is one — and it restores that binding afterwards, because the
   * caller is in the middle of a pass and expects to carry on drawing into it. Forgetting that
   * is a frame that finishes into the wrong target and comes out empty.
   *
   * Null where the copy could not be made, and the caller must read that as "no clamp" rather
   * than as a texture full of zeros — a depth of zero is the near plane, which would clamp every
   * march to nothing and delete every beam in the scene.
   */
  /**
   * The depth the frame is testing against, for a pass that must test against it too.
   *
   * **Not `snapshotDepth`, and the difference matters.** That returns a *copy*, for a pass that
   * samples depth while the attachment is bound; this is the attachment itself, for a pass that
   * attaches it and depth-tests against it without writing. Order-independent transparency needs
   * the second: its two passes reject a pane behind a wall exactly where the wall is, and both
   * must reject it in the same place or the accumulation and the revealage cover different
   * fragments.
   */
  depthAttachment(): WebGLTexture | null {
    return this.depth;
  }

  /**
   * The colour the frame has drawn so far, for a pass that reads the picture rather than the depth.
   *
   * **Null while multisampling, and that is the honest answer rather than a missing feature.** With
   * samples above one the frame is drawn into a renderbuffer and this texture holds nothing until
   * `resolve` blits into it — so a pass running mid-frame would read the frame before last. A
   * caller that needs the finished picture in the middle of the frame is asking for something a
   * multisampled attachment cannot give without a resolve of its own.
   */
  colorAttachment(): WebGLTexture | null {
    return this.msaaFramebuffer === null ? this.texture : null;
  }

  /**
   * The colour the frame has drawn so far, copied so a draw can sample it while still drawing.
   *
   * **A copy and never the attachment.** Sampling a texture attached to the bound framebuffer is
   * undefined in WebGL2 — it draws something plausible on this driver and something else on the
   * next — and `colorAttachment` returns null under multisampling anyway. A blit answers both:
   * it detaches the read, and from a multisampled source it resolves.
   *
   * **Latched, and the latch is the same trap `snapshotDepth` documents.** One copy serves every
   * refracting draw in a frame, so glass does not refract other glass — which is correct, a pane
   * behind a pane should show the room. What it also means is that opaque geometry drawn *after*
   * the first refracting draw is missing from what a pane shows. Draw the world, then the glass;
   * a caller that must have the later geometry asks `afresh` and pays another blit.
   *
   * Null where the copy could not be made, and a caller must read that as "do not refract" rather
   * than as a black texture — refracting against black paints every pane the colour of a hole.
   */
  snapshotColor(afresh = false): WebGLTexture | null {
    if (this.colorCopy === null || this.colorCopyFramebuffer === null) return null;
    if (this.colorCopyFilled && !afresh) return this.colorCopy;
    const { gl } = this;
    const source = this.msaaFramebuffer ?? this.framebuffer;
    if (source === null) return null;

    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, source);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.colorCopyFramebuffer);
    /* Drained first, for the reason `resolve` gives at length: `getError` reports whatever is
       pending from anywhere, so a check that does not start clean blames this call for somebody
       else's mistake — and did, once, permanently disabling an effect. */
    while (gl.getError() !== gl.NO_ERROR) {
      /* discard whatever was already pending */
    }
    /* `NEAREST` because the rectangles are the same size, so there is nothing to filter and the
       choice only decides which refusals are possible. */
    gl.blitFramebuffer(
      0,
      0,
      this.width,
      this.height,
      0,
      0,
      this.width,
      this.height,
      gl.COLOR_BUFFER_BIT,
      gl.NEAREST,
    );
    const refused = gl.getError() !== gl.NO_ERROR;
    /* Back to what the caller was drawing into, whichever that was. */
    gl.bindFramebuffer(gl.FRAMEBUFFER, source);
    if (refused) return null;
    this.colorCopyFilled = true;
    return this.colorCopy;
  }

  snapshotDepth(
    /**
     * Take the copy again even though one has already been taken this frame.
     *
     * **The latch that makes this cheap is also the trap in it.** A beam asks for the depth in
     * the middle of the frame, so the copy holds the world *as it stood then* — and a pass that
     * runs once every draw is in and reuses that copy marks a scene missing everything drawn
     * after the beam. The symptom is a decal landing on a wall that is no longer the nearest
     * thing, which reads as a depth-test bug rather than as a stale texture.
     *
     * So a caller at the end of the frame asks for it afresh, and pays one more blit on the
     * frames where something had already asked. `begin` clears the latch either way.
     */
    afresh = false,
  ): WebGLTexture | null {
    if (this.depthCopy === null || this.depthCopyFramebuffer === null) return null;
    if (this.depthCopyFilled && !afresh) return this.depthCopy;
    const { gl } = this;
    const source = this.msaaFramebuffer ?? this.framebuffer;
    if (source === null) return null;

    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, source);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.depthCopyFramebuffer);
    /* Drained first, for the reason `resolve` gives at length: `getError` reports whatever is
       pending from anywhere, so a check that does not start clean blames this call for
       somebody else's mistake — and did, once, permanently disabling an effect. */
    while (gl.getError() !== gl.NO_ERROR) {
      /* discard whatever was already pending */
    }
    gl.blitFramebuffer(
      0,
      0,
      this.width,
      this.height,
      0,
      0,
      this.width,
      this.height,
      gl.DEPTH_BUFFER_BIT,
      gl.NEAREST,
    );
    const refused = gl.getError() !== gl.NO_ERROR;
    /* Back to what the caller was drawing into, whichever that was. */
    gl.bindFramebuffer(gl.FRAMEBUFFER, source);
    if (refused) return null;
    this.depthCopyFilled = true;
    return this.depthCopy;
  }

  /**
   * Resolve the scene to the canvas, blurred by `strength`.
   *
   * Depth and blending are explicitly off for the pass: it is one opaque triangle over the
   * whole viewport, and inheriting a depth test from the last scene draw would let it fail
   * against nothing.
   */
  /**
   * The colour grade this and every later frame applies, until it is set again.
   *
   * **Held rather than passed to `resolve`**, because a lookup table is a *texture* and every
   * other texture this pass reads is owned here. The alternative is a ninth parameter on a call
   * that already takes eight, carrying an object the caller would then have to keep stable
   * anyway.
   *
   * `null`, or a strength at or below zero, is exactly the frame that existed before the effect
   * did: the shader's branch is on a uniform, so no fetch happens at all.
   */
  setColourGrade(lut: ColourGradeLut | null, strength: number): void {
    this.gradeStrength = lut === null ? 0 : Math.max(0, Math.min(1, strength));
    if (lut === null || lut === this.gradeSource) return;
    validateGradeLut(lut);
    this.uploadGrade(lut);
    this.gradeSource = lut;
  }

  /**
   * Put a table on the device, replacing whatever was there.
   *
   * `RGBA8` with `LINEAR` in every direction and `CLAMP_TO_EDGE` on all three axes. The filtering
   * is the whole point — an unfiltered 32-lattice table bands, which is the one artefact a grade
   * must never introduce — and the clamp is what makes the texel-centre coordinate safe at the
   * ends of the range rather than wrapping black round to white.
   */
  private uploadGrade(lut: ColourGradeLut): void {
    const { gl } = this;
    this.gradeTexture ??= gl.createTexture();
    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_3D, this.gradeTexture);
    gl.texImage3D(
      gl.TEXTURE_3D,
      0,
      gl.RGBA8,
      lut.size,
      lut.size,
      lut.size,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      lut.data,
    );
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
    gl.activeTexture(gl.TEXTURE0);
    this.gradeSize = lut.size;
  }

  resolve(
    strength: number,
    reachUv: number,
    /* The grade, applied here because this is the last pass. See RUSH_FRAG's own note. */
    grade: { readonly transform: number; readonly exposure: number } = {
      transform: 0,
      exposure: 1,
    },
    motion?: {
      readonly reprojection: Float32Array;
      readonly strength: number;
      readonly max: number;
    },
    ao?: {
      readonly strength: number;
      readonly radius: number;
      /** The projection's x and y scales, which turn a world radius into a screen one. */
      readonly projScale: Float32Array;
      readonly invProjection: Float32Array;
    },
    bloom?: {
      readonly strength: number;
      /** In scene units, which is why this wants `keepsRange`. See `BloomPass`. */
      readonly threshold: number;
    },
    /*
     * Depth of field, between the camera smear and the occlusion in the shader's own order. Like
     * `motion` and `ao` it needs the depth, and like them it is absent rather than zeroed when the
     * frame has not asked — so a renderer nobody asked for it never resolves a depth buffer to
     * feed it.
     */
    dof?: {
      /** Where the lens is focused, in metres. */
      readonly distance: number;
      /** How many metres either side of that stay sharp. */
      readonly range: number;
      /** How far the blur may reach, as a fraction of the frame's height. */
      readonly strength: number;
      /** `(m[10], m[14], m[11], m[15])` of the inverse projection. See `uDepthToView`. */
      readonly depthToView: Float32Array;
    },
    /*
     * The frame veil, composited last of everything this pass does. See
     * `Renderer.setFrameVeil` for why it sits here rather than upstream or downstream of the
     * grade. Defaulted rather than optional: the shader always reads both uniforms, so a
     * caller that never veils anything uploads the same two numbers it always would have.
     */
    veilColor: Vec3 = NO_VEIL,
    veilAlpha = 0,
    /*
     * The temporal resolve, appended rather than placed beside the other effects because
     * `veilColor` and `veilAlpha` are positional defaults and every existing caller passes them
     * by position.
     */
    temporal?: { readonly reprojection: Float32Array; readonly blend: number },
  ): void {
    const { gl } = this;
    this.depthWanted =
      motion !== undefined || ao !== undefined || dof !== undefined || temporal !== undefined;
    /*
     * Down from the multisampled buffer into the texture first, because a shader cannot
     * sample a multisampled attachment. NEAREST is the only filter `blitFramebuffer` accepts
     * for a same-size resolve, and the two are the same size by construction.
     */
    if (this.msaaFramebuffer !== null) {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.msaaFramebuffer);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.framebuffer);
      /*
       * **Colour on its own, always, and depth as a separate call that is allowed to fail.**
       *
       * These were one blit with both bits set, and that shipped a black game. A driver may
       * refuse a depth copy for a format combination it does not like, and `blitFramebuffer`
       * refuses the *whole* call when it does — so a disagreement about depth took the
       * colour with it and the frame resolved to nothing. The symptom is total and the cause
       * is a flag in a bitmask.
       *
       * Split, the worst case is losing the effect that wanted depth. The frame is never at
       * risk, which is the only acceptable ordering: this method's contract is that the scene
       * reaches the canvas.
       */
      gl.blitFramebuffer(
        0,
        0,
        this.width,
        this.height,
        0,
        0,
        this.width,
        this.height,
        gl.COLOR_BUFFER_BIT,
        gl.NEAREST,
      );
      if (this.depthWanted && !this.depthBlitRefused) {
        /*
         * Drained first, and this is not defensive tidiness. `getError` returns whatever
         * error is *pending*, from anywhere, and clears it — so a check that does not start
         * from a clean queue attributes somebody else's mistake to this call. That happened
         * here immediately: an unrelated error elsewhere in the frame was read as the driver
         * refusing depth, which switched motion blur off permanently and silently.
         */
        while (gl.getError() !== gl.NO_ERROR) {
          /* discard whatever was already pending */
        }
        gl.blitFramebuffer(
          0,
          0,
          this.width,
          this.height,
          0,
          0,
          this.width,
          this.height,
          gl.DEPTH_BUFFER_BIT,
          gl.NEAREST,
        );
        /*
         * Asked once rather than every frame: `getError` is a synchronisation point, and a
         * format combination that was refused on the first frame will be refused on every
         * one. After that the effect that wanted depth simply does not run.
         */
        if (gl.getError() !== gl.NO_ERROR) {
          this.depthBlitRefused = true;
          console.warn(
            'SceneTarget: this driver will not resolve multisampled depth, so effects that ' +
              'read it are off. The frame itself is unaffected.',
          );
        }
      }
      /*
       * **Thrown away the moment they have been blitted down, which is WebGL2's half of the
       * same statement `storeOp: 'discard'` makes on the other backend.**
       *
       * The blit above is the resolve, and on its own it is only half of one: the multisampled
       * renderbuffers still hold contents the driver has no reason to believe are finished
       * with, so a tile-based GPU dutifully writes all four samples out to memory at the end of
       * the pass. Nothing can ever read them — a multisampled renderbuffer cannot be sampled by
       * a shader at all, which is the entire reason this blit exists — so the write buys
       * nothing and costs a full attachment.
       *
       * Measured on the WebGPU side of the same frame at 824x1830 with four samples: 23 MB per
       * attachment, and the game keeps two of them. On a desktop part it is invisible, which is
       * why it survived; on a phone it is a share of the memory bandwidth the frame has.
       *
       * **Before the unbind, deliberately.** `invalidateFramebuffer` acts on whatever is bound
       * to the target it is given, so moving these two lines below the ones that follow would
       * discard the default framebuffer instead — which is the frame.
       */
      if (this.discardResolved) {
        gl.invalidateFramebuffer(gl.READ_FRAMEBUFFER, [gl.COLOR_ATTACHMENT0, gl.DEPTH_ATTACHMENT]);
      }
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    }
    /*
     * Occlusion before the composite, because the composite consumes it, and after the
     * resolve above, because it reads the depth that resolve produced. It leaves the
     * framebuffer unbound and the viewport its own, both of which the composite sets again
     * below.
     */
    let aoTexture: WebGLTexture | null = null;
    if (ao !== undefined && !this.depthBlitRefused && this.depth !== null) {
      this.ao ??= new AmbientOcclusionPass(gl);
      aoTexture = this.ao.run(
        this.depth,
        this.width,
        this.height,
        ao.radius,
        ao.projScale,
        ao.invProjection,
      );
    }

    /*
     * Bloom beside occlusion rather than after the composite, because the composite is what
     * consumes it. It reads the resolved colour rather than the depth, so it is independent of
     * the blit above having produced anything, and it leaves the framebuffer unbound and the
     * viewport its own — both of which the composite sets again below.
     */
    /*
     * **The temporal resolve happens before all of it**, and what it returns is what everything
     * below must treat as the scene. Bloom, occlusion and the grade each read the scene texture,
     * and reading the unresolved one would put the crawl the resolve just removed back on screen
     * through the bloom — a stable picture lit by an unstable one.
     */
    let scene = this.texture;
    if (temporal !== undefined && this.texture !== null && this.depth !== null) {
      this.temporal ??= new TemporalPass(gl, this.floatColor);
      scene = this.temporal.temporalResolve(
        this.texture,
        this.depth,
        temporal.reprojection,
        this.width,
        this.height,
        temporal.blend,
      );
    }

    let bloomTexture: WebGLTexture | null = null;
    if (bloom !== undefined && scene !== null) {
      this.bloom ??= new BloomPass(gl);
      bloomTexture = this.bloom.run(scene, this.width, this.height, bloom.threshold);
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.width, this.height);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);
    gl.depthMask(false);

    gl.useProgram(this.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, scene);
    gl.uniform1i(this.uniforms['uScene'] ?? null, 0);
    gl.uniform1f(this.uniforms['uStrength'] ?? null, strength);
    gl.uniform1f(this.uniforms['uReach'] ?? null, reachUv);
    gl.uniform1i(this.uniforms['uOutputTransform'] ?? null, grade.transform);
    gl.uniform1f(this.uniforms['uOutputExposure'] ?? null, grade.exposure);

    /*
     * Depth on its own unit, and the reprojection with it. Bound every frame rather than
     * once, because a texture unit is context state and any pass between two frames is free
     * to have left something else there.
     */
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.depth);
    gl.uniform1i(this.uniforms['uDepth'] ?? null, 1);
    /* Off if the driver would not give the depth back, so the shader never samples a
       texture that holds whatever was in it before. */
    const motionUsable = motion !== undefined && !this.depthBlitRefused;
    gl.uniform1f(this.uniforms['uMotionStrength'] ?? null, motionUsable ? motion.strength : 0);
    gl.uniform1f(this.uniforms['uMotionMax'] ?? null, motion?.max ?? 0);
    if (motionUsable) {
      gl.uniformMatrix4fv(this.uniforms['uReprojection'] ?? null, false, motion.reprojection);
    }
    /*
     * Depth of field, on the depth unit bound just above and gated on the same refusal: a driver
     * that would not give the depth back leaves that texture holding a previous frame, and a
     * circle of confusion computed from it defocuses the wrong half of the picture.
     */
    const dofUsable = dof !== undefined && !this.depthBlitRefused;
    gl.uniform1f(this.uniforms['uDofStrength'] ?? null, dofUsable ? dof.strength : 0);
    if (dofUsable) {
      gl.uniform1f(this.uniforms['uFocusDistance'] ?? null, dof.distance);
      gl.uniform1f(this.uniforms['uFocusRange'] ?? null, dof.range);
      /* Height over width, so a radius in fractions of the height is a circle on screen. */
      gl.uniform2f(this.uniforms['uDofAspect'] ?? null, this.height / this.width, 1);
      gl.uniform4fv(this.uniforms['uDepthToView'] ?? null, dof.depthToView);
    }

    /*
     * Ambient occlusion on its own unit, gated on the same fact as the blur and for the same
     * reason: a refused depth resolve leaves that texture holding whatever a previous frame
     * put there, and occlusion measured from it is not a degraded picture but a pattern of
     * dirt with no relationship to the scene. The pass may also decline for itself, which
     * arrives here as a null texture. Either way the strength goes to zero, which is exactly
     * the frame that existed before the effect did.
     *
     * The placeholder rather than an unbound unit when it is off: an incomplete texture is
     * something a driver may fetch the descriptor for before it evaluates the branch that
     * would have skipped the read.
     */
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, aoTexture ?? scene);
    gl.uniform1i(this.uniforms['uAo'] ?? null, 2);
    gl.uniform1f(
      this.uniforms['uAoStrength'] ?? null,
      aoTexture === null ? 0 : (ao?.strength ?? 0),
    );

    /* Bloom on its own unit, and the placeholder for the same reason as the one above: a
       driver may fetch a texture's descriptor before it evaluates the branch that skips the
       read, and an incomplete texture is not a thing to hand it. */
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, bloomTexture ?? scene);
    gl.uniform1i(this.uniforms['uBloom'] ?? null, 3);
    gl.uniform1f(
      this.uniforms['uBloomStrength'] ?? null,
      bloomTexture === null ? 0 : (bloom?.strength ?? 0),
    );

    /*
     * The grade on unit 4, and the placeholder built here rather than at construction: a frame
     * that never grades anything should not carry a texture, and a sampler declared in the
     * program must still have a complete one bound whether or not the branch reads it — the
     * argument the occlusion and bloom placeholders above make, one dimension up.
     *
     * The placeholder is an **identity** table at two lattice points, which is exact: identity
     * is linear and a trilinear fetch through corners holding their own coordinates reproduces a
     * linear function precisely. So it is the right answer if anything ever samples it rather
     * than an inert stand-in that happens not to be read.
     */
    if (this.gradeTexture === null) this.uploadGrade(identityGradeLut(GRADE_PLACEHOLDER_SIZE));
    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_3D, this.gradeTexture);
    gl.uniform1i(this.uniforms['uGradeLut'] ?? null, 4);
    gl.uniform1f(this.uniforms['uGradeStrength'] ?? null, this.gradeStrength);
    gl.uniform1f(this.uniforms['uGradeSize'] ?? null, this.gradeSize);
    gl.activeTexture(gl.TEXTURE0);

    /* No unit and no texture: a flat colour, not a sample. Uploaded unconditionally — two
       floats and a triplet cost nothing next to the triangle this pass already draws — and it
       is `withVeil` in the shader, not a branch here, that keeps a veil-less frame free of the
       mix it does not need. */
    gl.uniform3fv(this.uniforms['uVeilColor'] ?? null, veilColor);
    gl.uniform1f(this.uniforms['uVeilAlpha'] ?? null, veilAlpha);

    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);

    /*
     * **The units this pass used are released, and that is not tidiness.**
     *
     * Unit 1 holds `depth` — an attachment of this very target — and a binding survives the frame
     * it was made in. Anything that later *attaches* that texture while it is still bound to a
     * sampler the active program declares forms a feedback loop, which WebGL2 reports as
     * `GL_INVALID_OPERATION: Feedback loop formed between Framebuffer and active Texture` and then
     * draws something undefined. Order-independent transparency attaches exactly this depth to its
     * own framebuffers on the next frame, and that is how this was found: 120 pixels of a frame
     * that should have been identical, and a warning per draw explaining why.
     */
    for (let unit = 0; unit <= 4; unit++) {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, null);
    }
    gl.activeTexture(gl.TEXTURE0);

    // Handed back the way the rest of the renderer expects to find it.
    gl.depthMask(true);
    gl.enable(gl.DEPTH_TEST);
    /*
     * **And culling, which this pass switched off and the next frame's world is drawn with.**
     *
     * It was the one borrowed state never returned. `resolve` runs at `endFrame`, so from the
     * second frame onwards every `drawMesh` in every scene ran with `CULL_FACE` disabled — the
     * world drawn double-sided on the backend this engine is most often looked at, against a
     * renderer that enables culling once at setup and documents it as "on for the life of the
     * renderer because the world is solid".
     *
     * Invisible wherever geometry is wound correctly, which is every scene here, so nothing
     * caught it. What caught it was a scene whose geometry was wound *backwards*: it looked
     * perfect on WebGL2 and lost its entire ground on WebGPU, where culling is pipeline state
     * that no pass can leak. The defect read as a WebGPU bug for a fortnight and was this line.
     */
    gl.enable(gl.CULL_FACE);
  }

  dispose(): void {
    const { gl } = this;
    this.ao?.dispose();
    this.ao = null;
    this.bloom?.dispose();
    this.bloom = null;
    if (this.framebuffer !== null) gl.deleteFramebuffer(this.framebuffer);
    if (this.texture !== null) gl.deleteTexture(this.texture);
    if (this.depth !== null) gl.deleteTexture(this.depth);
    /*
     * The two snapshots and their framebuffers, which this method did not release before the
     * colour one was added. **The depth pair is the same leak and is freed here for the same
     * reason**: they are allocated in `ensureSize` beside everything above, so releasing some of
     * what that allocates and not the rest is a distinction nothing here intends.
     */
    if (this.colorCopy !== null) gl.deleteTexture(this.colorCopy);
    if (this.colorCopyFramebuffer !== null) gl.deleteFramebuffer(this.colorCopyFramebuffer);
    if (this.depthCopy !== null) gl.deleteTexture(this.depthCopy);
    if (this.depthCopyFramebuffer !== null) gl.deleteFramebuffer(this.depthCopyFramebuffer);
    if (this.gradeTexture !== null) gl.deleteTexture(this.gradeTexture);
    this.gradeTexture = null;
    this.gradeSource = null;
    this.releaseMultisample();
    gl.deleteProgram(this.program);
    gl.deleteVertexArray(this.vao);
    this.framebuffer = null;
    this.texture = null;
    this.depth = null;
    this.colorCopy = null;
    this.colorCopyFramebuffer = null;
    this.depthCopy = null;
    this.depthCopyFramebuffer = null;
  }
}
