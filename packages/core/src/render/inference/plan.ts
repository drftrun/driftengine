/**
 * Which device buffer each value of a graph lives in, reusing a buffer once nothing will read it.
 *
 * **The rule is `@driftengine/texture`'s `planReuse`**, which the reference evaluator plans by too:
 * one decision, so a buffer freed too early cannot mean one thing here and another there. This says
 * what a device holds for the life of a runner — every input, every output and every weight — and
 * measures a buffer in values.
 */
import { planReuse, type BufferReuse } from './reuse.ts';

import { shapeSize, type DeviceGraph } from './deviceGraph.ts';

/** The buffer each value lives in, and each buffer's size in values. */
export type BufferPlan = BufferReuse;

export function planBuffers(graph: DeviceGraph): BufferPlan {
  return planReuse(
    {
      nodes: graph.nodes,
      /* An input is written before every run and a weight uploaded once: both keep a buffer. */
      held: [...graph.inputs.map((input) => input.name), ...graph.tensors.map((t) => t.name)],
      outputs: graph.outputs,
    },
    (name) => shapeSize(graph.shapes.get(name) ?? []),
  );
}
