/**
 * A pass registered from outside the renderer, drawn by both backends.
 *
 * **The scene exists because an API nothing uses is an API nobody has checked.** `registerPass`
 * is the whole of what lets `@driftengine/splats`, `ui2d` and `xr` become packages, and every
 * claim about it up to here was a unit test against a stub. This draws real geometry through it,
 * on a real device, on both backends, and a capture compares the two.
 *
 * The pass is written as a package would write one: it owns its shader, its buffer and its
 * pipeline, it builds them in `init`, it draws in `draw`, and it never touches an engine internal.
 * Everything it is handed comes through `PassDevice` and `PassContext`.
 */
import { Camera, createEnvironment, createRenderer } from '../packages/core/src/index';
import type {
  PassContext,
  PassDefinition,
  PassDevice,
  PassHandle,
  RenderBackend,
  RendererApi,
  RenderQualityOptions,
  SkyColors,
} from '../packages/core/src/index';

import { DEMO_BACKEND } from './backend';
import { OrbitView } from './orbit';
import type { DemoBudget, DemoHandle, DemoScene, DemoStats } from './types';

/**
 * Bars across the frame, so a capture can see at a glance whether the pass ran.
 *
 * Sat clear of the bottom of the frame on purpose: the readout band is drawn over the last
 * forty-odd pixels, and `shots.mjs` is gated with `--region=0,92,1280,678` to keep its changing
 * `ms gpu` digits out of a diff. Geometry underneath it is geometry the gate cannot see.
 */
const BAR_COUNT = 24;

/**
 * The same picture in two languages.
 *
 * A contributor writes both, and that is the honest shape rather than a shortcoming: a package
 * drawing splats has a different sort, a different buffer layout and a different shader per
 * backend, so the union in `PassContext` makes a branch it was going to make anyway explicit.
 */
const WGSL = `
struct Out { @builtin(position) pos: vec4f, @location(0) tint: f32 }

@vertex
fn vs(@builtin(vertex_index) vertex: u32) -> Out {
  /* Indexed off the vertex and not off the instance, so the two backends compute the same
     geometry from the same one number: the GLSL half has no instancing to reach for. */
  let bar = vertex / 6u;
  let width = 2.0 / f32(${BAR_COUNT}) * 0.55;
  let left = -1.0 + 2.0 / f32(${BAR_COUNT}) * f32(bar);
  let height = 0.06 + 0.10 * f32(bar % 3u);
  let corner = array(
    vec2f(0.0, 0.0), vec2f(1.0, 0.0), vec2f(0.0, 1.0),
    vec2f(0.0, 1.0), vec2f(1.0, 0.0), vec2f(1.0, 1.0),
  )[vertex % 6u];
  var out: Out;
  out.pos = vec4f(left + corner.x * width, -0.75 + corner.y * height, 0.0, 1.0);
  out.tint = f32(bar) / f32(${BAR_COUNT});
  return out;
}

@fragment
fn fs(in: Out) -> @location(0) vec4f {
  return vec4f(0.15 + 0.85 * in.tint, 0.55, 1.0 - 0.6 * in.tint, 1.0);
}
`;

const VERT = `#version 300 es
precision highp float;
out float vTint;
void main() {
  int bar = gl_VertexID / 6;
  int corner = gl_VertexID % 6;
  float width = 2.0 / float(${BAR_COUNT}) * 0.55;
  float left = -1.0 + 2.0 / float(${BAR_COUNT}) * float(bar);
  float height = 0.06 + 0.10 * float(bar % 3);
  vec2 offsets[6] = vec2[6](
    vec2(0.0, 0.0), vec2(1.0, 0.0), vec2(0.0, 1.0),
    vec2(0.0, 1.0), vec2(1.0, 0.0), vec2(1.0, 1.0)
  );
  vec2 at = offsets[corner];
  vTint = float(bar) / float(${BAR_COUNT});
  gl_Position = vec4(left + at.x * width, -0.75 + at.y * height, 0.0, 1.0);
}
`;

const FRAG = `#version 300 es
precision highp float;
in float vTint;
out vec4 fragColor;
void main() {
  fragColor = vec4(0.15 + 0.85 * vTint, 0.55, 1.0 - 0.6 * vTint, 1.0);
}
`;

/**
 * What a package's pass looks like from the inside.
 *
 * **It leaves the context as it found it**, which is the contract in `PassDefinition.draw`: the
 * WebGL2 half unbinds its vertex array and the WebGPU half sets nothing the next verb does not
 * set for itself. Neither allocates: the buffers and the pipeline are built once in `init`.
 */
class BarsPass implements PassDefinition {
  readonly label = 'demo.bars';

  private program: WebGLProgram | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private pipeline: GPURenderPipeline | null = null;

