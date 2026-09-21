/**
 * Which way depth runs, in one place, because it is a decision every pass has to agree with.
 *
 * **Reversed-Z with a float depth attachment.** Clip space depth is mapped so the near plane is
 * 1 and the far plane is 0, the compare is `greater` rather than `less`, and the buffer is cleared
 * to 0 instead of 1. It is not a preference: a conventional buffer spends its precision
 * hyperbolically, resolving about `z² / (near · 2^bits)` at distance `z`, so the near plane is the
 * only control there is and every consumer ends up pushing it out and then pushing decals off
 * surfaces to compensate.
 *
 * **What it buys, in the arithmetic that motivated it.** A float's exponent gives its resolution
 * where the values are small, and reversed-Z puts *far* at zero — so the hyperbolic loss and the
 * floating-point gain very nearly cancel and precision becomes roughly uniform with distance.
 * A consumer measured what its absence costs: a street plate's letters held 7.5 mm proud of a 6 mm
 * plate and a sign 15 mm proud of its board, neither a thickness anybody chose, and a near plane
 * settled at 0.25 for a first-person camera that wanted 0.05 — 1.6x of precision surrendered
 * permanently, because dropping it to 0.15 made every decal in the world blink.
 *
 * **This is the cure for a near-coincident seam and deliberately not for a coincident one.**
 * `webgl2/renderer.ts` records taking a reversed-Z conversion off the table once, and that
 * reasoning stands where it was written: two *exactly* coplanar surfaces have equal depth in exact
 * arithmetic and no format separates equal numbers, which is what `POLYGON_OFFSET_FILL` is for.
 * What reversed-Z fixes is the other case — surfaces a fraction of a millimetre apart, which a
 * conventional buffer cannot tell apart past about forty metres and this one can.
 *
 * **Shadows are not reversed and that is deliberate.** The directional cascades are orthographic,
 * where depth is already linear and a float buffer gains nothing, and the point shadows write with
 * `always`. Converting them would mean flipping every comparison in the shadow shaders for no
 * precision at all, so `SHADOW_FORMAT` and its passes keep the conventional sense and this module
 * says nothing about them.
 */

/**
 * True while the engine renders its scene depth reversed.
 *
 * **It is `true`, on both backends, and this is what it took.** Nine attempts. The eight that
 * failed were not wrong about the conversion — the compares, clears, clip corrections and formats
 * were right early — they were wrong about *where to look*, and the note below on the instrument
 * is the most reusable thing on this page.
 *
 * **What it is gated at.** Each backend against its own conventional output, at zero tolerance,
 * across every published scene on a real GPU: **WebGL2's worst frame 7,348 pixels of 921,600** and
 * **WebGPU's 11,832**, most a few hundred or none, and all of it seams resolving the other way,
 * which is the improvement. The two backends against *each other* come to 443,035 pixels on their
 * worst scene reversed against 443,039 conventional, so the conversion costs four pixels of the
 * ordinary disagreement between two independent implementations of an animated scene, in the
 * direction of agreeing slightly better.
 *
 * **`npm run wgsl` is part of changing anything here.** WebGPU draws from generated WGSL, so a
 * GLSL change left unregenerated keeps the old expression compiled in and the gate measures the
 * previous shader.
 *
 * ## The instrument
 *
 * **Compare the two backends against each other, not each against its own conventional baseline.**
 * Five attempts read an ambiguous number because a diff against a baseline can say *that*
 * something changed and never *which side is wrong*. Two independent implementations that agree
 * conventionally and stop agreeing reversed localise the fault to one of them. Always take the
 * conventional pair as the control in the same run: it is not zero, and reading a reversed number
 * without it is what made several earlier measurements unreadable.
 *
 * **Then bisect the shader with a constant-output probe**, and neutralise terms one at a time. The
 * last three defects were each found by forcing one factor to a constant and watching the two
 * backends fall into agreement. `flat/main.ts` has exactly one `outColor` assignment and it is the
 * last line of the shader, so a probe inserted earlier is overwritten and reads as "this feature
 * is not active" — verify any probe by forcing magenta first and confirming the gate moves.
 *
 * ## The four defects, all of them WebGL2's, none of them in the depth conversion
 *
 * 1. **The lit shader was handed a range-corrected light matrix.** `shadowFactor` projects with
 *    `uLightViewProj` and then does `p = p * 0.5 + 0.5` on all three axes, and `GL_SHADOW_REMAP`
 *    performs that same range change in the matrix. Both applied put every receiver depth in
 *    `[0.5, 1]` against a map holding `[0, 1]`. `webgpu/renderer.ts` had this right and says so.
 * 2. **Point-shadow face matrices were never range-corrected at all.** `EXT_clip_control` is
 *    context state, so a face matrix still emitting OpenGL's `[-1, 1]` loses everything below zero
 *    and half of every face is clipped away.
 * 3. **`bakeOne` had no depth bracket.** `bakeAreaOne` put the conventional compare and clear back
 *    for the length of an area light's bake; the ordinary lamp path, which is nearly every point
 *    shadow a scene has, ran under the frame's own `GEQUAL` against a scratch cleared to 0 while
 *    writing depths from a matrix that is deliberately not reversed. Both paths go through
 *    `bakePointShadow` now, unconditionally, so there is no branch left to forget.
 * 4. **Three shadow matrices shared one scratch buffer**, so whichever ran last rewrote the
 *    others, and `beginShadowPass` uploaded the raw matrix while holding the corrected one.
 *
 * Every one of them was invisible conventionally, and none of them looks like a depth bug: a wrong
 * shadow map does not draw broken, it draws *dark*. That is why the scene read as a lighting
 * regression for eight attempts and why bisecting the lit expression is what finally named them.
 *
 * **The trap, recorded because it cost a whole attempt.** Reversed depth measured *more
 * view-stable* than conventional on both scenes across two nearby frames, which reads as evidence
 * that the difference is the improvement. It is not: both scenes animate, so most of that is
 * motion. Do not stop at the stability number.
 *
 * **Candidates eliminated by measurement along the way**, so nobody pays for them twice: ambient
 * occlusion and its far-plane guards, `drawScatter` and `drawSdfText`, `POLYGON_OFFSET_FILL` and
 * the offset sign, environment irradiance, depth of field, and the directional cascade's bracket
 * and range, which were correct before any of this started.
 *
 * Everything else in this module is live and correct in both senses, and every consumer reads it
 * instead of a constant of its own.
 */
