/**
 * The canvas a graph is seen through: one transform, the geometry it produces, and what a pointer
 * does to it.
 *
 * **The hit test is not given the view, and that is the whole design.** The commonest defect in a
 * graph editor is a hit test that disagrees with the draw about the pan or the zoom — the link you
 * click is not the link you grab, and the error grows the further you scroll, so it looks like a
 * mystery rather than like arithmetic. Every way of preventing it by care fails eventually, because
 * there are two places applying the transform and nothing makes them stay the same. So there is one
 * place: `buildGraphGeometry` turns graph space into screen space once, into arrays, and both the
 * draw and the hit test read those arrays. `hitTestGraph` takes no `GraphView` at all. It cannot
 * get the transform wrong because it cannot see it.
 *
 * **A link is a polyline, not a rectangle, which is why it is not in the node tree.** `UiNode` draws
 * an axis-aligned box; a cubic curve is not one, and a link layer faked out of boxes would be drawn
 * along a path the hit test does not follow — the same defect by another route. So links are
 * tessellated into `linkPoints`, the hit test walks those points, and `strokeGraphLinks` turns the
 * same points into rotated quads through `drawSprite`. Draw and hit test share the vertices, not
 * merely the formula.
 *
 * **A port's target has a floor in screen pixels.** Drawn at five graph units, a port is a pixel
 * and a quarter across at a quarter zoom, which nobody can hit. The target is the larger of the
 * drawn circle and seven screen pixels — never smaller than what is drawn, and never smaller than
 * what a hand can find.
 */
import { addUiChild, createUiNode, drawSprite, themeRgba } from '@driftengine/ui2d';
import type { SpriteBatch, Theme, UiNode } from '@driftengine/ui2d';
import { type Command, type UiEvent } from '@driftengine/tools';
import { connectCommand, moveNodesCommand } from './commands.ts';
import {
  LINK_SEGMENTS,
  NODE_WIDTH,
  PORT_RADIUS,
  linkCurvePoint,
  nodeHeight,
  portPoint,
  specFor,
  type PortSide,
} from './layout.ts';
import { nodeOf, type Graph, type GraphLink, type Vocabulary } from './model.ts';

/** How close to a port's drawn centre counts as on it, at the least. See the header. */
export const PORT_GRAB_PX = 7;
/** How close to a link's drawn path counts as on it. Screen pixels at every zoom. */
export const LINK_GRAB_PX = 6;

export const MIN_ZOOM = 0.2;
export const MAX_ZOOM = 4;
/** One notch of the wheel, as a browser spells it in `deltaY`. */
export const WHEEL_NOTCH = 100;
/** What one notch multiplies the zoom by. */
export const ZOOM_STEP = 1.1;

/** Where the canvas is looking, and what the pointer is in the middle of doing. */
export interface GraphView {
  /** The graph point that lands on the viewport's top-left corner. */
  panX: number;
  panY: number;
  /** Screen pixels to the graph unit. */
  zoom: number;
  drag: GraphDrag | null;
}

/**
 * What a press began.
 *
 * A link drag holds its loose end in **graph** space, so panning or zooming mid-drag moves the end
 * with the graph rather than with the screen — which is what somebody dragging a wire across a
 * large graph is doing when they scroll. A pan holds its last position in **screen** space, because
 * a pan that measured itself in graph units would accelerate as it changed the very thing it
 * measures in.
 */
export type GraphDrag =
  | {
      readonly kind: 'link';
      readonly from: number;
      readonly fromPort: number;
      x: number;
      y: number;
    }
  | { readonly kind: 'node'; readonly ids: readonly number[]; x: number; y: number }
  | { readonly kind: 'pan'; x: number; y: number };

export interface GraphViewOptions {
  readonly panX?: number;
  readonly panY?: number;
  readonly zoom?: number;
}

export function createGraphView(options: GraphViewOptions = {}): GraphView {
  return {
    panX: options.panX ?? 0,
    panY: options.panY ?? 0,
    zoom: options.zoom ?? 1,
    drag: null,
  };
}

export function graphToScreen(
  view: GraphView,
  gx: number,
  gy: number,
  out: Float64Array,
): Float64Array {
  out[0] = (gx - view.panX) * view.zoom;
  out[1] = (gy - view.panY) * view.zoom;
  return out;
}

