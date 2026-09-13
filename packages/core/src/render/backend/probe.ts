/**
 * Whether a WebGPU device can do what it is about to be asked to do.
 *
 * **Feature detection is not this.** `navigator.gpu` was present, an adapter was offered and a
 * device was returned throughout the total iOS failure recorded in
 * The iOS black-screen investigation: WebKit enforces a sixteen-byte stride
 * for arrays in the uniform address space where Dawn does not, so the shaders that draw everything
 * compiled on every desktop browser and on no iPhone. Nothing in the boot sequence asked, and the
 * player got a black screen.
 *
 * Two checks, because neither finds the other's failures:
 *
 *   1. **Compile what will be compiled.** Catches a device that rejects real source.
 *   2. **Draw a known colour and read it back.** Catches a device that validates everything and
 *      rasterises nothing — which is a black screen with a clean log.
 *
 * **What this costs** is one pipeline and one 1x1 readback at boot, plus the compile of whatever
 * `shaders` is given. **What would make it wrong** is a driver where the probe passes and real
 * content fails anyway; this narrows that window and does not close it, and nothing short of
 * running the game can.
 *
 * Not a hot path: called once, before the first frame.
 */

/** What the probe decided, and why. */
export interface ProbeVerdict {
  readonly ok: boolean;
  /** Why it was refused, in words a bug report can carry. Empty when `ok`. */
  readonly reason: string;
}

/** Magenta, because an empty frame has no red and no blue in either colour space. */
const EXPECTED = [255, 0, 255, 255] as const;

/*
 * Usage flags numerically rather than off `GPUTextureUsage` and friends, matching
 * `render/webgpu/buffers.ts` and for its reason: those globals do not exist under vitest, and a
 * probe that can only run on a device is a probe whose own logic nobody checks. The values are
 * normative in the WebGPU specification, so nothing here is guessed.
 */
const TEXTURE_COPY_SRC = 0x0001;
const TEXTURE_RENDER_ATTACHMENT = 0x0010;
const BUFFER_MAP_READ = 0x0001;
const BUFFER_COPY_DST = 0x0008;
const MAP_MODE_READ = 0x0001;

/** 256 is the smallest bytes-per-row a texture-to-buffer copy accepts. */
const READBACK_BYTES = 256;

const DRAW_WGSL = `
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  var p = array(vec2f(-1.0, -3.0), vec2f(3.0, 1.0), vec2f(-1.0, 1.0));
  return vec4f(p[i], 0.0, 1.0);
}
@fragment fn fs() -> @location(0) vec4f { return vec4f(1.0, 0.0, 1.0, 1.0); }
`;

export async function probeDevice(
  device: GPUDevice,
  shaders: readonly string[],
): Promise<ProbeVerdict> {
  /* Inside the try, with everything else: this function's contract is that it *answers* rather
     than throws, and a device broken enough to reject an error scope must reach the same
     fallback as one that draws black rather than an exception the caller has to catch. */
  try {
    device.pushErrorScope('validation');
    for (const code of shaders) {
      const info = await device.createShaderModule({ code }).getCompilationInfo();
      const failure = info.messages.find((message) => message.type === 'error');
      if (failure !== undefined) {
        await device.popErrorScope();
        return { ok: false, reason: `a shader did not compile: ${failure.message}` };
      }
    }

    const pixel = await drawOnePixel(device);
    const error = await device.popErrorScope();
    if (error !== null) {
      return { ok: false, reason: `the device refused something: ${error.message}` };
    }
    if (pixel === null) {
      return { ok: false, reason: 'the device drew nothing that could be read back' };
    }

    const matches = EXPECTED.every((value, i) => Math.abs(value - (pixel[i] ?? 0)) <= 1);
    if (!matches) {
      return { ok: false, reason: `the device drew nothing: read ${[...pixel].join(',')}` };
    }
    return { ok: true, reason: '' };
  } catch (cause) {
    /* The scope has to be popped whatever happened, and a device that throws here may well
       throw on the pop as well — which must not replace the interesting error with a dull one. */
    try {
      await device.popErrorScope();
    } catch {
      /* nothing to add: the throw below is the one worth reporting */
    }
    return { ok: false, reason: `the device threw during the probe: ${String(cause)}` };
  }
}

/** One triangle of known colour into a 1x1 target, read back. */
async function drawOnePixel(device: GPUDevice): Promise<Uint8Array | null> {
  const module = device.createShaderModule({ code: DRAW_WGSL });
  const pipeline = device.createRenderPipeline({
    layout: 'auto',
    vertex: { module, entryPoint: 'vs' },
    fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] },
    primitive: { topology: 'triangle-list' },
  });

  const target = device.createTexture({
    size: { width: 1, height: 1 },
    format: 'rgba8unorm',
    usage: TEXTURE_RENDER_ATTACHMENT | TEXTURE_COPY_SRC,
    label: 'probe.target',
  });
  const readback = device.createBuffer({
    size: READBACK_BYTES,
    usage: BUFFER_COPY_DST | BUFFER_MAP_READ,
    label: 'probe.readback',
  });

  const encoder = device.createCommandEncoder();
  const pass = encoder.beginRenderPass({
    colorAttachments: [
      {
        view: target.createView(),
        loadOp: 'clear',
        storeOp: 'store',
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
      },
    ],
  });
  pass.setPipeline(pipeline);
  pass.draw(3);
  pass.end();
  encoder.copyTextureToBuffer(
    { texture: target },
    { buffer: readback, bytesPerRow: READBACK_BYTES },
    { width: 1, height: 1 },
  );
  device.queue.submit([encoder.finish()]);
  await device.queue.onSubmittedWorkDone();

  await readback.mapAsync(MAP_MODE_READ);
  const pixel = new Uint8Array(readback.getMappedRange().slice(0, 4));
  readback.unmap();
  readback.destroy();
  target.destroy();
  return pixel;
}
