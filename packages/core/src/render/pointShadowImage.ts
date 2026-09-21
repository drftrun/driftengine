import { mat3, mat4, vec3 } from 'gl-matrix';

/**
 * What a point light's shadow cubemap *is*, with no device in it.
 *
 * **Everything here is a decision, and the six that matter are already paid for.** A cubemap
 * that is stale by a millimetre re-bakes six passes over the world; one that is not stale
 * enough strobes; one that publishes its parameters before its last face pairs new numbers with
 * old pixels; one that keeps `baked` across a pool handover reports another lamp's picture as
 * its own. Each of those was a shipped bug on the WebGL2 path and each is fixed *here*, so a
 * second backend inherits the fixes instead of re-earning them. That is the 2026-08-13 rule
 * applied to the largest piece of state in the renderer.
 *
 * The device half — the cube texture and the six passes that fill it — is per backend and is
 * all that is left outside this file.
 */

/** A cubemap is six faces, and a bake may be spread across frames a few at a time. */
export const FACE_COUNT = 6;

/** Which way each face looks, and which way is up for it. The order is the cubemap's own. */
const FACE_TARGETS: readonly (readonly [vec3, vec3])[] = [
  [
    [1, 0, 0],
    [0, -1, 0],
  ],
  [
    [-1, 0, 0],
    [0, -1, 0],
  ],
  [
    [0, 1, 0],
    [0, 0, 1],
  ],
  [
    [0, -1, 0],
    [0, 0, -1],
  ],
  [
    [0, 0, 1],
    [0, -1, 0],
  ],
  [
    [0, 0, -1],
    [0, -1, 0],
  ],
];

/**
 * Default distance from the source at which shadow casting begins.
 *
 * Raising it per light is how a fixture avoids shadowing its own lamp: a brazier sits directly
 * under its flame, so with a near plane of a few centimetres it occludes an enormous solid
 * angle and throws a big square across the ground. Anything nearer the source than this is
 * simply not rendered into the map, which is what real fixtures do — the light comes from
 * *inside* them.
 */
export const POINT_SHADOW_NEAR = 0.25;

/**
 * How long a freshly baked image takes to reach full strength, in seconds.
 *
 * Long enough to read as a shadow settling rather than a shadow appearing, short enough that
 * nobody standing still waits for it. A quarter second is about thirty frames at 120 Hz, which
 * is also comfortably longer than the six-face bake it follows, so the ramp starts from a
 * picture that is already complete.
 */
const ARRIVAL_SECONDS = 0.25;

/**
 * The emitter radius assumed for a light that names none.
 *
 * One constant because it is read in three places — the field, the bake and `matchesSource` —
 * and the whole of the bug it replaces was two of those disagreeing. The bake filled in 0.05
 * and `matchesSource` compared against `undefined`, so a map baked by a caller that said
 * nothing was stale on every frame it was ever checked.
 */
export const DEFAULT_SOURCE_RADIUS = 0.05;

const scratchView = mat4.create();
const scratchLook = mat4.create();
const scratchProj = mat4.create();
const scratchEye = vec3.create();
const scratchCenter = vec3.create();

/**
 * One face's view-projection, into a matrix the caller owns.
 *
 * A ninety-degree square frustum per face is what makes six of them a cube, so the projection
 * takes no aspect and no field of view: both are fixed by the shape. Module-scope scratch,
 * because this runs once per face of every bake and `AGENTS.md` allows no allocation there.
 */
export function pointShadowFaceViewProj(
  face: number,
  x: number,
  y: number,
  z: number,
  near: number,
  range: number,
  out: mat4,
): mat4 {
  const target = FACE_TARGETS[face];
  if (target === undefined) return out;
  const dir = target[0];
  vec3.set(scratchEye, x, y, z);
  vec3.set(scratchCenter, x + dir[0], y + dir[1], z + dir[2]);
  mat4.perspective(scratchProj, Math.PI / 2, 1, near, range);
  mat4.lookAt(scratchView, scratchEye, scratchCenter, target[1]);
  return mat4.multiply(out, scratchProj, scratchView);
}