  init(device: PassDevice): void {
    if (device.backend === 'webgl2') {
      const { gl } = device;
      const compile = (kind: number, source: string): WebGLShader => {
        const shader = gl.createShader(kind);
        if (shader === null) throw new Error('demo.bars: createShader failed');
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        return shader;
      };
      const program = gl.createProgram();
      if (program === null) throw new Error('demo.bars: createProgram failed');
      gl.attachShader(program, compile(gl.VERTEX_SHADER, VERT));
      gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAG));
      gl.linkProgram(program);
      this.program = program;
      /* A vertex array with nothing in it: the geometry is `gl_VertexID` arithmetic, so there is
         no buffer to describe. It still has to exist, because a draw with the default vertex
         array bound is invalid in a core WebGL2 context. */
      this.vao = gl.createVertexArray();
      return;
    }

    const module = device.device.createShaderModule({ label: 'demo.bars', code: WGSL });
    this.pipeline = device.device.createRenderPipeline({
      label: 'demo.bars',
      layout: 'auto',
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [{ format: device.format }] },
      primitive: { topology: 'triangle-list' },
      /* The frame's own sample count, which is why `PassDevice` carries it: a pipeline whose
         count disagrees with the pass it is set on is rejected outright. */
      multisample: { count: device.samples },
      /* Depth is the frame's, and these bars sit in front of everything without testing. The
         format is the renderer's own, read off `PassDevice` — it was hard-coded as `depth24plus`
         until 2026-08-25, which was right about this frame and was a contributor guessing. */
      depthStencil: {
        format: device.depthFormat,
        depthWriteEnabled: false,
        depthCompare: 'always',
      },
    });
  }

  draw(ctx: PassContext): void {
    if (ctx.backend === 'webgl2') {
      const { gl } = ctx;
      if (this.program === null) return;
      gl.useProgram(this.program);
      gl.bindVertexArray(this.vao);
      gl.drawArrays(gl.TRIANGLES, 0, BAR_COUNT * 6);
      /* Put back what was borrowed. The renderer's verbs assume what they left. */
      gl.bindVertexArray(null);
      return;
    }
    if (this.pipeline === null) return;
    ctx.pass.setPipeline(this.pipeline);
    ctx.pass.draw(BAR_COUNT * 6);
    /* Read so the field is exercised on a real device every time the shots run. These bars are
       flat colour and do not grade; a pass that shades has to, per `PassContext`. */
    void ctx.outputTransform;
  }

  dispose(device: PassDevice): void {
    if (device.backend !== 'webgl2') return;
    if (this.program !== null) device.gl.deleteProgram(this.program);
    if (this.vao !== null) device.gl.deleteVertexArray(this.vao);
  }
}

const SKY: SkyColors = {
  top: [0.06, 0.09, 0.16],
  horizon: [0.22, 0.26, 0.34],
  deep: [0.02, 0.03, 0.06],
  sunDir: [0.3, 0.7, 0.4],
  sunColor: [1, 0.95, 0.85],
  sunAngularRadius: 0.005,
  moonDir: [-0.3, 0.6, -0.4],
  moonColor: [0.5, 0.55, 0.7],
  moonAngularRadius: 0.006,
  moonPhase: 0.5,
  nightFactor: 0.7,
  cloudOffsetX: 0,
  cloudOffsetZ: 0,
};

const ENV = createEnvironment({
  directionalDir: [0.3, 0.7, 0.4],
  directionalColor: [0.8, 0.8, 0.9],
  ambient: [0.1, 0.12, 0.16],
  ambientGround: [0.05, 0.05, 0.07],
  emissiveGain: 1,
  nightFactor: 0.7,
  fogColor: [0.12, 0.14, 0.2],
  fogDensity: 0.004,
  fogHeightFalloff: 0.05,
  fogBaseY: 0,
});

class ContributedPassHandle implements DemoHandle {
  private readonly renderer: RendererApi;
  private readonly camera = new Camera();
  readonly view = new OrbitView(6, 60, 1.1);
  private readonly bars = new BarsPass();
  private readonly pass: PassHandle;
  private readonly stats: DemoStats = { draws: 0, gpuMs: 0, instances: 0 };
  private disposed = false;

  get backend(): RenderBackend {
    return this.renderer.backend;
  }

  get lost(): boolean {
    return this.renderer.contextLost;
  }

  private readonly canvas: HTMLCanvasElement;

  constructor(renderer: RendererApi, canvas: HTMLCanvasElement) {
    this.renderer = renderer;
    this.canvas = canvas;
    this.renderer.resize();
    this.pass = this.renderer.registerPass(this.bars);
  }

  frame(_dtSec: number): DemoStats {
    if (this.disposed || this.renderer.contextLost) return this.stats;
    /* A fixed viewpoint unless a reader takes it: the bars are in clip space and do not move,
       and what is behind them only has to be something. */
    if (this.view.taken) this.view.place(this.camera);
    else this.view.follow(this.camera, 0, 1, -6);
    this.camera.updateMatrices(this.canvas.height > 0 ? this.canvas.width / this.canvas.height : 1);

    this.renderer.beginFrame([0.04, 0.05, 0.08]);
    this.renderer.bindMeshPass(this.camera, ENV);
    this.renderer.drawSky(this.camera, SKY, ENV);
    /*
     * **Here, and this line is the whole scene.** The pass draws where the caller puts it: after
     * the sky and before the frame ends, exactly as a built-in verb would. Moving this line moves
     * the bars in the frame, which is the only ordering guarantee a contributor gets and the only
     * one it should want.
     */
    this.renderer.drawPass(this.pass);
    this.renderer.endFrame();

    this.stats.draws = 2;
    this.stats.gpuMs = 0;
    return this.stats;
  }

  resize(): void {
    this.renderer.resize();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.renderer.unregisterPass(this.pass);
    this.renderer.dispose();
  }
}

export const contributedPass: DemoScene = {
  id: 'contributed-pass',
  title: 'A pass from outside the engine',
  note:
    'The bars along the bottom are not drawn by any of the renderer’s verbs. They come from a ' +
    'pass registered against it, which owns its own shader and pipeline on each backend and is ' +
    'invoked where the scene puts it. It is what a rendering package would be made of.',

  async mount(
    canvas: HTMLCanvasElement,
    _budget: DemoBudget = 'full',
    overrides: RenderQualityOptions = {},
  ): Promise<DemoHandle> {
    const { renderer } = await createRenderer(canvas, { ...overrides }, DEMO_BACKEND);
    await renderer.ready();
    return new ContributedPassHandle(renderer, canvas);
  },
};
