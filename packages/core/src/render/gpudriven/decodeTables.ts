/** Every material's decode programs, flattened into what the shading pass binds. */

import {
  DECODE_ADDRESS_MODES,
  DECODE_CONSTANT_CAPACITY,
  DECODE_FBM_OCTAVES,
  DECODE_NETWORK_CAPACITY,
  DECODE_NETWORK_HIDDEN_LAYERS,
  DECODE_NETWORK_INPUTS,
  DECODE_NETWORK_OUTPUTS,
  DECODE_NETWORK_WIDTH,
  DECODE_NODE_CAPACITY,
  DECODE_NODES_BYTES,
  DECODE_OPS,
  DECODE_PROGRAM_CAPACITY,
  DECODE_REGISTERS,
  DECODE_WEIGHT_BLOCKS,
  DECODE_WEIGHTS_BYTES,
} from '../shaders/gpudriven/decode.wgsl.ts';

/**
 * **A program is `DecodeResources` with bytes rather than floats**, because bytes are what the
 * device array holds. The types are structural: core does not import `@driftengine/texture`, and
 * what `encodeMaterial` returns satisfies `programFromEncoded` as it stands.
 *
 * **Every slot a graph names is program-local and is rewritten here to a global one** — a layer, a
 * network, a constant — so the interpreter needs no per-program indirection table. The graph a
 * caller handed in is not modified; the rewritten copy lives only in the table.
 */

export interface GpuDrivenLatent {
  readonly width: number;
  readonly height: number;
  /** One to four. The lanes past them read zero, and alpha reads one, as `decodeCpu` does. */
  readonly components: number;
  /** Level 0 first, each half the last, down to one texel. `components` bytes a texel. */
  readonly levels: readonly Uint8Array[];
}

export interface GpuDrivenNetwork {
  readonly shape: {
    readonly inputs: number;
    readonly hidden: readonly number[];
    readonly outputs: number;
  };
  readonly weights: Float32Array;
}

export interface GpuDrivenProgram {
  readonly graph: {
    readonly nodes: Uint32Array;
    readonly count: number;
    readonly result: number;
    readonly addressMode: number;
  };
  readonly latents: readonly GpuDrivenLatent[];
  readonly blocks?: readonly GpuDrivenLatent[];
  readonly networks: readonly GpuDrivenNetwork[];
  /** Four floats a slot, for `CONSTANT`. */
  readonly constants?: Float32Array;
}

export interface DecodeTables {
  readonly nodes: Uint32Array;
  readonly weights: Float32Array;
  /** One array a mip level: every layer's RGBA bytes, layer after layer. */
  readonly levels: readonly Uint8Array[];
  /** At least one, because a texture array of no layers cannot be created. */
  readonly layerCount: number;
  /** Level 0's edge in texels. One when nothing is sampled. */
  readonly layerSize: number;
}

/** What `encodeMaterial` returns, as far as this needs it. */
export interface EncodedProgramShape {
  readonly latentWidth: number;
  readonly latentHeight: number;
  readonly components: number;
  readonly weights: Float32Array;
  readonly shape: GpuDrivenNetwork['shape'];
  readonly graph: GpuDrivenProgram['graph'];
  /** Level 0 first — `encodeMaterial` puts the latent itself there. */
  readonly mips: readonly { readonly data: Uint8Array }[];
}

export function programFromEncoded(encoded: EncodedProgramShape): GpuDrivenProgram {
  return {
    graph: encoded.graph,
    latents: [
      {
        width: encoded.latentWidth,
        height: encoded.latentHeight,
        components: encoded.components,
        levels: encoded.mips.map((level) => level.data),
      },
    ],
    networks: [{ shape: encoded.shape, weights: encoded.weights }],
  };
}

const NETWORK_AT = DECODE_PROGRAM_CAPACITY * 4;
const NODE_AT = NETWORK_AT + DECODE_NETWORK_CAPACITY * 8;
const CONSTANT_AT = DECODE_WEIGHT_BLOCKS * 4;

/** Whether an operation's `a` and `b` name registers. `decodeGraph.ts`'s `OP_ARGS`, again. */
const REGISTER_ARGS: Readonly<Record<number, readonly [boolean, boolean]>> = {
  [DECODE_OPS.SAMPLE_LATENT]: [false, false],
  [DECODE_OPS.EVAL_NETWORK]: [true, false],
  [DECODE_OPS.SAMPLE_BLOCK]: [false, false],
  [DECODE_OPS.PROCEDURAL_FBM]: [false, false],
  [DECODE_OPS.FLIPBOOK_INDEX]: [false, false],
  [DECODE_OPS.LATENT_LERP]: [true, true],
  [DECODE_OPS.REMAP_CHANNEL]: [true, false],
  [DECODE_OPS.COMPOSITE]: [true, true],
  [DECODE_OPS.CONSTANT]: [false, false],
};

