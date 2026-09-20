import { createHandleRegistry, definitionAt, type HandleRegistry } from './handleRegistry.ts';

import type { FrameResource } from './frame/index.ts';

/**
 * A pass a package contributes, and the two contexts it is handed.
 *
 * **This is the one thing that makes a rendering package possible.** The renderer's verb surface
 * is fixed and nothing outside `render/` can add to it, so `@driftengine/splats`, `ui2d` and `xr`
 * had nowhere at all to put a draw call. `RENDERING.md` and the render graph design both name
 * that as the thing blocking the package architecture rather than any shortage of machinery.
 */

/**
 * What a registered pass is handed once, at registration, to build its resources.
 *
 * **Backend-specific on purpose.** A neutral device abstraction would be a second renderer API
 * and an enormous one, and it would buy nothing: a package drawing Gaussian splats has a
 * different shader, a different buffer layout and a different sort on each backend, so it
 * branches whatever this looks like. A union makes the branch explicit and typed instead of
 * hidden behind a lowest common denominator.
 *
 * `format` and `samples` ride along on the WebGPU side because a render pipeline cannot be built
 * without them and a package has no other way to learn what the frame is.
 *
 * **`depthFormat` rides along for the same reason, and was missing for the same length of time
 * nobody depth-tested through this seam (2026-08-25).** A pipeline that reads the depth buffer
 * cannot be built without it either, and the only contributed pass in the tree hard-coded
 * `depth24plus` with `depthCompare: 'always'` — invisible while a pass does not depth-test, and
 * wrong the first time one does. Splats are that first one: a Gaussian is composed *into* the
 * scene and has to be occluded by the geometry standing in front of it, which is a depth test
 * against the frame's own attachment.
 *
 * What it costs: one more field every backend must answer honestly, which is the 2026-08-13 rule
 * and not an accident. What would make it wrong: a frame with no depth attachment at all, which
 * this renderer does not have and which would want the field to be nullable rather than absent.
 */
export type PassDevice = {
  /**
   * Pre-multiply a projection by this **if your WGSL was generated from GLSL**. Identity on WebGL2.
   *
   * A contributed pass takes its camera from its caller, so it never sees the corrected matrix the
   * renderer built for its own verbs. Without this it would have to copy four numbers — and a
   * copied convention is one that silently disagrees the day the original changes. The splat pass
   * drew the world upside down on WebGPU until this existed, which is the same first frame this
   * backend ever produced: a colonnade hanging from the ceiling.
   *
   * **It does two things and only one of them is about the APIs.** Depth: OpenGL clips z to
   * [-1, 1] and WebGPU to [0, 1], so an uncorrected matrix throws away half the buffer. Y: it is
   * negated — and *not* because the framebuffer origins differ, which is what this comment used to
   * say. Both viewport transforms put clip `y = +1` at the top of the image. What flips it is
   * `naga`, which ends every generated vertex entry point with `gl_Position.y = -gl_Position.y`;
   * the negation here cancels that one. See `CLIP_CORRECTION` in `webgpu/renderer.ts`.
   *
   * So **a pass whose shader went through the engine's generator wants this one**, which is every
   * pass that has ever used it — `@driftengine/splats` writes GLSL and generates its WGSL — and a
   * pass that wrote WGSL by hand wants `depthCorrection` instead.
   */
  readonly clipCorrection: Float32Array;
  /**
   * Pre-multiply a projection by this **if you wrote your WGSL by hand**. Identity on WebGL2.
   *
   * The same matrix without the Y negation, because there is no generated negation to cancel.
   * Taking `clipCorrection` in a hand-written shader mirrors the picture vertically — and mirrors
   * the triangle winding with it, so it presents as a culling problem and is answered with
   * `frontFace: 'cw'`, which draws the correct faces of a mirrored world. That is exactly what
   * happened to the GPU-driven pipeline's raster, and the capture that settled it was the same
   * scene through `drawMesh`: an exact vertical mirror about the canvas centre.
   */
  readonly depthCorrection: Float32Array;
} & (
  | { readonly backend: 'webgl2'; readonly gl: WebGL2RenderingContext }
  | {
      readonly backend: 'webgpu';
      readonly device: GPUDevice;
      readonly format: GPUTextureFormat;
      readonly depthFormat: GPUTextureFormat;
      readonly samples: number;
      /**
       * Whether this renderer reconstructs its frames, which is fixed at construction as `samples`
       * is.
       *
       * **A pass drawing the world into a reconstructed frame owes it two things.** It draws with
       * the frame's jitter (`PrepareContext.jitter`), and it leaves its depth in the frame's
       * attachment: the resolve reprojects every pixel's history through that depth, and a pixel
       * still holding the clear reads as infinitely far away — so a turning camera's history is
       * moved correctly, since a turn moves every depth alike, and a sliding camera's is not moved
       * at all and trails the picture. A pass that decides at `init` whether to write depth
       * decides it by this.
       */
      readonly reconstruction: boolean;
    }
);

