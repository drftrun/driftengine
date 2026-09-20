/**
 * Where a node sits, how big it is, where its ports are, and the curve a link is drawn along.
 *
 * **Everything here is in graph space, and that is the whole reason this file is separate from the
 * view.** A node's box, a port's centre and a link's curve are properties of the graph, not of
 * where the canvas happens to be scrolled to — so panning and zooming cannot change any of them,
 * and the one place a pan or a zoom is applied is the transform in `view.ts`. The most common
 * defect in a graph editor is a hit test that disagrees with the draw about that transform, and
 * the strongest form of not having it is having only one thing that knows about it.
 *
 * **A link's curve is computed here rather than in screen space**, so its shape does not change
 * with the zoom: the handles are a fraction of the horizontal gap in graph units, and a graph
 * zoomed out looks like the same graph rather than like one whose links have gone slack.
 *
 * **An unknown node kind gets a body and no ports.** The model deliberately lets a graph hold a
 * kind the vocabulary lacks — `validateGraph` reports it, `addNode` does not refuse it — and a
 * layout that skipped such a node would make the thing that is wrong the one thing you cannot see.
 */
import { type Command } from '@driftengine/tools';
import type { Graph, GraphNode, NodeSpec, Vocabulary } from './model.ts';
import { topologicalOrder } from './model.ts';

/** Graph units. Every node is the same width, which is what keeps columns from overlapping. */
export const NODE_WIDTH = 140;
/** The strip above the first port, where the kind is written. */
export const NODE_HEADER = 20;
/** One port to the next, down a node's edge. */
export const PORT_SPACING = 16;
/** Below the last port, so a port is not flush with the bottom edge. */
export const NODE_FOOT = 6;
/** The radius a port is drawn at, in graph units. `view.ts` says what it is *grabbed* at. */
export const PORT_RADIUS = 5;

/** Between one column of nodes and the next. */
export const COLUMN_GAP = 60;
/** Between one node and the node below it in the same column. */
export const ROW_GAP = 24;

/** How many straight pieces a link's curve is drawn and hit-tested as. */
export const LINK_SEGMENTS = 12;
/** The shortest a curve's handles may be, so a link between two close ports still bows. */
export const LINK_MIN_HANDLE = 40;

/** Which edge of a node a port is on. */
export type PortSide = 'input' | 'output';

/** What a node with a kind the vocabulary does not have is laid out as. See the header. */
const UNKNOWN: NodeSpec = { kind: '', inputs: [], outputs: [] };

/** The spec for a kind, or the portless one. Never undefined, so no caller has a second path. */
export function specFor(vocabulary: Vocabulary, kind: string): NodeSpec {
  return vocabulary.get(kind) ?? UNKNOWN;
}

/**
 * How tall a node is.
 *
 * **The busier side decides**, because the two columns of ports are drawn side by side and the box
 * has to hold the longer of them. A height from the inputs alone is right until the first node
 * with more outputs than inputs, and then its last output hangs below the box.
 */
export function nodeHeight(spec: NodeSpec): number {
  const rows = Math.max(spec.inputs.length, spec.outputs.length);
  return NODE_HEADER + rows * PORT_SPACING + NODE_FOOT;
}

/** A node's box in graph space: x, y, width, height. */
export function nodeBox(spec: NodeSpec, node: GraphNode, out: Float64Array): Float64Array {
  out[0] = node.x;
  out[1] = node.y;
  out[2] = NODE_WIDTH;
  out[3] = nodeHeight(spec);
  return out;
}

/**
 * The centre of one port, in graph space.
 *
 * Inputs are on the left edge and outputs on the right, which is what makes a link read left to
 * right and is why the curve's handles are horizontal.
 */
export function portPoint(
  spec: NodeSpec,
  node: GraphNode,
  side: PortSide,
  port: number,
  out: Float64Array,
): Float64Array {
  out[0] = side === 'input' ? node.x : node.x + NODE_WIDTH;
  out[1] = node.y + NODE_HEADER + (port + 0.5) * PORT_SPACING;
  return out;
}

/** Whether a node of this kind has that port at all. */
export function hasPort(spec: NodeSpec, side: PortSide, port: number): boolean {
  const ports = side === 'input' ? spec.inputs : spec.outputs;
  return port >= 0 && port < ports.length;
}

/**
 * A point along the curve joining two ports, at `t` from 0 to 1.
 *
 * A cubic with both handles horizontal: out of the output to the right, into the input from the
 * left. That is what makes a link that doubles back read as a loop rather than as a line crossing
 * its own nodes — and the handle length grows with the gap so a long link is not a tight S.
 */
