import { expect, test } from 'vitest';
import {
  ADDRESS_MODE_COUNT,
  DECODE_OP,
  MAX_REGISTERS,
  addDecodeNode,
  createDecodeGraph,
  decodeDecodeGraph,
  encodeDecodeGraph,
  graphRegisterCount,
  validateDecodeGraph,
} from './decodeGraph.ts';

function sampling() {
  const graph = createDecodeGraph(4);
  addDecodeNode(graph, DECODE_OP.SAMPLE_LATENT, 0, 0, 0);
  graph.result = 0;
  return graph;
}

test('a one-node graph validates', () => {
  expect(validateDecodeGraph(sampling())).toBe(null);
});

test('a graph round-trips through encode and decode exactly', () => {
  const graph = sampling();
  graph.addressMode = 1;
  const back = decodeDecodeGraph(encodeDecodeGraph(graph));
  expect(back.count).toBe(graph.count);
  expect(back.result).toBe(graph.result);
  expect(back.addressMode).toBe(1);
  expect(Array.from(back.nodes.subarray(0, 4))).toEqual(Array.from(graph.nodes.subarray(0, 4)));
});

test('reading a register nothing wrote is refused, and the message names the node', () => {
  const graph = createDecodeGraph(4);
  addDecodeNode(graph, DECODE_OP.COMPOSITE, 3, 4, 0);
  graph.result = 0;
  const message = validateDecodeGraph(graph);
  expect(message).toContain('node 0');
  expect(message).toContain('register 3');
});

test('a result register nothing writes is refused', () => {
  const graph = sampling();
  graph.result = 5;
  expect(validateDecodeGraph(graph)).toContain('result register 5');
});

test('an unknown opcode is refused rather than run as something else', () => {
  const graph = createDecodeGraph(4);
  addDecodeNode(graph, 99, 0, 0, 0);
  graph.result = 0;
  expect(validateDecodeGraph(graph)).toContain('unknown opcode 99');
});

test('a graph past the register budget is refused at validation, not on one device', () => {
  const graph = createDecodeGraph(4);
  addDecodeNode(graph, DECODE_OP.SAMPLE_LATENT, 0, 0, MAX_REGISTERS + 3);
  graph.result = MAX_REGISTERS + 3;
  expect(validateDecodeGraph(graph)).toContain('past the');
});

test('the register count is the highest written register plus one', () => {
  const graph = createDecodeGraph(4);
  addDecodeNode(graph, DECODE_OP.SAMPLE_LATENT, 0, 0, 0);
  addDecodeNode(graph, DECODE_OP.SAMPLE_LATENT, 1, 0, 3);
  graph.result = 3;
  expect(graphRegisterCount(graph)).toBe(4);
});

test('an operation whose arguments are immediates does not need them written', () => {
  const graph = createDecodeGraph(4);
  addDecodeNode(graph, DECODE_OP.PROCEDURAL_FBM, 1234, 4, 0);
  graph.result = 0;
  expect(validateDecodeGraph(graph)).toBe(null);
});

test('an address mode past the four the interpreter knows is refused, with the mode named', () => {
  const graph = createDecodeGraph(1);
  addDecodeNode(graph, DECODE_OP.SAMPLE_LATENT, 0, 0, 0);
  graph.result = 0;
  for (let mode = 0; mode < ADDRESS_MODE_COUNT; mode += 1) {
    graph.addressMode = mode;
    expect(validateDecodeGraph(graph), `mode ${mode}`).toBeNull();
  }
  graph.addressMode = ADDRESS_MODE_COUNT;
  expect(validateDecodeGraph(graph)).toContain(String(ADDRESS_MODE_COUNT));
});
