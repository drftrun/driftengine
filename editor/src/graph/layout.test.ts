import { describe, expect, it } from 'vitest';
import { createUndoStack } from '@driftengine/tools';
import { addLink, addNode, createGraph, createVocabulary, nodeOf, type Graph } from './model.ts';
import {
  COLUMN_GAP,
  LINK_SEGMENTS,
  NODE_HEADER,
  NODE_WIDTH,
  PORT_SPACING,
  ROW_GAP,
  arrangeCommand,
  arrangeGraph,
  linkCurvePoint,
  nodeBox,
  nodeHeight,
  portPoint,
  specFor,
} from './layout.ts';

const VOCABULARY = createVocabulary([
  { kind: 'source', inputs: [], outputs: [{ name: 'out', type: 'number' }] },
  {
    kind: 'one',
    inputs: [{ name: 'a', type: 'number' }],
    outputs: [{ name: 'out', type: 'number' }],
  },
  {
    kind: 'two',
    inputs: [
      { name: 'a', type: 'number' },
      { name: 'b', type: 'number' },
    ],
    outputs: [{ name: 'out', type: 'number' }],
  },
  {
    kind: 'four',
    inputs: [
      { name: 'a', type: 'number' },
      { name: 'b', type: 'number' },
      { name: 'c', type: 'number' },
      { name: 'd', type: 'number' },
    ],
    outputs: [{ name: 'out', type: 'number' }],
  },
  { kind: 'sink', inputs: [{ name: 'a', type: 'number' }], outputs: [] },
]);

const KINDS = ['source', 'one', 'two', 'four', 'sink'] as const;

function box(graph: Graph, id: number): Float64Array {
  const node = nodeOf(graph, id);
  if (node === undefined) throw new Error(`no node ${String(id)}`);
  return nodeBox(specFor(VOCABULARY, node.kind), node, new Float64Array(4));
}

function overlaps(a: Float64Array, b: Float64Array): boolean {
  const ax = a[0] as number;
  const ay = a[1] as number;
  const bx = b[0] as number;
  const by = b[1] as number;
  return (
    ax < bx + (b[2] as number) &&
    bx < ax + (a[2] as number) &&
    ay < by + (b[3] as number) &&
    by < ay + (a[3] as number)
  );
}

function positions(graph: Graph): string {
  return graph.nodes.map((node) => `${node.id}@${node.x},${node.y}`).join(' ');
}

describe('a node measures from its ports', () => {
  it('is as tall as its busier side', () => {
    /* Header, one row of 16 per port, and a foot: 20 + 16 + 6, 20 + 32 + 6, 20 + 64 + 6. */
    expect(nodeHeight(specFor(VOCABULARY, 'source'))).toBe(42);
    expect(nodeHeight(specFor(VOCABULARY, 'two'))).toBe(58);
    expect(nodeHeight(specFor(VOCABULARY, 'four'))).toBe(90);
  });

  it('counts the larger side, not the inputs', () => {
    /* `sink` has one input and no outputs; `source` has one output and no inputs. Same height. */
    expect(nodeHeight(specFor(VOCABULARY, 'sink'))).toBe(nodeHeight(specFor(VOCABULARY, 'source')));
  });

  it('gives an unknown kind a body and no ports, so a broken graph is still visible', () => {
    const spec = specFor(VOCABULARY, 'not-a-kind');
    expect(spec.inputs).toEqual([]);
    expect(spec.outputs).toEqual([]);
    expect(nodeHeight(spec)).toBe(NODE_HEADER + 6);
  });

  it('boxes a node at its own position', () => {
    const graph = createGraph();
    const id = addNode(graph, 'two', 10, 20);
    expect([...box(graph, id)]).toEqual([10, 20, 140, 58]);
  });

  it('puts inputs on the left edge and outputs on the right, one row apart', () => {
    const graph = createGraph();
    addNode(graph, 'two', 10, 20);
    const node = nodeOf(graph, 1);
    if (node === undefined) throw new Error('no node');
    const spec = specFor(VOCABULARY, 'two');
    const out = new Float64Array(2);
    /* 20 (y) + 20 (header) + 8 (half a row) = 48, then one row down. */
    expect([...portPoint(spec, node, 'input', 0, out)]).toEqual([10, 48]);
    expect([...portPoint(spec, node, 'input', 1, out)]).toEqual([10, 64]);
    expect([...portPoint(spec, node, 'output', 0, out)]).toEqual([150, 48]);
    expect(PORT_SPACING).toBe(16);
    expect(NODE_WIDTH).toBe(140);
  });
});