export function screenToGraph(
  view: GraphView,
  sx: number,
  sy: number,
  out: Float64Array,
): Float64Array {
  out[0] = sx / view.zoom + view.panX;
  out[1] = sy / view.zoom + view.panY;
  return out;
}

/** Move the picture by this many screen pixels. */
export function panView(view: GraphView, dx: number, dy: number): void {
  view.panX -= dx / view.zoom;
  view.panY -= dy / view.zoom;
}

/**
 * Multiply the zoom, keeping whatever is under `(x, y)` under it.
 *
 * **Anchored rather than centred**, because a zoom about the middle of the viewport moves the thing
 * somebody is looking at off the edge — they point at what they want to see and then have to chase
 * it. Clamped at both ends, so a hard scroll cannot reach a zoom of zero, where the inverse
 * transform divides by it.
 */
export function zoomViewAt(view: GraphView, factor: number, x: number, y: number): void {
  const before = screenToGraph(view, x, y, SCRATCH);
  const gx = before[0] as number;
  const gy = before[1] as number;
  view.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, view.zoom * factor));
  view.panX = gx - x / view.zoom;
  view.panY = gy - y / view.zoom;
}

const SCRATCH = new Float64Array(2);
const SCRATCH2 = new Float64Array(2);

/**
 * Everything drawn, in screen space, and the only thing the hit test consults.
 *
 * Typed arrays that grow to fit and are then reused, so rebuilding every frame — which is what a
 * canvas being panned does — allocates nothing once the graph has stopped growing.
 */
export interface GraphGeometry {
  /** One identifier a node, in draw order. */
  nodeIds: Int32Array;
  /** Four floats a node: x, y, width, height. */
  nodeRects: Float64Array;
  nodeCount: number;
  /** Three ints a port: the node, the port index, and 0 for an input or 1 for an output. */
  portKeys: Int32Array;
  /** Two floats a port: the centre it is drawn at. */
  portPoints: Float64Array;
  portCount: number;
  /** What a port is drawn at, in screen pixels. The grab radius is never below it. */
  portRadius: number;
  /** One index into `graph.links` a link, in the order they were tessellated. */
  linkAt: Int32Array;
  /** `(LINK_SEGMENTS + 1) * 2` floats a link. */
  linkPoints: Float64Array;
  linkCount: number;
  /** Whether a link drag is in progress and `pendingPoints` holds its curve. */
  pendingActive: boolean;
  pendingPoints: Float64Array;
  /** The links themselves, so a hit can name one without the caller holding the graph. */
  links: GraphLink[];
}

const CURVE_FLOATS = (LINK_SEGMENTS + 1) * 2;

export function createGraphGeometry(): GraphGeometry {
  return {
    nodeIds: new Int32Array(0),
    nodeRects: new Float64Array(0),
    nodeCount: 0,
    portKeys: new Int32Array(0),
    portPoints: new Float64Array(0),
    portCount: 0,
    portRadius: PORT_RADIUS,
    linkAt: new Int32Array(0),
    linkPoints: new Float64Array(0),
    linkCount: 0,
    pendingActive: false,
    pendingPoints: new Float64Array(CURVE_FLOATS),
    links: [],
  };
}

function growInt(array: Int32Array, need: number): Int32Array {
  return array.length >= need ? array : new Int32Array(need);
}

function growFloat(array: Float64Array, need: number): Float64Array {
  return array.length >= need ? array : new Float64Array(need);
}

/**
 * Turn the graph into screen-space geometry. The one place the transform is applied.
 *
 * Positions come from `layout.ts` in graph units and are put through `graphToScreen` here; nothing
 * downstream sees a graph coordinate again.
 */
