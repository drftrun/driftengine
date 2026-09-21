/** Construction-time GPU quality controls shared by every renderer resource. */

import { MAX_AREA_LIGHTS } from './areaLights.ts';
import { MAX_GLOBAL_MEDIUM_STEPS } from './globalMedium.ts';
import { MAX_POINT_LIGHTS } from './lightBudget.ts';
import { PREFILTER_SAMPLE_COUNTS } from './prefilterEnvMap.ts';

/**
 * What happens to a shaded colour on its way to the framebuffer.
 *
 * `none` writes it unchanged, which is what this renderer has always done and what its
 * worlds are authored against.
 *
 * `srgb` applies the sRGB transfer function. This is not a stylistic choice: shading
 * maths is linear and a display is not, so writing linear values into an 8-bit
 * framebuffer crushes the midtones — a surface at 0.2 linear should read as 0.48 and
 * instead reads as 0.2. It is why an untransformed render looks dark and muddy in
 * exactly the places a lit one should look ordinary.
 *
 * `aces` adds filmic tone mapping before that, rolling highlights off instead of
 * clipping them flat. Together they are what three.js does by default, which is why a
 * world ported from it looks wrong until this exists.
 */
export type OutputTransform = 'none' | 'srgb' | 'aces';

/**
 * The three settings whose accepted values are a closed set, written as one.
 *
 * Each of these already threw at construction with a message naming the allowed values, which is
 * the right refusal at the wrong moment: it survives `tsc` and lands as a blank page. A union moves
 * the same failure to the call site and costs nothing, because these are decisions rather than
 * quantities and a caller computing one is choosing between named tiers either way.
 *
 * Exported so a consumer building a quality profile can name the type of the field it is filling.
 */
export type ShadowFilterTaps = 4 | 8 | 12;
export type DirectionalShadowDepthLayers = 1 | 2;
export type WaterReflectionFilterTaps = 1 | 5 | 9;

