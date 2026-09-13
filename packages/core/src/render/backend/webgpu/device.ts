/**
 * A device, a configured canvas, and loss adapted to the shape the renderer already handles.
 *
 * Everything WebGPU-specific about *owning* a drawing surface lives here, so that
 * `webgpu/renderer.ts` is about drawing and this is about the context it draws into. The
 * split matters because these two fail for unrelated reasons: a device is lost by a driver
 * reset the page did not cause, and a frame is wrong because of something the frame did.
 */

/** What the renderer needs from the canvas it draws into, with the API's shape absorbed. */
export interface GpuSurface {
  readonly device: GPUDevice;
  readonly context: GPUCanvasContext;
  /**
   * The canvas being drawn into.
   *
   * Carried because the renderer's public measurements are questions about it and nothing
   * else: `cssWidth` and `cssHeight` are its CSS box, `aspect` its drawing buffer. WebGL2
   * answers them off `this.canvas` and a second backend has to answer the same questions
   * from somewhere.
   */
  readonly canvas: HTMLCanvasElement;
  /** The swap chain's format, which every render pipeline has to be built against. */
  readonly format: GPUTextureFormat;
  /** Whether the device has gone. Read per frame; never throws. */
  readonly lost: boolean;
  /** Called when the device is lost. Fires immediately if it already has been. */
  onLost(listener: () => void): void;
  /** Resize the drawing buffer and reconfigure the swap chain. */
  configure(width: number, height: number): void;
  /** Tear down on purpose. A disposed surface never reports a loss. */
  dispose(): void;
}

/**
 * Take a canvas and a device, and hand back the surface the renderer draws into.
 *
 * **Device loss is a promise, and that is a different shape from the event WebGL gives.**
 * `webglcontextlost` fires once and is missed by anybody not already listening;
 * `device.lost` is a promise that resolves once, never rejects, and stays resolved. A
 * renderer constructed after the loss therefore gets no event at all from the WebGL-shaped
 * mental model, and would draw into a dead device forever without ever being told.
 *
 * So the resolution is latched here and `onLost` fires immediately for a listener that
 * arrives late. Adapting it once, at the boundary, is why no call site has to know that the
 * two APIs disagree about what a failure looks like — the same argument `contextLoss.ts`
 * makes for owning the WebGL half rather than letting a game listen for it.
 *
 * **Disposal is not loss.** Tearing a surface down calls `destroy()`, which resolves
 * `device.lost` exactly as a driver reset would. Reporting that to listeners would tell a
 * consumer its GPU had failed every time it unmounted a canvas on purpose, so a disposed
 * surface stays silent.
 */
export function createGpuSurface(canvas: HTMLCanvasElement, device: GPUDevice): GpuSurface {
  const context = canvas.getContext('webgpu') as GPUCanvasContext | null;
  if (context === null) {
    throw new Error('createGpuSurface: the canvas would not give a webgpu context');
  }

  const format = navigator.gpu.getPreferredCanvasFormat();
  const listeners: (() => void)[] = [];
  let lost = false;
  let disposed = false;

  void device.lost.then(() => {
    if (disposed) return;
    lost = true;
    for (const listener of listeners) listener();
  });

  /*
   * **Say what the device rejected, because otherwise nothing does.**
   *
   * WebGPU does not throw on a bad resource. `createBindGroup` with a mismatched sample type
   * returns an object that is invalid, every pass built on it records nothing, and the frame
   * still presents — so the failure arrives as a picture that is merely wrong, and gets
   * attributed to shaders, matrices and orientation in that order. That is not hypothetical:
   * the shadow peel cost three implementations across two sessions, all of them measuring the
   * frame produced by a pass that could not run, and one line of this would have named it.
   * The water shader's invalid pipeline was the same silence.
   *
   * **Measured, because when it arrives decides whether it is any use.** Making the peel's
   * exact mistake and listening gives *nothing* at `createBindGroup` — Dawn defers it — and
   * then three messages at `queue.submit`, root cause first:
   *
   *     None of the supported sample types (UnfilterableFloat|Depth) of
   *       [Texture "shadow.static"] match the expected sample types (Float).
   *     [Invalid BindGroup (unlabeled)] is invalid due to a previous error.
   *     [Invalid CommandBuffer] is invalid due to a previous error.
   *
   * So the useful line is there, and it is there a frame later than the call that caused it.
   * **Label every resource**, because that first message is only readable thanks to
   * `shadow.static` being one.
   *
   * `console.error` rather than a throw, and for that reason: submission is inside the frame
   * loop, and the house rule is that nothing throws there. Once per distinct message, because
   * an invalid bind group set per draw arrives every frame — the same argument `warnedFull`
   * makes in the renderer.
   */
  const said = new Set<string>();
  device.addEventListener('uncapturederror', (event) => {
    const { error } = event as GPUUncapturedErrorEvent;
    const message = error.message;
    if (disposed || said.has(message)) return;
    said.add(message);
    console.error(`[driftengine] the GPU rejected something, and drew nothing for it:\n${message}`);
  });

  const configure = (width: number, height: number): void => {
    if (disposed) return;
    canvas.width = width;
    canvas.height = height;
    /*
     * `opaque` rather than `premultiplied`: this engine draws a sky behind everything and
     * has no use for a transparent canvas, and the opaque path is the one a compositor can
     * take without a blend.
     */
    context.configure({ device, format, alphaMode: 'opaque' });
  };

  configure(canvas.width, canvas.height);

  return {
    device,
    context,
    canvas,
    format,
    get lost() {
      return lost;
    },
    onLost(listener: () => void): void {
      /* Late is the normal case for a renderer built after a driver reset, not an edge one. */
      if (lost) {
        listener();
        return;
      }
      listeners.push(listener);
    },
    configure,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      listeners.length = 0;
      context.unconfigure();
      device.destroy();
    },
  };
}