export function buildGraphGeometry(
  graph: Graph,
  vocabulary: Vocabulary,
  view: GraphView,
  geometry: GraphGeometry,
): void {
  const nodes = graph.nodes.length;
  geometry.nodeIds = growInt(geometry.nodeIds, nodes);
  geometry.nodeRects = growFloat(geometry.nodeRects, nodes * 4);
  geometry.nodeCount = 0;

  let ports = 0;
  for (const node of graph.nodes) {
    const spec = specFor(vocabulary, node.kind);
    ports += spec.inputs.length + spec.outputs.length;
  }
  geometry.portKeys = growInt(geometry.portKeys, ports * 3);
  geometry.portPoints = growFloat(geometry.portPoints, ports * 2);
  geometry.portCount = 0;
  geometry.portRadius = PORT_RADIUS * view.zoom;

  for (const node of graph.nodes) {
    const spec = specFor(vocabulary, node.kind);
    const at = geometry.nodeCount;
    graphToScreen(view, node.x, node.y, SCRATCH);
    geometry.nodeIds[at] = node.id;
    geometry.nodeRects[at * 4] = SCRATCH[0] as number;
    geometry.nodeRects[at * 4 + 1] = SCRATCH[1] as number;
    geometry.nodeRects[at * 4 + 2] = NODE_WIDTH * view.zoom;
    geometry.nodeRects[at * 4 + 3] = nodeHeight(spec) * view.zoom;
    geometry.nodeCount += 1;

    for (const side of ['input', 'output'] as const) {
      const list = side === 'input' ? spec.inputs : spec.outputs;
      for (let port = 0; port < list.length; port += 1) {
        portPoint(spec, node, side, port, SCRATCH2);
        graphToScreen(view, SCRATCH2[0] as number, SCRATCH2[1] as number, SCRATCH);
        const slot = geometry.portCount;
        geometry.portKeys[slot * 3] = node.id;
        geometry.portKeys[slot * 3 + 1] = port;
        geometry.portKeys[slot * 3 + 2] = side === 'input' ? 0 : 1;
        geometry.portPoints[slot * 2] = SCRATCH[0] as number;
        geometry.portPoints[slot * 2 + 1] = SCRATCH[1] as number;
        geometry.portCount += 1;
      }
    }
  }

  geometry.linkAt = growInt(geometry.linkAt, graph.links.length);
  geometry.linkPoints = growFloat(geometry.linkPoints, graph.links.length * CURVE_FLOATS);
  geometry.linkCount = 0;
  geometry.links = graph.links;

  for (let index = 0; index < graph.links.length; index += 1) {
    const link = graph.links[index] as GraphLink;
    if (!endpoints(graph, vocabulary, link.from, 'output', link.fromPort, SCRATCH)) continue;
    const x0 = SCRATCH[0] as number;
    const y0 = SCRATCH[1] as number;
    if (!endpoints(graph, vocabulary, link.to, 'input', link.toPort, SCRATCH)) continue;
    const slot = geometry.linkCount;
    geometry.linkAt[slot] = index;
    tessellate(view, x0, y0, SCRATCH[0] as number, SCRATCH[1] as number, geometry.linkPoints, slot);
    geometry.linkCount += 1;
  }

  const drag = view.drag;
  geometry.pendingActive = false;
  if (drag !== null && drag.kind === 'link') {
    if (endpoints(graph, vocabulary, drag.from, 'output', drag.fromPort, SCRATCH)) {
      tessellate(
        view,
        SCRATCH[0] as number,
        SCRATCH[1] as number,
        drag.x,
        drag.y,
        geometry.pendingPoints,
        0,
      );
      geometry.pendingActive = true;
    }
  }
}

/** A port's centre in **graph** space, or false where the node or the port is not there. */
function endpoints(
  graph: Graph,
  vocabulary: Vocabulary,
  id: number,
  side: PortSide,
  port: number,
  out: Float64Array,
): boolean {
  const node = nodeOf(graph, id);
  if (node === undefined) return false;
  const spec = specFor(vocabulary, node.kind);
  const list = side === 'input' ? spec.inputs : spec.outputs;
  if (port < 0 || port >= list.length) return false;
  portPoint(spec, node, side, port, out);
  return true;
}

/** Sample the curve in graph space and put every sample through the transform. */
function tessellate(
  view: GraphView,
  gx0: number,
  gy0: number,
  gx1: number,
  gy1: number,
  into: Float64Array,
  slot: number,
): void {
  const base = slot * CURVE_FLOATS;
  for (let step = 0; step <= LINK_SEGMENTS; step += 1) {
    linkCurvePoint(gx0, gy0, gx1, gy1, step / LINK_SEGMENTS, SCRATCH2);
    graphToScreen(view, SCRATCH2[0] as number, SCRATCH2[1] as number, SCRATCH2);
    into[base + step * 2] = SCRATCH2[0] as number;
    into[base + step * 2 + 1] = SCRATCH2[1] as number;
  }
}