export interface RenderQuality {
  /**
   * The transfer curve applied at the end of every shaded pass.
   *
   * Construction-time, like every other quality control here, and `none` by default so
   * no existing world changes by a single bit.
   *
   * **The symptom, written down because nobody searches for a transfer curve they do not know
   * exists.** With `none`, values above 1 clip flat rather than rolling off, so a scene with
   * bright sources against dark surroundings reads as crushed and desaturated: the highlights
   * go to a hard white with no colour left in them and the midtones look muddy. That is
   * reported by eye as "dark", "flat" or "not vivid", which sounds like a lighting problem, so
   * that is where people look. A consumer built, tuned and shipped six worlds before anybody
   * said the word. If a scene looks like that, try `outputTransform: 'aces'` with an
   * `outputExposure` before touching a single light.
   *
   * The default stays `none`, and that is not the fault: a curve that changed every existing
   * consumer's output would be far worse than one nobody found.
   */
  readonly outputTransform: OutputTransform;
  /**
   * How far the scene is scaled into the tone curve before it is applied. 1 is neutral.
   *
   * A tone curve is only meaningful relative to an exposure, and the reference ACES
   * transform is graded for a dark cinema. Renderers that ship it therefore scale their
   * input to suit the room the image will actually be seen in, and the factor each one
   * chooses is a look rather than a standard — three.js uses 1/0.6 and says so. This
   * engine holds no opinion and takes the number from whoever is authoring the world, so
   * that matching another renderer, or simply preferring a different grade, is a setting
   * rather than a patch. Ignored when `outputTransform` is not `aces`.
   */
  readonly outputExposure: number;
  /**
   * How a point light fades with distance.
   *
   * `smooth` shapes the curve to the light's own radius — zero exactly at the edge, gentle
   * near the source — which is what makes a light cullable without a seam and is what
   * every world built on this engine is authored against. `inverseSquare` is the physical
   * law, windowed by the radius so it still ends where it says it does; it is far brighter
   * close in, which matters when a source sits centimetres from a surface. Neither is more
   * correct than the other for a stylised world, so this engine ships both and holds no
   * opinion about which a game should want.
   */
  readonly pointLightFalloff: 'smooth' | 'inverseSquare';
  /** Drawing-buffer pixel density cap. */
  readonly maxDevicePixelRatio: number;
  /**
   * Drawing-buffer *area* cap, in pixels. Zero is uncapped.
   *
   * The companion to `maxDevicePixelRatio` and not a duplicate of it: density answers
   * "is this panel high-DPI", area answers "how much frame is this". With only the
   * density cap, the cost of a frame is whatever area the window happens to be, which
   * makes the size of somebody's window an uncontrolled multiplier on a renderer that is
   * roughly 90% fragment-bound. See `drawingBuffer.ts` for why vsync turns that into a
   * halved frame rate rather than a slightly slower one.
   */
  readonly maxDrawingBufferPixels: number;
  readonly directionalShadows: boolean;
  readonly pointShadows: boolean;
  /**
   * The most point lights the lit shader will be built to shade at once. A ceiling, not a promise.
   *
   * **What it is for is fitting a device, not tuning a picture.** Ten of the lit shader's uniform
   * arrays are sized by this with point shadows off and twenty with them on, and GLSL ES spends a
   * whole row of the fragment uniform grid per array *element* whatever its base type — so the
   * full budget declares 440 rows where an Adreno 740 offers 256 and WebGL2 guarantees 224. A
   * shader that does not link is not a slower frame, it is no frame at all.
   *
   * **The renderer already lowers this on its own when the part is short**, counting the shader it
   * is about to compile against what the device reports and saying so in the console. So a
   * consumer never has to set it to boot — this is here for the one who wants the arrays smaller
   * than the device would force, to spend the rows on something else or to hold a scene to a
   * budget they have measured.
   *
   * Lowering it costs lights. `Renderer.shadedLights` reports what was actually resolved, and a
   * `PointLightBuffer` should be sized from that: the selection evicts the weakest when the buffer
   * is full, so a buffer wider than the shader leaves an arbitrary subset lit rather than the
   * nearest ones.
   *
   * **WebGL2 only.** The generated WGSL is built and committed at the full budget, and WebGPU has
   * no per-stage uniform-vector ceiling to be short of. A consumer that lowers this and lands on
   * WebGPU gets all sixteen, which is both the better picture and the one that device can afford.
   */
  readonly maxLights: number;
  /** The most rectangular emitters the lit shader will be built to shade at once. See `maxLights`. */
  readonly maxAreaLights: number;
  readonly directionalShadowMapSize: number;
  /** Side length of each of the six point-shadow cubemap faces. */
  readonly pointShadowFaceSize: number;
  /**
   * Shared PCF budget for directional and point-light shadows.
   *
   * A closed set written as one, so a value outside it is a red squiggle rather than a blank
   * page. **Reported from outside**: `shadowFilterTaps: 9` type-checked and then threw at
   * construction, which is the right refusal arriving at the worst moment. The runtime check
   * stays for JavaScript consumers, which have no types to be helped by.
   */
  readonly shadowFilterTaps: ShadowFilterTaps;
  /**
   * How many samples a volume of light takes along each view ray. See `drawLightVolume`.
   *
   * The pass integrates the air rather than drawing sheets through it, so this is the dial
   * between banding and cost, and it is the only quality control the volume has. Thirty-two is
   * clean at the size a shaft usually occupies because the march is dithered per pixel, which
   * turns what would be concentric shells into grain the effect wants anyway. Below about
   * eight that grain becomes the picture; above thirty-two nothing here could see a change.
   *
   * It costs nothing when no volume is drawn, which is most frames in most worlds.
   */
  readonly lightVolumeSamples: number;
  /** Independently composited static sun depths; two preserves common overlaps. */
  readonly directionalShadowDepthLayers: DirectionalShadowDepthLayers;
  /** Horizontal world-space reach over which a directional shadow dissolves. */
  readonly directionalShadowMaxDistance: number;
  /** Maximum horizontal projection per vertical metre before low-angle shadows vanish. */
  readonly directionalShadowMaxSlope: number;
  /**
   * Metres a point light may drift from where its shadow was baked before re-baking.
   *
   * Zero is the old behaviour and it was the wrong default. See
   * `PointShadowMap.matchesSource`: a light that wanders to look alive invalidated
   * its map every frame, and a re-bake is six passes over the static world. Eight
   * sampled lights flickering at once accounted for 174 of the frame's 296 draw
   * calls, and for the game being unplayable exactly where lamps cluster.
   *
   * **It was 0.4 until 4.1.5, chosen to clear a flame's whole wander with room to spare** — so
   * a flame never re-baked at all, and its shadow of the static world stood still while the live
   * map under the same light, which is re-rendered every frame because it holds the movers, swung
   * with the flame. One light, two shadows, visibly disagreeing about where it was. Reported as
   * the runner's shadow following the fire and the brazier's not.
   *
   * **A millimetre instead, which is as near to "whenever it moved" as makes sense**, so a shadow
   * travels with its light rather than freezing between re-bakes. A centimetre was tried first and
   * left a visible vibration: a light wandering on a curve moves less than that in a frame near
   * the turning points of its travel, so the shadow ran smoothly through the fast part and stepped
   * through the slow part. What the tolerance is still for is not re-baking on arithmetic noise.
   *
   * A light that does not move never goes stale at any positive value, so the whole cost falls on
   * the lights that need it, and it is bounded rather than proportional: one such light takes a
   * whole cube in a frame and the rest dribble under the ordinary face budget.
   *
   * **What makes that affordable is not this number.** The 174-of-296 draw calls this paragraph
   * used to cite was measured before `pointShadowFacesPerFrame` capped the whole static bake, and
   * before `planPointShadowBakes` learned to put a chronically stale map behind every cold and
   * settling one. A flame now spends leftover budget and can never hold another light's first
   * image hostage. One such light also finishes its cube inside a single frame rather than
   * dribbling it over three, which is what makes the motion smooth instead of stepped; see
   * `pointShadowBudget.ts`.
   *
   * **What would make it wrong** is a caster set heavy enough that six passes over it does not
   * fit the frame, where a stepped shadow is the better trade and this should go back up.
   * `gpuTiming` is how to tell which, and it is a number rather than an opinion.
   */
  readonly pointShadowRebakeDistance: number;
  /**
   * Cubemap faces of point-shadow bake the renderer may spend in one frame.
   *
   * A face is a full pass over the static casters, so six of them is one light. Baking
   * every stale light in the frame it goes stale is fine in the steady state and ruinous
   * on the frame that stops being true: walking into a courtyard makes eight lights stale at
   * once, and 48 passes measured as two consecutive frames of 89 ms and 99 ms against an
   * 8.3 ms budget. That is the hitch a second after a page load.
   *
   * Two faces is about 6 ms of the same work, and the backlog drains over the next
   * handful of frames while shadows resolve progressively. Raising it trades that
   * smoothness for lamps that light sooner.
   */
  readonly pointShadowFacesPerFrame: number;
  /**
   * Cubemap faces of *live* point-shadow bake the renderer may spend in one frame.
   *
   * The companion to `pointShadowFacesPerFrame` and not a duplicate of it. That one budgets the
   * static maps, which go stale when a lamp drifts; this budgets the live maps, which hold the
   * movers and are stale every frame by definition — a character is somewhere new each frame, and
   * no `matchesSource` tolerance will ever say otherwise.
   *
   * **It defaults to a whole cubemap because that is what the renderer did before this existed,
   * and that default is wrong for a phone.** The live loop had no budget at all: it asked for
   * all six faces per live map per frame, outside the static budget. Measured as
   * `pointShadow.face` six times a frame in the consumer and in three of the engine's own
   * demos, in frames that were otherwise nine to fourteen passes. There are two live maps and
   * the second wakes during an ownership handoff, so running past a row of lamps costs twelve
   * full passes over the dynamic casters every frame.
   *
   * Lowering it spreads a mover's shadow across two or three frames instead of finishing it in
   * one. The shadow then trails a fast character slightly, which is a real cost and a smaller one
   * than the frame it was taking. Six keeps the old behaviour exactly.
   */
  readonly liveShadowFacesPerFrame: number;
  readonly water: boolean;
  /** Cells per side; the vertex count is this value plus one, squared. */
  readonly waterResolution: number;
  /** Full planar scene reflection sampled by water; false keeps the sky fallback. */
  readonly waterReflections: boolean;
  /** Reflection-target dimensions relative to the drawing buffer. */
  readonly waterReflectionScale: number;
  /** Water-material samples used to broaden the otherwise sharp planar image. */
  readonly waterReflectionFilterTaps: WaterReflectionFilterTaps;
  /**
   * Allocate the planar reflection target even where there is no water to sample it.
   *
   * **The reflection was a water feature by accident of its wiring rather than by design.** The
   * target existed only when `water` and `waterReflections` were both on, so a scene whose ground
   * is a mesh slab with wet film over it, which is what a street at night is, could not mirror
   * anything into it however it asked. A consumer attempted exactly that on the strength of
   * `beginPlanarReflection`'s name and had to do without.
   *
   * Off by default, because the target is a second colour buffer sized from the drawing one and
   * a scene that does not sample it should not pay for it. `water && waterReflections` still
   * turns it on by itself, so nothing that had a reflection loses one.
   */
  readonly planarReflections: boolean;
  /**
   * Keep the scene's real brightness through the composite, and grade at the end instead of in
   * the mesh pass.
   *
   * **Off by default and it has to be, because it is not neutral.** With it on, the scene target
   * holds half floats, so a value above 1 survives to the composite instead of being clamped on
   * the way in, and every effect there works on what the scene actually emitted. Measured on the
   * gilded chamber, held: pixels the scene had already driven near white changed **19.4% of the
   * time with a mean delta of 3.21**, while every other band moved by 0.02 to 0.04, which is
   * rounding between eight bits and a half float. That is the change being correct rather than
   * the change being small, and it is still a change to a shipped picture.
   *
   * **What it is for.** Nothing downstream can tell a star at five times white from a sheet of
   * white paper once the buffer has clamped both to 1, so a brightness threshold cannot exist.
   * This is the prerequisite for one. It also moves the tone curve to the resolve, which fixes an
   * inconsistency that predates it: the mesh pass was the only pass that graded, so the sky, the
   * particles, the wet film and the water were composited ungraded beside a world that was.
   *
   * Needs `screenEffects`, since without a composite there is nothing at the end to grade in, and
   * `EXT_color_buffer_float`, which is asked for rather than assumed: without it the target stays
   * eight-bit and this buys only the consistent grading.
   */
  readonly hdrScene: boolean;
  /** Camera-depth water tint and scattering across every visible pass. */
  readonly underwaterAtmosphere: boolean;
  /** Procedural noise octaves evaluated by plume shaders. */
  readonly plumeNoiseOctaves: number;
  /**
   * Whether a GPU family known to struggle may have its pixel terms clamped at construction.
   *
   * True by default, because the overwhelming majority of players never open a settings
   * screen and a phone opening at a desktop profile is how `NFD6QQ` happened.
   *
   * **A caller passes false to mean "this person chose these numbers themselves."** A player
   * who has deliberately asked for the good profile on a part that cannot hold it is entitled
   * to have it, and to the frame rate that comes with it. Guessing over the top of an explicit
   * choice is worse than a slow game, because it is a setting that silently does not apply.
   */
  readonly capabilityClamp: boolean;
  /**
   * Throw away a multisampled attachment once it has been resolved, instead of writing it back.
   *
   * True is correct and is what the engine wants: the resolve happens either way, and no shader
   * can read the four-sample texture because it carries no `TEXTURE_BINDING` usage. It is worth
   * 115 MB a frame at a phone-sized frame with four samples.
   *
   * **It is a switch because it cannot be verified anywhere but on a tile-based GPU.** On an
   * immediate-mode desktop part `discard` costs nothing and changes nothing — the samples have
   * nowhere else to be — so a screenshot gate cannot tell a correct discard from a wrong one. A
   * tiler really drops them. If a device flashes black or shows a stale frame, turn this off
   * first: it is the one change in this area whose blast radius is a whole frame.
   */
  /**
   * Measure GPU time with timestamp queries. **Off by default, and that is the lesson.**
   *
   * A frame timer is a diagnostic, and a diagnostic must never be able to break the thing it
   * observes. This one could: enabling it attaches a `timestampWrites` block to **every render
   * pass in the frame**, so an implementation that disagrees about any part of it invalidates
   * the whole command buffer, and an invalid command buffer draws nothing at all. That is a
   * black canvas caused by a profiler.
   *
   * It shipped on by default and had only ever run against one implementation. Turning it on
   * costs two queries a pass and is worth it while measuring; paying that risk on every
   * consumer's frame for a number nobody is reading is not.
   *
   * Requires the adapter's `timestamp-query` feature. Without it this reports `available: false`
   * and measures nothing, which is the honest answer rather than a silent zero.
   */
  readonly gpuTiming: boolean;
  readonly discardResolvedAttachments: boolean;
  /**
   * Open the frame's render pass on the first draw that wants it, rather than in `beginFrame`.
   *
   * True avoids closing and reloading the frame's attachment around every planar reflection,
   * measured at 155 MB a frame on a scene with one mirror. False restores the eager open.
   *
   * A switch for the same reason as the one above: it moves *when* a pass is opened relative to
   * everything else a consumer does in a frame, and the failure it could cause is a frame that
   * does not present rather than a pixel that is wrong.
   */
  readonly deferFramePass: boolean;
  /**
   * Route the verbs that have been migrated through the frame graph rather than issuing them
   * directly.
   *
   * **On by default as of 2026-08-25.** The graph records a draw instead of executing it and
   * schedules what accumulated at each boundary. `graphVerbFlushes` is zero — no verb flushes to
   * issue its own calls any more — and the seven published scenes are **pixel-identical with it on
   * and with it off**, 0 of 921,600 each at delta 16, measured on an AMD RX 9070 XT with no device
   * errors on either setting.
   *
   * What kept it off was two defects that only recording could expose, both fixed the same day:
   * a draw took the pipeline of whichever pass happened to be open rather than the one it would
   * land in, and a probe bake never replayed its records, so it baked an empty cube and leaked six
   * draws into the next pass to open. `IMPROVEMENTS.md` carries both.
   *
   * It remains a switch on the same reasoning as the two above: it changes *when* work reaches the
   * GPU relative to everything else a consumer does, so a regression wants to be bisectable to this
   * rather than to a release. `?graph=0` turns it off in one reload.
   */
  readonly frameGraph: boolean;
  /**
   * Schedule each flush through the identifier graph rather than through masks. WebGPU only.
   *
   * **Off, and nothing a consumer can see changes with it on.** The graph `frameGraph` records is
   * the same either way; this chooses which scheduler groups it into passes and derives what each
   * attachment loads and stores. The mask scheduler is exactly right for a frame whose composition
   * is fixed, and the identifier graph is what can also express a frame whose composition is not —
   * the second pipeline's — so this is the switch that says the second is a generalisation of the
   * first: the eighteen scenes the harness walks are pixel-identical with it on, measured
   * 2026-09-17 — `showroom` in six captures a side, because it varies between runs of one build
   * whatever this says. `frame/flushGraph.ts` says where the two can part, and why no flush the
   * renderer makes reaches it.
   *
   * Ignored where `frameGraph` is off, which records nothing to schedule, and on WebGL2, which has no
   * verb-level graph. `?idgraph=1` turns it on in one reload.
   */
  readonly identifierGraph: boolean;
  /**
   * Light the world from a froxel table rather than from a fixed set of uniform-array slots.
   *
   * **Off, and off is what every published scene is gated at.** With it off the clustered lines
   * are not in the compiled shader at all — `resolveConditionals` cuts them — so a consumer that
   * does not ask for this compiles and runs exactly the shader it did before, which is what makes
   * the zero-pixel gate on the published scenes mean something.
   *
   * On, the point-light budget stops being `MAX_POINT_LIGHTS` and becomes `MAX_CLUSTERED_LIGHTS`,
   * and a fragment shades against the lights in its own froxel rather than against every light the
   * CPU chose for the whole scene.
   *
   * **What it gives up.** One texture unit on WebGL2, permanently, for the table. A per-frame
   * binning cost that is on the main thread on WebGL2 and on the GPU on WebGPU — measured in
   * `clusteredLights.ts`, 0.411 ms a frame at sixteen lights and 2.6 ms at 256. And the froxel
   * bounds are the AABB of a truncated pyramid, so a light is occasionally shaded against a
   * fragment it only nearly reaches.
   *
   * **What would make it wrong.** A scene whose lights are few and enormous: binning cost scales
   * with a light's screen area rather than with the light count, so sixteen lights each covering
   * the frame is the shape that pays most and gains least. The fixed path is still there and is
   * still the right answer for it.
   */
  readonly clusteredLights: boolean;
  /**
   * Skip a mesh draw whose bounds are outside the frame.
   *
   * **Off, and it is a behaviour change rather than a switch between two right answers.** A
   * correct cull is invisible: the pixels are identical and the work is not done. A cull with
   * wrong bounds is a missing object, and bounds come from vertex positions the renderer was
   * handed — so a mesh whose geometry is displaced in its vertex shader, as foliage under wind
   * is, occupies more space than its positions describe.
   *
   * A consumer that knows its own world is better placed to cull than this is: `visible` lets it
   * skip the model matrix, the animation update and the material switch as well, none of which
   * the renderer can avoid once it has been called. This flag exists to prove the test is right
   * and to serve a consumer for whom that restructuring is not worth it.
   */
  readonly cullDraws: boolean;
  /**
   * Resolve the scene through an off-screen target so screen-space effects can run.
   *
   * Off is not "no blur" — it is *no post-process stage at all*: the scene draws straight
   * to the canvas as it always did, and the extra colour target and full-viewport pass are
   * never allocated. That is the honest low-end setting, because the cost is one write and
   * one read of every pixel and it does not shrink with a smaller effect.
   */
  readonly screenEffects: boolean;
  /**
   * Multisample the off-screen scene target: 1 is off, 4 is the usual asked-for figure.
   *
   * **This is the missing half of a decision that was only half made.** The renderer asks
   * the canvas for `antialias: !screenEffects`, and that reasoning is sound and measured:
   * with the scene drawn into an off-screen target, the only thing reaching the default
   * framebuffer is one fullscreen triangle, which has no interior edges to multisample.
   * Forcing it off moved `gl.SAMPLES` from 4 to 0 with identical screenshots and saved a
   * multisampled backbuffer and a resolve every frame. What never happened is anything
   * replacing it, so the default configuration — every screen effect on — has had no
   * anti-aliasing at all, and it shows on an imported model as hard-stepped edges along
   * anything seen at a shallow angle.
   *
   * True multisampling rather than a post filter, because it works on geometry edges and
   * does not touch texture detail: FXAA is cheaper and softens a 4K base colour map, which
   * is a real loss on exactly the assets this matters for. It costs memory bandwidth
   * proportional to the sample count and nothing else.
   *
   * **Defaults to 1, so nothing changes for anyone who does not ask.** Clamped to what the
   * driver reports through `MAX_SAMPLES`, since asking for more than a part supports is a
   * framebuffer that never completes.
   */
  readonly sceneSamples: number;
  /**
   * Camera motion blur, 0 to 1. Off by default.
   *
   * Camera rather than per-object, and that is a decision rather than a stage. Per-object
   * blur needs a velocity buffer: every mesh writing its own screen-space motion into a
   * second render target, so a second set of matrices per draw and a wider G-buffer, which
   * is a structural change to a forward renderer that writes one colour target. Camera blur
   * needs only the previous view-projection, which is one matrix, and it covers the case
   * that actually matters — a camera whipping round a turntable or through a world.
   *
   * Runs inside the composite pass, so it costs a depth sample and eight taps on the pixels
   * that are moving and nothing on a still frame. Needs `screenEffects`, since without the
   * off-screen target there is no finished image or depth to sample.
   */
  readonly cameraMotionBlur: number;
  /**
   * Temporal antialiasing: an edge stops crawling as the camera moves. Off by default.
   *
   * **Antialiasing across frames instead of inside one.** The projection is jittered a fraction of
   * a pixel each frame and the result is blended into where the last frame was, so an edge that
   * fell one side of a pixel centre falls the other side next frame. What MSAA buys per frame this
   * buys over eight of them, for one texture and one fullscreen pass instead of a multiplied fill
   * rate — which is the trade a browser target wants, where MSAA on a float target is not free.
   *
   * **Off by default, and that is not timidity.** Jittering the projection moves every pixel of
   * every frame by construction, so turning it on by default would change every capture in the
   * repository and every consumer's reference images with them.
   *
   * The motion is the camera's: reprojection is exact for a static world under a moving camera and
   * wrong for a moving object under a still one, which the neighbourhood clip rejects rather than
   * corrects. A velocity buffer is what fixes that, and the README carries it as its own gap.
   *
   * Needs `screenEffects`, since without the off-screen target there is no finished image to
   * resolve or depth to reproject through.
   */
  readonly temporalAa: boolean;
  /**
   * Order-independent transparency: two panes of glass stop depending on submission order. Off by
   * default.
   *
   * **Sorted alpha blending is order-dependent by construction** — `over` does not commute — so a
   * translucent set is drawn back to front and anything the sort cannot separate wins arbitrarily
   * or flickers: two panes that intersect, a pane containing another, a pane and the smoke inside
   * it. Sorting harder cannot fix an intersection at all.
   *
   * Weighted blending replaces the ordering with a sum and a product, both of which commute. It is
   * **exact for a single layer** and an approximation of the ordering for several, where near
   * layers count for more than far ones — which is what a pane of glass needs and what a
   * stained-glass window of eight overlapping leaves does not.
   *
   * The cost is two extra targets and a **second submission of the translucent geometry**: the
   * accumulation and the revealage are separate blend states, and this renderer draws immediately
   * rather than into a G-buffer. That was chosen over writing both from one pass, which would need
   * a second fragment output and therefore another `flatFrag` permutation — measured at about
   * 247 KB gzipped, paid by every consumer whether or not they enable this.
   *
   * Needs `screenEffects`, since the resolve composites over the finished scene.
   */
  readonly orderIndependent: boolean;
  /**
   * Depth of field: how wide the blur may reach, as a fraction of the frame's height. Off by
   * default.
   *
   * **A ceiling rather than the effect**, the same split `cameraMotionBlur` takes: this says how
   * far a defocused point may spread and therefore what the pass may cost, and
   * `setDepthOfField` says where this frame's lens is focused and how much of the ceiling it
   * takes. A camera focuses on a subject; a quality profile decides how expensive that is
   * allowed to be, and a device that cannot afford eight extra taps caps it in one place.
   *
   * Runs inside the composite pass, so it costs a depth sample and eight taps on the pixels that
   * are out of focus and one comparison on a frame that has not asked for it. Needs
   * `screenEffects`, since without the off-screen target there is no finished image or depth to
   * sample.
   *
   * **0.02 is a strong, visible defocus** — two per cent of the frame's height is about twenty
   * pixels at 1080 — and 1 is the top of the range rather than a value anybody wants.
   */
  readonly depthOfField: number;
  /**
   * Occlusion culling: how many texels wide the occlusion buffer is. **0 is off and is the
   * default.**
   *
   * A width rather than a boolean, because the only dial this has is its resolution and a second
   * option for it would be a second thing to keep in step. 256 is a reasonable frame's worth: at
   * 16:9 that is a buffer of 256 by 144, which rasterises a handful of occluder boxes in well under
   * a millisecond and answers a rectangle test in a few reads.
   *
   * **It culls nothing until a consumer declares an occluder**, which is what `addOccluder` is for.
   * Nothing is inferred from the scene: an occluder is the box you may safely be hidden by, and
   * only the consumer knows which of its objects that is true of. See `OcclusionBuffer`.
   *
   * Costs nothing on the GPU at all — the whole thing is arithmetic on the CPU, which is what lets
   * it be identical on both backends and asserted without one.
   */
  readonly occlusionCulling: number;
  /**
   * Reconstruction: how many output pixels the renderer draws for each render pixel, each axis.
   * **0 is off and is the default.**
   *
   * On, the scene and everything that reads it before the resolve are drawn at
   * `ceil(output / ratio)` and a compute dispatch reconstructs the output-size picture from this
   * frame and the accumulated history — DriftTR, `render/recon/`. What it saves is `1 - 1/r²` of
   * the scene's fragment work, which at 1.5 is 56%; what it costs is one motion target and one
   * previous depth at render size, two output-size histories and one dispatch.
   *
   * **Off is byte-for-byte what the renderer does today**, which is what the published scenes are
   * gated at. WebGPU only: WebGL2 has no compute stage, and it keeps the temporal resolve at native
   * size, which is what it does now.
   *
   * **Zero is off rather than one, because one is a thing somebody might mean** — the resolve at
   * the output size with no upscaling, which is a temporal antialiaser with a better neighbourhood
   * rule than `temporalAa`'s. A sentinel that collided with it would make that unaskable.
   *
   * The range is 1.3 to 2 and a value inside it is clamped to the end it is nearest. Below 1.3 the
   * render saves less than a third of the fragment work and the resolve's own cost eats it; above 2
   * the render is a quarter of the output and no reconstruction holds an edge through that. A
   * negative number is off, not a clamp to the bottom: it cannot mean "a little".
   *
   * `?recon=` is how it gets A/B'd in one reload.
   */
  readonly reconstruction: number;
  /**
   * Light a scene from what bounces, rather than from what was baked. **Off by default.**
   *
   * On, the probe grid the shading already samples is filled by tracing `render/gi/`'s three-level
   * chain — the world distance field, and behind it the probes themselves, which is what makes the
   * solution converge on several bounces over a few refreshes. Off, the probes hold one bounce of
   * the rasterised scene, which is what this engine has always baked.
   *
   * **A switch rather than a strength.** Half an indirect bounce is not a thing to ask for: a probe
   * either holds what the chain traced or it holds what the cube held, and mixing them is two
   * solutions averaged rather than one at a lower quality. What is adjustable is how many probes
   * refresh a frame, and that belongs to the grid.
   *
   * **WebGPU only**, and refused in words elsewhere — `INDIRECT_LIGHT_WEBGL2_REFUSAL`. A probe is a
   * few hundred rays and that is a compute dispatch; WebGL2 has no stage for one, and the
   * alternative — the two backends lighting one scene differently — is the disagreement the
   * published pixel gate exists to prevent.
   *
   * `?indirect=1` turns it on in one reload.
   */
  readonly indirectLight: boolean;
  /**
   * Ambient occlusion, 0 to 1. Off by default.
   *
   * Contact shading where geometry meets: a wheel arch against a tyre, a plinth against a
   * floor, the inside of a panel gap. It is most of what makes an imported model sit in a
   * room rather than float in it, and its absence does not read as a missing feature — it
   * reads as the model being pasted over the picture.
   *
   * Depth compared against its neighbours, in the pass that already holds the depth, so it
   * costs no extra target and no second submission of the scene. Needs `screenEffects`,
   * since without the off-screen target there is no depth to sample; on a driver that
   * refuses to resolve multisampled depth it turns itself off rather than sampling a
   * texture holding whatever was there before.
   *
   * **1 is not the intended look.** It is the top of the range, and a value that dark is
   * useful mostly for seeing where the effect is landing while tuning it.
   */
  readonly ambientOcclusion: number;
  /**
   * Compile the night-side emissive term into the surface shader. Off by default.
   *
   * The amount is `Environment.nightEmissive` and is per frame; this decides whether the term
   * exists at all, and it is construction-time because it changes the shader that gets compiled
   * rather than a value uploaded to one.
   *
   * **It is two options rather than one because the term is not free when it is switched off**,
   * and that was measured rather than assumed. It names `emissiveTint` and `vEmissive`, which
   * the ordinary emissive line also names, so its mere presence lets the compiler re-plan the
   * arithmetic they share: held on the gilded chamber with the amount at 0, **109 pixels of
   * 750,080 moved** against the build before the term existed, where a shadow tap sat exactly on
   * its boundary and flipped. Cut out of the source, the same scene is identical.
   *
   * So a consumer that wants city lights on a rotating planet asks for it and accepts that its
   * pictures move by that much, and every consumer that does not is charged nothing and sees
   * nothing. See `shaders/flat.ts` for the elimination that established which half cost what.
   */
  readonly nightEmissive: boolean;
  /**
   * Bloom, 0 to 1. Off by default.
   *
   * How far a bright thing spreads past its own pixels. Without it an emissive surface is
   * exactly as bright as the pixels it covers and not one wider, so anything meant to
   * overwhelm the eye — a lamp, a star, a neon strip, a shaft of daylight — has to be built
   * out of geometry that imitates a halo. A consumer asked for this after building one star
   * from a core sphere, a second sphere at 1.22 times the radius and fifty-four additive
   * particles, which is a hundred lines standing in for one pass.
   *
   * **Composed with `outputTransform` rather than replacing it.** The curve decides how a
   * bright pixel rolls off; this decides how far it spreads. The bloom is added in linear
   * scene units and the curve then rolls off the sum.
   *
   * **It wants `hdrScene`, and it says so at construction if it does not have it.** The
   * threshold below is in scene units, and with an eight-bit target the scene has already been
   * clipped to 0..1 by the time the composite sees it: a star and a sheet of white paper are
   * the same colour there, so a threshold can only mean whiteness. Needs `screenEffects` too,
   * since without the off-screen target there is no finished image to threshold.
   *
   * Deliberately absent, because they were asked against by name: lens dirt, anamorphic
   * streaks and ghosting. One threshold, one radius, one strength.
   */
  readonly bloom: number;
  /**
   * How bright a pixel has to be before it blooms, in scene units.
   *
   * 1.0 means "brighter than white", which is the useful place to start with a tone curve and
   * an exposure: everything a surface reflects sits below it and only sources of light climb
   * past. Lower it to bloom bright paint as well as lamps.
   *
   * **Subtracted rather than cut**, so there is no second knee knob and no visible edge where
   * a gradient crosses the threshold: a pixel just over it contributes almost nothing and one
   * far over contributes nearly all of itself.
   *
   * Only consulted while `bloom` is non-zero. It is not clamped to any range because a scene
   * is free to define its own units, though it must be positive: a threshold of zero blooms
   * the entire frame including the parts of it that are meant to be dark.
   */
  readonly bloomThreshold: number;
  /**
   * How far the occlusion sampling reaches, in metres.
   *
   * A world-space radius rather than a pixel one, because contact shading is a fact about
   * the geometry: a gap of two centimetres should darken by the same amount from across the
   * room as from a metre away, and a radius in pixels does the opposite. It is projected to
   * a screen radius per pixel from the depth there.
   *
   * The scale to match is the size of the gaps that matter. Half a metre suits a room and a
   * vehicle; a landscape wants more, a model of a watch wants very much less.
   */
  readonly ambientOcclusionRadius: number;
  /**
   * How many steps a global-medium march takes per pixel. **0 is off, and is the default.**
   *
   * A ceiling rather than the effect, in the shape `depthOfField` and `bloom` already use: this
   * says what the pass may cost and `setGlobalMedium` says how thick this frame's air is. At 0 no
   * target is allocated, no program is built and no composite runs, so a consumer who never asks
   * for weather pays nothing — which is the property `scripts/medium-check.mjs` asserts by
   * photographing a frame at density 0 against a frame with the ceiling at 0 and demanding they
   * be identical rather than close.
   *
   * **It is the only thing here that costs linearly.** Each step is a shadow lookup and an
   * exponential; the march is otherwise a fixed setup. 24 is a room, 48 is a landscape where the
   * sun is low enough to make the steps visible as banding at fewer, and above about 48 the
   * picture stops changing. Clamped to 64, which is the shader's own loop bound.
   *
   * What the medium *is* — a body of light inside a hull, or the air itself — is the distinction
   * `globalMedium.ts` opens with: `drawLightVolume` is a shaft somebody placed, and this is
   * everything between the camera and the wall.
   */
  readonly globalMediumSteps: number;
  /**
   * Whether the march runs at half the frame each way. On by default, and it should stay on.
   *
   * Half is a quarter of the march, and what pays for it is that a homogeneous medium is smooth
   * everywhere except at a silhouette — which is the one thing the depth-aware upsample is built
   * to handle. Full resolution is here for a capture that has to rule the upsample out as the
   * cause of something, and for a part with pixels to spare.
   */
  readonly globalMediumHalfResolution: boolean;
  /**
   * Cubemap face size for a baked reflection probe. Zero is off, and is the default.
   *
   * A probe is how a reflective surface shows the *room* rather than a sky-and-ground gradient:
   * a car body carrying the light panels above it and the walls around it. It is baked by the
   * caller through `bakeReflectionProbe`, once, so it costs six submissions of the scene at that
   * moment and one cubemap fetch per reflective pixel afterwards. Nothing per frame.
   *
   * **It needs a seventeenth texture unit**, and WebGL2 guarantees sixteen. On a device at the
   * guarantee the probe is declined with a warning and reflective surfaces keep the
   * approximation, rather than point shadows being dropped to make room. See
   * `ENVIRONMENT_TEXTURE_UNIT`.
   */
  readonly reflectionProbeSize: number;
  /**
   * Whether a surface may reflect its surroundings at all. On by default.
   *
   * **The switch beside the size, in the shape `water`/`waterReflections` and
   * `pointShadows`/`pointShadowFaceSize` already use.** `reflectionProbeSize` says how good the
   * reflection is and this says whether there is one, which is what a settings screen needs: a
   * player turning reflections off should not have to know that a cubemap of zero pixels is the
   * spelling for it, and a consumer scaling a quality preset should be able to drop the whole
   * feature in one field rather than remembering which number means absent.
   *
   * **What it costs to leave on**, since that is the question this answers: one cubemap fetch per
   * pixel of every surface that reflects anything, plus six submissions of the scene and a blur
   * chain each time a caller bakes. Nothing per frame beyond the fetch. What it costs to turn off
   * is the room: a metal has no diffuse term, so what it shows *is* its reflection.
   *
   * **Off is a defined picture rather than an absence**, which is the half worth stating. With no
   * probe the mesh shader keeps the sky-and-ground gradient it had before probes existed —
   * `uAmbient` above, `uAmbientGround` below, mixed by the mirror direction — so a reflective
   * surface still reads as reflective and still varies with the view, it just carries an
   * approximation of the sky instead of an image of the room. Nothing renders black and no caller
   * has to branch: `bakeReflectionProbe` answers false and may be issued unconditionally.
   *
   * What would make this wrong: image-based lighting. With a real irradiance term and a
   * prefiltered environment the gradient stops being the honest fallback, because there would be
   * a cheaper *correct* answer to fall back to.
   */
  readonly environmentReflections: boolean;
  /**
   * Samples per texel in the environment prefilter's GGX convolution.
   *
   * **A quality option because a phone and a workstation should not agree on it**, and it is
   * affordable at all only because a bake happens once per scene rather than once per frame. The
   * named tiers live in `prefilterEnvMap.ts`; this is the number one of them resolved to, so a
   * consumer can also state its own.
   *
   * **What it costs:** the convolution is this many cube fetches per texel per level, against the
   * single fetch the box-filtered chain it replaces cost. **What would make a low count wrong** is
   * a small very bright source in an otherwise dark environment, which is the worst case for
   * variance and is where a rough level shows the samples separately rather than as a lobe.
   *
   * Consulted only when a probe exists, so at the default `reflectionProbeSize` of zero this
   * changes nothing at all.
   */
  readonly environmentPrefilterSamples: number;
  /**
   * Whether the lit pass reads the **GGX-prefiltered** cube rather than the capture's box chain.
   *
   * **Off by default, and that default is a correction rather than a preference.** The prefilter
   * shipped in 3.2.0 wired straight into the lit pass, so it changed the picture of every consumer
   * that had a probe — which this file's own rule forbids: every feature's default reproduces
   * today's picture, and a scene that changes because a feature was added is a regression however
   * good it looks. It was reported as metals reading opaque, twice, before anybody connected it to
   * a feature nobody had asked for.
   *
   * **What the two chains are.** A box level is a smaller picture of the room; a prefiltered level
   * is the room convolved with the lobe for the roughness that level stands for. At the same
   * material roughness the prefiltered one is far blurrier — which is the physically correct
   * answer and is why it exists — so a surface authored against the box chain reads as a wash.
   *
   * **On is the better construction and costs a cube of memory plus the bake.** Turn it on when a
   * scene's materials were authored for it, and note that `envLod` changes meaning with it: the
   * texel-footprint floor is right for a box chain and a roughness combined in quadrature is right
   * for a lobe chain, and the shader picks by this flag rather than by a guess.
   */
  readonly environmentPrefilter: boolean;
}

