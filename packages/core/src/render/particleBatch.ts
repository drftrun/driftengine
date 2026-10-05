import { compileProgram, uniformLocations } from './shader.ts';
import { particleShaders, type ParticleMaterial } from './particleMaterial.ts';
import { PARTICLE_BLADES, PARTICLE_INDICES, PARTICLE_VERTS } from './shaders/particle.ts';
import type { ParticleInstances } from './particlePool.ts';
import { blendCovering, blendKeeping } from './sceneCoverage.ts';
import type { SurfaceTexture } from './surfaceTexture.ts';
import { PARTICLE_SPRITE_UNIT } from './lightBudget.ts';
import { createParticleSort, sortBackToFront, type ParticleSort } from './particleSort.ts';

/** The vertex stage's `uCameraFacing` for a facing: the cross 0, the camera 1, the travel 2. */
export function facingCode(facing: ParticleFacing): number {
  return facing === 'cross' ? 0 : facing === 'velocity' ? 2 : 1;
}

/**
 * A sprite's frame and half-height, two floats a particle, into `out` — the stream the vertex
 * stage reads at location 10. Shared by both backends, so the two read one layout.
 */
export function packSpriteStream(data: ParticleInstances, count: number, out: Float32Array): void {
  const frames = data.frames;
  const heights = data.heights;
  for (let i = 0; i < count; i++) {
    out[i * 2] = frames?.[i] ?? 0;
    out[i * 2 + 1] = heights?.[i] ?? 0;
  }
}

/**
 * One draw call for a live particle pool: one camera-facing quad per particle, or a
 * crossed pair of world-fixed ones when `facing` asks for them.
 *
 * Instanced: the cross is uploaded once as eight vertices, and each frame only the
 * per-particle stream is re-sent. That is the difference between this and the
 * scatter path it replaces — `InstancedMesh` is built for data that never changes
 * after placement, and a particle system's data changes entirely every frame.
 *
 * Blending and depth are the batch's own decision because they are a property of
 * the *material*: smoke occludes what is behind it and sparks add to it, and a
 * caller that had to remember which would eventually forget. Neither writes depth
 * — a soft particle that did would punch a hole in everything drawn after it.
 */
export type ParticleBlend = 'additive' | 'alpha';

/**
 * How a particle's quads are turned.
 *
 * `'camera'` is one quad facing the viewer, and the default. `'cross'` is the pair of
 * world-fixed blades this batch drew before the option existed — see `uCameraFacing` in
 * `shaders/particle.ts` for the artifact that made the default the other one, and for what
 * the cross still buys a caller who wants it back. `'velocity'` faces the camera with its up along
 * the particle's travel across the view — a streak, a spark stretched by its motion — and a
 * particle at rest faces the camera as `'camera'` does.
 */
export type ParticleFacing = 'camera' | 'cross' | 'velocity';