export const REVERSED_DEPTH = true;

/** What a scene depth attachment is cleared to: the far plane. */
export const DEPTH_CLEAR = REVERSED_DEPTH ? 0 : 1;

/**
 * The same value for a backend that learned its convention at runtime rather than at compile time.
 *
 * **`DEPTH_CLEAR` above says what the engine wants; this says what a context got.** Reversed depth
 * on WebGL2 needs `EXT_clip_control`, and a context not granted it runs conventional depth while
 * the constant still reads 0. Clearing to 0 with a `LEQUAL` compare rejects every fragment in the
 * scene — every one sits at depth >= 0 and only depth <= 0 is admitted — so the frame that reaches
 * the screen is the colour clear and nothing else.
 *
 * Reported from Firefox on Linux, which exposes no `EXT_clip_control`: every consumer drew one flat
 * colour with its interface still on top, at a healthy sixty frames a second. The depth *compare*
 * beside it was already chosen at runtime, and that asymmetry is what made this total rather than
 * subtle — two halves of one convention would still have drawn a picture.
 *
 * **Here rather than in the backend** for the 2026-08-13 rule's first clause: the decision is
 * backend-neutral and only the binding is per-backend. It is also what lets a test hold the clear
 * and the compare to each other, which a private field on a renderer could not.
 */
export function depthClearFor(reversed: boolean): number {
  return reversed ? 0 : 1;
}

/** The WebGPU compare for "nearer than what is there". */
export const DEPTH_COMPARE: GPUCompareFunction = REVERSED_DEPTH ? 'greater' : 'less';

/**
 * The same, admitting equality.
 *
 * The sky draws with this so it fills exactly the pixels nothing else claimed, and text with it so
 * a glyph coplanar with its quad is not dropped.
 */
export const DEPTH_COMPARE_EQUAL: GPUCompareFunction = REVERSED_DEPTH
  ? 'greater-equal'
  : 'less-equal';

/**
 * The scene depth format.
 *
 * **Float is half of reversed-Z and the half that is easy to forget.** Reversing a 24-bit unorm
 * buffer moves the precision around and does not create any; the gain comes from a float's
 * exponent having room near zero, which is where reversing puts the far plane.
 */