/**
 * A face's world-to-face rotation, from the same targets its frustum is built from.
 *
 * **The resolve needs one and the bake needs the other, and two tables would eventually
 * disagree.** A face's octahedral region is written by projecting each texel's direction into that
 * face's own frame and reading the depth the bake stored there; if the two differ by an up vector,
 * every texel of that face is read from the wrong place. That reads as a lighting bug and is a
 * transcription error, so both come off `FACE_TARGETS` and a test puts one point through each and
 * requires the same image coordinates.
 *
 * `lookAt` builds a right-handed view looking down `-z`, so a direction inside this face comes
 * back with a **negative** `z`. The resolve divides by `-v.z` for that reason and not by
 * preference.
 *
 * Module-scope scratch, because this runs once per resolved face inside the bake budget and
 * `AGENTS.md` allows no allocation there.
 */
export function pointShadowFaceRotation(face: number, out: mat3): mat3 {
  const target = FACE_TARGETS[face];
  if (target === undefined) return out;
  const dir = target[0];
  vec3.set(scratchEye, 0, 0, 0);
  vec3.set(scratchCenter, dir[0], dir[1], dir[2]);
  mat4.lookAt(scratchLook, scratchEye, scratchCenter, target[1]);
  return mat3.fromMat4(out, scratchLook);
}

/**
 * The window of faces a resumed bake should render this frame, and what to render them for.
 * Empty when there is none.
 *
 * **The parameters travel with the window, and that is the point rather than a convenience.**
 * A bake is spread over frames against `pointShadowBudget.ts`, and a caller that used its own
 * live light position for the second half would build an image around two different places —
 * which is the failure `planBake` says it exists to prevent and, before these fields, did not.
 * See `planBake`.
 */
export interface FaceRange {
  first: number;
  last: number;
  /** Where the light was when this bake started. */
  x: number;
  y: number;
  z: number;
  /** The far plane, the near plane and the emitter radius the same bake started with. */
  range: number;
  near: number;
  sourceRadius: number;
}

/** A `FaceRange` a map can own for the life of the session, since a bake allocates nothing. */
export function createFaceRange(): FaceRange {
  return {
    first: 0,
    last: 0,
    x: 0,
    y: 0,
    z: 0,
    range: 1,
    near: POINT_SHADOW_NEAR,
    sourceRadius: DEFAULT_SOURCE_RADIUS,
  };
}

/**
 * The state of one cubemap: what it was baked for, how present it is, and how far through.
 *
 * Held by a backend's map rather than inherited from, so the device resource stays a device
 * resource and this stays testable without one.
 */
export class PointShadowImage {
  /** Far plane, needed by the shader to linearise the comparison. */
  far = 1;
  /** Near plane; the shader needs the same value to linearise. */
  near = POINT_SHADOW_NEAR;
  /** Emitter radius of the light this map was baked for. */
  sourceRadius = DEFAULT_SOURCE_RADIUS;

  private baked = false;
  private arrival = 0;
  private x = 0;
  private y = 0;
  private z = 0;
  /** Next face a resumed bake will render; 0 when none is in flight. */
  private pendingFace = 0;
  /** What the in-flight bake was started for, so a changed light restarts it. */
  private pendingX = 0;
  private pendingY = 0;
  private pendingZ = 0;
  private pendingRange = 0;
  private pendingNear = 0;
  private pendingSourceRadius = 0;

  /**
   * Where this image was rendered from, which is what a sampler has to shoot its ray from.
   *
   * **Not the light's position**, and the difference is the whole point: `matchesSource` lets a
   * light drift up to the caller's rebake tolerance from here before the image is re-rendered,
   * so for any light that wanders these two are apart on nearly every frame. A shader that
   * builds its direction and its distance from the live light asks this picture a question the
   * picture cannot answer. See `ResolvedPointShadows.origins`.
   */
  get originX(): number {
    return this.x;
  }

  get originY(): number {
    return this.y;
  }

  get originZ(): number {
    return this.z;
  }

  /** Whether this map holds an image worth sampling. False until a bake completes. */
  get hasBaked(): boolean {
    return this.baked;
  }

