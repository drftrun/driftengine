/**
 * A material graph, as the decode program a baked texture already carries.
 *
 * **The target is `DecodeGraph` and not a shader.** That is the insight the whole wave rests on:
 * Wave 2B already defined a texture as a small interpreted program, so a graph-authored material
 * and a baked one are indistinguishable downstream — and the graph editor is therefore also a
 * debugger for baked materials, which is a second product for no extra code.
 *
 * **A node the decode vocabulary cannot express fails by name.** Emitting a shader for it would
 * make the graph's output a different kind of thing depending on which nodes were in it, and would
 * reintroduce the permutation cost the texture design exists to avoid.
 *
 * **Registers are assigned in topological order and freed never.** The budget is sixteen, which is
 * a real limit a real graph can reach — so `validateDecodeGraph` is run on the way out and its
 * complaint is passed through rather than reworded.
 */
import {
  DECODE_OP,
  addDecodeNode,
  createDecodeGraph,
  validateDecodeGraph,
  type DecodeGraph,
} from '@driftengine/texture';
import {
  inputLink,
  nodeOf,
  topologicalOrder,
  validateGraph,
  type Graph,
  type GraphNode,
} from '../model.ts';
import { MATERIAL_VOCABULARY } from './nodes.ts';

export interface CompiledMaterial {
  readonly graph: DecodeGraph;
  /** Four floats per slot, for every `constant` node. */
  readonly constants: Float32Array;
  readonly error: string | null;
}

const FAILED = (error: string): CompiledMaterial => ({
  graph: createDecodeGraph(1),
  constants: new Float32Array(0),
  error,
});

/** What a node's parameter says, or a stated default. */
function param(node: GraphNode, name: string, fallback: number): number {
  const value = node.params[name];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function compileMaterialGraph(graph: Graph): CompiledMaterial {
  const complaint = validateGraph(graph, MATERIAL_VOCABULARY, { forCompile: true });
  if (complaint !== null) return FAILED(complaint);

  const order: number[] = [];
  topologicalOrder(graph, order);

  const outputs = graph.nodes.filter((node) => node.kind === 'output');
  if (outputs.length !== 1) {
    return FAILED(
      outputs.length === 0
        ? 'the graph has no output node, so there is nothing to compile'
        : `the graph has ${outputs.length} output nodes and a texture has one result`,
    );
  }

  const decode = createDecodeGraph(order.length + 1);
  const constants: number[] = [];
  /** Which decode register holds each graph node's output. */
  const register = new Map<number, number>();
  let next = 0;

  /* The register a node's input arrives in, or -1 where the input is empty. */
  const inputRegister = (node: GraphNode, port: number): number => {
    const link = inputLink(graph, node.id, port);
    return link === undefined ? -1 : (register.get(link.from) ?? -1);
  };

  for (const id of order) {
    const node = nodeOf(graph, id) as GraphNode;
    if (node.kind === 'output') {
      const source = inputRegister(node, 0);
      if (source < 0) return FAILED(`node ${node.id} (output) has nothing connected to it`);
      decode.result = source;
      continue;
    }

    const dst = next;
    next += 1;

    switch (node.kind) {
      case 'constant': {
        const slot = constants.length / 4;
        constants.push(
          param(node, 'r', 0),
          param(node, 'g', 0),
          param(node, 'b', 0),
          param(node, 'a', 1),
        );
        addDecodeNode(decode, DECODE_OP.CONSTANT, slot, 0, dst);
        break;
      }
      case 'sample':
        addDecodeNode(decode, DECODE_OP.SAMPLE_LATENT, param(node, 'slot', 0), 0, dst);
        break;
      case 'block':
        addDecodeNode(decode, DECODE_OP.SAMPLE_BLOCK, param(node, 'slot', 0), 0, dst);
        break;
      case 'noise':
        addDecodeNode(
          decode,
          DECODE_OP.PROCEDURAL_FBM,
          param(node, 'seed', 1),
          param(node, 'octaves', 3),
          dst,
        );
        break;
      case 'flipbook':
        addDecodeNode(
          decode,
          DECODE_OP.FLIPBOOK_INDEX,
          param(node, 'frames', 1),
          param(node, 'fps', 1),
          dst,
        );
        break;
      case 'blend':
        addDecodeNode(
          decode,
          DECODE_OP.COMPOSITE,
          inputRegister(node, 0),
          inputRegister(node, 1),
          dst,
        );
        break;
      case 'lerp':
        addDecodeNode(
          decode,
          DECODE_OP.LATENT_LERP,
          inputRegister(node, 0),
          inputRegister(node, 1),
          dst,
        );
        break;
      case 'remap':
        addDecodeNode(
          decode,
          DECODE_OP.REMAP_CHANNEL,
          inputRegister(node, 0),
          param(node, 'spec', 0),
          dst,
        );
        break;
      default:
        return FAILED(
          `node ${node.id} (${node.kind}) has no decode operation behind it, and this compiles to a decode program rather than to a shader`,
        );
    }
    register.set(node.id, dst);
  }

  /* Passed through rather than reworded: the register budget is its complaint to make. */
  const refusal = validateDecodeGraph(decode);
  if (refusal !== null) return FAILED(refusal);

  return { graph: decode, constants: Float32Array.from(constants), error: null };
}
