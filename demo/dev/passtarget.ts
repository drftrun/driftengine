/**
 * Does a contributed pass really own a target, fill it before the frame, and sample it during one?
 *
 * **This page exists because the seam it exercises has no picture of its own.** A pass-owned
 * attachment is machinery: what it draws is whatever the package draws, and a screenshot of that
 * says nothing about whether the target was filled at the right moment. So the evidence is the
 * same shape `compute.html` uses for the other seam with no picture — a readback compared against
 * numbers written here.
 *
 *     /passtarget.html?backend=webgpu
 *     /passtarget.html?backend=webgl2
 *
 * **What it does.** A pass creates a 64x64 target in `init`. In `prepare` it clears that target to
 * **red on even frames and green on odd ones**, and in `draw` it samples the target across the
 * whole frame. The page then reads the middle pixel of the canvas back and compares the dominant
 * channel against the frame's parity.
 *
 * **The alternation is the whole instrument, and a constant colour would not be one.** A pass-owned
 * target filled *after* the frame's pass had already opened would be sampled one frame late — the
 * canvas would show the previous frame's colour, which is a lag a still picture cannot see and a
 * consumer would blame on their own timing. Alternating makes that failure the loudest possible
 * one: every reported frame is wrong instead of none of them.
 *
 * **What a failure looks like**, so it is recognised rather than explained away:
 *
 *   - **Every frame black** — the target was never sampled. On WebGPU read the device console
 *     first: a validation failure reports at `submit` naming the resource, and every resource here
 *     is labelled so that message is readable.
 *   - **Every frame the previous frame's colour** — `prepare` is running in the wrong place. That
 *     is the bug this page exists for.
 *   - **The first frame right and the rest black on WebGL2** — `prepare` left its own framebuffer
 *     bound, and the frame after it drew into a 64-pixel texture.
 *
 * Nothing here is engine API, and nothing under `packages/*​/src` may import it.
 */
import { createPassAttachment, createRenderer } from '../../packages/core/src/index';
import type {
  PassContext,
  PassDevice,
  PassTarget,
  PrepareContext,
  RendererApi,
} from '../../packages/core/src/index';
import { DEV_RENDERER, askedQuality } from './askedQuality';

/** Small on purpose: nothing here is about resolution, and a small target is a fast readback. */
const SIZE = 64;
/** How many frames to run before reporting. Enough that a one-frame lag cannot look like a start. */
const FRAMES = 6;

/** What the page reports, and what a checker reads. */
interface Result {
  backend: string;
  /** One entry a frame: the parity asked for and the dominant channel that came back. */
  frames: { parity: number; r: number; g: number; b: number; ok: boolean }[];
  ok: boolean;
  error: string | null;
}

const VERTEX_GLSL = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const FRAGMENT_GLSL = `#version 300 es
precision highp float;
uniform sampler2D uSource;
out vec4 fragColour;
void main() {
  fragColour = texelFetch(uSource, ivec2(${SIZE / 2}, ${SIZE / 2}), 0);
}`;

const WGSL = `
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;

@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}

@fragment fn fs() -> @location(0) vec4f {
  return textureSampleLevel(src, samp, vec2f(0.5, 0.5), 0.0);
}
`;

/** Red on an even frame, green on an odd one. Saturated, so any tone curve leaves the winner. */
function colourFor(frame: number): [number, number, number] {
  return frame % 2 === 0 ? [1, 0, 0] : [0, 1, 0];
}

/**
 * The contributed pass, holding whatever its backend needs and nothing the other one does.
 *
 * A package branches on the backend anyway — a different shader, a different pipeline, a different
 * buffer layout — which is the argument `PassDevice` makes for being a union rather than a neutral
 * device. This is that argument in a page: two arms, no common abstraction between them.
 */
class OwnedTargetPass {
  readonly label = 'probe.ownedTarget';
  frame = 0;
  private target: PassTarget | null = null;
  private gl: WebGL2RenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private pipeline: GPURenderPipeline | null = null;
  private bindGroup: GPUBindGroup | null = null;