  /** How present the image is, 0 to 1. The shader mixes the occlusion in by it. */
  get presence(): number {
    return this.arrival;
  }

  /**
   * Whether this map still represents the source projection well enough to sample.
   *
   * `tolerance` is how far the source may drift from where it was baked before the map is
   * stale. It exists because an exact comparison made a *flame* the most expensive object in
   * the scene: a brazier wanders a few centimetres every frame to look alive, every frame that
   * moved the light, and every move re-baked six cubemap faces of the entire static world. Up
   * to eight sampled lights doing that is where a frame's 174 surplus draw calls came from,
   * against an `AGENTS.md` budget of a hundred in total.
   *
   * A drift tolerance is the honest fix rather than a cheat. The shadow of static geometry
   * metres away barely moves when the emitter shifts by centimetres, and a fire's shadow that
   * re-solves every frame reads as strobing rather than as flicker. Callers that genuinely move
   * a light pass 0 and get the old behaviour, because drift is measured against the *baked*
   * origin and so accumulates rather than being forgiven each frame.
   *
   * `sourceRadius` defaults to exactly what a bake defaults it to, and the two defaults being
   * one constant is the point rather than a convenience: they disagreed once, `0.05 !== undefined`
   * was true every frame, every map was stale forever, and with a couple of faces of budget the
   * only thing on screen was whichever face had most recently finished — a hard square of shadow
   * that moved as you did. Any default would do as long as it is the same one. Two is the bug.
   */
  matchesSource(
    x: number,
    y: number,
    z: number,
    range: number,
    near: number,
    sourceRadius = DEFAULT_SOURCE_RADIUS,
    tolerance = 0,
  ): boolean {
    if (
      !this.baked ||
      this.far !== range ||
      this.near !== near ||
      this.sourceRadius !== sourceRadius
    ) {
      return false;
    }
    const dx = this.x - x;
    const dy = this.y - y;
    const dz = this.z - z;
    return dx * dx + dy * dy + dz * dz <= tolerance * tolerance;
  }

  /**
   * Ramp the image in over `ARRIVAL_SECONDS`.
   *
   * The drastic case, and the one the light's own fade cannot reach. A light leaving takes its
   * shadow with it, because by the time membership changes the light is already at nothing —
   * but a light *keeping* its place can still lose its picture, when a pool slot changes hands
   * and `forget` throws the image away. The re-bake then lands whole between two frames, under
   * a lamp that has not moved, and a shadow switching on is exactly as wrong as one switching
   * off.
   *
   * Only a first image after a `forget` ramps. A map that merely drifted past the rebake
   * tolerance keeps `baked` true throughout and stays fully present, which is right: it is
   * correcting a picture, not arriving with one.
   */
  advance(dt: number): void {
    if (!this.baked) {
      this.arrival = 0;
      return;
    }
    this.arrival = Math.min(1, this.arrival + dt / ARRIVAL_SECONDS);
  }

  /**
   * Throw away the image, because this map is about to belong to another light.
   *
   * A pool slot keeps its cubemap when it changes hands. Without this, `baked` stayed true from
   * the previous borrower, so the new light reported an image it had never rendered — the *old*
   * lamp's, taken from somewhere else — and the shader sampled it for the three frames a
   * re-bake takes at two faces each. That is the flicker: shadows and glare appearing and
   * disappearing as the camera moves and the chosen eight reorder.
   *
   * The partial-bake cursor goes too: a resumed bake must not stitch new faces onto the
   * previous light's old ones. Presence goes with the image — whatever arrives next is a new
   * light's, and it arrives as one.
   */
  forget(): void {
    this.baked = false;
    this.pendingFace = 0;
    this.arrival = 0;
  }

