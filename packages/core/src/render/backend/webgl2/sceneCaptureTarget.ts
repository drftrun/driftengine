import { glSceneDepthFormat } from '../../depthConvention.ts';
import type { SurfaceTexture } from '../../surfaceTexture.ts';

/**
 * A scene capture's framebuffers on WebGL2: the capture's own texture as the colour a pass resolves
 * into, and a depth of its own, at the capture's size. See `sceneCapture.ts` for what a capture is.
 *
 * **At the frame's sample count, as WebGPU's is**, so a capture's edges are antialiased exactly as
 * the frame's are: drawn into multisampled renderbuffers and blitted into the texture at the end,
 * since a texture layer cannot be multisampled and sampled both. A count the driver refuses falls
 * back to one, as the scene target's does, rather than drawing nothing.
 */
export class GlSceneCaptureTarget {
  /** Where the capture resolves: its texture's layer, and a depth when it is drawn into directly. */
  private readonly resolveFramebuffer: WebGLFramebuffer;
  private readonly resolveDepth: WebGLRenderbuffer;
  /** Where it is drawn above one sample, or null. */
  private multisampleFramebuffer: WebGLFramebuffer | null = null;
  private multisampleColor: WebGLRenderbuffer | null = null;
  private multisampleDepth: WebGLRenderbuffer | null = null;
  /** False where the driver refused the attachment, said once by the renderer. */
  readonly usable: boolean;

  constructor(
    gl: WebGL2RenderingContext,
    texture: SurfaceTexture,
    readonly width: number,
    readonly height: number,
    samples: number,
    float: boolean,
  ) {
    const depthFormat = glSceneDepthFormat(gl).internalFormat;
    this.resolveFramebuffer = must(gl.createFramebuffer());
    this.resolveDepth = must(gl.createRenderbuffer());
    gl.bindRenderbuffer(gl.RENDERBUFFER, this.resolveDepth);
    gl.renderbufferStorage(gl.RENDERBUFFER, depthFormat, width, height);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.resolveFramebuffer);
    texture.attachColor(gl);
    gl.framebufferRenderbuffer(
      gl.FRAMEBUFFER,
      gl.DEPTH_ATTACHMENT,
      gl.RENDERBUFFER,
      this.resolveDepth,
    );
    this.usable = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;

    const maximum = gl.getParameter(gl.MAX_SAMPLES) as number;
    const count = Math.max(
      1,
      Math.min(Math.round(samples), Number.isFinite(maximum) ? maximum : 1),
    );
    if (this.usable && count > 1) {
      const color = must(gl.createRenderbuffer());
      const depth = must(gl.createRenderbuffer());
      gl.bindRenderbuffer(gl.RENDERBUFFER, color);
      gl.renderbufferStorageMultisample(
        gl.RENDERBUFFER,
        count,
        float ? gl.RGBA16F : gl.RGBA8,
        width,
        height,
      );
      gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
      gl.renderbufferStorageMultisample(gl.RENDERBUFFER, count, depthFormat, width, height);
      const framebuffer = must(gl.createFramebuffer());
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, color);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE) {
        this.multisampleFramebuffer = framebuffer;
        this.multisampleColor = color;
        this.multisampleDepth = depth;
      } else {
        gl.deleteFramebuffer(framebuffer);
        gl.deleteRenderbuffer(color);
        gl.deleteRenderbuffer(depth);
      }
    }
    gl.bindRenderbuffer(gl.RENDERBUFFER, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /** Bind where the pass draws, size the viewport and clear: colour to `clear`, depth to `depthClear`. */
  begin(
    gl: WebGL2RenderingContext,
    clear: readonly [number, number, number],
    depthClear: number,
  ): void {
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.multisampleFramebuffer ?? this.resolveFramebuffer);
    gl.viewport(0, 0, this.width, this.height);
    gl.clearColor(clear[0], clear[1], clear[2], 1);
    gl.clearDepth(depthClear);
    gl.depthMask(true);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  }

  /** Resolve the multisampled colour into the texture, where there is any. */
  end(gl: WebGL2RenderingContext): void {
    if (this.multisampleFramebuffer === null) return;
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.multisampleFramebuffer);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.resolveFramebuffer);
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
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
  }

  dispose(gl: WebGL2RenderingContext): void {
    gl.deleteFramebuffer(this.resolveFramebuffer);
    gl.deleteRenderbuffer(this.resolveDepth);
    if (this.multisampleFramebuffer !== null) gl.deleteFramebuffer(this.multisampleFramebuffer);
    if (this.multisampleColor !== null) gl.deleteRenderbuffer(this.multisampleColor);
    if (this.multisampleDepth !== null) gl.deleteRenderbuffer(this.multisampleDepth);
  }
}

function must<T>(made: T | null): T {
  if (made === null) throw new Error('GlSceneCaptureTarget: a GL object could not be created');
  return made;
}