export interface ParticleBatchOptions {
  /**
   * Which particle this is, by name.
   *
   * **This replaced a GLSL source string on 2026-08-13**, the same change and for the same
   * reason as `PlumeOptions.material`: a caller-supplied shader is a capability that can only
   * ever exist on WebGL2, and naming the material lets each backend resolve what it can
   * compile. See `particleMaterial.ts`.
   */
  material: ParticleMaterial;
  blend: ParticleBlend;
  /**
   * Seconds of travel a particle is stretched along. 0 for smoke.
   *
   * **The velocity it stretches along is a direction to be drawn on, not a motion being
   * simulated, and it must stay that way.** Nothing here integrates it: a caller writes both
   * position and velocity every frame, so a deterministic consumer that computes where a
   * particle *is* from its own plan can still ask for the streak that a moving thing has. That
   * is load-bearing outside this repository, where a corona's streamers are the spark material
   * stretched radially and nothing about them moves. Advancing position from this would take
   * the feature away from every caller that is not running a simulation.
   */
  stretchSec?: number;
  /** How hard the noise erodes a puff, 0 to 1. Ignored by the spark and mote materials. */
  erosion?: number;
  /** How far past white a spark's core may go. Ignored by the smoke and mote materials. */
  coreGain?: number;
  /**
   * Whether the medium's fog and underwater tint reach this pool. Ignored by the spark and
   * smoke materials, which stay unconditionally fogged — a real ember and real grit belong in
   * the same haze as the rest of the world, matching every particle drawn before this option
   * existed. Defaults to false, because a caller reaching for `'mote'` over `'spark'`/`'smoke'`
   * is usually asking for exactly what those two cannot draw: an unlit point exactly its own
   * colour, untouched by distance. See `PARTICLE_MOTE_FRAG`'s own comment on `uFogEnabled`.
   */
  fog?: boolean;
  /**
   * Whether each particle is one camera-facing quad or a world-fixed cross of two.
   *
   * Defaults to `'camera'`, and **this default changed** — every particle drawn before it
   * was a cross. A cross has a blade edge-on down each of two world axes, and a sprite
   * squeezed into a one-pixel column spends its whole brightness there: a bright straight
   * line through the middle, worst on the additive materials, and a pair of them from
   * directly above. Consider `'cross'` when the camera stays near horizontal and the
   * parallax of two blades is worth more than a stable brightness, which is the trade the
   * shader's own comment on `uCameraFacing` lays out.
   */
  facing?: ParticleFacing;
  /**
   * The image a `'sprite'` draws: a surface texture, its first layer. **Required by the sprite** and
   * ignored by the procedural materials. Colour is the particle's times the image's, unlit.
   */
  texture?: SurfaceTexture;
  /**
   * A `'sprite'`'s flipbook: the image as `[columns, rows]` cells, numbered across then down from
   * the top-left, a particle's `frames` naming one. `[1, 1]`, the default, is the whole image.
   */
  cells?: readonly [number, number];
  /**
   * Whether a `'sprite'` blends from a particle's cell toward the next by the fraction of its
   * frame, so a slow flipbook moves rather than steps. Off by default: one cell, sampled once.
   */
  blendCells?: boolean;
  /**
   * Metres over which a `'sprite'` fades where it meets the opaque scene: the hard line a flat card
   * draws where it cuts a floor or a body, softened. **0, the default, is a hard edge.** It reads a
   * copy of the frame's depth, which needs `screenEffects`; without one the edge stays hard and
   * the renderer says so once.
   */
  softDepth?: number;
  /** Metres in front of the eye over which a `'sprite'` fades in. 0, the default, is no fade. */
  cameraFade?: number;
  /**
   * Metres each particle is moved toward the eye before it is drawn, so a sprite born inside a
   * surface is drawn in front of it. 0 by default. Every material reads it.
   */
  cameraOffset?: number;
  /**
   * Whether the live particles are drawn farthest first, the order an alpha blend assumes. Off
   * by default, because sorting costs a pass over the particles on the CPU each frame and an
   * additive blend is a sum that does not care. See `particleSort.ts`.
   */
  sort?: boolean;
  /**
   * Another batch whose compiled program this one should reuse.
   *
   * Several pools legitimately share a *material* while needing their own buffers —
   * a game may have four kinds of smoke, each with its own colours, lifetime and
   * capacity, all drawn by one fragment shader. Without this each of them compiles
   * the same source again, which is pure boot time on the device where boot time is
   * scarcest. The per-material constants stay per batch, because they are the point
   * of having several.
   *
   * Only valid for the same `material`, and **that is now checked** — it was not, and could
   * not be, while the material was an opaque source string a caller supplied. Naming it made
   * the constraint expressible, so a spark batch reusing a smoke program fails at construction
   * with both names rather than drawing sparks that look like smoke.
   */
  reuse?: ParticleBatch;
}

/** Corners of one blade, as a triangle-strip-friendly quad. */
const CORNERS = [
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, 1],
] as const;

export class ParticleBatch {
  readonly program: WebGLProgram;
  readonly uniforms: Record<string, WebGLUniformLocation>;

  private readonly vao: WebGLVertexArrayObject;
  private readonly buffers: WebGLBuffer[] = [];
  private readonly positionBuffer: WebGLBuffer;
  private readonly sizeBuffer: WebGLBuffer;
  private readonly spinBuffer: WebGLBuffer;
  private readonly colorBuffer: WebGLBuffer;
  private readonly alphaBuffer: WebGLBuffer;
  private readonly ageBuffer: WebGLBuffer;
  private readonly seedBuffer: WebGLBuffer;
  private readonly velocityBuffer: WebGLBuffer;
  private readonly spriteBuffer: WebGLBuffer;
  private readonly spriteStaging: Float32Array;
  /** Room to draw farthest first, where the batch asked. See `ParticleBatchOptions.sort`. */
  private readonly order: ParticleSort | null;
  /** The sprite's own: its image, its flipbook and its fades. See `ParticleBatchOptions`. */
  readonly texture: SurfaceTexture | null;
  readonly cells: readonly [number, number];
  readonly blendCells: boolean;
  readonly softDepth: number;
  readonly cameraFade: number;
  readonly cameraOffset: number;
  private readonly blend: ParticleBlend;
  private readonly stretchSec: number;
  private readonly erosion: number;
  private readonly coreGain: number;
  private readonly fog: boolean;
  private readonly facing: ParticleFacing;
  /** False when the program belongs to another batch, so `dispose` leaves it alone. */
  private readonly ownsProgram: boolean;
  /** Which material compiled this batch's program, so `reuse` can be checked. */
  readonly material: ParticleMaterial;