export const DEPTH_FORMAT: GPUTextureFormat = REVERSED_DEPTH ? 'depth32float' : 'depth24plus';

/**
 * Turn a depth read out of the buffer back into the `[0, 1]` a conventional one would have held.
 *
 * For anything that reconstructs a position or a distance from stored depth and was written
 * against the conventional sense. One place, so a pass that forgets it is a pass that looks wrong
 * rather than one that quietly disagrees with its neighbour.
 */
export function conventionalDepth(stored: number): number {
  return REVERSED_DEPTH ? 1 - stored : stored;
}

/**
 * The GLSL that turns a sampled scene depth back into OpenGL's `[-1, 1]` clip z.
 *
 * **One expression, interpolated, because four shaders had written it out by hand.** Ambient
 * occlusion twice, the camera blur's reprojection and depth of field each carried
 * `depth * 2.0 - 1.0`, which is the inverse of the conventional mapping and the wrong inverse of
 * the reversed one. A reversed buffer stores `0.5 - 0.5z`, so recovering z is `1 - 2 * stored`,
 * and a pass that keeps the old form does not fail loudly — it reprojects to slightly the wrong
 * place, which is what the renderer's own reprojection test caught when this landed.
 *
 * `%s` is the name of the depth variable at the call site.
 */
export function glslSceneDepthToNdc(depth: string): string {
  return REVERSED_DEPTH ? `(1.0 - ${depth} * 2.0)` : `(${depth} * 2.0 - 1.0)`;
}

/**
 * The same conversion as WGSL, for the hand-written compute shaders that have no GLSL to generate
 * from.
 *
 * **It is the same text, and that is the point of it being here.** The reconstruction resolve picks
 * the *nearest* of nine depths and dilates that texel's motion, which is the rule every temporal
 * upscaler uses because an edge's motion belongs to the nearer of the two surfaces meeting there.
 * Under a reversed buffer the nearest is the largest number, so a shader reading the attachment
 * without this conversion picks the furthest and drags the background's motion over every
 * silhouette — a defect that draws a plausible picture and moves the wrong way.
 */
export function wgslSceneDepthToNdc(depth: string): string {
  return REVERSED_DEPTH ? `(1.0 - ${depth} * 2.0)` : `(${depth} * 2.0 - 1.0)`;
}

/**
 * The clip-space z of the far plane, as GLSL, for geometry that writes a fixed depth.
 *
 * **The sky is the whole reason this exists.** It is a full-screen triangle written straight into
 * clip space with `z = w`, which is the far plane conventionally and the *near* plane once depth
 * is reversed — so a reversed engine whose sky still says 1.0 paints the sky over the entire
 * world. That is what the pixel gate caught the first time this landed: every scene changed, most
 * of the frame, and the largest was 743,669 pixels of 921,600.
 */
export function glslFarDepth(): string {
  return REVERSED_DEPTH ? '0.0' : '1.0';
}

/**
 * The WebGL2 depth compare for "nearer than what is there", and the one that admits equality.
 *
 * Taken as functions of the context because these are GL enums and this module must not import a
 * backend. The pair mirrors `DEPTH_COMPARE` and `DEPTH_COMPARE_EQUAL` exactly, so the two backends
 * cannot end up testing depth in opposite directions.
 */
export function glDepthFunc(gl: WebGL2RenderingContext): number {
  return REVERSED_DEPTH ? gl.GREATER : gl.LESS;
}

export function glDepthFuncEqual(gl: WebGL2RenderingContext): number {
  return REVERSED_DEPTH ? gl.GEQUAL : gl.LEQUAL;
}

/** The conventional pair, for the shadow passes, which are deliberately not reversed. */
export function glShadowDepthFunc(gl: WebGL2RenderingContext): number {
  return gl.LEQUAL;
}

/**
 * What a shadow pass clears its depth to, and it travels with the compare above.
 *
 * Separate from `DEPTH_CLEAR` because a shadow pass does not follow the frame: it renders from a
 * light matrix this module deliberately leaves conventional, so far is 1 there whatever the scene
 * is doing. Stated as its own constant so the pair cannot be half-applied — which is exactly how a
 * point-light bake ended up clearing to the scene's far plane and comparing with the scene's sense
 * against depths written the other way.
 */
export const SHADOW_DEPTH_CLEAR = 1;