/**
 * What it is handed each frame, at the point the caller asked for it.
 *
 * On WebGL2 the framebuffer the frame is going into is already bound, so the context is the
 * whole of it. On WebGPU the encoder is the pass, and it is the frame's own or the mirror's
 * depending on where the caller invoked it — which is the caller's business and not this
 * object's.
 */
export type PassContext = {
  /**
   * The grade this frame wants, and whether it wants one at all.
   *
   * **A contributed pass is a forward pass, so the 2026-08-17 rule binds it too**: with a
   * composite the resolve grades and a pass that also graded would apply the curve twice; without
   * one, each pass is the last thing to touch the frame and each must grade itself. The renderer
   * decides which by whether it has a scene target, and that decision was private — so until this
   * field a package could only guess, and both guesses are wrong half the time.
   *
   * 0 is none, and is what a frame with a composite reports. `OUTPUT_TRANSFORM_GLSL` is exported
   * from the barrel so the pass applies the same curve rather than a copy of it.
   */
  readonly outputTransform: number;
  /** The exposure that goes with it. 1 where the composite will apply the real one. */
  readonly outputExposure: number;
} & (
  | { readonly backend: 'webgl2'; readonly gl: WebGL2RenderingContext }
  | {
      readonly backend: 'webgpu';
      readonly pass: GPURenderPassEncoder;
      /** The frame's jitter, the same array `PrepareContext.jitter` held. */
      readonly jitter: Float32Array;
    }
);

/**
 * What a pass is handed once a frame, before the frame's own target exists.
 *
 * **A sibling of `PassContext` rather than a widening of it**, because the two carry different
 * things and one of them cannot be nested inside the other. `draw` is invoked *inside* an open
 * render pass on WebGPU, and a render pass cannot contain another; so a pass that wants to render
 * into a target of its own needs a `GPUCommandEncoder` instead, and that is what this is.
 *
 * **The window it runs in already existed.** `beginFrame` creates the frame's command encoder and
 * then defers opening the frame's render pass until the first draw that wants one — which
 * `ensurePass` does for a measured reason about mirrors and tile memory. So there is a point at
 * which an encoder exists and no render pass is open, and commands recorded on one encoder execute
 * in recording order. A pass-owned target filled there has completed before any frame pass could
 * sample it, **with the graph learning nothing and nothing reordered**.
 *
 * **On WebGL2 the contract is a restore rather than an ordering.** There is no verb-level graph on
 * that backend and it was withdrawn on purpose, so there is nothing to schedule against. `prepare`
 * is called before the frame's target is bound, with the **default framebuffer bound**, and must
 * leave it bound. That is the same promise `draw` already makes about the program, the vertex
 * array, the blend and depth state and the viewport — one step stronger, because a framebuffer
 * left bound takes the whole frame with it rather than one draw. The asymmetry with WebGPU is real
 * and is not papered over: there the ordering is a property of the encoder, and here it is a
 * property of the caller's politeness.
 */