describe('a link is a curve with horizontal handles', () => {
  const out = new Float64Array(2);

  it('starts and ends on its ports', () => {
    expect([...linkCurvePoint(0, 0, 200, 200, 0, out)]).toEqual([0, 0]);
    expect([...linkCurvePoint(0, 0, 200, 200, 1, out)]).toEqual([200, 200]);
  });

  it('leaves the straight line between them', () => {
    /*
     * Handles at 100 either side, so the cubic is (0,0) (100,0) (100,200) (200,200). At t = 1/4
     * the weights are 27/64, 27/64, 9/64, 1/64:
     *   x = 27/64·100 + 9/64·100 + 1/64·200 = 59.375
     *   y =             9/64·200 + 1/64·200 = 31.25
     * The chord's nearest point is (45.3125, 45.3125), which is 19.9 away — far enough that a hit
     * test against the straight line and one against the curve cannot both pass.
     */
    expect([...linkCurvePoint(0, 0, 200, 200, 0.25, out)]).toEqual([59.375, 31.25]);
  });

  it('is sampled often enough to be a curve', () => {
    expect(LINK_SEGMENTS).toBeGreaterThanOrEqual(8);
  });
});

describe('automatic arrangement', () => {
  it('puts a chain in columns, each node right of what feeds it', () => {
    const graph = createGraph();
    const a = addNode(graph, 'source', 0, 0);
    const b = addNode(graph, 'one', 0, 0);
    const c = addNode(graph, 'sink', 0, 0);
    addLink(graph, VOCABULARY, { from: a, fromPort: 0, to: b, toPort: 0 });
    addLink(graph, VOCABULARY, { from: b, fromPort: 0, to: c, toPort: 0 });
    arrangeGraph(graph, VOCABULARY);
    expect(nodeOf(graph, a)?.x).toBe(0);
    expect(nodeOf(graph, b)?.x).toBe(NODE_WIDTH + COLUMN_GAP);
    expect(nodeOf(graph, c)?.x).toBe(2 * (NODE_WIDTH + COLUMN_GAP));
  });

  it('stacks a column with a gap between neighbours', () => {
    const graph = createGraph();
    addNode(graph, 'source', 0, 0);
    addNode(graph, 'source', 0, 0);
    arrangeGraph(graph, VOCABULARY);
    expect(nodeOf(graph, 1)?.y).toBe(0);
    expect(nodeOf(graph, 2)?.y).toBe(42 + ROW_GAP);
  });

  it('places a node as deep as its longest path, not its shortest', () => {
    /* `a` feeds both `b` and `c`; `b` also feeds `c`. `c` belongs in column 2, past `b`. */
    const graph = createGraph();
    const a = addNode(graph, 'source', 0, 0);
    const b = addNode(graph, 'one', 0, 0);
    const c = addNode(graph, 'two', 0, 0);
    addLink(graph, VOCABULARY, { from: a, fromPort: 0, to: b, toPort: 0 });
    addLink(graph, VOCABULARY, { from: a, fromPort: 0, to: c, toPort: 0 });
    addLink(graph, VOCABULARY, { from: b, fromPort: 0, to: c, toPort: 1 });
    arrangeGraph(graph, VOCABULARY);
    expect(nodeOf(graph, c)?.x).toBe(2 * (NODE_WIDTH + COLUMN_GAP));
  });

  it('orders a column by where its feeders sit, not by identifier', () => {
    /*
     * Column 0 is `a` (1) above `b` (2), by identifier. Column 1 holds `x` (3) fed by `b` and
     * `y` (4) fed by `a`. Ordering by identifier would put `x` above `y` and cross the two links;
     * ordering by the feeder's row puts `y` first.
     */
    const graph = createGraph();
    const a = addNode(graph, 'source', 0, 0);
    const b = addNode(graph, 'source', 0, 0);
    const x = addNode(graph, 'one', 0, 0);
    const y = addNode(graph, 'one', 0, 0);
    addLink(graph, VOCABULARY, { from: b, fromPort: 0, to: x, toPort: 0 });
    addLink(graph, VOCABULARY, { from: a, fromPort: 0, to: y, toPort: 0 });
    arrangeGraph(graph, VOCABULARY);
    expect(nodeOf(graph, y)?.y).toBeLessThan(nodeOf(graph, x)?.y ?? 0);
  });

  it('is the same every run and does not read where the nodes already are', () => {
    const graph = createGraph();
    const a = addNode(graph, 'source', 0, 0);
    const b = addNode(graph, 'source', 0, 0);
    const c = addNode(graph, 'two', 0, 0);
    addLink(graph, VOCABULARY, { from: a, fromPort: 0, to: c, toPort: 0 });
    addLink(graph, VOCABULARY, { from: b, fromPort: 0, to: c, toPort: 1 });
    arrangeGraph(graph, VOCABULARY);
    const once = positions(graph);
    arrangeGraph(graph, VOCABULARY);
    expect(positions(graph)).toBe(once);

    /* Scattered by hand and arranged again: the same answer, so tidying is not path-dependent. */
    for (const node of graph.nodes) {
      node.x = node.id * -717;
      node.y = node.id * 313;
    }
    arrangeGraph(graph, VOCABULARY);
    expect(positions(graph)).toBe(once);
  });

  it('places every node of a graph with a cycle in it', () => {
    /* The model permits a cycle — `validateGraph` reports one, `addLink` does not refuse it — so
       arranging must not drop the nodes that a topological order cannot reach. */
    const graph = createGraph();
    const a = addNode(graph, 'one', 0, 0);
    const b = addNode(graph, 'one', 0, 0);
    const c = addNode(graph, 'source', 0, 0);
    addLink(graph, VOCABULARY, { from: a, fromPort: 0, to: b, toPort: 0 });
    addLink(graph, VOCABULARY, { from: b, fromPort: 0, to: a, toPort: 0 });
    arrangeGraph(graph, VOCABULARY);
    /*
     * Numbers first: a node the layout dropped keeps whatever coordinates it had, or gets `NaN`,
     * and an overlap test against `NaN` is false for every pair — so "nothing overlaps" is true of
     * a layout that placed nothing. This is exactly what that check alone could not see.
     */
    for (const node of graph.nodes) {
      expect(Number.isFinite(node.x), `node ${String(node.id)} has no x`).toBe(true);
      expect(Number.isFinite(node.y), `node ${String(node.id)} has no y`).toBe(true);
    }
    /* `c` is the only node an order can reach, so the two on the cycle go one column past it. */
    expect(nodeOf(graph, c)?.x).toBe(0);
    expect(nodeOf(graph, a)?.x).toBe(NODE_WIDTH + COLUMN_GAP);
    expect(nodeOf(graph, b)?.x).toBe(NODE_WIDTH + COLUMN_GAP);
    expect(nodeOf(graph, a)?.y).not.toBe(nodeOf(graph, b)?.y);

    const boxes = [box(graph, a), box(graph, b), box(graph, c)];
    for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) {
        expect(overlaps(boxes[i] as Float64Array, boxes[j] as Float64Array)).toBe(false);
      }
    }
  });

  it('overlaps nothing, across two hundred random graphs', () => {
    /*
     * Five hand-picked shapes said the contour builder was sound and two hundred random blobs found
     * forty-six broken ones. A layout is geometry too, so it gets the same treatment: a seed alone
     * reproduces any failure.
     */
    const sizes = new Set<number>();
    for (let seed = 1; seed <= 200; seed += 1) {
      const graph = randomGraph(seed);
      arrangeGraph(graph, VOCABULARY);
      const boxes = graph.nodes.map((node) => box(graph, node.id));
      for (let i = 0; i < boxes.length; i += 1) {
        for (let j = i + 1; j < boxes.length; j += 1) {
          const hit = overlaps(boxes[i] as Float64Array, boxes[j] as Float64Array);
          expect(hit, `seed ${String(seed)}: nodes ${String(i)} and ${String(j)} overlap`).toBe(
            false,
          );
        }
      }
      sizes.add(graph.nodes.length);
    }
    /* And the graphs really were different: see `randomGraph` for what this caught. */
    expect(sizes.size).toBeGreaterThan(8);
  });
});

