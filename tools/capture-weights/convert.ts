/**
 * A checkpoint made into a graph the runtime runs: verified before it is read, and read only as a
 * model's definition asks.
 *
 * **Nothing about the file is taken on trust.** Its SHA-256 is checked against the manifest's
 * before a byte of it is parsed, and then the definition — an `Architecture` from
 * `@driftengine/texture`, the same function the runtime rebuilds the graph with at every new size —
 * reads it by name through `graphFromWeights`, which refuses a weight the checkpoint lacks, one at
 * another shape, and one the checkpoint holds that the definition never reads. Tensors are decoded
 * to single precision only as the definition asks for them, so the heads it sets aside are never
 * decoded at all.
 *
 * `storedGraph` puts the result in the shape the `NGRF` chunk writes, at half precision or single.
 */
import { createHash } from 'node:crypto';

import type { DrftGraph } from '../../packages/drft/src/index.ts';
import {
  graphFromWeights,
  toHalfBits,
  type Architecture,
  type GraphTensor,
  type NetworkGraph,
  type WeightSource,
} from '../../packages/texture/src/index.ts';
import { tensorFloats } from './checkpoint.ts';
import { readPytorch } from './pytorch.ts';
import { readSafetensors } from './safetensors.ts';

export interface Pinned {
  readonly sha256: string;
  readonly format: 'safetensors' | 'pytorch';
}

/**
 * `beside` holds tensors that come with the checkpoint rather than in it — a tokenizer's merges —
 * read by the definition exactly as the checkpoint's are; one named in both is refused.
 */
export function convert(
  file: Uint8Array,
  architecture: Architecture,
  pinned: Pinned,
  beside: ReadonlyMap<string, GraphTensor> = new Map(),
): NetworkGraph {
  const hash = createHash('sha256').update(file).digest('hex');
  if (hash !== pinned.sha256) {
    throw new Error(
      `the file's SHA-256 is ${hash} and the manifest pins ${pinned.sha256}: it is not the ` +
        'checkpoint that was pinned, and none of it has been read',
    );
  }
  const stored = pinned.format === 'safetensors' ? readSafetensors(file) : readPytorch(file);
  for (const name of beside.keys()) {
    if (stored.has(name)) throw new Error(`"${name}" is in the checkpoint and beside it`);
  }
  const decoded = new Map<string, GraphTensor>(beside);
  const source: WeightSource = {
    get(name) {
      let tensor = decoded.get(name);
      if (tensor === undefined) {
        const held = stored.get(name);
        if (held === undefined) return undefined;
        tensor = { shape: held.shape, data: tensorFloats(name, held) };
        decoded.set(name, tensor);
      }
      return tensor;
    },
    names: () => [...stored.keys(), ...beside.keys()],
  };
  return graphFromWeights(source, architecture);
}

/* Half precision holds every whole number to 2,048 and not every one past it. */
const HALF_WHOLE = 2048;

/** A tensor of whole numbers, one of them past what half precision holds — token ids. */
function wholeBeyondHalf(data: Float32Array): boolean {
  return data.every(Number.isInteger) && data.some((value) => Math.abs(value) > HALF_WHOLE);
}

/**
 * A graph as the `NGRF` chunk stores it, every tensor at half precision or at single — its constants
 * too — **except a tensor of whole numbers half cannot hold**, a tokenizer's ids, which is kept
 * single whatever was asked: rounded, an id is another token. A table of the shapes is rebuilt in single precision whenever `@driftengine/capture` builds
 * the graph for a clip's size, which is how the graph is run, so what the file's copy costs is the
 * point: Depth Anything 3 Small's readout positions at 504² are 32 MB in single, and storing its
 * constants apart from its weights took the file from 71.1 MB to 92.2 for a graph run as stored
 * only by somebody choosing to. **What it gives up** is that run's constants at half precision —
 * inside what half-precision weights already cost it.
 */
export function storedGraph(
  graph: NetworkGraph,
  role: string,
  precision: 'half' | 'single',
): DrftGraph {
  return {
    role,
    inputs: graph.inputs,
    outputs: graph.outputs,
    nodes: graph.nodes,
    tensors: [...graph.tensors].map(([name, tensor]) => ({
      name,
      shape: tensor.shape,
      data:
        precision === 'half' && !wholeBeyondHalf(tensor.data)
          ? Uint16Array.from(tensor.data, toHalfBits)
          : tensor.data,
    })),
  };
}
