import { describe, expect, it } from 'vitest';
import {
  addLink,
  addNode,
  createGraph,
  createVocabulary,
  inputLink,
  linksOf,
  portsCompatible,
  removeLink,
  topologicalOrder,
  validateGraph,
  type Graph,
} from './model.ts';

const VOCABULARY = createVocabulary([
  { kind: 'constant', inputs: [], outputs: [{ name: 'value', type: 'number' }] },
  { kind: 'colour', inputs: [], outputs: [{ name: 'rgba', type: 'colour' }] },
  {
    kind: 'add',
    inputs: [
      { name: 'a', type: 'number', required: true },
      { name: 'b', type: 'number', required: true },
    ],
    outputs: [{ name: 'sum', type: 'number' }],
  },
  {
    kind: 'scale',
    inputs: [
      { name: 'colour', type: 'colour', required: true },
      { name: 'by', type: 'number' },
    ],
    outputs: [{ name: 'out', type: 'colour' }],
  },
  { kind: 'output', inputs: [{ name: 'final', type: 'colour', required: true }], outputs: [] },
]);

/** `constant → add ← constant`, with the sum going nowhere. */
function chain(): { graph: Graph; a: number; b: number; sum: number } {
  const graph = createGraph();
  const a = addNode(graph, 'constant', 0, 0);
  const b = addNode(graph, 'constant', 0, 40);
  const sum = addNode(graph, 'add', 100, 20);
  addLink(graph, VOCABULARY, { from: a, fromPort: 0, to: sum, toPort: 0 });
  addLink(graph, VOCABULARY, { from: b, fromPort: 0, to: sum, toPort: 1 });
  return { graph, a, b, sum };
}

describe('the graph model', () => {
  it('gives every node a fresh identifier', () => {
    const graph = createGraph();
    const ids = [addNode(graph, 'constant', 0, 0), addNode(graph, 'constant', 0, 0)];
    expect(new Set(ids).size).toBe(2);
  });

  it('orders an acyclic graph so every node follows what it depends on', () => {
    const { graph, a, b, sum } = chain();
    const out: number[] = [];
    expect(topologicalOrder(graph, out)).toBe(3);
    expect(out.indexOf(sum), 'the sum comes after both of its inputs').toBeGreaterThan(
      Math.max(out.indexOf(a), out.indexOf(b)),
    );
  });

  /**
   * **A compiled material is content, and content that shuffles between builds cannot be diffed.**
   * So ties are broken by identifier rather than by whichever link happened to be added first —
   * asserted on a shape where the two differ, because a chain of three is the same order either
   * way and would have said nothing.
   */
  it('breaks ties by identifier, not by the order links were added', () => {
    const graph = createGraph();
    const source = addNode(graph, 'constant', 0, 0);
    const first = addNode(graph, 'add', 100, 0);
    const second = addNode(graph, 'add', 100, 40);
    const third = addNode(graph, 'add', 100, 80);

    /* Deliberately not in identifier order: the third node is connected first. */
    addLink(graph, VOCABULARY, { from: source, fromPort: 0, to: third, toPort: 0 });
    addLink(graph, VOCABULARY, { from: source, fromPort: 0, to: first, toPort: 0 });
    addLink(graph, VOCABULARY, { from: source, fromPort: 0, to: second, toPort: 0 });

    const out: number[] = [];
    expect(topologicalOrder(graph, out)).toBe(4);
    expect(out).toEqual([source, first, second, third]);
  });

  it('orders the same way every time', () => {
    const { graph } = chain();
    const first: number[] = [];
    topologicalOrder(graph, first);
    for (let again = 0; again < 5; again += 1) {
      const out: number[] = [];
      topologicalOrder(graph, out);
      expect(out).toEqual(first);
    }
  });

  /**
   * **A cycle is refused by name.** "Invalid graph" in a fifty-node material is a message somebody
   * reads and then has to go looking, which is the whole of the work the message was supposed to
   * save them.
   */
  it('refuses a cycle and names a node on it', () => {
    const graph = createGraph();
    const one = addNode(graph, 'add', 0, 0);
    const two = addNode(graph, 'add', 100, 0);
    addLink(graph, VOCABULARY, { from: one, fromPort: 0, to: two, toPort: 0 });
    addLink(graph, VOCABULARY, { from: two, fromPort: 0, to: one, toPort: 0 });

    const complaint = validateGraph(graph, VOCABULARY, { forCompile: false });
    expect(complaint).not.toBe(null);
    expect(complaint).toContain('cycle');
    expect(
      complaint?.includes(String(one)) || complaint?.includes(String(two)),
      'and says which node',
    ).toBe(true);
  });

  it('reports a cycle from topologicalOrder as a short count rather than a lie', () => {
    const graph = createGraph();
    const one = addNode(graph, 'add', 0, 0);
    const two = addNode(graph, 'add', 100, 0);
    addLink(graph, VOCABULARY, { from: one, fromPort: 0, to: two, toPort: 0 });
    addLink(graph, VOCABULARY, { from: two, fromPort: 0, to: one, toPort: 0 });

    const out: number[] = [];
    expect(topologicalOrder(graph, out), 'neither node can be placed').toBe(0);
  });

  it('refuses a node whose kind nothing declares', () => {
    const graph = createGraph();
    addNode(graph, 'imaginary', 0, 0);
    expect(validateGraph(graph, VOCABULARY, { forCompile: false })).toContain('imaginary');
  });
});

