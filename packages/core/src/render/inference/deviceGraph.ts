/**
 * A network graph as the device runs it: the structure `@driftengine/texture` validated, and the
 * shape of every value it inferred.
 *
 * **Structural rather than imported**, because `@driftengine/core` does not depend on
 * `@driftengine/texture` — texture peers on core, and the arrow cannot run both ways. A caller that
 * holds both validates with texture and hands the result here; `DTEX` and the world's distance
 * field cross the same boundary the same way. **The shapes are given, not inferred again**: a
 * second copy of every operator's shape rule is the copy that drifts.
 */

export type DeviceAttribute = number | string | boolean | readonly number[];

export interface DeviceGraphNode {
  readonly op: string;
  readonly inputs: readonly string[];
  readonly output: string;
  readonly attributes: Readonly<Record<string, DeviceAttribute>>;
}

export interface DeviceGraph {
  readonly inputs: readonly { readonly name: string; readonly shape: readonly number[] }[];
  readonly outputs: readonly string[];
  readonly nodes: readonly DeviceGraphNode[];
  readonly tensors: readonly {
    readonly name: string;
    readonly shape: readonly number[];
    readonly data: Float32Array;
  }[];
  /** Every value's shape — inputs, tensors and intermediates — as texture's evaluator inferred it. */
  readonly shapes: ReadonlyMap<string, readonly number[]>;
}

/** How many values a shape holds. */
export function shapeSize(shape: readonly number[]): number {
  let total = 1;
  for (const d of shape) total *= d;
  return total;
}
