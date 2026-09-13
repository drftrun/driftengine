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
   * Pre-multiply a projection by this before uploading it. Identity on WebGL2.
   *
   * **The two APIs do not agree about which way clip space points, and the engine settles it in
   * the matrix rather than in the shaders** — see `CLIP_CORRECTION`, whose own comment gives the
   * reason: the shaders are generated from the GLSL the WebGL2 path uses, and a Y flip written
   * into them would be a difference no generator could keep honest. WebGPU's framebuffer origin
   * is the top-left and OpenGL's is the bottom-left, and depth clips to [0, 1] rather than
   * [-1, 1].
   *
   * A contributed pass takes its camera from its caller, so it never sees the corrected matrix the
   * renderer built for its own verbs. Without this it would have to copy four numbers — and a
   * copied convention is one that silently disagrees the day the original changes. The splat pass
   * drew the world upside down on WebGPU until this existed, which is the same first frame this
   * backend ever produced: a colonnade hanging from the ceiling.
   */
  readonly clipCorrection: Float32Array;
} & (
  | { readonly backend: 'webgl2'; readonly gl: WebGL2RenderingContext }
  | {
      readonly backend: 'webgpu';
      readonly device: GPUDevice;
      readonly format: GPUTextureFormat;
      readonly depthFormat: GPUTextureFormat;
      readonly samples: number;
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
  | { readonly backend: 'webgpu'; readonly pass: GPURenderPassEncoder }
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
  | { readonly backend: 'webgpu'; readonly encoder: GPUCommandEncoder };

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
