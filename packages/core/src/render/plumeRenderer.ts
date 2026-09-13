import { PLUME_VERTS } from './plumeGeometry.ts';
import type { FrameView } from './frameView.ts';
import { compileProgram, uniformLocations } from './shader.ts';
import { bindAtmosphere } from './atmosphere.ts';
import { plumeShaders, type PlumeMaterial } from './plumeMaterial.ts';
import { buildPlumeGeometry } from './plumeGeometry.ts';
import type { Atmosphere } from './atmosphere.ts';
import type { Vec3 } from '../math/color.ts';

/**
 * Batched camera-facing quads for volumetric effects — flames, smoke, steam,
 * dust. Game-agnostic: it knows positions, sizes and time, and nothing about
 * what the plume represents.
 *
 * One VAO for the whole batch, four vertices per plume, everything animated on
 * the GPU. The caller supplies the shader pair, so a new effect is a new
 * fragment shader rather than a new renderer.
 */
export interface PlumePlacement {
  x: number;
  y: number;
  z: number;
  /** Half-width and full height, metres. */
  width: number;
  height: number;
}

export type PlumeBlend = 'additive' | 'alpha';

export interface PlumeOptions {
  /**
   * Which plume this is, by name.
   *
   * **This replaced a pair of GLSL source strings on 2026-08-13, and the replacement is a
   * breaking change made on purpose.** A caller-supplied shader is a capability that can only
   * ever exist on WebGL2: WebGPU has no runtime GLSL compiler and this package must not ship
   * one. Naming the material lets each backend resolve what it can compile. See
   * `plumeMaterial.ts` for what was given up.
   */
  material: PlumeMaterial;
  /** Emissive effects (fire) add light; dense ones (smoke) occlude it. */
  blend: PlumeBlend;
  /**
   * How much the quads swell and shrink over time, 0 for a fixed size. Purely
   * visual — anything gameplay depends on must keep its own fixed volume, or
   * the simulation starts depending on the render clock.
   */
  sizePulse?: number;
  /**
   * How far this plume leans in a given wind, metres per m/s at its crown.
   * Smoke is carried; a flame is anchored to its fuel and barely bends.
   */
  windResponse?: number;
  /**
   * Colour handed to the fragment stage as `uTint`, or white when absent.
   *
   * Optional shader contract, the same arrangement `uNoiseOctaves` and
   * `uCameraRight` already use: the uniform is set unconditionally and
   * `uniformLocations` hands back null for a shader that ignores it, so `fire`
   * and `smoke` are untouched by this existing.
   */
  tint?: Vec3;
}

/**
 * Blades in each plume's cross, and the vertices that costs.
 *
 * **Two, crossed at 90°, instead of one card turned to face the viewer.** A single
 * billboard has no three-dimensional structure to see: orbiting a fire showed the
 * identical silhouette from every angle, because every card shared one camera-derived
 * axis and the whole plume swivelled as a sheet. Reported twice: the fire did not read
 * as three-dimensional, it read as something that moved with the camera — and after a
 * first attempt that only *leaned* edge-on cards toward the viewer, it still did,
 * correctly, because leaning still rotates whichever cards are edge-on, so the ensemble
 * still tracks the viewer.
 *
 * A cross cannot track anything: both blades are fixed in world space, so turning
 * around a fire genuinely brings one broadside as the other goes edge-on, which is
 * the parallax a volume has. It also removes the reason billboarding existed — a
 * blade going edge-on no longer vanishes, because its partner is square-on at that
 * exact moment.
 *
 * Two rather than three because the plumes blend additively and are drawn in
 * quantity: the third blade costs 50% more geometry for a difference the eye does not
 * separate at the sizes these are drawn.
 */
const BLADES = 2;
/* The shared count, so both backends step a plume's vertices the same way. */
const VERTS_PER_PLUME = PLUME_VERTS;

const CORNERS = [
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, 1],
] as const;

export class PlumeRenderer {
  private readonly program: WebGLProgram;
  private readonly uniforms: Record<string, WebGLUniformLocation>;
  private readonly vao: WebGLVertexArrayObject;
  private readonly buffers: WebGLBuffer[] = [];
  private readonly indexCount: number;
  /**
   * The per-vertex size buffer, kept so a caller can turn individual plumes off.
   *
   * A batch is uploaded once because a fire does not move — but a *fire that is not always
   * burning* does need saying. Oil slicks ignite on a cycle, and before this there was no way
   * to draw one only while it was alight: the launch happened with an empty screen.
   */
  private readonly sizeBuffer: WebGLBuffer;
  private readonly sizes: Float32Array;
  private readonly baseSizes: Float32Array;
  private readonly blend: PlumeBlend;
  private readonly sizePulse: number;
  private readonly windResponse: number;
  private readonly noiseOctaves: number;
  private readonly tint: Vec3;

