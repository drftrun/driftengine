import { describe, expect, it } from 'vitest';
import {
  DECODE_OP,
  createDecodeRegisters,
  decodeCpu,
  nodeOp,
  validateDecodeGraph,
} from '@driftengine/texture';
import { addLink, addNode, createGraph, type Graph } from '../model.ts';
import { MATERIAL_VOCABULARY } from './nodes.ts';
import { compileMaterialGraph, type CompiledMaterial } from './compile.ts';

function link(graph: Graph, from: number, fromPort: number, to: number, toPort: number): void {
  expect(addLink(graph, MATERIAL_VOCABULARY, { from, fromPort, to, toPort })).toBe(true);
}

/** Evaluate a compiled material at one texel and one time, which is what a texture is. */
function evaluate(compiled: CompiledMaterial, u = 0.5, v = 0.5, t = 0): number[] {
  const out = new Float32Array(4);
  decodeCpu(
    compiled.graph,
    { latents: [], blocks: [], networks: [], constants: compiled.constants },
    u,
    v,
    t,
    out,
    createDecodeRegisters(),
  );
  return [...out];
}

function opsOf(compiled: CompiledMaterial): number[] {
  const ops: number[] = [];
  for (let at = 0; at < compiled.graph.count; at += 1) ops.push(nodeOp(compiled.graph, at));
  return ops;
}

describe('a material graph', () => {
  /**
   * **The claim the whole wave rests on**: what comes out is the decode program a baked `DTEX`
   * already carries, so a graph-authored material and a baked one are indistinguishable downstream
   * — and the graph editor is a debugger for baked materials as a side effect.
   */
  it('compiles a constant colour to a program that evaluates to that colour', () => {
    const graph = createGraph();
    const colour = addNode(graph, 'constant', 0, 0);
    const out = addNode(graph, 'output', 100, 0);
    (graph.nodes[0] as { params: Record<string, number> }).params = {
      r: 0.25,
      g: 0.5,
      b: 0.75,
      a: 1,
    };
    link(graph, colour, 0, out, 0);

    const compiled = compileMaterialGraph(graph);
    expect(compiled.error).toBe(null);
    expect(opsOf(compiled)).toEqual([DECODE_OP.CONSTANT]);
    expect(evaluate(compiled)).toEqual([0.25, 0.5, 0.75, 1]);
  });

  /**
   * **Each constant gets its own slot**, which counting operations does not check: a compiler that
   * pushed every colour into the array and then pointed every node at slot zero produces the right
   * number of nodes, the right number of floats, and one colour. Evaluating is what tells them
   * apart.
   */
  it('gives every constant its own slot', () => {
    const graph = createGraph();
    const clear = addNode(graph, 'constant', 0, 0);
    const blue = addNode(graph, 'constant', 0, 40);
    const blend = addNode(graph, 'blend', 100, 20);
    const out = addNode(graph, 'output', 200, 20);
    (graph.nodes[0] as { params: Record<string, number> }).params = { r: 1, g: 0, b: 0, a: 0 };
    (graph.nodes[1] as { params: Record<string, number> }).params = { r: 0, g: 0, b: 1, a: 1 };
    link(graph, clear, 0, blend, 0);
    link(graph, blue, 0, blend, 1);
    link(graph, blend, 0, out, 0);

    const compiled = compileMaterialGraph(graph);
    expect(compiled.error).toBe(null);
    expect([...compiled.constants]).toEqual([1, 0, 0, 0, 0, 0, 1, 1]);
    /* Red at zero alpha over opaque blue is blue. Both reading slot zero would give red. */
    expect(evaluate(compiled).slice(0, 3)).toEqual([0, 0, 1]);
  });

  it('compiles a texture sample to SAMPLE_LATENT and a blend to COMPOSITE', () => {
    const graph = createGraph();
    const a = addNode(graph, 'sample', 0, 0);
    const b = addNode(graph, 'block', 0, 40);
    const blend = addNode(graph, 'blend', 100, 20);
    const out = addNode(graph, 'output', 200, 20);
    link(graph, a, 0, blend, 0);
    link(graph, b, 0, blend, 1);
    link(graph, blend, 0, out, 0);

    const compiled = compileMaterialGraph(graph);
    expect(compiled.error).toBe(null);
    expect(opsOf(compiled)).toEqual([
      DECODE_OP.SAMPLE_LATENT,
      DECODE_OP.SAMPLE_BLOCK,
      DECODE_OP.COMPOSITE,
    ]);
  });

  /**
   * **Time is a sampling argument and not a clock**, which is the property the texture design rests
   * on: the same graph at the same `t` is the same texel, so an animated material is byte-exact
   * under replay. A flipbook node is where that becomes visible.
   */
  it('compiles a flipbook whose output changes with t', () => {
    const graph = createGraph();
    const book = addNode(graph, 'flipbook', 0, 0);
    const out = addNode(graph, 'output', 100, 0);
    (graph.nodes[0] as { params: Record<string, number> }).params = { frames: 8, fps: 4 };
    link(graph, book, 0, out, 0);

    const compiled = compileMaterialGraph(graph);
    expect(compiled.error).toBe(null);
    expect(opsOf(compiled)).toEqual([DECODE_OP.FLIPBOOK_INDEX]);

    const early = evaluate(compiled, 0.5, 0.5, 0);
    const later = evaluate(compiled, 0.5, 0.5, 1);
    expect(later[0], 'a second in at four frames a second').not.toBe(early[0]);
    expect(evaluate(compiled, 0.5, 0.5, 1), 'and the same t gives the same answer').toEqual(later);
  });

  it('compiles a lerp to LATENT_LERP and a remap to REMAP_CHANNEL', () => {
    const graph = createGraph();
    const a = addNode(graph, 'sample', 0, 0);
    const b = addNode(graph, 'sample', 0, 40);
    const mix = addNode(graph, 'lerp', 100, 20);
    const remap = addNode(graph, 'remap', 200, 20);
    const out = addNode(graph, 'output', 300, 20);
    link(graph, a, 0, mix, 0);
    link(graph, b, 0, mix, 1);
    link(graph, mix, 0, remap, 0);
    link(graph, remap, 0, out, 0);

    const compiled = compileMaterialGraph(graph);
    expect(compiled.error).toBe(null);
    expect(opsOf(compiled)).toContain(DECODE_OP.LATENT_LERP);
    expect(opsOf(compiled)).toContain(DECODE_OP.REMAP_CHANNEL);
  });

  it('always produces a program the decoder will accept', () => {
    const graph = createGraph();
    const a = addNode(graph, 'noise', 0, 0);
    const b = addNode(graph, 'constant', 0, 40);
    const blend = addNode(graph, 'blend', 100, 20);
    const out = addNode(graph, 'output', 200, 20);
    link(graph, a, 0, blend, 0);
    link(graph, b, 0, blend, 1);
    link(graph, blend, 0, out, 0);

    const compiled = compileMaterialGraph(graph);
    expect(compiled.error).toBe(null);
    expect(validateDecodeGraph(compiled.graph)).toBe(null);
  });
});

