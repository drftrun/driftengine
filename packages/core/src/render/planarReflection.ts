/** GPU target and mirrored camera for one horizontal planar reflection. */

import type { ReadonlyMat4 } from 'gl-matrix';
import type { Vec3 } from '../math/color.ts';
import { Camera } from './camera.ts';
import {
  mirrorCamera,
  reflectionClipPlane,
  reflectionTargetSize,
  type ReflectionSize,
} from './planarReflectionDraw.ts';

export class PlanarReflection {
  readonly camera = new Camera();
  readonly clipPlane = new Float32Array(4);
  readonly texture: WebGLTexture;

  private readonly framebuffer: WebGLFramebuffer;
  private readonly depth: WebGLRenderbuffer;
  private readonly scale: number;
  private readonly maxTextureSize: number;
  private width = 0;
  private height = 0;
  /** Refilled per resize rather than allocated; `ensureSize` runs from `Renderer.resize`. */
  private readonly size: ReflectionSize = { width: 0, height: 0 };
  private planeY = 0;
  private ready = false;
  /**
   * Set once the target proves it cannot be allocated, and never cleared.
   *
   * A reflection is an optimisation of appearance, not a requirement: a world without
   * one still renders, and `WaterRenderer` already has a complete path for water that
   * has no reflection to sample. So a device that refuses the allocation should lose the
   * reflection and keep the scene, which is what this makes possible.
   */
  private unusable = false;