/** Where a node's box was drawn: x, y, width, height. False where it was not. */
export function drawnNodeBox(geometry: GraphGeometry, id: number, out: Float64Array): boolean {
  for (let at = 0; at < geometry.nodeCount; at += 1) {
    if (geometry.nodeIds[at] !== id) continue;
    out[0] = geometry.nodeRects[at * 4] as number;
    out[1] = geometry.nodeRects[at * 4 + 1] as number;
    out[2] = geometry.nodeRects[at * 4 + 2] as number;
    out[3] = geometry.nodeRects[at * 4 + 3] as number;
    return true;
  }
  return false;
}

/** Where a port was drawn. False where it was not — an unknown kind has no ports. */
export function drawnPortPoint(
  geometry: GraphGeometry,
  id: number,
  side: PortSide,
  port: number,
  out: Float64Array,
): boolean {
  const wanted = side === 'input' ? 0 : 1;
  for (let at = 0; at < geometry.portCount; at += 1) {
    if (geometry.portKeys[at * 3] !== id) continue;
    if (geometry.portKeys[at * 3 + 1] !== port) continue;
    if (geometry.portKeys[at * 3 + 2] !== wanted) continue;
    out[0] = geometry.portPoints[at * 2] as number;
    out[1] = geometry.portPoints[at * 2 + 1] as number;
    return true;
  }
  return false;
}

/** What is under a screen point, or nothing. */
export type GraphHit =
  | { readonly kind: 'port'; readonly node: number; readonly port: number; readonly side: PortSide }
  | { readonly kind: 'node'; readonly node: number }
  | { readonly kind: 'link'; readonly link: GraphLink };

/**
 * What is at this screen point.
 *
 * **Ports, then node bodies, then links**, which is the reverse of the order they are drawn in and
 * so gives the topmost thing. Ports before bodies because a port sits astride the edge of the box
 * it belongs to and is the smaller target of the two; bodies before links because a link passing
 * behind a node is not something anybody is trying to click.
 *
 * Takes no `GraphView`. See the header for why that is the point rather than an omission.
 */
export function hitTestGraph(geometry: GraphGeometry, x: number, y: number): GraphHit | null {
  const grab = Math.max(geometry.portRadius, PORT_GRAB_PX);
  let best = grab * grab;
  let found = -1;
  for (let at = 0; at < geometry.portCount; at += 1) {
    const dx = (geometry.portPoints[at * 2] as number) - x;
    const dy = (geometry.portPoints[at * 2 + 1] as number) - y;
    const distance = dx * dx + dy * dy;
    if (distance > best) continue;
    best = distance;
    found = at;
  }
  if (found >= 0) {
    return {
      kind: 'port',
      node: geometry.portKeys[found * 3] as number,
      port: geometry.portKeys[found * 3 + 1] as number,
      side: geometry.portKeys[found * 3 + 2] === 0 ? 'input' : 'output',
    };
  }

  for (let at = geometry.nodeCount - 1; at >= 0; at -= 1) {
    const rx = geometry.nodeRects[at * 4] as number;
    const ry = geometry.nodeRects[at * 4 + 1] as number;
    if (x < rx || y < ry) continue;
    if (x >= rx + (geometry.nodeRects[at * 4 + 2] as number)) continue;
    if (y >= ry + (geometry.nodeRects[at * 4 + 3] as number)) continue;
    return { kind: 'node', node: geometry.nodeIds[at] as number };
  }

  let closest = LINK_GRAB_PX * LINK_GRAB_PX;
  let link = -1;
  for (let at = 0; at < geometry.linkCount; at += 1) {
    const base = at * CURVE_FLOATS;
    for (let step = 0; step < LINK_SEGMENTS; step += 1) {
      const distance = segmentDistanceSquared(
        geometry.linkPoints[base + step * 2] as number,
        geometry.linkPoints[base + step * 2 + 1] as number,
        geometry.linkPoints[base + step * 2 + 2] as number,
        geometry.linkPoints[base + step * 2 + 3] as number,
        x,
        y,
      );
      if (distance > closest) continue;
      closest = distance;
      link = geometry.linkAt[at] as number;
    }
  }
  if (link < 0) return null;
  const hit = geometry.links[link];
  return hit === undefined ? null : { kind: 'link', link: hit };
}

