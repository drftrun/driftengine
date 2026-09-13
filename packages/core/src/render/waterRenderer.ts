import type { FrameView } from './frameView.ts';
import type { Vec3 } from '../math/color.ts';
import { compileProgram, uniformLocations } from './shader.ts';
import { PATCH_RESOLUTION, buildUnitSheet, buildWaterGrid } from './waterGrid.ts';
import { WATER_FRAG, WATER_VERT } from './shaders/water.ts';
import { bindAtmosphere } from './atmosphere.ts';
import type { Atmosphere } from './atmosphere.ts';
import type { PlanarReflection } from './planarReflection.ts';
import { bindPointLights } from './lightBudget.ts';
import type { PointLightSet } from './lightBudget.ts';
import { DEFAULT_RENDER_QUALITY } from './renderQuality.ts';
import { createResolvedWater, resolveWater, waterAppearance } from './waterDraw.ts';

/**
 * An endless wave surface. Game-agnostic: it takes a height, colours and a
 * lighting environment, and knows nothing about what the water is for.
 *
 * The mesh is a fixed grid that follows the camera and is snapped to whole
 * cells in the vertex shader, so a bounded vertex budget covers an unbounded
 * ocean without the surface sliding underfoot. Displacement is Gerstner, so
 * crests are sharp and troughs broad rather than a rolling sine blanket.
 */
/**
 * A body of water: the sea, a fountain's basin, a tank, a puddle.
 *
 * One description and one material for all of them. The sea is not a special
 * case with a shader of its own — it is this, unbounded and dense, and a
 * fountain is this, bounded and clear. The first attempt gave a basin its own
 * faked surface, and the correction was the right one: water should be a single
 * configurable concept — density, visibility, up to fully transparent — rather
 * than a trick per body of water. The sea is water too, and it gets the same
 * reusable component with the same abilities.
 *
 * So every body gets the waves, the Fresnel, the specular, the fog and the
 * planar reflection, and differs only in these numbers.
 */
export interface WaterBody {
  /** Resting height of the surface. */
  level: number;
  deepColor: Vec3;
  shallowColor: Vec3;
  /**
   * How much of what lies beneath it the water hides, looked straight down,
   * 0 to 1. A sea hides its own floor; a fountain shows the tiles at the bottom
   * of it; zero is glass. Only this end is configurable — at a grazing angle
   * every water surface goes reflective, which is Fresnel rather than a property
   * of the liquid.
   */
  density?: number;
  /** The surface's overall visibility, 0 to 1. Zero draws nothing. */
  visibility?: number;
  /**
   * How much it mirrors regardless of viewing angle, 0 to 1.
   *
   * Zero is physics — reflection by Fresnel alone, which is what an ocean does and
   * what leaves a basin looking blank from directly above, since at that angle the
   * Fresnel term is a few percent. A pool is looked *into*, so it is allowed to
   * cheat; the sea is not, and keeps zero.
   */
  mirror?: number;
  /**
   * How built-up its waves are, as a multiple of what the wind is doing.
   *
   * One is the open sea. A basin wants a fraction of it: the same wave field at
   * a scale where it reads as a surface breathing rather than as a swell rolling
   * through somebody's fountain.
   */
  waveScale?: number;
  /**
   * How worked-up this body is on its own, 0 to 1, ignoring the wind entirely.
   *
   * For water the weather cannot reach: a cistern, a flooded corridor, a tank. Zero is
   * as near still as this surface goes — never glass, because dead-flat water reads as a
   * mirror rather than as calm — and one matches a fully developed sea.
   *
   * Omitted, the body takes its state from the wind it is drawn with, which is what an
   * ocean, a lake or a fountain in a courtyard should do.
   */
  agitation?: number;

