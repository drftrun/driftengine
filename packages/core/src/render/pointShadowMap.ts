import { mat4 } from 'gl-matrix';
import type { PointShadowTarget } from './pointShadowArray.ts';
import { DEFAULT_RENDER_QUALITY } from './renderQuality.ts';
import {
  createFaceRange,
  DEFAULT_SOURCE_RADIUS,
  FACE_COUNT,
  POINT_SHADOW_NEAR,
  PointShadowImage,
  pointShadowFaceViewProj,
  type FaceRange,
} from './pointShadowImage.ts';

/**
 * Omnidirectional shadows for a point light: one octahedral layer, rendered a face at a time.
 *
 * Six depth passes per light is normally what makes point-light shadows unaffordable. Static
 * scenes can bake once; a caller may also rebuild a map for a moving source or nearby moving
 * casters.
 *
 * Game-agnostic: it takes a position, a range, and a callback that draws whatever should cast.
 *
 * **All of the state is `PointShadowImage`'s and all of the arithmetic is too**, and now every
 * GPU object is `PointShadowArray`'s — so what is left here is a layer index and a loop. That
 * split is what lets a second backend inherit six paid-for decisions rather than re-derive them;
 * see that file.
 *
 * **The six faces are still rasterised under six 90 degree frusta**, unchanged, because that is
 * the only projection a triangle survives. What changed is where they land: each one goes to the
 * array's shared scratch and is resolved from there into this map's layer, in the octahedral
 * projection the shader reads. Nothing about the bake's cost, order or resumption moved.
 */

/* Re-exported so callers that reach for these through this module keep working. */
export { FACE_COUNT, POINT_SHADOW_NEAR };

const scratchViewProj = mat4.create();

export class PointShadowMap {
  readonly size: number;
  /**
   * Which layer of the shared array this map's image lives in.
   *
   * Fixed for the life of the map. The pool hands slots out and takes them back, and a slot's
   * layer never moves — `forget` throws the *image* away, not the storage — so the shader can be
   * told a layer index and nothing has to re-upload a texture binding when a light changes hands.
   */
  readonly layer: number;

  /** Everything this map knows about itself that is not a GPU object. */
  private readonly image = new PointShadowImage();
  private readonly range: FaceRange = createFaceRange();

  /**
   * The array this map writes into, read late rather than held.
   *
   * The pool builds its live maps when the renderer is constructed, and the array cannot exist
   * until a world says how many lights it has — and it is rebuilt if a later world says more. A
   * getter rather than a reference means a map outlives both events without knowing about either.
   * Called once per resolved face, which is nowhere near a per-fragment path.
   */
  private readonly array: () => PointShadowTarget | null;

  get far(): number {
    return this.image.far;
  }

  get near(): number {
    return this.image.near;
  }

  get sourceRadius(): number {
    return this.image.sourceRadius;
  }

  /** Where the image was rendered from, not where the light is now. See the image. */
  get originX(): number {
    return this.image.originX;
  }

  get originY(): number {
    return this.image.originY;
  }

  get originZ(): number {
    return this.image.originZ;
  }

  /** Whether this map holds an image worth sampling. False until a bake completes. */
  get hasBaked(): boolean {
    return this.image.hasBaked;
  }

  /** How present the image is, 0 to 1. The shader mixes the occlusion in by it. */
  get presence(): number {
    return this.image.presence;
  }

  /** Whether this map still represents the source well enough to sample. See the image. */
  matchesSource(
    x: number,
    y: number,
    z: number,
    range: number,
    near: number,
    sourceRadius = DEFAULT_SOURCE_RADIUS,
    tolerance = 0,
  ): boolean {
    return this.image.matchesSource(x, y, z, range, near, sourceRadius, tolerance);
  }

  /** Ramp the image in. See the image. */
  advance(dt: number): void {
    this.image.advance(dt);
  }

  /** Throw the image away, because this map is about to belong to another light. */
  forget(): void {
    this.image.forget();
  }

  constructor(
    array: () => PointShadowTarget | null,
    layer: number,
    size = DEFAULT_RENDER_QUALITY.pointShadowFaceSize,
  ) {
    this.array = array;
    this.layer = layer;
    this.size = size;
  }