  constructor(
    gl: WebGL2RenderingContext,
    plumes: readonly PlumePlacement[],
    options: PlumeOptions,
    noiseOctaves: number,
  ) {
    const shaders = plumeShaders(options.material);
    this.program = compileProgram(gl, shaders.vertexSource, shaders.fragmentSource, shaders.label);
    this.uniforms = uniformLocations(gl, this.program, 'plumeRenderer');
    this.blend = options.blend;
    this.sizePulse = options.sizePulse ?? 0;
    this.windResponse = options.windResponse ?? 0;
    this.noiseOctaves = noiseOctaves;
    this.tint = options.tint ?? [1, 1, 1];

    /* Built in `plumeGeometry.ts`, so both backends lay out the same crossed quads. */
    const { centers, corners, sizes, seeds, blades, indices } = buildPlumeGeometry(plumes);
    this.indexCount = indices.length;

    const vao = gl.createVertexArray();
    if (vao === null) throw new Error(`${shaders.label}: createVertexArray failed`);
    this.vao = vao;
    gl.bindVertexArray(vao);
    this.attach(gl, 0, centers, 3, shaders.label);
    this.attach(gl, 1, corners, 2, shaders.label);
    this.sizeBuffer = this.attach(gl, 2, sizes, 2, shaders.label);
    this.attach(gl, 3, seeds, 1, shaders.label);
    this.attach(gl, 4, blades, 1, shaders.label);
    this.sizes = sizes;
    // The authored sizes, so a hidden plume can be restored to exactly what it was.
    this.baseSizes = new Float32Array(plumes.length * 2);
    for (let f = 0; f < plumes.length; f++) {
      const plume = plumes[f];
      if (plume === undefined) continue;
      this.baseSizes[f * 2] = plume.width;
      this.baseSizes[f * 2 + 1] = plume.height;
    }

    const indexBuffer = gl.createBuffer();
    if (indexBuffer === null) throw new Error(`${shaders.label}: createBuffer failed`);
    this.buffers.push(indexBuffer);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
  }

  /**
   * Scale one plume, 0 to hide it.
   *
   * Writes only that plume's own vertices — every blade of its cross — so turning a slick's
   * fire on costs a handful of floats rather than a re-upload of the batch. The caller owns
   * *when*; the renderer has no idea what a slick is.
   */
  setScale(gl: WebGL2RenderingContext, index: number, scale: number): void {
    const span = VERTS_PER_PLUME * 2;
    const base = index * span;
    if (base < 0 || base + span > this.sizes.length) return;
    const width = this.baseSizes[index * 2] ?? 0;
    const height = this.baseSizes[index * 2 + 1] ?? 0;
    for (let c = 0; c < VERTS_PER_PLUME; c++) {
      this.sizes[base + c * 2] = width * scale;
      this.sizes[base + c * 2 + 1] = height * scale;
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.sizeBuffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, base * 4, this.sizes.subarray(base, base + span));
  }

  /**
   * Draw the batch. Call after the sky: these blend without writing depth, and
   * the sky at depth 1.0 under LEQUAL would otherwise overwrite anything drawn
   * against open background.
   */
  draw(
    gl: WebGL2RenderingContext,
    camera: FrameView,
    timeSeconds: number,
    atmosphere: Atmosphere,
    underwaterEnabled: boolean,
    atmosphereCameraY: number,
    clipPlane: Float32Array | null,
    windX = 0,
    windZ = 0,
    originX = 0,
    originY = 0,
    originZ = 0,
  ): void {
    if (this.indexCount === 0) return;
    const u = this.uniforms;

    gl.useProgram(this.program);
    gl.uniform2f(u['uWind'] ?? null, windX, windZ);
    gl.uniform3f(u['uOrigin'] ?? null, originX, originY, originZ);
    gl.uniform1f(u['uWindResponse'] ?? null, this.windResponse);
    gl.uniformMatrix4fv(u['uViewProj'] ?? null, false, camera.viewProjection);
    const v = camera.view;
    /*
     * The camera's own basis, for shader pairs that billboard. The plume shaders
     * shipped here no longer do — they draw world-fixed crosses, because anything
     * that rotates with the camera reads as flat (see `BLADES`) — but the uniform is
     * part of the generic contract a caller may supply its own vertex shader against,
     * and `uniformLocations` hands back null for a shader that ignores it.
     */
    gl.uniform3f(u['uCameraRight'] ?? null, v[0] ?? 1, v[4] ?? 0, v[8] ?? 0);
    gl.uniform3f(u['uCameraUp'] ?? null, v[1] ?? 0, v[5] ?? 1, v[9] ?? 0);
    gl.uniform3fv(u['uCameraPos'] ?? null, camera.position);
    gl.uniform1f(u['uTime'] ?? null, timeSeconds);
    gl.uniform1f(u['uSizePulse'] ?? null, this.sizePulse);
    // Optional shader contract: generic plume shaders may ignore these uniforms.
    gl.uniform1i(u['uNoiseOctaves'] ?? null, this.noiseOctaves);
    gl.uniform3f(u['uTint'] ?? null, this.tint[0], this.tint[1], this.tint[2]);
    gl.uniform1i(u['uClipEnabled'] ?? null, clipPlane === null ? 0 : 1);
    if (clipPlane !== null) gl.uniform4fv(u['uClipPlane'] ?? null, clipPlane);
    bindAtmosphere(gl, u, atmosphere, atmosphereCameraY, underwaterEnabled);

    gl.enable(gl.BLEND);
    if (this.blend === 'additive') gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
    else gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    gl.disable(gl.CULL_FACE);

    gl.bindVertexArray(this.vao);
    gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_INT, 0);
    gl.bindVertexArray(null);

    gl.enable(gl.CULL_FACE);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
  }

  dispose(gl: WebGL2RenderingContext): void {
    for (const buffer of this.buffers) gl.deleteBuffer(buffer);
    gl.deleteVertexArray(this.vao);
    gl.deleteProgram(this.program);
  }

  /** Uploads one attribute and returns its buffer, for the rare one a caller can change. */
  private attach(
    gl: WebGL2RenderingContext,
    location: number,
    data: Float32Array,
    size: number,
    label: string,
  ): WebGLBuffer {
    const buffer = gl.createBuffer();
    if (buffer === null) throw new Error(`${label}: createBuffer failed`);
    this.buffers.push(buffer);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, size, gl.FLOAT, false, 0, 0);
    return buffer;
  }
}