  constructor(gl: WebGL2RenderingContext, capacity: number, options: ParticleBatchOptions) {
    /* The vertex stage comes with the material now; it used to be a separate argument that
       every caller passed the same value for. */
    const shaders = particleShaders(options.material);
    const shared = options.reuse;
    if (shared !== undefined && shared.material !== options.material) {
      throw new Error(
        `createParticles: cannot reuse a "${shared.material}" program for a ` +
          `"${options.material}" batch. \`reuse\` shares one compiled material between pools.`,
      );
    }
    this.ownsProgram = shared === undefined;
    this.material = options.material;
    this.program =
      shared?.program ??
      compileProgram(gl, shaders.vertexSource, shaders.fragmentSource, shaders.label);
    this.uniforms = shared?.uniforms ?? uniformLocations(gl, this.program, 'particleBatch');
    this.blend = options.blend;
    this.stretchSec = options.stretchSec ?? 0;
    this.erosion = options.erosion ?? 0;
    this.coreGain = options.coreGain ?? 1;
    this.fog = options.fog ?? false;
    this.facing = options.facing ?? 'camera';
    this.texture = options.texture ?? null;
    this.cells = options.cells ?? [1, 1];
    this.blendCells = options.blendCells === true;
    this.softDepth = Math.max(0, options.softDepth ?? 0);
    this.cameraFade = Math.max(0, options.cameraFade ?? 0);
    this.cameraOffset = options.cameraOffset ?? 0;
    this.order = options.sort === true ? createParticleSort(capacity) : null;
    this.spriteStaging = new Float32Array(capacity * 2);
    if (options.material === 'sprite' && this.texture === null) {
      throw new Error("createParticles: a 'sprite' draws an image, and was given no `texture`");
    }

    const corners = new Float32Array(PARTICLE_VERTS * 2);
    const blades = new Float32Array(PARTICLE_VERTS);
    const indices = new Uint16Array(PARTICLE_INDICES);
    for (let b = 0; b < PARTICLE_BLADES; b++) {
      for (let c = 0; c < 4; c++) {
        const v = b * 4 + c;
        const corner = CORNERS[c] ?? [0, 0];
        corners[v * 2] = corner[0];
        corners[v * 2 + 1] = corner[1];
        blades[v] = b;
      }
      const base = b * 4;
      const i = b * 6;
      indices[i] = base;
      indices[i + 1] = base + 1;
      indices[i + 2] = base + 2;
      indices[i + 3] = base;
      indices[i + 4] = base + 2;
      indices[i + 5] = base + 3;
    }

    const vao = gl.createVertexArray();
    if (vao === null) throw new Error(`${shaders.label}: createVertexArray failed`);
    this.vao = vao;
    gl.bindVertexArray(vao);

    this.attach(gl, 0, corners, 2, 0, shaders.label);
    this.attach(gl, 1, blades, 1, 0, shaders.label);
    this.positionBuffer = this.attach(gl, 2, capacity * 3, 3, 1, shaders.label);
    this.sizeBuffer = this.attach(gl, 3, capacity, 1, 1, shaders.label);
    this.spinBuffer = this.attach(gl, 4, capacity, 1, 1, shaders.label);
    this.colorBuffer = this.attach(gl, 5, capacity * 3, 3, 1, shaders.label);
    this.alphaBuffer = this.attach(gl, 6, capacity, 1, 1, shaders.label);
    this.ageBuffer = this.attach(gl, 7, capacity, 1, 1, shaders.label);
    this.seedBuffer = this.attach(gl, 8, capacity, 1, 1, shaders.label);
    this.velocityBuffer = this.attach(gl, 9, capacity * 3, 3, 1, shaders.label);
    this.spriteBuffer = this.attach(gl, 10, capacity * 2, 2, 1, shaders.label);

    const indexBuffer = gl.createBuffer();
    if (indexBuffer === null) throw new Error(`${shaders.label}: createBuffer failed`);
    this.buffers.push(indexBuffer);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
  }