  init(device: PassDevice): void {
    this.target = createPassAttachment(device, {
      label: 'probe.ownedTarget',
      width: SIZE,
      height: SIZE,
    });
    if (device.backend === 'webgl2') {
      const { gl } = device;
      this.gl = gl;
      this.program = link(gl, VERTEX_GLSL, FRAGMENT_GLSL);
      this.vao = gl.createVertexArray();
      return;
    }
    const { device: gpu } = device;
    const module = gpu.createShaderModule({ label: 'probe.ownedTarget', code: WGSL });
    this.pipeline = gpu.createRenderPipeline({
      label: 'probe.ownedTarget',
      layout: 'auto',
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [{ format: device.format }] },
      primitive: { topology: 'triangle-list' },
      /* The frame's own depth attachment is bound whether this pass wants it or not, so a
         pipeline that declared none would not match the pass it is drawn into. */
      depthStencil: {
        format: device.depthFormat,
        depthWriteEnabled: false,
        depthCompare: 'always',
      },
      multisample: { count: device.samples },
    });
    if (this.target?.backend !== 'webgpu') return;
    this.bindGroup = gpu.createBindGroup({
      label: 'probe.ownedTarget',
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this.target.colourView },
        { binding: 1, resource: gpu.createSampler({ label: 'probe.ownedTarget' }) },
      ],
    });
  }

  /** Fill the target this pass owns. No shader: a clear is the whole of what is being proved. */
  prepare(ctx: PrepareContext): void {
    const target = this.target;
    if (target === null) return;
    const [r, g, b] = colourFor(this.frame);
    if (ctx.backend === 'webgl2' && target.backend === 'webgl2') {
      const { gl } = ctx;
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
      gl.viewport(0, 0, target.width, target.height);
      gl.clearColor(r, g, b, 1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      /* The contract, and the one line whose absence takes the whole frame with it. */
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return;
    }
    if (ctx.backend !== 'webgpu' || target.backend !== 'webgpu') return;
    const pass = ctx.encoder.beginRenderPass({
      label: 'probe.ownedTarget',
      colorAttachments: [
        {
          view: target.colourView,
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: { r, g, b, a: 1 },
        },
      ],
      depthStencilAttachment:
        target.depthView === null
          ? undefined
          : {
              view: target.depthView,
              depthLoadOp: 'clear',
              depthStoreOp: 'store',
              depthClearValue: 1,
            },
    });
    pass.end();
  }

  /** Sample it across the frame, so what the canvas shows is what the target holds. */
  draw(ctx: PassContext): void {
    const target = this.target;
    if (target === null) return;
    if (ctx.backend === 'webgl2' && target.backend === 'webgl2') {
      const { gl } = ctx;
      const depthWas = gl.isEnabled(gl.DEPTH_TEST);
      gl.disable(gl.DEPTH_TEST);
      gl.useProgram(this.program);
      gl.bindVertexArray(this.vao);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, target.colour);
      gl.uniform1i(gl.getUniformLocation(this.program as WebGLProgram, 'uSource'), 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindVertexArray(null);
      if (depthWas) gl.enable(gl.DEPTH_TEST);
      return;
    }
    if (ctx.backend !== 'webgpu' || this.pipeline === null || this.bindGroup === null) return;
    ctx.pass.setPipeline(this.pipeline);
    ctx.pass.setBindGroup(0, this.bindGroup);
    ctx.pass.draw(3);
  }

  dispose(): void {
    this.target?.dispose();
    this.target = null;
    if (this.gl !== null) {
      if (this.program !== null) this.gl.deleteProgram(this.program);
      if (this.vao !== null) this.gl.deleteVertexArray(this.vao);
    }
  }
}

function link(gl: WebGL2RenderingContext, vertex: string, fragment: string): WebGLProgram {
  const compile = (kind: number, source: string): WebGLShader => {
    const shader = gl.createShader(kind);
    if (shader === null) throw new Error('passtarget: the context refused a shader');
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error(`passtarget: ${gl.getShaderInfoLog(shader) ?? 'shader did not compile'}`);
    }
    return shader;
  };
  const program = gl.createProgram();
  if (program === null) throw new Error('passtarget: the context refused a program');
  gl.attachShader(program, compile(gl.VERTEX_SHADER, vertex));
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragment));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`passtarget: ${gl.getProgramInfoLog(program) ?? 'program did not link'}`);
  }
  return program;
}

/**
 * The middle pixel of the canvas, read through a 2D context.
 *
 * `drawImage` rather than `readPixels`, because one call answers for both backends and neither
 * needs `preserveDrawingBuffer`. Read in the same task as the frame that drew it, which is the
 * only point at which a drawing buffer is guaranteed to still hold it.
 */
function centrePixel(canvas: HTMLCanvasElement, scratch: HTMLCanvasElement): Uint8ClampedArray {
  /* `willReadFrequently`, because this reads back every frame and Chromium warns otherwise —
     and a warning on an instrument's own console is noise the instrument then has to filter. */
  const ctx = scratch.getContext('2d', { willReadFrequently: true });
  if (ctx === null) throw new Error('passtarget: no 2D context to read the frame through');
  ctx.drawImage(canvas, 0, 0, scratch.width, scratch.height);
  return ctx.getImageData(scratch.width >> 1, scratch.height >> 1, 1, 1).data;
}

async function main(): Promise<void> {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const out = document.getElementById('out') as HTMLElement;
  const created = await createRenderer(canvas, askedQuality(), DEV_RENDERER);
  const renderer: RendererApi = created.renderer;
  const result: Result = { backend: created.backend, frames: [], ok: false, error: null };

  const scratch = document.createElement('canvas');
  scratch.width = 32;
  scratch.height = 32;

  try {
    const pass = new OwnedTargetPass();
    const handle = renderer.registerPass(pass);
    for (let frame = 0; frame < FRAMES; frame++) {
      pass.frame = frame;
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      renderer.beginFrame([0, 0, 0]);
      renderer.drawPass(handle);
      renderer.endFrame();
      const [r = 0, g = 0, b = 0] = centrePixel(canvas, scratch);
      const parity = frame % 2;
      const ok = parity === 0 ? r > g && r > 40 : g > r && g > 40;
      result.frames.push({ parity, r, g, b, ok });
    }
    renderer.unregisterPass(handle);
    /* The first frame is dropped: a swap chain configured this task may present one frame late,
       and that is a browser's presentation rather than anything this seam decides. */
    result.ok = result.frames.slice(1).every((f) => f.ok);
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  }

  (globalThis as unknown as { __passTargetCheck: Result }).__passTargetCheck = result;
  out.textContent =
    `backend ${result.backend}\nok ${result.ok}\n` +
    (result.error !== null ? `error ${result.error}\n` : '') +
    result.frames
      .map((f) => `${f.parity} -> ${f.r} ${f.g} ${f.b} ${f.ok ? 'ok' : 'WRONG'}`)
      .join('\n');
}

void main();
