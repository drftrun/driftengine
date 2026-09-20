/**
 * A graph with each GELU folded into the multiply before it, where that is safe.
 *
 * **Safe means nothing else reads what the multiply wrote**: the fused kernel applies the GELU as
 * it writes, so the pre-activation value never reaches memory, and a second reader of it — or a
 * caller asking for it as an output — would read a buffer nobody filled. Where both hold, the
 * multiply takes the GELU's output name and an `activation` attribute, and the GELU goes: one
 * dispatch and one buffer fewer. A transformer's feed-forward block is exactly this shape, once per
 * layer.
 *
 * The attribute is the device's own and never crosses back: `@driftengine/texture`'s references
 * validate the graph before this runs, and nothing here is handed to them.
 */
import type { DeviceGraph, DeviceGraphNode } from './deviceGraph.ts';

export function fuseActivations(graph: DeviceGraph): DeviceGraph {
  const readers = new Map<string, number>();
  for (const node of graph.nodes) {
    for (const input of node.inputs) readers.set(input, (readers.get(input) ?? 0) + 1);
  }
  const outputs = new Set(graph.outputs);
  const producer = new Map<string, number>();
  graph.nodes.forEach((node, at) => producer.set(node.output, at));

  const folded = new Set<number>();
  const replaced = new Map<number, DeviceGraphNode>();
  graph.nodes.forEach((node, at) => {
    if (node.op !== 'gelu') return;
    const source = node.inputs[0] as string;
    const from = producer.get(source);
    if (from === undefined) return;
    const multiply = graph.nodes[from] as DeviceGraphNode;
    if (multiply.op !== 'linear' || readers.get(source) !== 1 || outputs.has(source)) return;
    replaced.set(from, {
      ...multiply,
      output: node.output,
      attributes: { ...multiply.attributes, activation: 'gelu' },
    });
    folded.add(at);
  });
  if (folded.size === 0) return graph;
  const nodes: DeviceGraphNode[] = [];
  graph.nodes.forEach((node, at) => {
    if (!folded.has(at)) nodes.push(replaced.get(at) ?? node);
  });
  return { ...graph, nodes };
}