/** Callers override only the levers selected by a future settings profile. */
export type RenderQualityOptions = Partial<RenderQuality>;

export const MAX_SHADOW_FILTER_TAPS = 12;
export const MAX_WATER_REFLECTION_FILTER_TAPS = 9;
export const POINT_SHADOW_FADE_START = 0.35;
export const DIRECTIONAL_SHADOW_FADE_START = 0.65;

/**
 * Current fidelity target. Different shadow projections use different texture
 * dimensions for comparable visible detail: a cubemap spends its allocation
 * six times, while the directional map spends all of it on one focused area.
 */
export const DEFAULT_RENDER_QUALITY: Readonly<RenderQuality> = Object.freeze({
  outputTransform: 'none',
  outputExposure: 1,
  pointLightFalloff: 'smooth',
  /**
   * Render at the display's own density, up to 2×.
   *
   * It was 1.75, which is a number that renders *nothing* at native resolution: every
   * retina panel reports 2, so the drawing buffer was 87% of the pixels the screen has and
   * the browser stretched the difference. It was found by comparing a small figure in a
   * box against the world behind it: both were blurred, and for the same reason.
   *
   * 2 is where the ceiling belongs. It is what the overwhelming majority of high-density
   * displays report, so it is the point at which a game stops being upscaled; past it the
   * cost is quadratic for detail almost nobody can resolve, which is why there is a cap at
   * all. A device that cannot hold its rate at 2 has the Low profile, which is a decision
   * about pixels rather than a blur applied to everyone.
   */
  maxDevicePixelRatio: 2,
  /**
   * 12 megapixels, which is a guard rail rather than a haircut.
   *
   * At a density cap of 2 the drawing buffer is the panel's own pixels, so this does
   * nothing at all up to and including 4K (8.3 MP) — the resolutions almost everybody is
   * on keep every pixel they have. It starts holding at 5K and above, and on the
   * high-density laptop panels whose logical size is large enough to ask for more than a
   * 4K frame, which are exactly the cases where the density cap has stopped meaning
   * anything about cost.
   *
   * A ceiling that never binds on common hardware is the point: the failure it exists to
   * prevent is a frame that quietly grew past a vsync slot, and a cap only prevents that
   * if it is above where people actually are. Consumers wanting the pixels set it to 0.
   */
  maxDrawingBufferPixels: 12_000_000,
  directionalShadows: true,
  pointShadows: true,
  /* The engine's own budgets, which the renderer lowers per device when it has to. */
  maxLights: MAX_POINT_LIGHTS,
  maxAreaLights: MAX_AREA_LIGHTS,
  directionalShadowMapSize: 2048,
  pointShadowFaceSize: 512,
  shadowFilterTaps: MAX_SHADOW_FILTER_TAPS,
  lightVolumeSamples: 32,
  directionalShadowDepthLayers: 2,
  directionalShadowMaxDistance: 6,
  directionalShadowMaxSlope: 3,
  pointShadowRebakeDistance: 0.001,
  pointShadowFacesPerFrame: 2,
  /*
   * Twelve, which is `LIVE_POINT_SHADOW_MAPS` cubemaps of six faces: exactly what the live
   * loop took before it had a budget at all, so no existing consumer's shadows arrive at a
   * different moment.
   *
   * **Six would have been the wrong default and looked like the right one.** The budget is
   * shared across every live map rather than granted to each, so at six the first map takes
   * the whole cubemap and the second — the one that exists only during an ownership handoff —
   * gets nothing and never bakes. That is a mover's shadow vanishing exactly while a character
   * crosses between two lamps, which is the moment the handoff exists to smooth over.
   */
  liveShadowFacesPerFrame: 12,
  water: true,
  screenEffects: true,
  sceneSamples: 1,
  planarReflections: false,
  hdrScene: false,
  cameraMotionBlur: 0,
  temporalAa: false,
  orderIndependent: false,
  depthOfField: 0,
  reconstruction: 0,
  indirectLight: false,
  occlusionCulling: 0,
  ambientOcclusion: 0,
  nightEmissive: false,
  bloom: 0,
  /* Brighter than white, which is where a source of light sits and a reflecting surface does
     not. Only consulted once the strength above is non-zero, and positive for the same reason
     the occlusion radius is: a zero left sitting here would look legal and bloom the whole
     frame the moment somebody turned the effect on. */
  bloomThreshold: 1,
  /* Off: a probe only exists once a caller bakes one, so nothing changes by default. */
  reflectionProbeSize: 0,
  /* On, because the cost of the feature is the probe and this only says whether one is allowed:
     with the size at its own default of zero, leaving this true changes nothing at all. */
  environmentReflections: true,
  /* The medium tier. Powers of two only; see PREFILTER_SAMPLE_COUNTS for why. */
  environmentPrefilterSamples: PREFILTER_SAMPLE_COUNTS.medium,
  /* Off: the shipped look is the box chain. See the field for why the default is this way round. */
  environmentPrefilter: false,
  /* Half a metre, which is the scale of the gaps in a room and around a vehicle. Only
     consulted when the strength above is non-zero, so it changes nothing by default. */
  ambientOcclusionRadius: 0.5,
  /* Off, so the medium costs nothing until a consumer asks for it. See the field. */
  globalMediumSteps: 0,
  /* Half, which is the resolution the upsample was designed against. */
  globalMediumHalfResolution: true,
  waterResolution: 128,
  waterReflections: true,
  /*
   * Full, and deliberately not the half the GPU-budget design proposed as a free win.
   *
   * It is not free. The reflection is a second full submission of the scene, but with the
   * GPU timer finally armed it measures **0.50 ms of an 18.00 ms frame** — the same 3%
   * category the 72% shadow claim collapsed into. Trading a visibly softer reflection on
   * every machine for 3% none of them needed is not a win, and it is worse than that in
   * one place: this is construction-time, so a clip export cannot ask for full scale back,
   * and an export is the one frame somebody keeps.
   *
   * The devices that genuinely cannot afford the target get it halved by the capability
   * clamp in `renderer.ts` instead, where the cost is paid by the parts that need it paid.
   */
  waterReflectionScale: 1,
  waterReflectionFilterTaps: MAX_WATER_REFLECTION_FILTER_TAPS,
  underwaterAtmosphere: true,
  plumeNoiseOctaves: 3,
  capabilityClamp: true,
  /*
   * **Both back ON in 1.1.2, because the black screen they were turned off for was not them.**
   *
   * These are the only two changes in this engine whose correctness an immediate-mode desktop
   * GPU physically cannot express: a discarded attachment costs nothing and changes nothing
   * where the samples have nowhere else to be, and taking the swap chain late is
   * indistinguishable from taking it early until a browser disagrees about when a frame is
   * presented. So when all three consumers came back completely black on an iPhone 16 Pro,
   * these two were the obvious suspects and both were defaulted off.
   *
   * They were not the cause and turning them off never lifted the black screen. It was a
   * uniform array striding by four bytes where WGSL requires sixteen, which WebKit enforces
   * and Dawn does not, so every shader that draws geometry failed to compile on iOS and
   * nowhere else. Fixed in 1.1.1; the iOS black-screen investigation is
   * the investigation, and the retreat here is the clearest thing it cost.
   *
   * **What leaving them off costs, measured on the gilded chamber at a phone viewport with
   * `npm run frame-audit`:** 75.6 MB a frame against 49.7, which is 4.43 GB/s against 2.91 at
   * 60 fps, and thirteen passes against twelve. Nearly all of it is the deferral — off it is
   * 51.2 MB on its own, because opening the frame's pass eagerly forces a load and a store of
   * the attachment for every mirror. The discard adds the last 1.5 MB and takes the frame's
   * unreadable writes to zero. That is the entire mobile bandwidth result of 1.1.0, and it was
   * being paid on exactly the devices it was measured for.
   *
   * **Still unverified on a tiler, and that has not changed.** What changed is that there is no
   * longer an observed failure to attribute to them. `?discard=0` and `?defer=0` turn them off
   * one at a time in all three consumers, so a device that misbehaves still names its own cause
   * in two reloads.
   */
  discardResolvedAttachments: true,
  deferFramePass: true,
  frameGraph: true,
  identifierGraph: false,
  clusteredLights: false,
  cullDraws: false,
  /*
   * The profiler stays off, and for its own reason rather than that one: it attaches a
   * timestamp block to every render pass in the frame, which is a cost nobody who did not ask
   * for a measurement should pay. `?gputiming=1` arms it.
   */
  gpuTiming: false,
});

