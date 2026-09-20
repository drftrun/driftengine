/**
 * Every graph edit, as a command.
 *
 * **Including a node drag**, which is the one that decides whether the undo stack is usable: a drag
 * emits a command per frame, and sixty of them means sixty presses of undo to put a node back. They
 * merge through `command.ts`'s existing `merge` rather than a second mechanism invented here, and
 * they obey its contract — `next` has already been applied by the stack and must not be applied
 * again, so the earlier command keeps its own `from` and adopts the other's `to`.
 *
 * **Deleting a node takes its links with it, in one entry.** The defect this exists to prevent is
 * undo bringing back a node with no connections: the links went with the same gesture and came
 * back with nothing, so the graph after undo is not the graph before the delete.
 *
 * **A restored node goes back where it was in the list**, not at the end. Order is what a reader
 * sees in a list and what a serialiser writes, and a node that moves to the bottom every time
 * somebody undoes a deletion is a diff nobody can read.
 */
import { type Command } from '@driftengine/tools';
import {
  addLink,
  addNode,
  inputLink,
  nodeOf,
  removeLink,
  type Graph,
  type GraphLink,
  type GraphNode,
  type Vocabulary,
} from './model.ts';

/** A node as it was, with where it sat in the list, so undo can put it back exactly. */
interface HeldNode {
  readonly at: number;
  readonly node: GraphNode;
}

export function addNodeCommand(graph: Graph, kind: string, x: number, y: number): Command {
  /*
   * The identifier is taken once, here, rather than inside `apply`. Redo that consumed a fresh one
   * would leave anything holding the old — a selection, a link another entry restored — pointing at
   * nothing, and the graph would come back with pieces missing for no visible reason.
   */
  const id = graph.nextId;
  graph.nextId += 1;
  const node: GraphNode = { id, kind, x, y, params: {} };

  return {
    label: `Add ${kind}`,
    apply: (): void => {
      graph.nodes.push(node);
    },
    revert: (): void => {
      const at = graph.nodes.indexOf(node);
      if (at >= 0) graph.nodes.splice(at, 1);
    },
  };
}

/** Delete nodes and every link touching them, as one entry. Null where there is nothing to delete. */
export function removeNodesCommand(graph: Graph, ids: readonly number[]): Command | null {
  const doomed = ids.filter((id) => nodeOf(graph, id) !== undefined);
  if (doomed.length === 0) return null;

  const held: HeldNode[] = graph.nodes
    .map((node, at) => ({ at, node }))
    .filter((entry) => doomed.includes(entry.node.id));
  const links = graph.links.filter(
    (link) => doomed.includes(link.from) || doomed.includes(link.to),
  );

  return {
    label:
      doomed.length === 1
        ? `Delete ${held[0]?.node.kind ?? 'node'}`
        : `Delete ${doomed.length} nodes`,
    apply: (): void => {
      for (const link of links) removeLink(graph, link);
      for (const entry of held) {
        const at = graph.nodes.indexOf(entry.node);
        if (at >= 0) graph.nodes.splice(at, 1);
      }
    },
    revert: (): void => {
      /* Ascending, so each node lands at the index it had once the earlier ones are back. */
      for (const entry of [...held].sort((a, b) => a.at - b.at)) {
        graph.nodes.splice(entry.at, 0, entry.node);
      }
      for (const link of links) graph.links.push({ ...link });
    },
  };
}

/**
 * Connect two ports. Null where the model would refuse the link.
 *
 * **The displaced link is remembered.** Connecting over an occupied input replaces what was there,
 * and an undo that only removed the new link would leave the input empty — which is not the state
 * anybody was in.
 */
export function connectCommand(
  graph: Graph,
  vocabulary: Vocabulary,
  link: GraphLink,
): Command | null {
  const displaced = inputLink(graph, link.to, link.toPort);
  const held = displaced === undefined ? null : { ...displaced };

  /* Tried once here so a refusal is `null` rather than a command that does nothing. */
  if (!addLink(graph, vocabulary, link)) return null;
  removeLink(graph, link);
  if (held !== null) graph.links.push(held);

  return {
    label: 'Connect',
    apply: (): void => {
      addLink(graph, vocabulary, link);
    },
    revert: (): void => {
      removeLink(graph, link);
      if (held !== null) graph.links.push({ ...held });
    },
  };
}

export function disconnectCommand(graph: Graph, link: GraphLink): Command | null {
  if (inputLink(graph, link.to, link.toPort) === undefined) return null;
  const held = { ...link };
  return {
    label: 'Disconnect',
    apply: (): void => {
      removeLink(graph, held);
    },
    revert: (): void => {
      graph.links.push({ ...held });
    },
  };
}

