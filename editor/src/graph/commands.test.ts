import { describe, expect, it } from 'vitest';
import { createUndoStack, type Command } from '@driftengine/tools';
import {
  addLink,
  addNode,
  createGraph,
  createVocabulary,
  inputLink,
  linksOf,
  nodeOf,
  type Graph,
} from './model.ts';
import {
  addNodeCommand,
  connectCommand,
  disconnectCommand,
  moveNodesCommand,
  pasteSubgraphCommand,
  removeNodesCommand,
  subgraphOf,
} from './commands.ts';

const VOCABULARY = createVocabulary([
  { kind: 'constant', inputs: [], outputs: [{ name: 'value', type: 'number' }] },
  {
    kind: 'add',
    inputs: [
      { name: 'a', type: 'number', required: true },
      { name: 'b', type: 'number', required: true },
    ],
    outputs: [{ name: 'sum', type: 'number' }],
  },
]);

/** `a → sum ← b`, with both links in. */
function wired(): { graph: Graph; a: number; b: number; sum: number } {
  const graph = createGraph();
  const a = addNode(graph, 'constant', 0, 0);
  const b = addNode(graph, 'constant', 0, 40);
  const sum = addNode(graph, 'add', 100, 20);
  addLink(graph, VOCABULARY, { from: a, fromPort: 0, to: sum, toPort: 0 });
  addLink(graph, VOCABULARY, { from: b, fromPort: 0, to: sum, toPort: 1 });
  return { graph, a, b, sum };
}

describe('adding a node', () => {
  it('is undoable, and redo puts back the same identifier', () => {
    const graph = createGraph();
    const stack = createUndoStack(8);
    const command = addNodeCommand(graph, 'constant', 10, 20);

    stack.push(command);
    expect(graph.nodes.length).toBe(1);
    const id = (graph.nodes[0] as { id: number }).id;

    stack.undo();
    expect(graph.nodes.length).toBe(0);
    stack.redo();
    expect((graph.nodes[0] as { id: number }).id, 'the same node, not a new one').toBe(id);
  });

  /**
   * **A redone node must not take a fresh identifier.** Anything holding the old one — a
   * selection, a link the same undo entry restored — would be pointing at nothing, and the graph
   * would come back with pieces missing for no reason a person could see.
   */
  it('does not consume an identifier on redo', () => {
    const graph = createGraph();
    const stack = createUndoStack(8);
    stack.push(addNodeCommand(graph, 'constant', 0, 0));
    stack.undo();
    stack.redo();
    const after = graph.nextId;
    stack.undo();
    stack.redo();
    expect(graph.nextId).toBe(after);
  });
});

/**
 * **Deleting a node takes its links with it, in one entry.** The defect is undo bringing back a
 * node with no connections: the links were removed by the same gesture and restored by nothing, so
 * the graph after undo is not the graph before delete.
 */
/** A command the test expects to exist. `removeNodesCommand` returns null for a delete of nothing. */
function must(command: Command | null): Command {
  if (command === null) throw new Error('the command was refused');
  return command;
}

describe('deleting nodes', () => {
  it('takes the links with it and brings both back', () => {
    const { graph, sum } = wired();
    const stack = createUndoStack(8);

    stack.push(must(removeNodesCommand(graph, [sum])));
    expect(graph.nodes.length).toBe(2);
    expect(linksOf(graph).length, 'the links went too').toBe(0);

    expect(stack.undo()).toBe(true);
    expect(graph.nodes.length).toBe(3);
    expect(linksOf(graph).length, 'and came back with it').toBe(2);
    expect(inputLink(graph, sum, 0)).toBeDefined();
    expect(stack.canUndo(), 'one entry for the whole deletion').toBe(false);
  });

  it('restores a node where it was, not at the end', () => {
    const { graph, b } = wired();
    const stack = createUndoStack(8);
    const before = graph.nodes.map((node) => node.id);

    stack.push(must(removeNodesCommand(graph, [b])));
    stack.undo();
    expect(graph.nodes.map((node) => node.id)).toEqual(before);
  });

  it('deletes several at once as one entry', () => {
    const { graph, a, b } = wired();
    const stack = createUndoStack(8);
    stack.push(must(removeNodesCommand(graph, [a, b])));
    expect(graph.nodes.length).toBe(1);
    expect(linksOf(graph).length).toBe(0);
    stack.undo();
    expect(graph.nodes.length).toBe(3);
    expect(linksOf(graph).length).toBe(2);
  });

  it('asks for nothing when there is nothing to delete', () => {
    const graph = createGraph();
    expect(removeNodesCommand(graph, [])).toBe(null);
    expect(removeNodesCommand(graph, [99])).toBe(null);
  });
});

describe('connecting', () => {
  it('is undoable', () => {
    const graph = createGraph();
    const a = addNode(graph, 'constant', 0, 0);
    const sum = addNode(graph, 'add', 100, 0);
    const stack = createUndoStack(8);

    stack.push(connectCommand(graph, VOCABULARY, { from: a, fromPort: 0, to: sum, toPort: 0 })!);
    expect(linksOf(graph).length).toBe(1);
    stack.undo();
    expect(linksOf(graph).length).toBe(0);
  });

  /** Connecting over an occupied input replaces, so undo has to put the displaced link back. */
  it('puts back the link it displaced', () => {
    const { graph, a, b, sum } = wired();
    const stack = createUndoStack(8);

    stack.push(connectCommand(graph, VOCABULARY, { from: b, fromPort: 0, to: sum, toPort: 0 })!);
    expect(inputLink(graph, sum, 0)?.from).toBe(b);

    stack.undo();
    expect(inputLink(graph, sum, 0)?.from, 'the displaced link came back').toBe(a);
    expect(linksOf(graph).length).toBe(2);
  });

  it('refuses a link the model would refuse', () => {
    const graph = createGraph();
    const a = addNode(graph, 'constant', 0, 0);
    expect(connectCommand(graph, VOCABULARY, { from: a, fromPort: 0, to: 99, toPort: 0 })).toBe(
      null,
    );
  });

  it('disconnects and reconnects', () => {
    const { graph, a, sum } = wired();
    const stack = createUndoStack(8);
    stack.push(disconnectCommand(graph, { from: a, fromPort: 0, to: sum, toPort: 0 })!);
    expect(linksOf(graph).length).toBe(1);
    stack.undo();
    expect(linksOf(graph).length).toBe(2);
  });
});