describe('arranging is an undoable command', () => {
  it('does not arrange until the stack applies it, and undo puts the nodes back', () => {
    const graph = createGraph();
    const a = addNode(graph, 'source', 11, 22);
    const b = addNode(graph, 'one', 33, 44);
    addLink(graph, VOCABULARY, { from: a, fromPort: 0, to: b, toPort: 0 });

    const command = arrangeCommand(graph, VOCABULARY);
    if (command === null) throw new Error('nothing to arrange');
    /* Built but not applied: the stack applies exactly once, and a command that arranged on the
       way out would arrange twice. */
    expect(nodeOf(graph, a)?.x).toBe(11);

    const stack = createUndoStack(8);
    stack.push(command);
    expect(nodeOf(graph, a)?.x).toBe(0);
    expect(nodeOf(graph, b)?.x).toBe(NODE_WIDTH + COLUMN_GAP);

    stack.undo();
    expect(nodeOf(graph, a)?.x).toBe(11);
    expect(nodeOf(graph, a)?.y).toBe(22);
    expect(nodeOf(graph, b)?.x).toBe(33);
    expect(nodeOf(graph, b)?.y).toBe(44);
  });

  it('is nothing to do when the nodes are already where arranging puts them', () => {
    const graph = createGraph();
    addNode(graph, 'source', 0, 0);
    arrangeGraph(graph, VOCABULARY);
    expect(arrangeCommand(graph, VOCABULARY)).toBeNull();
  });
});