describe('links', () => {
  it('refuses to join ports of different types', () => {
    const graph = createGraph();
    const number = addNode(graph, 'constant', 0, 0);
    const out = addNode(graph, 'output', 100, 0);
    expect(addLink(graph, VOCABULARY, { from: number, fromPort: 0, to: out, toPort: 0 })).toBe(
      false,
    );
    expect(linksOf(graph).length).toBe(0);
  });

  it('refuses a port that does not exist', () => {
    const graph = createGraph();
    const a = addNode(graph, 'constant', 0, 0);
    const b = addNode(graph, 'add', 100, 0);
    expect(addLink(graph, VOCABULARY, { from: a, fromPort: 7, to: b, toPort: 0 })).toBe(false);
    expect(addLink(graph, VOCABULARY, { from: a, fromPort: 0, to: b, toPort: 7 })).toBe(false);
  });

  it('refuses a link to a node that is not there', () => {
    const graph = createGraph();
    const a = addNode(graph, 'constant', 0, 0);
    expect(addLink(graph, VOCABULARY, { from: a, fromPort: 0, to: 999, toPort: 0 })).toBe(false);
  });

  /** An input takes one value, so connecting a second replaces the first rather than stacking. */
  it('replaces the link into an input that already had one', () => {
    const graph = createGraph();
    const a = addNode(graph, 'constant', 0, 0);
    const b = addNode(graph, 'constant', 0, 40);
    const sum = addNode(graph, 'add', 100, 0);

    addLink(graph, VOCABULARY, { from: a, fromPort: 0, to: sum, toPort: 0 });
    addLink(graph, VOCABULARY, { from: b, fromPort: 0, to: sum, toPort: 0 });

    expect(linksOf(graph).length, 'one link into that input, not two').toBe(1);
    expect(inputLink(graph, sum, 0)?.from).toBe(b);
  });

  /** An output is a value, and a value may be read as often as anybody likes. */
  it('lets one output feed many inputs', () => {
    const graph = createGraph();
    const a = addNode(graph, 'constant', 0, 0);
    const sum = addNode(graph, 'add', 100, 0);
    addLink(graph, VOCABULARY, { from: a, fromPort: 0, to: sum, toPort: 0 });
    addLink(graph, VOCABULARY, { from: a, fromPort: 0, to: sum, toPort: 1 });
    expect(linksOf(graph).length).toBe(2);
  });

  it('removes a link that is there and reports one that is not', () => {
    const { graph, a, sum } = chain();
    expect(removeLink(graph, { from: a, fromPort: 0, to: sum, toPort: 0 })).toBe(true);
    expect(removeLink(graph, { from: a, fromPort: 0, to: sum, toPort: 0 })).toBe(false);
    expect(linksOf(graph).length).toBe(1);
  });

  it('knows which port types may be joined', () => {
    expect(portsCompatible('number', 'number')).toBe(true);
    expect(portsCompatible('number', 'colour')).toBe(false);
  });
});

/**
 * **A half-built graph is the normal state of a graph being built**, so an unconnected required
 * input is an error at compile time and not while editing. An editor that refused every incomplete
 * graph would refuse every graph somebody was in the middle of making.
 */
describe('a required input that nothing feeds', () => {
  it('is allowed while editing and refused at compile time', () => {
    const graph = createGraph();
    const a = addNode(graph, 'constant', 0, 0);
    const sum = addNode(graph, 'add', 100, 0);
    addLink(graph, VOCABULARY, { from: a, fromPort: 0, to: sum, toPort: 0 });

    expect(validateGraph(graph, VOCABULARY, { forCompile: false })).toBe(null);
    const complaint = validateGraph(graph, VOCABULARY, { forCompile: true });
    expect(complaint).toContain('b');
    expect(complaint).toContain(String(sum));
  });

  it('says nothing about an optional input that is empty', () => {
    const graph = createGraph();
    const colour = addNode(graph, 'colour', 0, 0);
    const scale = addNode(graph, 'scale', 100, 0);
    addLink(graph, VOCABULARY, { from: colour, fromPort: 0, to: scale, toPort: 0 });
    expect(validateGraph(graph, VOCABULARY, { forCompile: true })).toBe(null);
  });

  it('is happy once everything required is fed', () => {
    const { graph } = chain();
    expect(validateGraph(graph, VOCABULARY, { forCompile: true })).toBe(null);
  });
});