function segmentDistanceSquared(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  px: number,
  py: number,
): number {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const length = dx * dx + dy * dy;
  let t = 0;
  if (length > 0) t = Math.min(1, Math.max(0, ((px - x0) * dx + (py - y0) * dy) / length));
  const ex = x0 + t * dx - px;
  const ey = y0 + t * dy - py;
  return ex * ex + ey * ey;
}

/** Enough that a graph is visible against nothing, so a theme is an override rather than a duty. */
const FALLBACKS: Readonly<Record<string, number>> = {
  'graph.node': 0x2c2c2cff,
  'graph.port': 0x8899aaff,
  'graph.link': 0x8899aaff,
};

/**
 * Fill `root` with one absolute box a node and one a port, in draw order.
 *
 * **Flat rather than ports nested under their nodes.** Nesting would make a port's position
 * relative to a box whose own position the transform already decided, which is a second place for
 * the transform to be applied and the thing this file exists to avoid. Flat, every child carries
 * the screen rectangle the geometry computed and nothing is derived twice.
 *
 * The links are not here; `strokeGraphLinks` draws those. See the header.
 */
export function drawGraph(geometry: GraphGeometry, graph: Graph, root: UiNode, theme: Theme): void {
  root.children.length = 0;
  for (let at = 0; at < geometry.nodeCount; at += 1) {
    const id = geometry.nodeIds[at] as number;
    addUiChild(
      root,
      createUiNode({
        absolute: true,
        x: geometry.nodeRects[at * 4] as number,
        y: geometry.nodeRects[at * 4 + 1] as number,
        width: geometry.nodeRects[at * 4 + 2] as number,
        height: geometry.nodeRects[at * 4 + 3] as number,
        background: themeRgba(
          theme,
          'graph.node',
          FALLBACKS['graph.node'] ?? 0,
          new Float32Array(4),
        ),
        text: nodeOf(graph, id)?.kind ?? '',
        interactive: true,
        name: `gnode:${String(id)}`,
      }),
    );
  }

  const size = geometry.portRadius * 2;
  for (let at = 0; at < geometry.portCount; at += 1) {
    const id = geometry.portKeys[at * 3] as number;
    const port = geometry.portKeys[at * 3 + 1] as number;
    const side = geometry.portKeys[at * 3 + 2] === 0 ? 'i' : 'o';
    addUiChild(
      root,
      createUiNode({
        absolute: true,
        x: (geometry.portPoints[at * 2] as number) - geometry.portRadius,
        y: (geometry.portPoints[at * 2 + 1] as number) - geometry.portRadius,
        width: size,
        height: size,
        background: themeRgba(
          theme,
          'graph.port',
          FALLBACKS['graph.port'] ?? 0,
          new Float32Array(4),
        ),
        interactive: true,
        name: `gport:${String(id)}:${side}${String(port)}`,
      }),
    );
  }
}

/**
 * Push every link, and the one being dragged, as rotated quads along the points they were
 * tessellated into.
 *
 * `drawSprite` is the only thing in `ui2d` that can draw something that is not axis-aligned, so
 * this is what "a link is drawn on ui2d" means. The pivot is the segment's start at half the
 * thickness up, so the quad's long edge *is* the segment — the same two points the hit test
 * measures against.
 */
export function strokeGraphLinks(
  geometry: GraphGeometry,
  batch: SpriteBatch,
  texture: number,
  thickness: number,
  tint: ArrayLike<number> | null,
): void {
  const stroke = (points: Float64Array, base: number): void => {
    for (let step = 0; step < LINK_SEGMENTS; step += 1) {
      const x0 = points[base + step * 2] as number;
      const y0 = points[base + step * 2 + 1] as number;
      const dx = (points[base + step * 2 + 2] as number) - x0;
      const dy = (points[base + step * 2 + 3] as number) - y0;
      const length = Math.sqrt(dx * dx + dy * dy);
      /* No guard against a zero-length segment: the handles are at least forty graph units, so the
         curve always moves between samples. Two hundred thousand curves, endpoints deliberately
         made to coincide among them, produced none shorter than 0.0066 and none of zero. */
      drawSprite(
        batch,
        texture,
        {
          x: x0,
          y: y0 - thickness / 2,
          w: length,
          h: thickness,
          rotation: Math.atan2(dy, dx),
          pivotX: 0,
          pivotY: 0.5,
        },
        null,
        tint,
      );
    }
  };

  for (let at = 0; at < geometry.linkCount; at += 1) stroke(geometry.linkPoints, at * CURVE_FLOATS);
  if (geometry.pendingActive) stroke(geometry.pendingPoints, 0);
}