/** Resolve and validate once at renderer construction, never in a hot path. */
/** The narrowest and widest ratio a reconstruction runs at; outside them a caller means the end. */
export const RECONSTRUCTION_RANGE = { least: 1.3, most: 2 } as const;

/**
 * Off, or a ratio inside the range.
 *
 * Anything that is not a positive number is off, which covers the default, a negative, and a
 * `NaN` arriving from a query string somebody spelled wrong — none of those can mean "a little
 * reconstruction", and a renderer that guessed one would be drawing at a size nobody asked for.
 */
function resolveReconstruction(asked: number | undefined): number {
  const value = asked ?? DEFAULT_RENDER_QUALITY.reconstruction;
  if (!(value > 0)) return 0;
  return Math.min(RECONSTRUCTION_RANGE.most, Math.max(RECONSTRUCTION_RANGE.least, value));
}

export function resolveRenderQuality(options: RenderQualityOptions = {}): Readonly<RenderQuality> {
  const quality: RenderQuality = {
    outputTransform: options.outputTransform ?? DEFAULT_RENDER_QUALITY.outputTransform,
    outputExposure: options.outputExposure ?? DEFAULT_RENDER_QUALITY.outputExposure,
    pointLightFalloff: options.pointLightFalloff ?? DEFAULT_RENDER_QUALITY.pointLightFalloff,
    maxDevicePixelRatio: options.maxDevicePixelRatio ?? DEFAULT_RENDER_QUALITY.maxDevicePixelRatio,
    maxDrawingBufferPixels:
      options.maxDrawingBufferPixels ?? DEFAULT_RENDER_QUALITY.maxDrawingBufferPixels,
    directionalShadows: options.directionalShadows ?? DEFAULT_RENDER_QUALITY.directionalShadows,
    pointShadows: options.pointShadows ?? DEFAULT_RENDER_QUALITY.pointShadows,
    /* Whole slots, at least one, never above what the shader is written for: these two are
       interpolated into the source as array sizes, so a fractional or zero one is a shader that
       does not compile and a larger one is arrays the uploads never fill. */
    maxLights: Math.min(
      MAX_POINT_LIGHTS,
      Math.max(1, Math.round(options.maxLights ?? DEFAULT_RENDER_QUALITY.maxLights)),
    ),
    maxAreaLights: Math.min(
      MAX_AREA_LIGHTS,
      Math.max(1, Math.round(options.maxAreaLights ?? DEFAULT_RENDER_QUALITY.maxAreaLights)),
    ),
    directionalShadowMapSize:
      options.directionalShadowMapSize ?? DEFAULT_RENDER_QUALITY.directionalShadowMapSize,
    pointShadowFaceSize: options.pointShadowFaceSize ?? DEFAULT_RENDER_QUALITY.pointShadowFaceSize,
    shadowFilterTaps: options.shadowFilterTaps ?? DEFAULT_RENDER_QUALITY.shadowFilterTaps,
    lightVolumeSamples: options.lightVolumeSamples ?? DEFAULT_RENDER_QUALITY.lightVolumeSamples,
    directionalShadowDepthLayers:
      options.directionalShadowDepthLayers ?? DEFAULT_RENDER_QUALITY.directionalShadowDepthLayers,
    directionalShadowMaxDistance:
      options.directionalShadowMaxDistance ?? DEFAULT_RENDER_QUALITY.directionalShadowMaxDistance,
    directionalShadowMaxSlope:
      options.directionalShadowMaxSlope ?? DEFAULT_RENDER_QUALITY.directionalShadowMaxSlope,
    pointShadowRebakeDistance:
      options.pointShadowRebakeDistance ?? DEFAULT_RENDER_QUALITY.pointShadowRebakeDistance,
    pointShadowFacesPerFrame:
      options.pointShadowFacesPerFrame ?? DEFAULT_RENDER_QUALITY.pointShadowFacesPerFrame,
    liveShadowFacesPerFrame:
      options.liveShadowFacesPerFrame ?? DEFAULT_RENDER_QUALITY.liveShadowFacesPerFrame,
    water: options.water ?? DEFAULT_RENDER_QUALITY.water,
    screenEffects: options.screenEffects ?? DEFAULT_RENDER_QUALITY.screenEffects,
    sceneSamples: Math.max(
      1,
      Math.round(options.sceneSamples ?? DEFAULT_RENDER_QUALITY.sceneSamples),
    ),
    planarReflections: options.planarReflections ?? DEFAULT_RENDER_QUALITY.planarReflections,
    hdrScene: options.hdrScene ?? DEFAULT_RENDER_QUALITY.hdrScene,
    cameraMotionBlur: Math.min(
      1,
      Math.max(0, options.cameraMotionBlur ?? DEFAULT_RENDER_QUALITY.cameraMotionBlur),
    ),
    temporalAa: options.temporalAa ?? DEFAULT_RENDER_QUALITY.temporalAa,
    orderIndependent: options.orderIndependent ?? DEFAULT_RENDER_QUALITY.orderIndependent,
    /* Off, or a ratio at least 1.3 and at most 2 — never a number between zero and the range. */
    reconstruction: resolveReconstruction(options.reconstruction),
    indirectLight: options.indirectLight ?? DEFAULT_RENDER_QUALITY.indirectLight,
    depthOfField: Math.min(
      1,
      Math.max(0, options.depthOfField ?? DEFAULT_RENDER_QUALITY.depthOfField),
    ),
    occlusionCulling: Math.max(
      0,
      Math.round(options.occlusionCulling ?? DEFAULT_RENDER_QUALITY.occlusionCulling),
    ),
    ambientOcclusion: Math.min(
      1,
      Math.max(0, options.ambientOcclusion ?? DEFAULT_RENDER_QUALITY.ambientOcclusion),
    ),
    nightEmissive: options.nightEmissive ?? DEFAULT_RENDER_QUALITY.nightEmissive,
    bloom: Math.min(1, Math.max(0, options.bloom ?? DEFAULT_RENDER_QUALITY.bloom)),
    bloomThreshold: options.bloomThreshold ?? DEFAULT_RENDER_QUALITY.bloomThreshold,
    reflectionProbeSize: Math.max(
      0,
      Math.round(options.reflectionProbeSize ?? DEFAULT_RENDER_QUALITY.reflectionProbeSize),
    ),
    environmentReflections:
      options.environmentReflections ?? DEFAULT_RENDER_QUALITY.environmentReflections,
    /* At least one sample: zero would divide by an accumulated weight of zero and answer NaN,
       which a half-float target spreads across every rough level rather than reporting. */
    environmentPrefilterSamples: Math.max(
      1,
      Math.round(
        options.environmentPrefilterSamples ?? DEFAULT_RENDER_QUALITY.environmentPrefilterSamples,
      ),
    ),
    environmentPrefilter:
      options.environmentPrefilter ?? DEFAULT_RENDER_QUALITY.environmentPrefilter,
    ambientOcclusionRadius:
      options.ambientOcclusionRadius ?? DEFAULT_RENDER_QUALITY.ambientOcclusionRadius,
    /* Whole steps, and never past the shader's own loop bound: a uniform above it would make the
       clamp inside the shader disagree with the step length computed from it, which is a march
       that stops short of where it divided its distance. */
    globalMediumSteps: Math.min(
      MAX_GLOBAL_MEDIUM_STEPS,
      Math.max(
        0,
        Math.round(options.globalMediumSteps ?? DEFAULT_RENDER_QUALITY.globalMediumSteps),
      ),
    ),
    globalMediumHalfResolution:
      options.globalMediumHalfResolution ?? DEFAULT_RENDER_QUALITY.globalMediumHalfResolution,
    waterResolution: options.waterResolution ?? DEFAULT_RENDER_QUALITY.waterResolution,
    waterReflections: options.waterReflections ?? DEFAULT_RENDER_QUALITY.waterReflections,
    waterReflectionScale:
      options.waterReflectionScale ?? DEFAULT_RENDER_QUALITY.waterReflectionScale,
    capabilityClamp: options.capabilityClamp ?? DEFAULT_RENDER_QUALITY.capabilityClamp,
    gpuTiming: options.gpuTiming ?? DEFAULT_RENDER_QUALITY.gpuTiming,
    discardResolvedAttachments:
      options.discardResolvedAttachments ?? DEFAULT_RENDER_QUALITY.discardResolvedAttachments,
    deferFramePass: options.deferFramePass ?? DEFAULT_RENDER_QUALITY.deferFramePass,
    frameGraph: options.frameGraph ?? DEFAULT_RENDER_QUALITY.frameGraph,
    identifierGraph: options.identifierGraph ?? DEFAULT_RENDER_QUALITY.identifierGraph,
    clusteredLights: options.clusteredLights ?? DEFAULT_RENDER_QUALITY.clusteredLights,
    cullDraws: options.cullDraws ?? DEFAULT_RENDER_QUALITY.cullDraws,
    waterReflectionFilterTaps:
      options.waterReflectionFilterTaps ?? DEFAULT_RENDER_QUALITY.waterReflectionFilterTaps,
    underwaterAtmosphere:
      options.underwaterAtmosphere ?? DEFAULT_RENDER_QUALITY.underwaterAtmosphere,
    plumeNoiseOctaves: options.plumeNoiseOctaves ?? DEFAULT_RENDER_QUALITY.plumeNoiseOctaves,
  };

  positive('maxDevicePixelRatio', quality.maxDevicePixelRatio);
  // Zero is legal and means uncapped, so this is the non-negative check rather than
  // the positive one.
  nonNegative('maxDrawingBufferPixels', quality.maxDrawingBufferPixels);
  positiveInteger('directionalShadowMapSize', quality.directionalShadowMapSize);
  positiveInteger('pointShadowFaceSize', quality.pointShadowFaceSize);
  positiveInteger('shadowFilterTaps', quality.shadowFilterTaps);
  positiveInteger('lightVolumeSamples', quality.lightVolumeSamples);
  positiveInteger('directionalShadowDepthLayers', quality.directionalShadowDepthLayers);
  positive('directionalShadowMaxDistance', quality.directionalShadowMaxDistance);
  positive('directionalShadowMaxSlope', quality.directionalShadowMaxSlope);
  nonNegative('pointShadowRebakeDistance', quality.pointShadowRebakeDistance);
  positiveInteger('pointShadowFacesPerFrame', quality.pointShadowFacesPerFrame);
  positiveInteger('liveShadowFacesPerFrame', quality.liveShadowFacesPerFrame);
  positiveInteger('waterResolution', quality.waterResolution);
  positive('waterReflectionScale', quality.waterReflectionScale);
  positiveInteger('waterReflectionFilterTaps', quality.waterReflectionFilterTaps);
  positiveInteger('plumeNoiseOctaves', quality.plumeNoiseOctaves);
  /* A radius of zero would ask every tap to land on the pixel it started from, which is not
     "no occlusion" — it is a division by nothing in the estimator. Off is the strength. */
  positive('ambientOcclusionRadius', quality.ambientOcclusionRadius);
  /* Same shape as the radius above: a threshold of zero is not "bloom everything a little",
     it is every pixel in the frame contributing its whole self. Off is the strength. */
  positive('bloomThreshold', quality.bloomThreshold);
  if (
    quality.shadowFilterTaps !== 4 &&
    quality.shadowFilterTaps !== 8 &&
    quality.shadowFilterTaps !== MAX_SHADOW_FILTER_TAPS
  ) {
    throw new Error(
      `RenderQuality.shadowFilterTaps must be 4, 8 or ${MAX_SHADOW_FILTER_TAPS}, got ${quality.shadowFilterTaps}`,
    );
  }
  if (quality.directionalShadowDepthLayers !== 1 && quality.directionalShadowDepthLayers !== 2) {
    throw new Error(
      `RenderQuality.directionalShadowDepthLayers must be 1 or 2, got ${quality.directionalShadowDepthLayers}`,
    );
  }
  if (quality.plumeNoiseOctaves > 3) {
    throw new Error(
      `RenderQuality.plumeNoiseOctaves must be <= 3, got ${quality.plumeNoiseOctaves}`,
    );
  }
  if (
    quality.waterReflectionFilterTaps !== 1 &&
    quality.waterReflectionFilterTaps !== 5 &&
    quality.waterReflectionFilterTaps !== MAX_WATER_REFLECTION_FILTER_TAPS
  ) {
    throw new Error(
      `RenderQuality.waterReflectionFilterTaps must be 1, 5 or ${MAX_WATER_REFLECTION_FILTER_TAPS}, got ${quality.waterReflectionFilterTaps}`,
    );
  }
  return Object.freeze(quality);
}

function positive(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`RenderQuality.${name} must be a positive finite number, got ${value}`);
  }
}

/** Zero is meaningful for a tolerance: it asks for the exact comparison. */
function nonNegative(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`RenderQuality.${name} must be a non-negative finite number, got ${value}`);
  }
}

function positiveInteger(name: string, value: number): void {
  positive(name, value);
  if (!Number.isInteger(value)) {
    throw new Error(`RenderQuality.${name} must be an integer, got ${value}`);
  }
}
