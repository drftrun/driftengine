/** How a capture runs a graph: the device's runner, or the reference evaluator. */
import type { NetworkGraph } from '@driftengine/texture';

export type GraphRun = (
  graph: NetworkGraph,
  inputs: ReadonlyMap<string, Float32Array>,
) => Promise<ReadonlyMap<string, Float32Array>>;