  constructor(
    gl: WebGL2RenderingContext,
    scale: number,
    maxTextureSize: number,
    /** `RenderQuality.discardResolvedAttachments`, and see `end` for what it decides. */
    private readonly discardResolved = true,
  ) {
    this.scale = scale;
    this.maxTextureSize = maxTextureSize;

    const texture = gl.createTexture();
    if (texture === null) throw new Error('PlanarReflection: createTexture failed');
    this.texture = texture;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    const depth = gl.createRenderbuffer();
    if (depth === null) throw new Error('PlanarReflection: createRenderbuffer failed');
    this.depth = depth;

    const framebuffer = gl.createFramebuffer();
    if (framebuffer === null) throw new Error('PlanarReflection: createFramebuffer failed');
    this.framebuffer = framebuffer;
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  get viewProjection(): ReadonlyMat4 {
    return this.camera.viewProjection;
  }

  get textureWidth(): number {
    return this.width;
  }

  get textureHeight(): number {
    return this.height;
  }

  /** True only after this target was rendered for the supplied water plane. */
  isReadyFor(planeY: number): boolean {
    return this.ready && Math.abs(this.planeY - planeY) < 1e-4;
  }

  /** Whether this target can be rendered into at all. See `unusable`. */
  get usable(): boolean {
    return !this.unusable;
  }

  /** Bind, clear and return the persistent camera mirrored across `planeY`. */
  begin(
    gl: WebGL2RenderingContext,
    canvasWidth: number,
    canvasHeight: number,
    source: Camera,
    planeY: number,
    clearColor: Vec3,
  ): Camera {
    this.ensureSize(gl, canvasWidth, canvasHeight);
    this.planeY = planeY;

    /* Both chosen in `planarReflectionDraw.ts`, so both backends mirror the same world. */
    const reflected = this.camera;
    mirrorCamera(source, planeY, this.width / this.height, reflected);
    reflectionClipPlane(source.position[1] ?? 0, planeY, this.clipPlane);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.viewport(0, 0, this.width, this.height);
    gl.clearColor(clearColor[0], clearColor[1], clearColor[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    return reflected;
  }

  end(gl: WebGL2RenderingContext): void {
    /*
     * **The mirror's depth is finished with the moment the mirror is.**
     *
     * It is a `DEPTH_COMPONENT24` *renderbuffer*, so no shader can sample it — the same argument
     * `SceneTarget.resolve` makes about the multisampled pair, and the same one the WebGPU
     * backend acts on with `depthStoreOp: 'discard'`. This asymmetry between the two backends
     * was the thing worth finding: one threw the attachment away and the other unbound and left
     * it, so a tile-based GPU wrote a full drawing-buffer depth attachment out to memory every
     * frame that reflected, for a reader that cannot exist. At 824x1830 that is 6.0 MB a frame
     * a mirror, and the consumer draws two.
     *
     * **Before the unbind, deliberately.** `invalidateFramebuffer` acts on whatever is bound to
     * the target it is given, so below the next line it would name the default framebuffer,
     * which is the frame. `SceneTarget.resolve` carries the same warning for the same reason.
     */
    if (this.discardResolved) {
      gl.invalidateFramebuffer(gl.FRAMEBUFFER, [gl.DEPTH_ATTACHMENT]);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.ready = true;
  }

  dispose(gl: WebGL2RenderingContext): void {
    gl.deleteFramebuffer(this.framebuffer);
    gl.deleteRenderbuffer(this.depth);
    gl.deleteTexture(this.texture);
  }

  /**
   * Allocate the target now, rather than on the first frame that shows water.
   *
   * The target is a full drawing-buffer RGBA8 texture and a depth renderbuffer, so on
   * a large display it is tens of megabytes. Allocated lazily, that landed in whichever
   * frame first put water on screen — measured as 28% of a 62 ms frame the first time a
   * character came within sight of it, which is a stall in the middle of play rather than
   * during a load.
   *
   * The renderer calls this from `resize`, so the cost is paid where every other
   * allocation of this size is paid: once, at the size the frame is about to be, while
   * the loading plate is still up.
   */
  prepare(gl: WebGL2RenderingContext, canvasWidth: number, canvasHeight: number): void {
    this.ensureSize(gl, canvasWidth, canvasHeight);
  }

  private ensureSize(gl: WebGL2RenderingContext, canvasWidth: number, canvasHeight: number): void {
    // One refusal is enough. Retrying every resize would spend the same memory asking
    // the same question and would put the warning back in the frame loop.
    if (this.unusable) return;
    /* Clamped by one shared factor rather than per axis; see `reflectionTargetSize`. */
    const { width, height } = reflectionTargetSize(
      canvasWidth,
      canvasHeight,
      this.scale,
      this.maxTextureSize,
      this.size,
    );
    if (width === this.width && height === this.height) return;

    this.width = width;
    this.height = height;
    this.ready = false;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindRenderbuffer(gl.RENDERBUFFER, this.depth);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, width, height);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.texture, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.depth);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      /*
       * A lost context reports every attachment as unusable, so this check fires with
       * FRAMEBUFFER_UNSUPPORTED (0x8CDD) for a reason that is not a programming error
       * and cannot be fixed by the caller. Throwing there breaks the engine's own rule
       * that only init fails loudly and the running frame never throws — and it broke it
       * from `Renderer.resize`, a window listener, so the exception escaped into the
       * page rather than into anything that could handle it.
       *
       * It was reported as an uncaught throw immediately after CONTEXT_LOST_WEBGL.
       * A genuine misconfiguration still throws; a dead context is simply nothing to do.
       */
      if (gl.isContextLost()) return;

      /*
       * A refused allocation disables the reflection. It does not stop the frame.
       *
       * This used to throw, and the throw was reached from `Renderer.resize` — which a
       * consumer calls every frame. On a device that cannot afford this target the
       * result was not a missing reflection, it was an exception escaping the middle of
       * every single frame: nothing after `resize` ran, the canvas kept whatever was
       * last drawn, and the scene appeared to render as a fragment of itself. Reported
       * from an iOS webview as a room with only its fire in it, on the one scene in the
       * project that uses a planar reflection.
       *
       * It also broke the rule the block above already states, and states correctly:
       * only initialisation fails loudly, and a running frame never throws. A driver
       * refusing tens of megabytes on a memory-constrained device is the same category
       * as a lost context — not a programming error, and not something the caller can
       * fix by being more careful.
       *
       * Loud in the console, because a genuine misconfiguration must still be findable,
       * and once rather than sixty times a second.
       */
      this.unusable = true;
      this.ready = false;
      console.warn(
        `PlanarReflection: framebuffer incomplete (0x${status.toString(16)}) at ` +
          `${width}x${height}; reflections are off for the rest of this session.`,
      );
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.bindRenderbuffer(gl.RENDERBUFFER, null);
      gl.bindTexture(gl.TEXTURE_2D, null);
      return;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindRenderbuffer(gl.RENDERBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }
}