  /**
   * Which faces to render now, and what to render them for.
   *
   * **A bake in flight owns its parameters until it finishes**, and the returned range carries
   * them so the caller renders the remaining faces at the place the first ones were rendered
   * for. Half a cubemap around one point and half around another is not a cubemap around
   * anything, and this is what stops it being built.
   *
   * **It used to abandon a partial image whenever any argument moved, and that is the defect
   * this replaces.** The comparison was exact — position, range, near plane and emitter radius,
   * all of them — so a light that changes by any amount between two frames could never satisfy
   * it. Two kinds are ordinary rather than exotic: a flame wanders a few centimetres every
   * frame to look alive, and a light whose brightness is expressed as a radius rescales that
   * radius every frame while it pulses. For either, `pendingFace` was reset to zero on every
   * frame, so with a budget of two faces the bake rendered faces 0 and 1 for ever and **faces 2
   * to 5 were never written again**.
   *
   * That is not a bake that is merely slow. `resolveFace` writes each face into the light's
   * octahedral layer as it is rendered, and `hasBaked` stays true from the last bake that did
   * complete — so the shader keeps sampling a layer holding two faces from where the light is
   * now and four from wherever it used to be, permanently, at full presence. A cube face is a
   * 90 degree frustum, so what that draws is a hard-edged quadrilateral of shadow standing on
   * the ground under the lamp with nothing above it to cast one. Reported as exactly that.
   *
   * A light that moves during a bake is not lost: the image completes at the origin it started
   * from, `matchesSource` finds it stale on the next frame, and a fresh bake starts. What it
   * costs is a shadow up to `FACE_COUNT / facesPerFrame` frames behind a moving lamp, which is
   * the trade `pointShadowRebakeDistance` already makes in a coarser form.
   */
  planBake(
    x: number,
    y: number,
    z: number,
    range: number,
    near: number,
    sourceRadius: number,
    maxFaces: number,
    out: FaceRange,
  ): FaceRange {
    if (this.pendingFace <= 0) {
      this.pendingX = x;
      this.pendingY = y;
      this.pendingZ = z;
      this.pendingRange = range;
      this.pendingNear = near;
      this.pendingSourceRadius = sourceRadius;
    }
    out.first = this.pendingFace;
    out.last = Math.min(FACE_COUNT, out.first + Math.max(0, Math.trunc(maxFaces)));
    out.x = this.pendingX;
    out.y = this.pendingY;
    out.z = this.pendingZ;
    out.range = this.pendingRange;
    out.near = this.pendingNear;
    out.sourceRadius = this.pendingSourceRadius;
    return out;
  }

  /**
   * Record that faces up to `last` have been rendered.
   *
   * **`far`, `near` and `sourceRadius` move only when the last face lands**, and that is the
   * one subtle part. They describe the image the shader is sampling, so publishing them early
   * would pair new parameters with faces that are still mostly old. A first bake is not sampled
   * at all until it completes, so this only matters for a re-bake, where holding the old values
   * keeps them matched to the old faces.
   */
  completeBake(
    last: number,
    x: number,
    y: number,
    z: number,
    range: number,
    near: number,
    sourceRadius: number,
  ): void {
    this.pendingFace = last;
    if (last < FACE_COUNT) return;
    this.pendingFace = 0;
    this.x = x;
    this.y = y;
    this.z = z;
    this.far = range;
    this.near = near;
    this.sourceRadius = sourceRadius;
    this.baked = true;
  }
}

/**
 * What a pool needs of a cubemap, whichever device holds it.
 *
 * Nine members, seven of which are `PointShadowImage`'s already — so a backend's map is this
 * interface plus a texture and a way to fill it. Declared here rather than in either backend
 * because `PointShadowSystem` and `LivePointShadowSet` are written against it, and a pool that
 * knew which device it was pooling would be two pools.
 */
export interface PointShadowSource {
  /** Which layer of the shared array holds this map's image. */
  readonly layer: number;
  readonly far: number;
  readonly near: number;
  readonly sourceRadius: number;
  /** Where the image was rendered from. See `PointShadowImage.originX`. */
  readonly originX: number;
  readonly originY: number;
  readonly originZ: number;
  /** Whether this map holds an image worth sampling. */
  readonly hasBaked: boolean;
  /** How present the image is, 0 to 1. */
  readonly presence: number;
  advance(dt: number): void;
  forget(): void;
}

