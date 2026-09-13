import { glSceneDepthFormat } from './depthConvention.ts';
import type { PassDevice } from './pass.ts';

/**
 * A render target a contributed pass owns: it renders into this and samples it later.
 *
 * **The asymmetry with `PassDefinition.reads` is the whole design and is worth reading first.**
 * What a pass *writes into the frame* is not negotiable and is refused: every built-in verb writes
 * the current target, the executor replays a flush's nodes into one open pass, and a node
 * declaring some other write-set would schedule as a pass nothing opens — so letting a package
 * name its writes hands it the one declaration nothing can enforce. A target the pass *owns* is
 * outside that set by construction, which is exactly what makes it declarable when a write to the
 * frame is not.
 *
 * What it is for: a package's own shadow map, blur pyramid, picking buffer or intermediate. A
 * `@driftengine/splats` pass wanting a depth prepass of its own, a UI package wanting a cached
 * layer, an XR package wanting a per-eye scratch.
 *
 * **Two implementations behind one call**, the same split `PassDevice` itself takes, and for the
 * same reason: a neutral device abstraction would be a second renderer API and would buy nothing,
 * because a package's shader, buffer layout and pipeline differ per backend anyway. The union
 * makes the branch explicit and typed.
 *
 * **Single-sampled, and that is a decision rather than an omission.** A multisampled pass-owned
 * target needs a resolve target beside it and a decision about who allocates it, and no
 * contributed pass has asked. *What that costs* is that a pass wanting antialiased geometry of its
 * own supersamples instead. *What would reverse it* is a contributed pass that needs it, at which
 * point `samples` joins the options and the resolve target is created with the colour one.
 *
 * **`dispose` is the pass's to call**, from its own `dispose`, and nothing calls it for you: the
 * renderer knows what it created and this is not that. A target left undisposed is a texture the
 * driver holds until the context goes.
 */
export interface PassAttachmentOptions {
  /** For the label a backend gives the texture, and for diagnostics. */
  readonly label?: string;
  readonly width: number;
  readonly height: number;
  /**
   * Eight bits a channel, or half floats.
   *
   * Two rather than the format zoo either API offers, because these are the two a pass drawing
   * into its own target wants: a picking buffer or a cached layer is `rgba8`, and anything
   * carrying light before a tone curve is `rgba16float`. A third would need a reason.
   */
  readonly format?: 'rgba8' | 'rgba16float';
  /** Whether to attach a depth buffer. Default true, because a pass with geometry wants one. */
  readonly depth?: boolean;
}

export type PassTarget = {
  readonly width: number;
  readonly height: number;
  /**
   * Free the GPU objects. Call it from the pass's own `dispose`, and call it before creating a
   * replacement — **resizing is dispose-and-recreate** rather than a method, because a resize is
   * not a per-frame path and a mutable target would be one more thing to keep consistent.
   */
  dispose(): void;
} & (
  | {
      readonly backend: 'webgl2';
      /** Bind this, draw, and bind `null` again. See `PassDefinition.prepare`. */
      readonly framebuffer: WebGLFramebuffer;
      readonly colour: WebGLTexture;
      readonly depth: WebGLTexture | null;
    }
  | {
      readonly backend: 'webgpu';
      readonly colour: GPUTexture;
      readonly colourView: GPUTextureView;
      readonly depth: GPUTexture | null;
      readonly depthView: GPUTextureView | null;
      /** What a pipeline drawing into this must declare. */
      readonly format: GPUTextureFormat;
      readonly depthFormat: GPUTextureFormat | null;
    }
);

/**
 * Build one. Called from a pass's `init`, or from its `prepare` when the size has changed.
 *
 * **Restores the default framebuffer on WebGL2**, rather than whatever was bound before. Both
 * points where a pass may call this — `init`, outside a frame, and `prepare`, whose contract is
 * that the default framebuffer is bound on entry and on exit — have the default bound, so
 * restoring to it is restoring what was there. Reading the binding back to restore it exactly
 * would be a synchronous driver query in return for covering a case the contract forbids.
 *
 * Fails fast on a size that cannot work, which is the init-time rule: a zero-sized attachment is a
 * framebuffer that is never complete, and a driver reports that as a black draw rather than an
 * error.
 */
export function createPassAttachment(
  device: PassDevice,
  options: PassAttachmentOptions,
): PassTarget {
  const { width, height } = options;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error(
      `createPassAttachment: ${width}x${height} is not a size — width and height must be positive integers`,
    );
  }
  const wantDepth = options.depth ?? true;
  const label = options.label ?? 'pass target';
  const format = options.format ?? 'rgba8';

  if (device.backend === 'webgpu') {
    const { device: gpu } = device;
    /*
     * The two usage bits by value, which is what this renderer already does at every other
     * `createTexture`: `GPUTextureUsage` is a global the type definitions declare and Node does
     * not provide, so naming it here would make this module unimportable in a test that never
     * touches a GPU.
     */
    const RENDER_ATTACHMENT = 0x10;
    const TEXTURE_BINDING = 0x04;
    const colour = gpu.createTexture({
      label: `${label} colour`,
      size: { width, height },
      format: format === 'rgba8' ? 'rgba8unorm' : 'rgba16float',
      usage: RENDER_ATTACHMENT | TEXTURE_BINDING,
    });
    /* The frame's own depth format, so a pass may build one pipeline for its target and the
       frame rather than two that differ in a field it did not choose. */
    const depth = wantDepth
      ? gpu.createTexture({
          label: `${label} depth`,
          size: { width, height },
          format: device.depthFormat,
          usage: RENDER_ATTACHMENT,
        })
      : null;
    return {
      backend: 'webgpu',
      width,
      height,
      colour,
      colourView: colour.createView(),
      depth,
      depthView: depth === null ? null : depth.createView(),
      format: colour.format,
      depthFormat: depth === null ? null : device.depthFormat,
      dispose(): void {
        colour.destroy();
        depth?.destroy();
      },
    };
  }

  const { gl } = device;
  const colour = gl.createTexture();
  if (colour === null) throw new Error('createPassAttachment: the context refused a texture');
  gl.bindTexture(gl.TEXTURE_2D, colour);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    format === 'rgba8' ? gl.RGBA8 : gl.RGBA16F,
    width,
    height,
    0,
    gl.RGBA,
    format === 'rgba8' ? gl.UNSIGNED_BYTE : gl.HALF_FLOAT,
    null,
  );
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  let depth: WebGLTexture | null = null;
  if (wantDepth) {
    const sceneDepth = glSceneDepthFormat(gl);
    depth = gl.createTexture();
    if (depth === null) throw new Error('createPassAttachment: the context refused a texture');
    gl.bindTexture(gl.TEXTURE_2D, depth);
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
  }

  const framebuffer = gl.createFramebuffer();
  if (framebuffer === null) {
    throw new Error('createPassAttachment: the context refused a framebuffer');
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, colour, 0);
  if (depth !== null) {
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, depth, 0);
  }
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.bindTexture(gl.TEXTURE_2D, null);
  if (status !== gl.FRAMEBUFFER_COMPLETE) {
    gl.deleteFramebuffer(framebuffer);
    gl.deleteTexture(colour);
    if (depth !== null) gl.deleteTexture(depth);
    throw new Error(`createPassAttachment: framebuffer incomplete (0x${status.toString(16)})`);
  }

  return {
    backend: 'webgl2',
    width,
    height,
    framebuffer,
    colour,
    depth,
    dispose(): void {
      gl.deleteFramebuffer(framebuffer);
      gl.deleteTexture(colour);
      if (depth !== null) gl.deleteTexture(depth);
    },
  };
}