/** A move, which absorbs the next move of the same nodes. See `vectorEditCommand` for the shape. */
interface MoveEdit extends Command {
  readonly graph: Graph;
  readonly ids: readonly number[];
  dx: number;
  dy: number;
}

/**
 * Move nodes by a delta. Null for a move of nothing or of nowhere.
 *
 * Identity for merging is the set of nodes, so dragging one node and then another stays two
 * entries — comparing by label would make them one, and undoing a move of the second would move
 * the first.
 */
export function moveNodesCommand(
  graph: Graph,
  ids: readonly number[],
  dx: number,
  dy: number,
): Command | null {
  const live = ids.filter((id) => nodeOf(graph, id) !== undefined);
  if (live.length === 0 || (dx === 0 && dy === 0)) return null;

  const shift = (by: number, byY: number): void => {
    for (const id of live) {
      const node = nodeOf(graph, id);
      if (node === undefined) continue;
      node.x += by;
      node.y += byY;
    }
  };

  const edit: MoveEdit = {
    label: live.length === 1 ? 'Move node' : `Move ${live.length} nodes`,
    graph,
    ids: live,
    dx,
    dy,
    apply: (): void => shift(edit.dx, edit.dy),
    revert: (): void => shift(-edit.dx, -edit.dy),
    merge: (next: Command): boolean => {
      const other = next as Partial<MoveEdit>;
      if (other.graph !== graph || other.ids === undefined) return false;
      if (other.ids.length !== live.length) return false;
      if (!other.ids.every((id, at) => id === live[at])) return false;
      edit.dx += other.dx ?? 0;
      edit.dy += other.dy ?? 0;
      return true;
    },
  };
  return edit;
}

/** What a copy holds: nodes as they were, and only the links with both ends in the selection. */
export interface Subgraph {
  readonly nodes: readonly GraphNode[];
  readonly links: readonly GraphLink[];
}

/**
 * The selection as something that can be pasted.
 *
 * **Only links with both ends inside.** A link with one end outside would land on whatever node
 * happened to carry that identifier in the graph it was pasted into, which is a connection nobody
 * made.
 */
export function subgraphOf(graph: Graph, ids: readonly number[]): Subgraph {
  const nodes = graph.nodes
    .filter((node) => ids.includes(node.id))
    .map((node) => ({ ...node, params: { ...node.params } }));
  const links = graph.links
    .filter((link) => ids.includes(link.from) && ids.includes(link.to))
    .map((link) => ({ ...link }));
  return { nodes, links };
}

/**
 * Paste a subgraph at an offset, renumbered.
 *
 * **Renumbering is the whole of it.** Pasted into the graph it was copied from, the originals'
 * identifiers already exist: the copies would collide, and the copied links would wire the
 * originals to each other. The offset is applied to the top-left of the copy so the shape is kept
 * and the copy is not hidden exactly under what it came from.
 */
export function pasteSubgraphCommand(
  graph: Graph,
  clipboard: Subgraph,
  x: number,
  y: number,
): Command | null {
  if (clipboard.nodes.length === 0) return null;

  const originX = Math.min(...clipboard.nodes.map((node) => node.x));
  const originY = Math.min(...clipboard.nodes.map((node) => node.y));
  const renumbered = new Map<number, number>();
  const made: GraphNode[] = [];
  for (const node of clipboard.nodes) {
    const id = graph.nextId;
    graph.nextId += 1;
    renumbered.set(node.id, id);
    made.push({
      id,
      kind: node.kind,
      x: x + (node.x - originX),
      y: y + (node.y - originY),
      params: { ...node.params },
    });
  }
  const links = clipboard.links.map((link) => ({
    from: renumbered.get(link.from) as number,
    fromPort: link.fromPort,
    to: renumbered.get(link.to) as number,
    toPort: link.toPort,
  }));

  return {
    label: `Paste ${made.length} nodes`,
    apply: (): void => {
      for (const node of made) graph.nodes.push(node);
      for (const link of links) graph.links.push({ ...link });
    },
    revert: (): void => {
      for (const link of links) removeLink(graph, link);
      for (const node of made) {
        const at = graph.nodes.indexOf(node);
        if (at >= 0) graph.nodes.splice(at, 1);
      }
    },
  };
}

/** Re-exported so a caller building a graph editor needs one import rather than two. */
export { addNode };
