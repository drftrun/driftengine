/**
 * A registered pass that reads the finished frame's colour and depth and writes over it:
 * `reads: ['colorSnapshot', 'depthSnapshot']`.
 *
 *     /framePass.html?transform=none&hdr=1&invert=1   grey patches at known values, then a
 *                                                     full-screen pass: one minus the colour where
 *                                                     something was drawn, pure red where the depth
 *                                                     is the far plane's. Each patch reads 255 less
 *                                                     what `invert=0` reads there, and the margin red
 *     /framePass.html?transform=none&hdr=1&invert=0   the frame without the pass: the control
 *     /framePass.html?...&invert=1&recon=1.5&show=copy the copy drawn as it is, under a
 *                                                     reconstruction: the pass then draws after the
 *                                                     upscale, so the copy is the reconstructed
 *                                                     picture with the patches in it, and reads the
 *                                                     control's values. **Not the inversion there**:
 *                                                     the patches are blended draws, which land after
 *                                                     the upscale and in no depth the pass is handed,
 *                                                     so it reads them as far plane
 *
 * Measured 2026-10-06: 242 209 179 128 77 26 over 13 46 76 128 178 229 and a red margin, on both
 * backends, with and without multisampling; and the control's values through the copy at
 * reconstructions of 1 and 1.5.
 *
 * The colour arrives on WebGPU as `PrepareContext.sceneColor` and on WebGL2 as
 * `PassContext.sceneColor`, the depth as the matching `sceneDepth`; both are copies taken at the
 * pass's draw with everything drawn before it. Read with a texel fetch at the pixel's own
 * coordinate, so neither needs a sampler. Nothing under `src/` may import this.
 */
import { Camera, createEnvironment, createRenderer } from '../../packages/core/src/index';
import type {
  MeshData,
  PassContext,
  PassDevice,
  PrepareContext,
  RendererApi,
} from '../../packages/core/src/index';
import { DEV_RENDERER, askedQuality } from './askedQuality';

const ASKED = new URLSearchParams(location.search);
const FOV = 50;
const GREYS = [0.05, 0.18, 0.3, 0.5, 0.7, 0.9];

/** Six grey patches across the middle of the frame, with an empty margin all round. */
function patches(aspect: number): MeshData {
  const h = Math.tan((FOV * Math.PI) / 360);
  const w = h * aspect;
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  GREYS.forEach((grey, column) => {
    const x0 = -0.8 * w + (1.6 * w * column) / GREYS.length;
    const x1 = -0.8 * w + (1.6 * w * (column + 1)) / GREYS.length;
    const base = positions.length / 3;
    positions.push(x0, -0.4 * h, -1, x1, -0.4 * h, -1, x1, 0.4 * h, -1, x0, 0.4 * h, -1);
    for (let k = 0; k < 4; k++) colors.push(grey, grey, grey);
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  });
  const count = positions.length / 3;
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(count * 3).map((_, i) => (i % 3 === 2 ? 1 : 0)),
    colors: new Float32Array(colors),
    emissive: new Float32Array(count),
    indices: new Uint32Array(indices),
  };
}

const VERTEX_GLSL = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const FRAGMENT_GLSL = `#version 300 es
precision highp float;
uniform highp sampler2D uColor;
uniform highp sampler2D uDepth;
uniform float uFar;
out vec4 fragColour;
void main() {
  ivec2 at = ivec2(gl_FragCoord.xy);
  vec3 colour = texelFetch(uColor, at, 0).rgb;
  float depth = texelFetch(uDepth, at, 0).r;
  fragColour = abs(depth - uFar) < 1e-6 ? vec4(1.0, 0.0, 0.0, 1.0) : vec4(1.0 - colour, 1.0);
}`;

/* The far plane is 0 on WebGPU, whose depth is reversed. */
const SHOW_COPY = new URLSearchParams(location.search).get('show') === 'copy';
const WGSL = `
const SHOW_COPY = ${SHOW_COPY};
@group(0) @binding(0) var colour: texture_2d<f32>;
@group(0) @binding(1) var depth: texture_2d<f32>;

@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}

@fragment fn fs(@builtin(position) at: vec4f) -> @location(0) vec4f {
  let texel = vec2i(at.xy);
  let c = textureLoad(colour, texel, 0).rgb;
  let d = textureLoad(depth, texel, 0).r;
  if (SHOW_COPY) { return vec4f(c, 1.0); }
  if (abs(d) < 1e-6) { return vec4f(1.0, 0.0, 0.0, 1.0); }
  return vec4f(1.0 - c, 1.0);
}
`;

class FramePass {
  readonly label = 'probe.framePass';
  readonly reads = ['colorSnapshot', 'depthSnapshot'] as const;
  private gl: WebGL2RenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private far = 1;
  private device: GPUDevice | null = null;
  private module: GPUShaderModule | null = null;
  private layout: GPUBindGroupLayout | null = null;
  /**
   * One pipeline a target: the frame's at the render size, and under a reconstruction the
   * reconstructed picture's after the upscale, which `PassContext.format` names at the draw.
   */
  private readonly pipelines = new Map<string, GPURenderPipeline>();
  private group: GPUBindGroup | null = null;
  private groupColour: GPUTextureView | null = null;
  private groupDepth: GPUTextureView | null = null;