  /**
   * Send this frame's particles.
   *
   * Only the live prefix of each array, which is what the pool's compaction
   * exists for: a pool at a tenth of its capacity uploads a tenth of the bytes.
   */
  upload(gl: WebGL2RenderingContext, given: ParticleInstances, eye: ArrayLike<number>): void {
    const data = this.order === null ? given : sortBackToFront(given, eye, this.order);
    const n = data.count;
    if (n === 0) return;
    packSpriteStream(data, n, this.spriteStaging);
    this.send(gl, this.spriteBuffer, this.spriteStaging, n * 2);
    this.send(gl, this.positionBuffer, data.positions, n * 3);
    this.send(gl, this.sizeBuffer, data.sizes, n);
    this.send(gl, this.spinBuffer, data.spins, n);
    this.send(gl, this.colorBuffer, data.colors, n * 3);
    this.send(gl, this.alphaBuffer, data.alphas, n);
    this.send(gl, this.ageBuffer, data.ages, n);
    this.send(gl, this.seedBuffer, data.seeds, n);
    this.send(gl, this.velocityBuffer, data.velocities, n * 3);
  }

  /** Bind this material's own constants. Called once per draw, before `drawTo`. */
  bindMaterial(gl: WebGL2RenderingContext): void {
    const u = this.uniforms;
    gl.uniform1f(u['uStretchSec'] ?? null, this.stretchSec);
    gl.uniform1f(u['uCameraFacing'] ?? null, facingCode(this.facing));
    gl.uniform1f(u['uCameraOffset'] ?? null, this.cameraOffset);
    /* The sprite's flipbook and its image; the fades are the renderer's, which owns the depth. */
    if (this.texture !== null) {
      gl.uniform4f(u['uCells'] ?? null, this.cells[0], this.cells[1], this.blendCells ? 1 : 0, 0);
      this.texture.bind(gl, PARTICLE_SPRITE_UNIT);
      gl.uniform1i(u['uSprite'] ?? null, PARTICLE_SPRITE_UNIT);
    }
    gl.uniform1f(u['uErosion'] ?? null, this.erosion);
    gl.uniform1f(u['uCoreGain'] ?? null, this.coreGain);
    /* Only the mote program declares uFogEnabled, so this is a no-op — not a leak into the
       next draw — on the other two: `u['uFogEnabled']` is undefined there and gl.uniform1i
       silently ignores a null location. */
    gl.uniform1i(u['uFogEnabled'] ?? null, this.fog ? 1 : 0);
  }

  /**
   * Draw the live particles.
   *
   * Depth *tested* but not written, so a puff is correctly hidden behind the deck
   * and never hides a puff behind it. Culling off, because a blade seen from
   * behind is exactly as valid as one seen from the front.
   */
  drawTo(gl: WebGL2RenderingContext, count: number): void {
    if (count === 0) return;
    gl.enable(gl.BLEND);
    if (this.blend === 'additive') blendKeeping(gl, gl.SRC_ALPHA, gl.ONE);
    else blendCovering(gl, gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    gl.disable(gl.CULL_FACE);

    gl.bindVertexArray(this.vao);
    gl.drawElementsInstanced(gl.TRIANGLES, PARTICLE_INDICES, gl.UNSIGNED_SHORT, 0, count);
    gl.bindVertexArray(null);

    gl.enable(gl.CULL_FACE);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
  }

  dispose(gl: WebGL2RenderingContext): void {
    for (const buffer of this.buffers) gl.deleteBuffer(buffer);
    this.buffers.length = 0;
    gl.deleteVertexArray(this.vao);
    if (this.ownsProgram) gl.deleteProgram(this.program);
  }

  private send(
    gl: WebGL2RenderingContext,
    buffer: WebGLBuffer,
    data: Float32Array,
    length: number,
  ): void {
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, data, 0, length);
  }

  /**
   * One attribute buffer. `divisor` 0 is per-vertex, 1 is per-instance — the whole
   * mechanism by which eight vertices draw a thousand particles.
   */
  private attach(
    gl: WebGL2RenderingContext,
    location: number,
    dataOrFloats: Float32Array | number,
    size: number,
    divisor: number,
    label: string,
  ): WebGLBuffer {
    const buffer = gl.createBuffer();
    if (buffer === null) throw new Error(`${label}: createBuffer failed`);
    this.buffers.push(buffer);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    if (typeof dataOrFloats === 'number') {
      gl.bufferData(gl.ARRAY_BUFFER, dataOrFloats * 4, gl.DYNAMIC_DRAW);
    } else {
      gl.bufferData(gl.ARRAY_BUFFER, dataOrFloats, gl.STATIC_DRAW);
    }
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, size, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(location, divisor);
    return buffer;
  }
}