export function linkCurvePoint(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  t: number,
  out: Float64Array,
): Float64Array {
  const handle = Math.max(LINK_MIN_HANDLE, Math.abs(x1 - x0) * 0.5);
  const cx0 = x0 + handle;
  const cx1 = x1 - handle;
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  out[0] = a * x0 + b * cx0 + c * cx1 + d * x1;
  out[1] = a * y0 + b * y0 + c * y1 + d * y1;
  return out;
}

/**
 * Put every node in a column past everything that feeds it, and stack each column without overlap.
 *
 * **Reads the graph and never the current positions**, so tidying is not path-dependent: the same
 * graph arranges the same way whether it has just been made, dragged about for an hour, or
 * arranged already. An arrangement that used where the nodes are would shuffle the picture every
 * time somebody pressed the button, which is the complaint people have about automatic layout.
 *
 * **The column is the longest path, not the shortest.** With the shortest, a node fed by both a
 * source and a node two columns along would sit beside its own input and the link would run
 * backwards past it.
 *
 * **Nodes on a cycle are placed in one column past the rest.** A topological order cannot reach
 * them, and dropping them would leave the broken part of a broken graph invisible.
 */
export function arrangeGraph(graph: Graph, vocabulary: Vocabulary): void {
  const layer = new Map<number, number>();
  const order: number[] = [];
  topologicalOrder(graph, order);

  for (const id of order) layer.set(id, 0);
  for (const id of order) {
    for (const link of graph.links) {
      if (link.from !== id) continue;
      const already = layer.get(link.to);
      if (already === undefined) continue;
      layer.set(link.to, Math.max(already, (layer.get(id) as number) + 1));
    }
  }

  let deepest = -1;
  for (const value of layer.values()) deepest = Math.max(deepest, value);
  for (const node of graph.nodes) {
    if (!layer.has(node.id)) layer.set(node.id, deepest + 1);
  }

  /* Columns in order, each holding its nodes in identifier order to begin with. */
  const columns = new Map<number, number[]>();
  for (const node of graph.nodes) {
    const at = layer.get(node.id) as number;
    const column = columns.get(at);
    if (column === undefined) columns.set(at, [node.id]);
    else column.push(node.id);
  }
  for (const column of columns.values()) column.sort((a, b) => a - b);

  /*
   * Then each column after the first is reordered by where its feeders sit in the column before,
   * which is what stops two links crossing for no reason. Ties keep identifier order, so the
   * result is still one answer rather than whichever the sort happened to produce.
   */
  const row = new Map<number, number>();
  const slots = [...columns.keys()].sort((a, b) => a - b);
  for (const at of slots) {
    const column = columns.get(at) as number[];
    const centre = new Map<number, number>();
    for (const id of column) {
      let sum = 0;
      let count = 0;
      for (const link of graph.links) {
        if (link.to !== id) continue;
        const where = row.get(link.from);
        if (where === undefined) continue;
        sum += where;
        count += 1;
      }
      centre.set(id, count === 0 ? -1 : sum / count);
    }
    column.sort((a, b) => (centre.get(a) as number) - (centre.get(b) as number) || a - b);
    column.forEach((id, index) => row.set(id, index));
  }

  for (const at of slots) {
    const column = columns.get(at) as number[];
    let y = 0;
    for (const id of column) {
      const node = graph.nodes.find((other) => other.id === id);
      if (node === undefined) continue;
      node.x = at * (NODE_WIDTH + COLUMN_GAP);
      node.y = y;
      y += nodeHeight(specFor(vocabulary, node.kind)) + ROW_GAP;
    }
  }
}

/**
 * Arranging, as something the undo stack owns. Null where every node is already in place.
 *
 * **Built without arranging.** The stack applies a command exactly once, so a command that had
 * already done its work on the way out would do it twice — the defect that made a gizmo drag move
 * twice as far as the pointer. The new positions are computed here and then put back, and `apply`
 * is what installs them.
 */
export function arrangeCommand(graph: Graph, vocabulary: Vocabulary): Command | null {
  const ids = graph.nodes.map((node) => node.id);
  const before = graph.nodes.map((node) => [node.x, node.y] as const);
  arrangeGraph(graph, vocabulary);
  const after = graph.nodes.map((node) => [node.x, node.y] as const);

  const place = (to: readonly (readonly [number, number])[]): void => {
    ids.forEach((id, at) => {
      const node = graph.nodes.find((other) => other.id === id);
      const put = to[at];
      if (node === undefined || put === undefined) return;
      node.x = put[0];
      node.y = put[1];
    });
  };
  place(before);

  const moved = after.some((to, at) => {
    const from = before[at] as readonly [number, number];
    return to[0] !== from[0] || to[1] !== from[1];
  });
  if (!moved) return null;

  return {
    label: 'Arrange graph',
    apply: (): void => place(after),
    revert: (): void => place(before),
  };
}