  init(device: PassDevice): void {
    if (device.backend === 'webgl2') {
      const { gl } = device;
      this.gl = gl;
      this.program = link(gl, VERTEX_GLSL, FRAGMENT_GLSL);
      this.vao = gl.createVertexArray();
      /* Reversed depth on this context exactly where the pass's correction remaps it. */
      this.far = device.depthCorrection[10] === 1 ? 1 : 0;
      return;
    }
    this.device = device.device;
    this.module = device.device.createShaderModule({ label: this.label, code: WGSL });
    this.layout = device.device.createBindGroupLayout({
      label: this.label,
      entries: [
        { binding: 0, visibility: 0x2, texture: { sampleType: 'unfilterable-float' } },
        { binding: 1, visibility: 0x2, texture: { sampleType: 'unfilterable-float' } },
      ],
    });
  }

  private pipelineFor(format: GPUTextureFormat, depthFormat: GPUTextureFormat, samples: number) {
    const key = `${format}/${depthFormat}/${samples}`;
    const known = this.pipelines.get(key);
    if (known !== undefined) return known;
    if (this.device === null || this.module === null || this.layout === null) return null;
    const module = this.module;
    const built = this.device.createRenderPipeline({
      label: this.label,
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.layout] }),
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [{ format }] },
      primitive: { topology: 'triangle-list' },
      depthStencil: { format: depthFormat, depthWriteEnabled: false, depthCompare: 'always' },
      multisample: { count: samples },
    });
    this.pipelines.set(key, built);
    return built;
  }

  /** The bind group over this frame's two copies, rebuilt only when either view changes. */
  prepare(ctx: PrepareContext): void {
    if (ctx.backend !== 'webgpu' || this.device === null || this.layout === null) return;
    const { sceneColor, sceneDepth } = ctx;
    if (sceneColor === null || sceneDepth === null) {
      this.group = null;
      return;
    }
    if (sceneColor === this.groupColour && sceneDepth === this.groupDepth) return;
    this.groupColour = sceneColor;
    this.groupDepth = sceneDepth;
    this.group = this.device.createBindGroup({
      label: this.label,
      layout: this.layout,
      entries: [
        { binding: 0, resource: sceneColor },
        { binding: 1, resource: sceneDepth },
      ],
    });
  }

  draw(ctx: PassContext): void {
    if (ctx.backend === 'webgl2') {
      const { gl } = ctx;
      if (ctx.sceneColor === null || ctx.sceneDepth === null || this.program === null) return;
      const depthWas = gl.isEnabled(gl.DEPTH_TEST);
      const program = gl.getParameter(gl.CURRENT_PROGRAM) as WebGLProgram | null;
      gl.disable(gl.DEPTH_TEST);
      gl.useProgram(this.program);
      gl.bindVertexArray(this.vao);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, ctx.sceneColor);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, ctx.sceneDepth);
      gl.uniform1i(gl.getUniformLocation(this.program, 'uColor'), 0);
      gl.uniform1i(gl.getUniformLocation(this.program, 'uDepth'), 1);
      gl.uniform1f(gl.getUniformLocation(this.program, 'uFar'), this.far);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindVertexArray(null);
      gl.activeTexture(gl.TEXTURE0);
      gl.useProgram(program);
      if (depthWas) gl.enable(gl.DEPTH_TEST);
      return;
    }
    const pipeline = this.pipelineFor(ctx.format, ctx.depthFormat, ctx.samples);
    if (pipeline === null || this.group === null) return;
    ctx.pass.setPipeline(pipeline);
    ctx.pass.setBindGroup(0, this.group);
    ctx.pass.draw(3);
  }

  dispose(): void {
    if (this.gl !== null) {
      if (this.program !== null) this.gl.deleteProgram(this.program);
      if (this.vao !== null) this.gl.deleteVertexArray(this.vao);
    }
  }
}

function link(gl: WebGL2RenderingContext, vertex: string, fragment: string): WebGLProgram {
  const compile = (kind: number, source: string): WebGLShader => {
    const shader = gl.createShader(kind);
    if (shader === null) throw new Error('framePass: the context refused a shader');
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error(`framePass: ${gl.getShaderInfoLog(shader) ?? 'shader did not compile'}`);
    }
    return shader;
  };
  const program = gl.createProgram();
  if (program === null) throw new Error('framePass: the context refused a program');
  gl.attachShader(program, compile(gl.VERTEX_SHADER, vertex));
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragment));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`framePass: ${gl.getProgramInfoLog(program) ?? 'program did not link'}`);
  }
  return program;
}

async function main(): Promise<void> {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const stats = document.getElementById('stats') as HTMLElement;
  const created = await createRenderer(canvas, askedQuality(), DEV_RENDERER);
  const renderer: RendererApi = created.renderer;
  renderer.resize();
  const aspect = canvas.height > 0 ? canvas.width / canvas.height : 1;
  const mesh = renderer.createMesh(patches(aspect));
  const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const camera = new Camera();
  camera.fovYDeg = FOV;
  camera.near = 0.1;
  camera.far = 10;
  camera.updateMatrices(aspect);
  const env = createEnvironment({ fogDensity: 0 });
  const invert = ASKED.get('invert') === '1';
  const handle = invert ? renderer.registerPass(new FramePass()) : null;
  const frame = (): void => {
    renderer.beginFrame([0, 0, 0]);
    renderer.bindMeshPass(camera, env);
    renderer.drawTranslucentMesh(mesh, identity, 1, { lit: false, fog: false });
    if (handle !== null) renderer.drawPass(handle);
    renderer.endFrame();
    requestAnimationFrame(frame);
  };
  frame();
  stats.textContent = `${created.backend} · frame pass · ${location.search}`;
}

void main();