/**
 * **A drag is one undo entry.** A node dragged across the canvas emits a command per frame, and
 * sixty of them in the stack means sixty presses of undo to put it back — so they merge, through
 * the shell's existing `merge` rather than a second mechanism invented here.
 */
describe('moving nodes', () => {
  it('merges the frames of one drag into one entry', () => {
    const { graph, a } = wired();
    const stack = createUndoStack(8);

    /* A delta per frame, which is what a drag emits — not a position. */
    for (let frame = 1; frame <= 30; frame += 1) {
      stack.push(moveNodesCommand(graph, [a], 1, 2)!);
    }
    expect(nodeOf(graph, a)?.x).toBe(30);
    expect(nodeOf(graph, a)?.y).toBe(60);

    expect(stack.undo()).toBe(true);
    expect(nodeOf(graph, a)?.x, 'one press puts it back where it started').toBe(0);
    expect(stack.canUndo()).toBe(false);
  });

  it('moves a whole selection as one entry', () => {
    const { graph, a, b } = wired();
    const stack = createUndoStack(8);
    stack.push(moveNodesCommand(graph, [a, b], 10, 10)!);

    expect(nodeOf(graph, a)?.x).toBe(10);
    expect(nodeOf(graph, b)?.y).toBe(50);
    stack.undo();
    expect(nodeOf(graph, a)?.x).toBe(0);
    expect(nodeOf(graph, b)?.y).toBe(40);
  });

  /** A different selection is a different drag, or moving two things becomes one undo. */
  it('does not merge across different selections', () => {
    const { graph, a, b } = wired();
    const stack = createUndoStack(8);
    stack.push(moveNodesCommand(graph, [a], 5, 0)!);
    stack.push(moveNodesCommand(graph, [b], 5, 0)!);

    stack.undo();
    expect(nodeOf(graph, b)?.x).toBe(0);
    expect(nodeOf(graph, a)?.x, 'the first drag is still a separate entry').toBe(5);
  });

  it('asks for nothing for a move of nothing', () => {
    const { graph, a } = wired();
    expect(moveNodesCommand(graph, [], 1, 1)).toBe(null);
    expect(moveNodesCommand(graph, [a], 0, 0)).toBe(null);
  });
});

/**
 * **Pasting renumbers**, or a paste into the graph it was copied from collides with itself: the
 * new nodes take identifiers that already exist, and links that were meant for the copies land on
 * the originals.
 */
describe('pasting a subgraph', () => {
  it('renumbers without colliding, and keeps the shape', () => {
    const { graph, a, b, sum } = wired();
    const clipboard = subgraphOf(graph, [a, b, sum]);
    const stack = createUndoStack(8);

    stack.push(pasteSubgraphCommand(graph, clipboard, 200, 0)!);
    expect(graph.nodes.length).toBe(6);
    expect(linksOf(graph).length, 'the copy is wired like the original').toBe(4);
    expect(new Set(graph.nodes.map((node) => node.id)).size, 'no two nodes share one').toBe(6);

    stack.undo();
    expect(graph.nodes.length).toBe(3);
    expect(linksOf(graph).length).toBe(2);
  });

  /**
   * **Counting links is not enough**, and a perturbation proved it: mapping every copied link back
   * onto its original identifier still produces four links and six distinct nodes. What it produces
   * is a copy wired to the originals, so dragging the copy leaves its connections behind. The claim
   * is that no link crosses between the two.
   */
  it('wires the copy to itself and never back to what it came from', () => {
    const { graph, a, b, sum } = wired();
    const originals = new Set([a, b, sum]);
    pasteSubgraphCommand(graph, subgraphOf(graph, [a, b, sum]), 200, 0)!.apply();

    for (const link of linksOf(graph)) {
      expect(
        originals.has(link.from),
        `link ${link.from} → ${link.to} crosses between the copy and the original`,
      ).toBe(originals.has(link.to));
    }
    const copies = graph.nodes.slice(3).map((node) => node.id);
    expect(inputLink(graph, copies[2] as number, 0)?.from, "the copy's own input").toBe(copies[0]);
  });

  it('offsets the copy so it is not hidden under the original', () => {
    const { graph, a, b, sum } = wired();
    const clipboard = subgraphOf(graph, [a, b, sum]);
    pasteSubgraphCommand(graph, clipboard, 200, 5)!.apply();

    const copies = graph.nodes.slice(3);
    expect(copies.map((node) => node.x)).toEqual([200, 200, 300]);
    expect(copies.map((node) => node.y)).toEqual([5, 45, 25]);
  });

  it('copies only the links whose ends are both in the selection', () => {
    const { graph, a, sum } = wired();
    const clipboard = subgraphOf(graph, [a, sum]);
    expect(clipboard.links.length, 'the link from b is not in this selection').toBe(1);
  });

  it('asks for nothing for an empty clipboard', () => {
    const graph = createGraph();
    expect(pasteSubgraphCommand(graph, { nodes: [], links: [] }, 0, 0)).toBe(null);
  });
});