  /**
   * A bounded body: where it is, how far it reaches along each of its own axes, and which way
   * those axes point.
   *
   * Omitted, the body is the endless ocean — the camera-following sheet the sea has always been.
   * Given, it is a fixed rectangle of water sitting exactly where it was put.
   *
   * **It was a centre and one half-extent until 2026-08-28, and a square cannot bound a channel.**
   * Reported from outside: a 3 by 21 metre ditch bounded by the square that contains it floods
   * eighteen metres of field either side, so the workaround was a single *unbounded* body at the
   * ditches' water level with the world's whole ground raised above it — a technically flooded
   * world, held up by a rule nobody can see, that nothing anywhere may be drawn below the water
   * line. It cost that consumer one bug already: a distant ground plane 1.6 m down, correct for its
   * own reasons, put the village in a lake.
   *
   * **What this cannot do is bend.** A canal that turns is one body per straight run, and where two
   * runs meet at a corner their sheets overlap and the blend doubles there. That is cheap to place
   * and honest about what it draws; **what would change it** is a consumer measuring that seam as
   * the problem, which is the day `bounds` grows a polyline and a width.
   */
  bounds?: WaterBounds;
}

/**
 * Where a bounded body sits, how far it reaches and which way it faces.
 *
 * **Extents are measured along the body's own axes**, `x` across and `z` along `forward`, which is
 * how `addOrientedBox` measures a box: one convention for an oriented thing in this engine, so a
 * reader who has met one has met both.
 */
export interface WaterBounds {
  centreX: number;
  centreZ: number;
  /**
   * Half-extent along both axes, metres: the shorthand for a square.
   *
   * A pool, a tank and a puddle are square often enough to be worth one number, and this is that
   * number. `halfX` and `halfZ` override it **per axis**, so `{ halfM: 9, halfX: 2 }` is two metres
   * across and nine along. The cost is two ways to say one square; the rule is stated here and
   * applied in exactly one place, `resolveWater`.
   */
  halfM?: number;
  /** Half-extent across the body, metres. A channel is narrow in this one. */
  halfX?: number;
  /** Half-extent along `forward`, metres. A channel is long in this one. */
  halfZ?: number;
  /**
   * Which way the body's own +z points, in world XZ. Unset, it points along world +z.
   *
   * **A direction and not an angle**, because a consumer bounding a channel, a ditch or a gutter
   * arrives holding the direction the run takes — from a road graph, a spline's tangent, two
   * endpoints — and converting that to radians and back is arithmetic nobody needs. It is
   * normalised on the way in, so a length here is not a scale, and a direction of no length at all
   * is read as unturned instead of producing a sheet at NaN.
   */
  forwardX?: number;
  forwardZ?: number;
}

/** @deprecated The old name for an unbounded {@link WaterBody}. */
export type WaterSettings = WaterBody;

/** Vertices per side of a bounded body's sheet. A pool is not an ocean. */

export class WaterRenderer {
  private readonly program: WebGLProgram;
  private readonly uniforms: Record<string, WebGLUniformLocation>;
  private readonly vao: WebGLVertexArrayObject;
  /** A unit sheet, scaled per draw: every bounded body shares this one mesh. */
  private readonly patchVao: WebGLVertexArrayObject;
  private readonly patchIndexCount: number;
  private readonly buffers: WebGLBuffer[] = [];
  private readonly indexCount: number;
  private readonly cellSize: number;
  private readonly nearHalfExtent: number;
  private readonly farHalfExtent: number;
  private readonly reflectionFilterTaps: number;
  /** Refilled per draw rather than allocated; see `createResolvedWater`. */
  private readonly resolved = createResolvedWater();