  /**
   * Render up to `maxFaces` of the six, resuming a bake already under way.
   * Returns how many faces were rendered.
   *
   * `drawCasters` receives each face's view-projection and issues its draw calls, so a
   * face is a full pass over the caster set and six of them is the whole cost. Doing
   * all six unconditionally is what made this the most expensive thing in the frame the
   * moment several lights went stale together: eight lights is 48 passes, measured at
   * 89 ms and 99 ms in two consecutive frames against an 8.3 ms budget. The caller
   * spends a per-frame face budget across the lights that need one; see
   * `pointShadowBudget.ts`.
   *
   * A resumed bake keeps the origin it started with, **whatever this call is passed**:
   * half a cubemap around one point and half around another is not a cubemap around
   * anything, and a light that moves every frame used to produce exactly that, for ever.
   * See `planBake`. Different arguments are honoured by the *next* bake, which the
   * staleness test starts as soon as this one lands.
   *
   * **`far`, `near` and `sourceRadius` move only when the last face lands**, and that is
   * the one subtle part. They describe the image the shader is sampling, so publishing
   * them early would pair new parameters with faces that are still mostly old. A first
   * bake is not sampled at all until it completes, so this only matters for a re-bake,
   * where holding the old values keeps them matched to the old faces.
   */
  bake(
    gl: WebGL2RenderingContext,
    x: number,
    y: number,
    z: number,
    range: number,
    drawCasters: (viewProj: mat4) => void,
    near = POINT_SHADOW_NEAR,
    sourceRadius = DEFAULT_SOURCE_RADIUS,
    maxFaces = FACE_COUNT,
  ): number {
    /*
     * What to render now, **and what to render it for**. A bake in flight owns the parameters
     * it started with, so the arguments here are only a proposal for a bake that is not already
     * under way; see `planBake` for the permanent artefact that reading them unconditionally
     * left in a moving light's map.
     */
    const plan = this.image.planBake(x, y, z, range, near, sourceRadius, maxFaces, this.range);
    const { first, last } = plan;
    if (last <= first) return 0;

    const array = this.array();
    if (array === null) return 0;

    /*
     * Cull nothing.
     *
     * Rendering back faces only is the usual acne cure, but it stores the *far*
     * side of every caster — and for a character's limbs the near and far sides
     * are centimetres apart, so the caster effectively vanishes from the map.
     * Acne is handled properly by the slope-scaled bias in the flat shader,
     * which is where it belongs: it is a function of the receiving angle, not
     * of which faces were rasterised.
     */
    gl.disable(gl.CULL_FACE);

    /*
     * Render, resolve, repeat — and the *repeat* is what makes one scratch serve every light.
     *
     * A face's octahedral region is disjoint from the other five, so the scratch is consumed the
     * moment `resolveFace` reads it and is free again before the next face touches it. That holds
     * across lights too, which matters: `pointShadowBudget.ts` spends one frame's face budget
     * across several stale maps, so a scratch that had to survive a whole six-face bake would be
     * clobbered by whichever light baked next.
     *
     * Completeness is checked once, in the array's constructor. See the note there: asking here
     * is a pipeline flush in the middle of the frame loop.
     */
    for (let face = first; face < last; face++) {
      array.beginFace(gl);
      drawCasters(
        pointShadowFaceViewProj(
          face,
          plan.x,
          plan.y,
          plan.z,
          plan.near,
          plan.range,
          scratchViewProj,
        ),
      );
      /*
       * The casters left culling off and the resolve is a fullscreen triangle, so it does not
       * care; `resolveFace` restores the depth function it borrows, which is the one thing the
       * next face's pass does care about.
       */
      array.resolveFace(gl, this.layer, face, plan.range, plan.near);
    }

    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    this.image.completeBake(last, plan.x, plan.y, plan.z, plan.range, plan.near, plan.sourceRadius);
    return last - first;
  }

  /**
   * Nothing to free: every GPU object this map used to own belongs to `PointShadowArray` now.
   *
   * Kept because the pool's `releaseMap` calls it, and because a map that silently stopped
   * needing disposal is exactly the shape of a leak nobody notices. The array is disposed by the
   * renderer that built it.
   */
  dispose(_gl: WebGL2RenderingContext): void {}
}
