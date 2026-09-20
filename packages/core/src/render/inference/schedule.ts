/**
 * What a graph becomes before a device sees it: its dispatches, its buffers, and its weights.
 *
 * **Everything a runner decides is decided here, with no device**, so the decisions have tests and
 * the runner is a binder: GELUs folded into their multiplies, a buffer for every value from the
 * planner, one kernel per node generated at the shapes the node has, and the weights narrowed to
 * half precision when that was asked for. A dispatch binds its inputs' buffers in order and then
 * its output's, which is the binding order every kernel declares.
 *
 * **Half precision narrows the weights and nothing else.** A weight is stored as the nearest half
 * and widened as it is read; the values between nodes stay single precision, because they are what
 * a network's error accumulates through and a weight is read-only and read many times. What it
 * gives up is half the memory of the activations as well — the step to take if a model's
 * activations turn out to be what does not fit.
 */
import { shapeSize, type DeviceGraph } from './deviceGraph.ts';
import { fuseActivations } from './fuse.ts';
import { toHalfFloats } from '../halfFloat.ts';
import { DEVICE_KERNELS, type ElementType } from './kernels.ts';
import { planBuffers, type BufferPlan } from './plan.ts';

export interface ScheduledStep {
  /** The operator and the value it writes, which is what a device error names. */
  readonly label: string;
  readonly code: string;
  readonly workgroups: readonly [number, number, number];
  /** The buffers bound, in binding order: each input's, then the output's. */
  readonly slots: readonly number[];
}

export interface Schedule {
  readonly steps: readonly ScheduledStep[];
  readonly plan: BufferPlan;
  /** Each buffer's size in bytes, rounded up to the four a storage binding is sized in. */
  readonly bytes: readonly number[];
  /** The weights, each into its buffer once, as the precision asked for stores them. */
  readonly uploads: readonly { readonly slot: number; readonly data: Float32Array | Uint16Array }[];
}

export function scheduleGraph(graph: DeviceGraph, options: { readonly half: boolean }): Schedule {
  const missing = graph.nodes.filter((node) => !DEVICE_KERNELS.has(node.op));
  if (missing.length > 0) {
    const names = [...new Set(missing.map((node) => node.op))].join(', ');
    throw new Error(`the device has no kernel for ${names}; the graph cannot run here`);
  }
  const fused = fuseActivations(graph);
  const plan = planBuffers(fused);
  const narrow = new Set(options.half ? fused.tensors.map((tensor) => tensor.name) : []);
  const typeOf = (name: string): ElementType => (narrow.has(name) ? 'f16' : 'f32');
  const shapeOf = (name: string): readonly number[] => fused.shapes.get(name) ?? [];

  const bytes = plan.sizes.map((size) => Math.max(4, size * 4));
  for (const name of narrow) {
    const slot = plan.slotOf.get(name) as number;
    bytes[slot] = Math.max(4, Math.ceil((shapeSize(shapeOf(name)) * 2) / 4) * 4);
  }

  const steps = fused.nodes.map((node): ScheduledStep => {
    const generate = DEVICE_KERNELS.get(node.op);
    if (generate === undefined) throw new Error(`the device has no kernel for ${node.op}`);
    const kernel = generate({
      inputShapes: node.inputs.map(shapeOf),
      outputShape: shapeOf(node.output),
      attributes: node.attributes,
      inputTypes: node.inputs.map(typeOf),
    });
    return {
      label: `${node.op} ${node.output}`,
      code: kernel.code,
      workgroups: kernel.workgroups,
      slots: [...node.inputs, node.output].map((name) => plan.slotOf.get(name) as number),
    };
  });

  const uploads = fused.tensors.map((tensor) => ({
    slot: plan.slotOf.get(tensor.name) as number,
    data: narrow.has(tensor.name) ? toHalfFloats(tensor.data) : tensor.data,
  }));
  return { steps, plan, bytes, uploads };
}