  /**
   * @param resolution cells per side of the wave-bearing near sheet.
   * @param nearExtent total width of that sheet, in world metres.
   * @param farHalfExtent how far the flat skirt carries the ocean out. There is
   *   no point setting this far beyond the camera's far plane — geometry past it
   *   is clipped, not drawn — so this only has to outrun the fog. See
   *   `buildWaterGrid` for why these are two meshes and not one.
   */
  constructor(
    gl: WebGL2RenderingContext,
    resolution = 128,
    nearExtent = 500,
    farHalfExtent = 4000,
    reflectionFilterTaps = DEFAULT_RENDER_QUALITY.waterReflectionFilterTaps,
  ) {
    this.program = compileProgram(gl, WATER_VERT, WATER_FRAG, 'water');
    this.uniforms = uniformLocations(gl, this.program, 'waterRenderer');
    this.reflectionFilterTaps = reflectionFilterTaps;

    const grid = buildWaterGrid(resolution, nearExtent, farHalfExtent);
    // Exactly the near cell size: snapping by anything else re-samples the wave
    // field as the camera moves, which reads as the surface swimming.
    this.cellSize = grid.cellSize;
    this.nearHalfExtent = grid.nearHalfExtent;
    this.farHalfExtent = grid.farHalfExtent;
    const indices = grid.indices;
    this.indexCount = indices.length;

    const vao = gl.createVertexArray();
    if (vao === null) throw new Error('WaterRenderer: createVertexArray failed');
    this.vao = vao;
    gl.bindVertexArray(vao);

    const gridBuffer = gl.createBuffer();
    if (gridBuffer === null) throw new Error('WaterRenderer: createBuffer failed');
    this.buffers.push(gridBuffer);
    gl.bindBuffer(gl.ARRAY_BUFFER, gridBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, grid.offsets, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    const indexBuffer = gl.createBuffer();
    if (indexBuffer === null) throw new Error('WaterRenderer: createBuffer failed');
    this.buffers.push(indexBuffer);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
    gl.bindVertexArray(null);

    /*
     * And the unit sheet every bounded body is drawn from. One mesh in [-1, 1],
     * scaled by the body's own half-extent in the vertex shader — so a fountain
     * costs a uniform rather than a mesh, and a hundred puddles cost the same.
     */
    const patch = buildUnitSheet(PATCH_RESOLUTION);
    this.patchIndexCount = patch.indices.length;
    const patchVao = gl.createVertexArray();
    if (patchVao === null) throw new Error('WaterRenderer: createVertexArray failed');
    this.patchVao = patchVao;
    gl.bindVertexArray(patchVao);
    const patchGrid = gl.createBuffer();
    if (patchGrid === null) throw new Error('WaterRenderer: createBuffer failed');
    this.buffers.push(patchGrid);
    gl.bindBuffer(gl.ARRAY_BUFFER, patchGrid);
    gl.bufferData(gl.ARRAY_BUFFER, patch.offsets, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    const patchIndices = gl.createBuffer();
    if (patchIndices === null) throw new Error('WaterRenderer: createBuffer failed');
    this.buffers.push(patchIndices);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, patchIndices);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, patch.indices, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
  }

  /**
   * Draw the surface. Call *after* the sky: water writes depth and is occluded
   * by geometry in front of it, but its far edge fades out, and that fade needs
   * the sky already behind it to blend into.
   */
  draw(
    gl: WebGL2RenderingContext,
    camera: FrameView,
    timeSeconds: number,
    settings: WaterBody,
    directionalDir: Vec3,
    directionalColor: Vec3,
    ambient: Vec3,
    atmosphere: Atmosphere,
    underwaterEnabled: boolean,
    reflection: PlanarReflection | null,
    lights: PointLightSet | null = null,
    lightFalloff: 'smooth' | 'inverseSquare' = 'smooth',
    windX = 0,
    windZ = 0,
  ): void {
    const u = this.uniforms;
    const reflectionReady = reflection?.isReadyFor(settings.level) ?? false;
    gl.useProgram(this.program);
    gl.uniformMatrix4fv(u['uViewProj'] ?? null, false, camera.viewProjection);
    gl.uniformMatrix4fv(
      u['uReflectionViewProj'] ?? null,
      false,
      reflection?.viewProjection ?? camera.viewProjection,
    );
    gl.uniform3fv(u['uCameraPos'] ?? null, camera.position);
    gl.uniform1f(u['uTime'] ?? null, timeSeconds);
    /*
     * Where the sheet is laid, and how far one unit of it reaches. The ocean
     * snaps to whole cells under the camera — anything else re-samples the wave
     * field as it moves, which reads as the surface swimming — and a bounded body
     * simply sits where it was put.
     */
    /* Laid and settled in `waterDraw.ts`, so both backends get the same sea. */
    const w = resolveWater(
      settings,
      camera.position[0] ?? 0,
      camera.position[2] ?? 0,
      this.cellSize,
      this.nearHalfExtent,
      this.farHalfExtent,
      windX,
      windZ,
      this.resolved,
    );
    gl.uniform2fv(u['uGridOrigin'] ?? null, w.origin);
    /* Pairs since 2026-08-28: a body is bounded along each of its own axes, and the direction
       those axes take is the fourth of them. The ocean passes one number twice. */
    gl.uniform2fv(u['uGridSpan'] ?? null, w.span);
    gl.uniform2fv(u['uGridHalf'] ?? null, w.half);
    gl.uniform2fv(u['uNearHalf'] ?? null, w.nearHalf);
    gl.uniform2fv(u['uGridForward'] ?? null, w.forward);
    /*
     * `uGridScale` used to be uploaded here and is not, because the shader stopped reading it
     * when the grid snapping moved to the CPU. The uniform went on being written to a location
     * that no longer existed, which uploads to nothing and says nothing.
     */
    const look = waterAppearance(settings);
    gl.uniform1f(u['uNadirOpacity'] ?? null, look.nadirOpacity);
    gl.uniform1f(u['uVisibility'] ?? null, look.visibility);
    gl.uniform1f(u['uMirror'] ?? null, look.mirror);
    gl.uniform2fv(u['uWindDir'] ?? null, w.windDir);
    gl.uniform1f(u['uWaveGain'] ?? null, w.waveGain);
    gl.uniform1f(u['uFoamGain'] ?? null, w.foamGain);
    gl.uniform1f(u['uWaterLevel'] ?? null, settings.level);
    gl.uniform3fv(u['uDeepColor'] ?? null, settings.deepColor);
    gl.uniform3fv(u['uShallowColor'] ?? null, settings.shallowColor);
    gl.uniform3fv(u['uDirectionalDir'] ?? null, directionalDir);
    gl.uniform3fv(u['uDirectionalColor'] ?? null, directionalColor);
    gl.uniform3fv(u['uAmbient'] ?? null, ambient);
    // Water is lit by the world's lamps as well as by its sky. Indoors they are all of it.
    bindPointLights(gl, u, lights, lightFalloff);
    bindAtmosphere(gl, u, atmosphere, camera.position[1] ?? 0, underwaterEnabled);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(
      gl.TEXTURE_2D,
      reflectionReady && reflection !== null ? reflection.texture : null,
    );
    gl.uniform1i(u['uReflectionMap'] ?? null, 0);
    gl.uniform1i(u['uReflectionEnabled'] ?? null, reflectionReady ? 1 : 0);
    gl.uniform2f(
      u['uReflectionTexelSize'] ?? null,
      reflectionReady && reflection !== null ? 1 / reflection.textureWidth : 1,
      reflectionReady && reflection !== null ? 1 / reflection.textureHeight : 1,
    );
    gl.uniform1i(u['uReflectionFilterTaps'] ?? null, this.reflectionFilterTaps);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    // Waves are displaced far enough that back faces show at grazing angles.
    gl.disable(gl.CULL_FACE);

    gl.bindVertexArray(w.bounded ? this.patchVao : this.vao);
    gl.drawElements(
      gl.TRIANGLES,
      w.bounded ? this.patchIndexCount : this.indexCount,
      gl.UNSIGNED_INT,
      0,
    );
    gl.bindVertexArray(null);

    gl.enable(gl.CULL_FACE);
    gl.disable(gl.BLEND);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  dispose(gl: WebGL2RenderingContext): void {
    for (const buffer of this.buffers) gl.deleteBuffer(buffer);
    gl.deleteVertexArray(this.vao);
    gl.deleteVertexArray(this.patchVao);
    gl.deleteProgram(this.program);
  }
}
