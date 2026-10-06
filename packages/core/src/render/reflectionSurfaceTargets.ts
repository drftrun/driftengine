/**
 * The frame's materials' reflection maps on WebGL2: two half-float textures on the scene's own
 * framebuffer, beside its colour, written by the opaque lit draws as they are drawn. What the two
 * hold is `shaders/flat/reflectionSurface.ts`'s to say; this is where they live on this backend.
 *
 * **Written in the frame's own pass, where WebGPU replays the draws in a second one.** A WebGL2
 * program writing an output its framebuffer has no buffer enabled for loses that output and nothing
 * else, so the maps are enabled around an opaque lit draw (`on`, `off`) and stay disabled for every
 * other: the sky, glass, text and particles write no material, and a draw into a mirror, a probe or
 * a capture is into another framebuffer, whose draw buffers this never touches.
 *
 * **Detached once the trace has read them** (`detach`), because the resolve then draws into the
 * scene's framebuffer while sampling both, and a texture sampled while attached to the framebuffer
 * being drawn is a feedback loop whether or not its buffer is enabled. `begin` attaches them again.
 */
const ZERO = new Float32Array(4);

export class ReflectionSurfaceTargets {
  private probe: WebGLTexture | null = null;
  private tint: WebGLTexture | null = null;
  private width = 0;
  private height = 0;
  private readonly all: number[];
  private readonly colourAlone: number[];

  constructor(private readonly gl: WebGL2RenderingContext) {
    this.all = [gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1, gl.COLOR_ATTACHMENT2];
    this.colourAlone = [gl.COLOR_ATTACHMENT0];
  }

  /** The environment as the frame shows it, and the roughness in alpha. */
  get probeTexture(): WebGLTexture | null {
    return this.probe;
  }

  /** What a found reflection is multiplied by. */
  get tintTexture(): WebGLTexture | null {
    return this.tint;
  }

  /**
   * At the frame's start, with the scene's framebuffer bound: both at its size, attached, cleared to
   * nothing reflected, and left disabled.
   */
  begin(width: number, height: number): void {
    const { gl } = this;
    if (this.probe === null || this.width !== width || this.height !== height) {
      this.release();
      this.probe = this.make(width, height);
      this.tint = this.make(width, height);
      this.width = width;
      this.height = height;
    }
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, this.probe, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT2, gl.TEXTURE_2D, this.tint, 0);
    gl.drawBuffers(this.all);
    gl.clearBufferfv(gl.COLOR, 1, ZERO);
    gl.clearBufferfv(gl.COLOR, 2, ZERO);
    gl.drawBuffers(this.colourAlone);
  }

  /** Around an opaque lit draw into the frame: its two extra outputs land. */
  on(): void {
    this.gl.drawBuffers(this.all);
  }

  /** And after it: only the colour does. */
  off(): void {
    this.gl.drawBuffers(this.colourAlone);
  }

  /** With the scene's framebuffer bound, after the trace has read them: see the header. */
  detach(): void {
    const { gl } = this;
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, null, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT2, gl.TEXTURE_2D, null, 0);
  }

  dispose(): void {
    this.release();
  }

  private make(width: number, height: number): WebGLTexture {
    const { gl } = this;
    const texture = gl.createTexture();
    if (texture === null) throw new Error('ReflectionSurfaceTargets: createTexture failed');
    /* Unit 0, chosen rather than inherited, for the reason `SsrPass` gives. */
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA16F, width, height);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
    return texture;
  }

  private release(): void {
    if (this.probe !== null) this.gl.deleteTexture(this.probe);
    if (this.tint !== null) this.gl.deleteTexture(this.tint);
    this.probe = null;
    this.tint = null;
  }
}