/**
 * A deterministic random acyclic graph, so a failing seed can be reproduced from its number.
 *
 * **Warmed before use, and the first version of this was not.** A linear congruential generator
 * run from seeds 1 to 200 gives first draws between 0.236 and 0.313 — the seed barely moves the
 * state — so every one of the two hundred graphs came out nine or ten nodes. Two hundred graphs of
 * one size is one graph, and the test that caught it was the one asserting the sizes varied.
 */
function randomGraph(seed: number): Graph {
  let state = seed >>> 0;
  const next = (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  for (let i = 0; i < 6; i += 1) next();
  const graph = createGraph();
  const count = 6 + Math.floor(next() * 14);
  const ids: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const kind = KINDS[Math.floor(next() * KINDS.length)] as string;
    ids.push(addNode(graph, kind, 0, 0));
  }
  /* Only ever from a lower identifier to a higher one, which is what makes it acyclic. */
  for (let i = 1; i < count; i += 1) {
    const to = ids[i] as number;
    const inputs = specFor(VOCABULARY, (nodeOf(graph, to) as { kind: string }).kind).inputs.length;
    for (let port = 0; port < inputs; port += 1) {
      if (next() < 0.35) continue;
      const from = ids[Math.floor(next() * i)] as number;
      addLink(graph, VOCABULARY, { from, fromPort: 0, to, toPort: port });
    }
  }
  return graph;
}