function refuse(message: string): never {
  throw new Error(`[driftengine] ${message}`);
}

/** `networkWeightCount`, again, for the same reason `REGISTER_ARGS` is. */
function weightCount(shape: GpuDrivenNetwork['shape']): number {
  let total = 0;
  let previous = shape.inputs;
  for (const width of shape.hidden) {
    total += previous * width + width;
    previous = width;
  }
  return total + previous * shape.outputs + shape.outputs;
}

export function packDecodeTables(programs: readonly GpuDrivenProgram[]): DecodeTables {
  if (programs.length > DECODE_PROGRAM_CAPACITY) {
    refuse(`${programs.length} programs, past the ${DECODE_PROGRAM_CAPACITY} the table holds`);
  }
  const nodes = new Uint32Array(DECODE_NODES_BYTES / 4);
  const weights = new Float32Array(DECODE_WEIGHTS_BYTES / 4);

  const first = programs.flatMap((p) => [...p.latents, ...(p.blocks ?? [])])[0];
  const layerSize = first?.width ?? 1;
  if (!(layerSize > 0 && (layerSize & (layerSize - 1)) === 0)) {
    refuse(`a latent is ${layerSize} texels across, and a layer's edge has to be a power of two`);
  }
  const levelCount = Math.log2(layerSize) + 1;
  const chunks: Uint8Array[][] = Array.from({ length: levelCount }, () => []);

  let layers = 0;
  let networkCount = 0;
  let nodeCount = 0;
  let weightAt = 0;
  let constantCount = 0;

  const addLatent = (latent: GpuDrivenLatent): number => {
    if (latent.width !== layerSize || latent.height !== layerSize) {
      refuse(
        `a latent is ${latent.width} by ${latent.height}, and every latent in one pass is ` +
          `${layerSize} by ${layerSize}`,
      );
    }
    if (latent.components < 1 || latent.components > 4) {
      refuse(`a latent has ${latent.components} components, not one to four`);
    }
    if (latent.levels.length !== levelCount) {
      refuse(
        `a latent carries ${latent.levels.length} level${latent.levels.length === 1 ? '' : 's'}, ` +
          `and a ${layerSize}-texel layer has ${levelCount}`,
      );
    }
    for (let level = 0; level < levelCount; level += 1) {
      const edge = Math.max(1, layerSize >> level);
      const source = latent.levels[level] as Uint8Array;
      if (source.length !== edge * edge * latent.components) {
        refuse(
          `level ${level} of a latent holds ${source.length} bytes, not ${edge * edge * latent.components}`,
        );
      }
      const rgba = new Uint8Array(edge * edge * 4);
      for (let texel = 0; texel < edge * edge; texel += 1) {
        for (let c = 0; c < 4; c += 1) {
          rgba[texel * 4 + c] =
            c < latent.components
              ? (source[texel * latent.components + c] as number)
              : c === 3
                ? 255
                : 0;
        }
      }
      (chunks[level] as Uint8Array[]).push(rgba);
    }
    layers += 1;
    return layers - 1;
  };

  programs.forEach((program, p) => {
    const graph = program.graph;
    if (graph.addressMode >= DECODE_ADDRESS_MODES) {
      refuse(
        `program ${p} asks for address mode ${graph.addressMode}; the interpreter knows 0 to ${DECODE_ADDRESS_MODES - 1}`,
      );
    }
    if (graph.result >= DECODE_REGISTERS) {
      refuse(`program ${p} returns register ${graph.result}, past the ${DECODE_REGISTERS} it has`);
    }
    const latentLayer = program.latents.map(addLatent);
    const blockLayer = (program.blocks ?? []).map(addLatent);

    const networkIndex = program.networks.map((network) => {
      const { shape } = network;
      if (shape.inputs < 1 || shape.inputs > DECODE_NETWORK_INPUTS) {
        refuse(`a network takes ${shape.inputs} inputs; a register holds ${DECODE_NETWORK_INPUTS}`);
      }
      if (shape.outputs < 1 || shape.outputs > DECODE_NETWORK_OUTPUTS) {
        refuse(
          `a network gives ${shape.outputs} outputs; a register holds ${DECODE_NETWORK_OUTPUTS}`,
        );
      }
      if (shape.hidden.length > DECODE_NETWORK_HIDDEN_LAYERS) {
        refuse(
          `a network has ${shape.hidden.length} hidden layers, past ${DECODE_NETWORK_HIDDEN_LAYERS}`,
        );
      }
      for (const width of shape.hidden) {
        if (width < 1 || width > DECODE_NETWORK_WIDTH) {
          refuse(`a hidden layer is ${width} wide, past ${DECODE_NETWORK_WIDTH}`);
        }
      }
      if (network.weights.length !== weightCount(shape)) {
        refuse(
          `a network carries ${network.weights.length} weights and its shape needs ${weightCount(shape)}`,
        );
      }
      if (networkCount >= DECODE_NETWORK_CAPACITY) {
        refuse(`more than ${DECODE_NETWORK_CAPACITY} networks`);
      }
      if (weightAt + network.weights.length > DECODE_WEIGHT_BLOCKS * 4) {
        refuse(
          `the networks need more than the ${DECODE_WEIGHT_BLOCKS * 4} weights a ` +
            `${DECODE_WEIGHTS_BYTES}-byte uniform holds`,
        );
      }
      const at = NETWORK_AT + networkCount * 8;
      nodes[at] = weightAt;
      nodes[at + 1] = shape.inputs;
      nodes[at + 2] = shape.outputs;
      nodes[at + 3] = shape.hidden.length;
      shape.hidden.forEach((width, k) => {
        nodes[at + 4 + k] = width;
      });
      weights.set(network.weights, weightAt);
      weightAt += network.weights.length;
      networkCount += 1;
      return networkCount - 1;
    });

    const constants = program.constants ?? new Float32Array(0);
    const constantIndex: number[] = [];
    for (let k = 0; k * 4 < constants.length; k += 1) {
      if (constantCount >= DECODE_CONSTANT_CAPACITY) {
        refuse(`more than ${DECODE_CONSTANT_CAPACITY} constants`);
      }
      for (let c = 0; c < 4; c += 1) {
        weights[CONSTANT_AT + constantCount * 4 + c] = constants[k * 4 + c] ?? 0;
      }
      constantIndex.push(constantCount);
      constantCount += 1;
    }

    if (nodeCount + graph.count > DECODE_NODE_CAPACITY) {
      refuse(`more than ${DECODE_NODE_CAPACITY} decode nodes`);
    }
    const header = p * 4;
    nodes[header] = nodeCount;
    nodes[header + 1] = graph.count;
    nodes[header + 2] = graph.result;
    nodes[header + 3] = graph.addressMode;

    for (let i = 0; i < graph.count; i += 1) {
      const op = graph.nodes[i * 4] as number;
      let a = graph.nodes[i * 4 + 1] as number;
      let b = graph.nodes[i * 4 + 2] as number;
      const dst = graph.nodes[i * 4 + 3] as number;
      const args = REGISTER_ARGS[op];
      if (args === undefined) {
        refuse(`program ${p} node ${i} has opcode ${op}, which the interpreter does not have`);
      }
      if (
        dst >= DECODE_REGISTERS ||
        (args[0] && a >= DECODE_REGISTERS) ||
        (args[1] && b >= DECODE_REGISTERS)
      ) {
        refuse(
          `program ${p} node ${i} names a register past ${DECODE_REGISTERS - 1}: ${a}, ${b}, ${dst}`,
        );
      }
      if (op === DECODE_OPS.SAMPLE_LATENT) {
        a =
          latentLayer[a] ??
          refuse(`program ${p} node ${i} samples latent ${a}, which it does not carry`);
      } else if (op === DECODE_OPS.SAMPLE_BLOCK) {
        a =
          blockLayer[a] ??
          refuse(`program ${p} node ${i} samples block ${a}, which it does not carry`);
      } else if (op === DECODE_OPS.EVAL_NETWORK) {
        b =
          networkIndex[b] ??
          refuse(`program ${p} node ${i} runs network ${b}, which it does not carry`);
      } else if (op === DECODE_OPS.CONSTANT) {
        a =
          constantIndex[a] ??
          refuse(`program ${p} node ${i} reads constant ${a}, which it does not carry`);
      } else if (op === DECODE_OPS.PROCEDURAL_FBM && b > DECODE_FBM_OCTAVES) {
        refuse(`program ${p} node ${i} asks for ${b} octaves, past ${DECODE_FBM_OCTAVES}`);
      }
      const at = NODE_AT + nodeCount * 4;
      nodes[at] = op;
      nodes[at + 1] = a;
      nodes[at + 2] = b;
      nodes[at + 3] = dst;
      nodeCount += 1;
    }
  });

  const layerCount = Math.max(1, layers);
  const levels = chunks.map((parts, level) => {
    const edge = Math.max(1, layerSize >> level);
    const bytes = new Uint8Array(layerCount * edge * edge * 4);
    parts.forEach((part, layer) => bytes.set(part, layer * edge * edge * 4));
    return bytes;
  });
  return { nodes, weights, levels, layerCount, layerSize };
}