/**
 * Everything the shader needs about the point-shadow set, chosen once and bound twice.
 *
 * **The arrays are the decision and the textures are the binding**, which is the split the
 * 2026-08-13 rule asks for. Which light owns which slot, whether its image has landed, and how
 * present it is are answers a pool computes; turning them into `uniform1fv` or into bytes of a
 * uniform block is all that differs between the backends.
 *
 * A caller owns one of these and hands it in, because this is filled every frame.
 */
export interface ResolvedPointShadows {
  /**
   * Per shaded light: which array layer holds its static shadow, or −1 for none.
   *
   * **Indexed by the shading pass's light, and it used to be the other way round.** When each
   * map was its own `samplerCube` the shader could not index one, so it ran ten `else if` arms
   * comparing a light against a slot's owner; every array here was addressed by the slot and the
   * light was the value. One array texture makes the map a number, so the light can be the index
   * and the whole chain becomes a lookup. Every array below moved with it.
   */
  readonly layers: Int32Array;
  readonly far: Float32Array;
  readonly near: Float32Array;
  readonly sourceRadius: Float32Array;
  /**
   * The projection each bound map was rendered under: origin in `xyz`, far plane in `w`, four
   * floats a light. The origin is **not** the light's position.
   *
   * A light is allowed to drift `pointShadowRebakeDistance` from its image before the image is
   * re-rendered — that tolerance is what stops a flame re-baking six faces of the static world
   * every frame — so for anything that flickers these two are apart on nearly every frame. The
   * shader builds both its sample direction and the distance it compares from this point, so the
   * ray it shoots is the ray the picture was drawn along and the drift costs nothing.
   *
   * **It used to build them from the live light**, and the drift went straight into the
   * comparison: `dist` moved one for one with it against a bias of a few centimetres, and the
   * single-tap blocker search moved across the occluder's silhouette, swapping `occluderDistance`
   * between the caster and nothing. Reported on a brazier at night as a hard square under the
   * fire, flashing in time with the flame while the camera stood still.
   *
   * **The far plane rides in `w` rather than in an array of its own**, because a default-block
   * `float[N]` spends a whole uniform vector per element: declared separately the origin cost
   * sixteen rows on each of the two sets, which the budget ladder answers on a 256-vector
   * device by halving `MAX_LIGHTS`. See `uPointShadowProjection` in the preamble.
   */
  readonly projections: Float32Array;
  /** How present each bound map is, so a re-baked one arrives rather than appears. */
  readonly presence: Float32Array;
  /** The live pair, by the same light index: a light owns at most one of the two. */
  readonly liveLayers: Int32Array;
  readonly liveFar: Float32Array;
  readonly liveNear: Float32Array;
  readonly liveSourceRadius: Float32Array;
  /** The live pair's own, by the same rule and for the same reason. */
  readonly liveProjections: Float32Array;
  readonly liveWeights: Float32Array;
}

export function createResolvedPointShadows(lights: number): ResolvedPointShadows {
  /*
   * **−1 from the moment it exists, because zero is a layer.**
   *
   * `flat.ts` reads `uPointShadowLayer[i]` and samples when it is not negative, so a zero-filled
   * array does not mean "no point shadows" — it means every light in every scene samples layer
   * zero, which belongs to a live transition map. `resolve` fills these every frame, but a pass
   * bound before the pool has ever been updated would otherwise upload the zeroes, and a scene
   * is free to draw before it updates its shadows. Caught by a unit test that failed with
   * `expected +0 to be -1`; the same trap survives the move from slots to layers, with a worse
   * failure than before, because layer zero always exists where slot zero often did not.
   */
  return {
    layers: new Int32Array(lights).fill(-1),
    far: new Float32Array(lights),
    near: new Float32Array(lights),
    sourceRadius: new Float32Array(lights),
    projections: new Float32Array(lights * 4),
    presence: new Float32Array(lights),
    liveLayers: new Int32Array(lights).fill(-1),
    liveFar: new Float32Array(lights),
    liveNear: new Float32Array(lights),
    liveSourceRadius: new Float32Array(lights),
    liveProjections: new Float32Array(lights * 4),
    liveWeights: new Float32Array(lights),
  };
}