/**
 * What one pointer or wheel event does. Returns a command for the world, or nothing.
 *
 * `selected` is passed in rather than held, because a selection is shared with the rest of the
 * editor and a second copy here would be a second thing to keep in step. Pressing a node that is
 * in it drags the whole selection; pressing one that is not drags that node alone, which is what
 * every editor does and what somebody who clicked the wrong thing expects.
 *
 * **Pressing an *input* starts a node drag rather than detaching the wire.** Detaching would be a
 * disconnect followed by a connect — two entries in the undo stack for one gesture — and there is
 * no compound command yet to make it one. A gesture that needs two presses of undo is worse than
 * one that is not offered.
 */
export function routeGraphPointer(
  view: GraphView,
  geometry: GraphGeometry,
  graph: Graph,
  vocabulary: Vocabulary,
  event: UiEvent,
  selected: readonly number[] = [],
): Command | null {
  if (event.kind === 'wheel') {
    zoomViewAt(view, ZOOM_STEP ** (-event.dy / WHEEL_NOTCH), event.x, event.y);
    return null;
  }
  if (event.kind !== 'pointer') return null;

  if (event.phase === 'down') return press(view, geometry, graph, vocabulary, event, selected);
  const drag = view.drag;
  if (drag === null) return null;

  if (drag.kind === 'pan') {
    panView(view, event.x - drag.x, event.y - drag.y);
    drag.x = event.x;
    drag.y = event.y;
    if (event.phase === 'up') view.drag = null;
    return null;
  }

  if (drag.kind === 'node') {
    screenToGraph(view, event.x, event.y, SCRATCH);
    const dx = (SCRATCH[0] as number) - drag.x;
    const dy = (SCRATCH[1] as number) - drag.y;
    drag.x = SCRATCH[0] as number;
    drag.y = SCRATCH[1] as number;
    if (event.phase === 'up') view.drag = null;
    return moveNodesCommand(graph, drag.ids, dx, dy);
  }

  screenToGraph(view, event.x, event.y, SCRATCH);
  drag.x = SCRATCH[0] as number;
  drag.y = SCRATCH[1] as number;
  if (event.phase !== 'up') return null;

  view.drag = null;
  const hit = hitTestGraph(geometry, event.x, event.y);
  if (hit === null || hit.kind !== 'port' || hit.side !== 'input') return null;
  return connectCommand(graph, vocabulary, {
    from: drag.from,
    fromPort: drag.fromPort,
    to: hit.node,
    toPort: hit.port,
  });
}

function press(
  view: GraphView,
  geometry: GraphGeometry,
  graph: Graph,
  vocabulary: Vocabulary,
  event: { readonly x: number; readonly y: number; readonly button: number },
  selected: readonly number[],
): null {
  /* The middle button pans from anywhere, which is how somebody moves about a graph that fills
     the canvas and has nothing empty left to press. */
  if (event.button !== 0) {
    view.drag = { kind: 'pan', x: event.x, y: event.y };
    return null;
  }

  const hit = hitTestGraph(geometry, event.x, event.y);
  if (hit === null) {
    view.drag = { kind: 'pan', x: event.x, y: event.y };
    return null;
  }

  if (hit.kind === 'port' && hit.side === 'output') {
    if (endpoints(graph, vocabulary, hit.node, 'output', hit.port, SCRATCH)) {
      view.drag = {
        kind: 'link',
        from: hit.node,
        fromPort: hit.port,
        x: SCRATCH[0] as number,
        y: SCRATCH[1] as number,
      };
    }
    return null;
  }

  if (hit.kind === 'link') return null;

  const ids = selected.includes(hit.node) ? [...selected] : [hit.node];
  screenToGraph(view, event.x, event.y, SCRATCH);
  view.drag = { kind: 'node', ids, x: SCRATCH[0] as number, y: SCRATCH[1] as number };
  return null;
}