export type PrepareContext =
  | { readonly backend: 'webgl2'; readonly gl: WebGL2RenderingContext }
  | {
      readonly backend: 'webgpu';
      readonly encoder: GPUCommandEncoder;
      /**
       * The frame's environment probe, or null where the scene has not baked one.
       *
       * **The first thing this seam hands over that a pass could not render for itself**, and it
       * is here rather than on `PassDevice` because a probe is baked by a scene whenever it likes
       * — after registration, and again when the world changes — so a value captured once at
       * `init` would be null for the life of a pass that registered before the bake.
       *
       * It is offered rather than promised: a pass that wants to light what it draws by the room
       * the rest of the frame is lit by has no other way to reach it, and a pass that does not
       * care ignores the field. What it is *not* is an attachment of the frame — the rule that a
       * contributed pass renders its own targets is unchanged, and this is a resource the renderer
       * owns for the whole frame rather than one it is in the middle of writing.
       */
      readonly environment: PassEnvironment | null;
      /**
       * The world's composed distance field, or null where the frame composed none.
       *
       * **One frame behind, and that is what it is for.** The renderer composes at `endFrame`,
       * because a consumer declares its fields wherever in its own frame the objects live and the
       * set is not complete until the last verb. `prepare` runs at `beginFrame`, so what a pass is
       * handed here is the field the *previous* frame declared — which is right for everything
       * that reads a distance field, since a field is the shape of the world and the world does
       * not usually change between two frames.
       *
       * Offered rather than promised, as `environment` is: a pass that wants to march the world
       * the renderer's own indirect light marches has no other way to reach it, and one that does
       * not care ignores the field. It is null whenever `quality.indirectLight` is off, which is
       * the default, and whenever the frame declared nothing.
       */
      readonly distanceField: PassDistanceField | null;
      /**
       * The offset the renderer's own verbs are drawn with this frame, as a fraction of the clip
       * square — x rightward and y upward, the camera's own convention — and zero on a frame that
       * is not reconstructed. Two floats, the same array every frame.
       *
       * **A pass that draws the world applies it**, with `jitterClip`, to the camera matrix it was
       * given and before any correction. Reconstruction un-jitters every sample it takes, so
       * geometry drawn without the offset is placed up to half a render pixel from where it was,
       * differently every frame, and the picture shimmers and softens. Settled at `beginFrame`,
       * before this runs, and once a frame however many mesh passes the frame binds.
       *
       * What it gives up: the temporal resolve's jitter is not handed over. That resolve never
       * un-jitters, so a pass drawn without its offset is left unantialiased by it rather than
       * misplaced — a lesser fault, and one a pass can live with. A pass drawing into a mirror
       * should not apply it either; the renderer's own verbs do not jitter a mirror.
       */
      readonly jitter: Float32Array;
    };

/**
 * The world's distance field on the device, as the two buffers and four numbers that address it.
 *
 * **Cascades rather than one grid.** A single grid fine enough to resolve a doorway and large
 * enough to hold a street is not a thing that fits on a device; nested cascades each of the same
 * sample count, each reaching twice as far as the one inside it, spend their resolution where the
 * camera is. `gi/globalField.ts` composes them and `shaders/gi/sampleField.wgsl.ts` reads them,
 * and the layout below is what the two agree on.
 */
export interface PassDistanceField {
  /** Every cascade's samples, tightly packed, cascade 0 first. */
  readonly samples: GPUBuffer;
  /**
   * The colour of whatever surface won the union at each sample, three floats, same order.
   *
   * **A union loses which instance won**, and a ray that lands on a wall needs to know what colour
   * it is: what leaves a surface is the light arriving times its albedo, and a distance alone
   * cannot say. `GlobalFieldCascade.albedo` is the reference's own copy of this.
   */
  readonly albedo: GPUBuffer;
  /** Six bounds and a step per cascade, as `sampleField.wgsl.ts` reads them. */
  readonly cascades: GPUBuffer;
  /** How many cascades stand. */
  readonly levels: number;
  /** Samples along one side of every cascade. */
  readonly side: number;
  /** Metres between samples in the innermost cascade — the finest the field resolves. */
  readonly finestStep: number;
  /** The outermost cascade's corners, `[minX, minY, minZ, maxX, maxY, maxZ]`. */
  readonly outerBounds: Float32Array;
}

/**
 * A baked environment probe, as the two things that sample it and the four numbers that address it.
 *
 * **Octahedral rather than a cubemap**, which is the engine's own storage: one 2D array texture,
 * one layer a probe, a one-texel gutter at every level so a bilinear tap at the border reads the
 * folded direction rather than the other side of the map. `shaders/octahedral.ts` carries the
 * mapping in GLSL and in TypeScript, and `octInsetUv` is what turns a direction into a coordinate.
 *
 * **The chain is roughness, not size.** Level 0 is the mirror and `maxLod` is the roughest GGX
 * convolution; `irradianceLevel` sits one beyond it and holds the cosine convolution, which is the
 * diffuse half. `prefilterEnvMap.ts` derives all three from the edge and is the one place that
 * arithmetic lives.
 */
