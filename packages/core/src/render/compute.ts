import { createHandleRegistry, definitionAt, type HandleRegistry } from './handleRegistry.ts';

/**
 * A compute definition a package contributes, and the two things it is handed.
 *
 * **This is `pass.ts` again, for the one stage that only one backend has.** A package that wants
 * a radix sort, a light binner or a skinning kernel has nowhere to put it: the renderer's verb
 * surface is fixed and nothing outside `render/` can add to it. `registerPass` answered that for
 * drawing; this answers it for the stage before drawing.
 */

/**
 * What a registered definition is handed once, at registration, to build its resources.
 *
 * **There is no WebGL2 arm, and that absence is the type saying so.** `PassDevice` is a union
 * because both backends can draw. WebGL2 has no compute shaders — not "not yet", the language has
 * none — so a second arm would be a shape a contributor could switch on and never reach.
 * `Renderer.computeSupported` answers `false` there and `registerCompute` refuses in words.
 *
 * Tagged all the same, so that a second arm arriving later is a compile error at every
 * contributor rather than a silent widening, and so this reads as the same shape as `PassDevice`
 * to somebody who has just read that one.
 */
export type ComputeDevice = { readonly backend: 'webgpu'; readonly device: GPUDevice };

/**
 * What it is handed at each dispatch.
 *
 * **The engine opens the pass and hands it over, rather than handing over the command encoder.**
 * A definition holding the encoder could open a compute pass while a render pass was open, which
 * WebGPU forbids and which reports itself at `submit` rather than at the call that caused it —
 * the failure shape the 2026-08-14 rule is about, where the result is no picture from a frame
 * that recorded correctly. Handing over the pass keeps that invariant in one place instead of in
 * every contributor.
 *
 * A definition that needs an encoder of its own for a readback still has one: it holds `device`
 * from `init`, and a `copyBufferToBuffer` submitted afterwards sees this dispatch's result,
 * because submission order is execution order.
 */
export type ComputeContext = { readonly backend: 'webgpu'; readonly pass: GPUComputePassEncoder };

export interface ComputeDefinition {
  /** For diagnostics, and for the label the backend gives the encoder and the pass. */
  readonly label: string;
  /** Build pipelines and buffers. Called once, when the definition is registered. */
  init?(device: ComputeDevice): void;
  /**
   * Set a pipeline, set bind groups, and call `dispatchWorkgroups`.
   *
   * **The workgroup count is yours and does not cross the surface**, exactly as a contributed
   * pass issues its own draw calls. The count comes from data the definition owns — a light
   * count, a cluster count — so a renderer-side `(x, y, z)` would be one fact in two places, and
   * the renderer's copy would be the one nobody updated.
   *
   * **Allocates nothing.** This is a per-frame path and the house rule about them binds a
   * contributor exactly as it binds the renderer.
   */
  dispatch(ctx: ComputeContext): void;
  /** Release what `init` built. Called on `unregisterCompute` and when the renderer is disposed. */
  dispose?(device: ComputeDevice): void;
}

/**
 * A registered definition, as the caller holds it.
 *
 * A slot and a generation packed into one number, for the reason `PassHandle` explains: a handle
 * kept past `unregisterCompute` answers nothing rather than answering to whoever took the slot.
 */
export type ComputeHandle = number;

export type ComputeRegistry = HandleRegistry<ComputeDefinition>;

export function createComputeRegistry(): ComputeRegistry {
  return createHandleRegistry<ComputeDefinition>();
}

/** The definition a handle names, or `undefined` if it names one that has been released. */
export function computeAt(
  registry: ComputeRegistry,
  handle: ComputeHandle,
): ComputeDefinition | undefined {
  return definitionAt(registry, handle);
}