/**
 * Which way a polygon offset has to push to bring a coplanar overlay forward.
 *
 * **The sign flips with the compare and forgetting it is silent.** `POLYGON_OFFSET_FILL` adds to
 * depth; under `LESS` nearer is smaller, so an overlay is pulled forward with a negative offset,
 * and under `GREATER` nearer is larger and the same nudge pushes it *behind* the surface it is
 * meant to sit on. The symptom is a marking that disappears into the road rather than a marking
 * that fights, which reads as a missing draw call.
 */
export const DEPTH_OFFSET_SIGN = REVERSED_DEPTH ? -1 : 1;

/**
 * How much depth one overlay layer is worth, and how much of it follows the slope.
 *
 * Two numbers so that the two backends offset a coplanar surface by the *same* amount: WebGL2
 * hands them to `gl.polygonOffset` around a draw and WebGPU bakes them into a pipeline as
 * `depthBias` and `depthBiasSlopeScale`, and a layer that means one thing on one backend and
 * something else on the other is a difference no test compares and a photograph shows.
 *
 * **The slope term is not zero, and it was zero here until a measurement said otherwise.** The
 * argument for zero is good and it is wrong: a declared overlay is coplanar with what it decorates
 * from every angle, so a constant nudge ought to be the whole of what it needs, and a slope term
 * ought to mean a kerb stands further off its slab as the camera turns. What that reasoning misses
 * is that the offset is applied in *depth*, and how much depth one pixel spans grows without bound
 * as a surface turns edge-on — so a constant that clears the fight head-on clears none of it at a
 * grazing angle.
 *
 * Measured, on a blended quad coplanar with the panel it decorates, counting the pixels of the
 * decal that survive: **WebGL2 clears it at layer 1 either way, and WebGPU with a slope of 0 keeps
 * 1,178 pixels of 1,237 at layer 1 and needs layer 2 to reach 1,237.** With the slope, both
 * backends read 1,237 at layer 1. Two backends given the same number and drawing two pictures is
 * the defect; the slope is what makes a declared layer mean one thing.
 *
 * **The sign is the units' sign and not the opposite of it**, which cost a capture to find: set to
 * `+1` the slope fights the constant and pushes the overlay *away*, and the decal disappeared
 * entirely on both backends — the same symptom the sign note above describes, arriving through the
 * other term.
 *
 * The cost is bounded and was gated rather than argued: **every published scene is 0 of 921,600
 * pixels on both backends** against the release before it.
 */
export const OVERLAY_DEPTH_SLOPE = -1;
export const OVERLAY_DEPTH_UNITS = -2;

/**
 * Highest depth layer a caller may ask for.
 *
 * A ceiling rather than an open number, because the offset has to stay small enough that a layer
 * cannot be dragged out through geometry it genuinely stands behind. Four is more than any scene
 * has needed: a base surface, the decks that cross it, the trim fused into those, and the
 * markings painted on top.
 */
export const MAX_DEPTH_LAYER = 4;

/**
 * The depth offset a layer is worth, clamped and signed, for whichever backend is asking.
 *
 * One function because it is one decision. It used to be three lines inlined in `drawMesh` on
 * WebGL2 and nothing at all on WebGPU, where `depthLayer` was accepted and silently ignored —
 * so a consumer that declared which of two fused surfaces should win got the answer on one
 * backend and a per-pixel coin toss on the other, with nothing anywhere saying so.
 *
 * Layer 0 is the base world and takes no offset at all, which is why the units come back as zero
 * for it: a pipeline or a draw that asked for nothing must be identical to one built before this
 * existed.
 */
export function depthOffsetForLayer(
  layer: number,
  /**
   * Which way depth actually runs for the caller asking.
   *
   * Defaulted to the convention this module declares, and passed explicitly by WebGL2, where it
   * is **not** a compile-time fact: reversed depth there needs `EXT_clip_control`, and a context
   * that was not granted it runs conventional depth whatever this file says. Taking the default
   * on that backend would offset every overlay the wrong way on exactly the machines that fell
   * back — and the symptom, a marking sinking into its road, reads as a missing draw call.
   */
  reversed: boolean = REVERSED_DEPTH,
): { readonly slope: number; readonly units: number } {
  const clamped = Math.min(Math.max(Math.round(layer), 0), MAX_DEPTH_LAYER);
  if (clamped === 0) return { slope: 0, units: 0 };
  const sign = reversed ? -1 : 1;
  return {
    /* `|| 0` because `0 * -1` is `-0`, which equals zero in every arithmetic use and not under
       `Object.is` — so two descriptors alike in every way a GPU can see would compare unequal. */
    slope: OVERLAY_DEPTH_SLOPE * sign || 0,
    units: OVERLAY_DEPTH_UNITS * clamped * sign,
  };
}