export interface PassEnvironment {
  /** The whole array, `2d-array`, as the lit pass binds it. */
  readonly view: GPUTextureView;
  readonly sampler: GPUSampler;
  /** Texels across level 0, gutter included. A level's own edge is this over `exp2(level)`. */
  readonly edge: number;
  /** The coarsest level of the GGX chain. */
  readonly maxLod: number;
  /** Which level holds the cosine convolution. */
  readonly irradianceLevel: number;
  /** Whether the scene asked this grid to supply its ambient. `ProbeBakeOptions.irradiance`. */
  readonly irradiance: boolean;
  /** How many probes stand in the grid. A pass reading layer 0 alone is right only for one. */
  readonly layers: number;
}

export interface PassDefinition {
  /** For diagnostics, and for the label a backend gives the work. */
  readonly label: string;
  /**
   * Attachments this pass samples.
   *
   * **Reads only, and that asymmetry is deliberate.** What a pass *writes* is wherever the
   * caller is drawing, and is not negotiable: every built-in verb writes the current target and
   * the executor replays a flush's nodes into one open pass, so a node declaring some other
   * write-set schedules as a separate pass that nothing opens. Letting a package name its writes
   * would hand it the single declaration nothing can enforce, whose failure mode is a scene
   * quietly losing draws.
   *
   * A read, by contrast, is exactly what the scheduler needs from outside: declare `mirrorColor`
   * and the frame stops deriving a discard for an attachment this pass is about to sample.
   */
  readonly reads?: readonly FrameResource[];
  /**
   * Fill a target the pass **owns**, once a frame, before anything opens the frame's own.
   *
   * **Shipped 2026-08-27, to the design this comment used to carry as a plan.** A package's own
   * shadow map, blur pyramid or picking buffer: rendered here, sampled from `draw`. What a pass
   * writes into the *frame* stays refused for the reason `reads` gives above, and a pass-owned
   * target is outside that set by construction, which is what makes this declarable when a write
   * to the frame is not. `createPassAttachment` builds one from the `PassDevice` this pass was
   * handed at `init`; the pass releases it in its own `dispose`.
   *
   * **Called at one fixed point, for every pass that declares it, in registration order** — which
   * must not become dependency ordering. Gate 1.2 withdrew that with a reason on record and this
   * does not reintroduce it: registration order is an order, not a dependency graph, and a pass
   * that needs another's output has to be registered after it and know that it does.
   *
   * **It costs nothing for a pass that does not declare it.** Both renderers keep a count of the
   * passes that do and skip the whole step at zero, rather than walking the registry every frame
   * to find out that nobody wants it.
   *
   * Allocates nothing, like `draw`. On WebGL2, leaves the default framebuffer bound — see
   * `PrepareContext`, which is where that contract is written out.
   */
  prepare?(ctx: PrepareContext): void;
  /** Build pipelines, buffers and textures. Called once, when the pass is registered. */
  init?(device: PassDevice): void;
  /**
   * Draw. Called once a frame, at the point the caller invoked `drawPass`.
   *
   * **Allocates nothing.** This is a per-frame hot path and the engine's own rule about them
   * binds a contributor exactly as it binds the renderer.
   *
   * **Leaves the context as it found it.** On WebGL2 that means the program, the bound vertex
   * array, the blend and depth state and the viewport; the renderer's own verbs assume what they
   * left. On WebGPU the pass encoder's pipeline and bind groups are set by every verb before it
   * draws, so only the viewport and the scissor persist and only those two matter.
   */
  draw(ctx: PassContext): void;
  /** Release what `init` built. Called on `unregisterPass` and when the renderer is disposed. */
  dispose?(device: PassDevice): void;
}

/**
 * A registered pass, as the caller holds it.
 *
 * A slot and a generation packed into one number rather than a bare index, so a handle kept past
 * `unregisterPass` answers nothing instead of answering to whoever took the slot next. A package
 * that was torn down and goes on drawing reads as a leak and is a use-after-free.
 */
export type PassHandle = number;

export { drainRegistry, registerIn, unregisterIn } from './handleRegistry.ts';

/** The pass registry: the generic slot table with the definition type filled in. */
export type PassRegistry = HandleRegistry<PassDefinition>;

export function createPassRegistry(): PassRegistry {
  return createHandleRegistry<PassDefinition>();
}

/** The pass a handle names, or `undefined` if it names one that has been released. */
export function passAt(registry: PassRegistry, handle: PassHandle): PassDefinition | undefined {
  return definitionAt(registry, handle);
}