describe('what a material graph refuses', () => {
  /**
   * **A node the decode vocabulary cannot express fails by name.** Emitting a shader for it would
   * make the graph's output a different kind of thing depending on which nodes were in it, and
   * would bring back exactly the permutation cost the texture design exists to avoid.
   */
  it('names the node it cannot express rather than emitting a shader', () => {
    const graph = createGraph();
    const a = addNode(graph, 'sample', 0, 0);
    const split = addNode(graph, 'separate', 100, 0);
    const out = addNode(graph, 'output', 200, 0);
    link(graph, a, 0, split, 0);
    link(graph, a, 0, out, 0);

    const compiled = compileMaterialGraph(graph);
    expect(compiled.error).toContain('separate');
    expect(compiled.error).toContain(String(split));
    expect(compiled.error, 'and says why, not just that').toContain('decode program');
  });

  it('refuses a graph with a required input nothing feeds', () => {
    const graph = createGraph();
    const a = addNode(graph, 'sample', 0, 0);
    const blend = addNode(graph, 'blend', 100, 0);
    const out = addNode(graph, 'output', 200, 0);
    link(graph, a, 0, blend, 0);
    link(graph, blend, 0, out, 0);

    expect(compileMaterialGraph(graph).error).toContain('under');
  });

  it('refuses a graph with no output and a graph with two', () => {
    const empty = createGraph();
    addNode(empty, 'constant', 0, 0);
    expect(compileMaterialGraph(empty).error).toContain('no output node');

    const graph = createGraph();
    const a = addNode(graph, 'constant', 0, 0);
    const one = addNode(graph, 'output', 100, 0);
    const two = addNode(graph, 'output', 100, 40);
    link(graph, a, 0, one, 0);
    link(graph, a, 0, two, 0);
    expect(compileMaterialGraph(graph).error).toContain('2 output nodes');
  });

  /**
   * **Sixteen registers is a real limit a real graph reaches**, and the complaint is the decoder's
   * own rather than a reworded one — so the number a person is told is the number the interpreter
   * actually has.
   */
  it('passes the register budget’s own complaint through', () => {
    const graph = createGraph();
    const out = addNode(graph, 'output', 999, 0);
    let last = addNode(graph, 'sample', 0, 0);
    for (let at = 0; at < 20; at += 1) {
      const next = addNode(graph, 'sample', at * 10, 40);
      const blend = addNode(graph, 'blend', at * 10, 80);
      link(graph, last, 0, blend, 0);
      link(graph, next, 0, blend, 1);
      last = blend;
    }
    link(graph, last, 0, out, 0);

    const compiled = compileMaterialGraph(graph);
    expect(compiled.error).not.toBe(null);
    expect(compiled.error, 'the decoder names its own budget').toContain('register');
  });

  it('refuses a cycle before it tries to compile one', () => {
    const graph = createGraph();
    const a = addNode(graph, 'blend', 0, 0);
    const b = addNode(graph, 'blend', 100, 0);
    addLink(graph, MATERIAL_VOCABULARY, { from: a, fromPort: 0, to: b, toPort: 0 });
    addLink(graph, MATERIAL_VOCABULARY, { from: b, fromPort: 0, to: a, toPort: 0 });
    expect(compileMaterialGraph(graph).error).toContain('cycle');
  });
});