/**
 * The remap from the OpenGL clip space every camera matrix is built in to what the depth buffer
 * expects, as a column-major 4x4.
 *
 * **WebGL2 needs this only because `EXT_clip_control` puts its clip z in `[0, 1]`**, which is
 * where reversed-Z wants it and is not where `mat4.perspective` leaves it. It is the same
 * transform WebGPU's `CLIP_CORRECTION` carries, without the Y flip that backend also needs, and
 * it is the identity when depth is conventional and clip control is off — in which case the
 * renderer skips the multiply entirely.
 */
export const GL_DEPTH_REMAP = new Float32Array([
  1,
  0,
  0,
  0,
  0,
  1,
  0,
  0,
  0,
  0,
  REVERSED_DEPTH ? -0.5 : 0.5,
  0,
  0,
  0,
  0.5,
  1,
]);

/**
 * `EXT_clip_control`, which TypeScript's DOM library does not declare yet.
 *
 * Only the two enums and the one entry point this engine uses. Declared here beside the constant
 * that needs it rather than in a types file, so the reason it exists is next to the reason it is
 * called.
 */
export interface ClipControlExtension {
  readonly LOWER_LEFT_EXT: number;
  readonly ZERO_TO_ONE_EXT: number;
  clipControlEXT(origin: number, depth: number): void;
}

/**
 * The WebGL2 internal format and type for a scene depth attachment.
 *
 * **Float is the half of reversed-Z that is easy to forget.** Reversing a 24-bit unorm buffer moves
 * its precision around and creates none; the gain comes from a float's exponent having room near
 * zero, which is where reversing puts the far plane. `DEPTH_COMPONENT32F` is core in WebGL2, so
 * this needs no extension — only the matching `FLOAT` type, since a 32-bit float attachment
 * described as `UNSIGNED_INT` is refused.
 *
 * Shadow maps do not go through here: they are their own format for their own reason, and they are
 * not reversed.
 */
export function glSceneDepthFormat(gl: WebGL2RenderingContext): {
  readonly internalFormat: number;
  readonly type: number;
} {
  return REVERSED_DEPTH
    ? { internalFormat: gl.DEPTH_COMPONENT32F, type: gl.FLOAT }
    : { internalFormat: gl.DEPTH_COMPONENT24, type: gl.UNSIGNED_INT };
}

/**
 * The GLSL that asks "is this the far plane", for a pass that skips the background.
 *
 * **The guard that inverts, and the one that darkens a scene when it does not.** Ambient occlusion
 * skips a pixel showing nothing — `depth >= 1.0` conventionally — and under reversed depth the far
 * plane is 0.0, so that test never fires and occlusion is computed over the sky. The symptom is a
 * frame that comes out *darker rather than broken*: measured at 320,706 changed pixels of 921,600
 * with the mean luminance falling 18.5 to 15.3 and two thirds of mid-tones moved, which reads as a
 * shading difference and hides among the seams reversed depth is meant to fix.
 *
 * Written as a comparison rather than a constant so the sense and the bound move together: a
 * consumer of this cannot flip one and forget the other.
 */
export function glslIsFarDepth(depth: string): string {
  return REVERSED_DEPTH ? `(${depth} <= 0.0)` : `(${depth} >= 1.0)`;
}

/**
 * The `[-1, 1]` to `[0, 1]` remap **without** the reversal, for a pass that is not reversed.
 *
 * **Because `EXT_clip_control` is context-wide and a shadow pass is not.** Turning it on puts every
 * clip z in `[0, 1]`, including the shadow passes', whose light matrices are deliberately left
 * conventional — so a light matrix built by `mat4.perspective` or `mat4.ortho` emits `[-1, 1]` and
 * the context throws away everything below zero. Half of every shadow map's range disappears, which
 * does not look like clipping: it looks like the scene is *darker*.
 *
 * So a shadow pass gets this instead of `GL_DEPTH_REMAP`: the same range change, the same sense.
 */
export const GL_SHADOW_REMAP = new Float32Array([
  1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0.5, 0, 0, 0, 0.5, 1,
]);
