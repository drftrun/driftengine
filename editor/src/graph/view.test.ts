import { describe, expect, it } from 'vitest';
import { createSpriteBatch, createTheme, createUiNode } from '@driftengine/ui2d';
import { createUndoStack, pointerEvent, treeShape, wheelEvent } from '@driftengine/tools';
import {
  addNode,
  createGraph,
  createVocabulary,
  inputLink,
  linksOf,
  nodeOf,
  type Graph,
} from './model.ts';
import { LINK_SEGMENTS, portPoint, specFor } from './layout.ts';
import {
  LINK_GRAB_PX,
  MAX_ZOOM,
  MIN_ZOOM,
  PORT_GRAB_PX,
  buildGraphGeometry,
  createGraphGeometry,
  createGraphView,
  drawGraph,
  drawnNodeBox,
  drawnPortPoint,
  graphToScreen,
  hitTestGraph,
  panView,
  routeGraphPointer,
  screenToGraph,
  strokeGraphLinks,
  zoomViewAt,
  type GraphGeometry,
  type GraphView,
} from './view.ts';

const VOCABULARY = createVocabulary([
  { kind: 'source', inputs: [], outputs: [{ name: 'out', type: 'number' }] },
  {
    kind: 'one',
    inputs: [{ name: 'a', type: 'number' }],
    outputs: [{ name: 'out', type: 'number' }],
  },
  { kind: 'paint', inputs: [], outputs: [{ name: 'colour', type: 'colour' }] },
]);

const THEME = createTheme({});

interface Scene {
  graph: Graph;
  view: GraphView;
  geometry: GraphGeometry;
  rebuild(): void;
}

/**
 * Two nodes and the link between them, placed so the curve's shape is arithmetic somebody checked:
 * the output sits at (140, 28) and the input at (340, 228), exactly 200 right and 200 down.
 */
function scene(linked = true): Scene {
  const graph = createGraph();
  addNode(graph, 'source', 0, 0);
  addNode(graph, 'one', 340, 200);
  if (linked) graph.links.push({ from: 1, fromPort: 0, to: 2, toPort: 0 });
  const view = createGraphView();
  const geometry = createGraphGeometry();
  const rebuild = (): void => {
    buildGraphGeometry(graph, VOCABULARY, view, geometry);
  };
  rebuild();
  return { graph, view, geometry, rebuild };
}

const xy = new Float64Array(2);
const box = new Float64Array(4);

describe('one transform, used by the draw and by the hit test', () => {
  it('maps a graph point to the screen and back', () => {
    const view = createGraphView({ panX: 10, panY: 20, zoom: 2 });
    expect([...graphToScreen(view, 30, 40, xy)]).toEqual([40, 40]);
    expect([...screenToGraph(view, 40, 40, xy)]).toEqual([30, 40]);
  });

  it('moves the picture by exactly what the pan asked for', () => {
    const view = createGraphView({ zoom: 2 });
    const before = [...graphToScreen(view, 7, 9, xy)];
    panView(view, 25, -10);
    const after = [...graphToScreen(view, 7, 9, xy)];
    expect(after[0]).toBeCloseTo((before[0] as number) + 25, 10);
    expect(after[1]).toBeCloseTo((before[1] as number) - 10, 10);
  });

  it('zooms about the pointer, so what is under it stays under it', () => {
    const view = createGraphView({ panX: -13, panY: 41, zoom: 0.8 });
    for (const factor of [1.7, 0.45, 3.1]) {
      const kept = [...screenToGraph(view, 200, 150, xy)];
      zoomViewAt(view, factor, 200, 150);
      const now = [...graphToScreen(view, kept[0] as number, kept[1] as number, xy)];
      expect(now[0]).toBeCloseTo(200, 8);
      expect(now[1]).toBeCloseTo(150, 8);
    }
  });

  it('refuses a zoom past either end', () => {
    const view = createGraphView();
    zoomViewAt(view, 1000, 0, 0);
    expect(view.zoom).toBe(MAX_ZOOM);
    zoomViewAt(view, 0.0001, 0, 0);
    expect(view.zoom).toBe(MIN_ZOOM);
  });

  it('draws a port where the transform puts the port the layout computed', () => {
    const { graph, view, geometry, rebuild } = scene();
    view.panX = -30;
    view.panY = 17;
    view.zoom = 1.6;
    rebuild();

    const node = nodeOf(graph, 1);
    if (node === undefined) throw new Error('no node');
    const inGraph = portPoint(
      specFor(VOCABULARY, 'source'),
      node,
      'output',
      0,
      new Float64Array(2),
    );
    const expected = graphToScreen(view, inGraph[0] as number, inGraph[1] as number, xy);
    const wanted = [expected[0] as number, expected[1] as number];

    expect(drawnPortPoint(geometry, 1, 'output', 0, xy)).toBe(true);
    expect(xy[0]).toBeCloseTo(wanted[0] as number, 10);
    expect(xy[1]).toBeCloseTo(wanted[1] as number, 10);
  });
});

describe('hit testing reads what was drawn', () => {
  it('finds a port at its drawn position', () => {
    const { view, geometry } = scene();
    expect(drawnPortPoint(geometry, 1, 'output', 0, xy)).toBe(true);
    expect([...xy]).toEqual([140, 28]);
    expect(hitTestGraph(geometry, 140, 28)).toEqual({
      kind: 'port',
      node: 1,
      port: 0,
      side: 'output',
    });
  });

  it('still finds it after a pan and a zoom', () => {
    const { view, geometry, rebuild } = scene();
    drawnPortPoint(geometry, 1, 'output', 0, xy);
    const before = [...xy];

    panView(view, 37, -19);
    zoomViewAt(view, 1.7, 200, 150);
    rebuild();

    expect(drawnPortPoint(geometry, 1, 'output', 0, xy)).toBe(true);
    expect([...xy]).not.toEqual(before);
    expect(hitTestGraph(geometry, xy[0] as number, xy[1] as number)).toEqual({
      kind: 'port',
      node: 1,
      port: 0,
      side: 'output',
    });
  });

  it('prefers a port to the body it sits on', () => {
    const { view, geometry } = scene();
    /* Two pixels inside the right edge, which is both inside the node's box and on its port. */
    expect(hitTestGraph(geometry, 138, 28)).toEqual({
      kind: 'port',
      node: 1,
      port: 0,
      side: 'output',
    });
    expect(hitTestGraph(geometry, 70, 10)).toEqual({ kind: 'node', node: 1 });
  });

  it('finds nothing where nothing is', () => {
    const { view, geometry } = scene();
    expect(hitTestGraph(geometry, 900, 900)).toBeNull();
  });

  it('keeps a port hittable when the drawn circle is too small to hit', () => {
    const { view, geometry, rebuild } = scene();
    /* Node 2's output has no link on it, so nothing else can answer for these points. */
    expect(hitTestGraph(geometry, 486, 228)?.kind).toBe('port');
    expect(hitTestGraph(geometry, 489, 228)).toBeNull();

    view.zoom = 0.25;
    rebuild();
    drawnPortPoint(geometry, 2, 'output', 0, xy);
    expect([...xy]).toEqual([120, 57]);
    /* The circle is a pixel and a quarter across here; the target is still seven pixels. */
    expect(hitTestGraph(geometry, 126, 57)?.kind).toBe('port');
    expect(hitTestGraph(geometry, 129, 57)).toBeNull();

    view.zoom = 3;
    rebuild();
    /* And where the circle is larger than the floor, the circle wins: fifteen pixels, not seven. */
    expect(PORT_GRAB_PX).toBe(7);
    expect(hitTestGraph(geometry, 1452, 684)?.kind).toBe('port');
  });

  it('gives the node on top where two overlap', () => {
    /* Nothing stops somebody dragging one node over another, and the one they can see is the one
       drawn last — so the hit test walks the boxes backwards. */
    const graph = createGraph();
    addNode(graph, 'source', 0, 0);
    addNode(graph, 'source', 20, 10);
    const view = createGraphView();
    const geometry = createGraphGeometry();
    buildGraphGeometry(graph, VOCABULARY, view, geometry);
    expect(hitTestGraph(geometry, 100, 30)).toEqual({ kind: 'node', node: 2 });
  });

  it('follows the link where it was drawn, not the straight line', () => {
    const { view, geometry } = scene();
    /*
     * The curve from (140, 28) to (340, 228) passes through (199.375, 59.25) at a quarter along.
     * The nearest point of the chord is (185.3125, 73.3125), nineteen and nine tenths away — so a
     * hit test that had quietly used the straight line would pass the second and fail the first.
     */
    expect(hitTestGraph(geometry, 199.375, 59.25)).toEqual({
      kind: 'link',
      link: { from: 1, fromPort: 0, to: 2, toPort: 0 },
    });
    expect(hitTestGraph(geometry, 185.3125, 73.3125)).toBeNull();
    expect(LINK_GRAB_PX).toBeLessThan(19);
  });
});

describe('drawing', () => {
  it('builds one box a node and one square a port', () => {
    const { graph, geometry } = scene();
    const root = createUiNode({ name: 'canvas' });
    drawGraph(geometry, graph, root, THEME);
    const names = root.children.map((child) => child.name);
    expect(names).toEqual(['gnode:1', 'gnode:2', 'gport:1:o0', 'gport:2:i0', 'gport:2:o0']);
    expect(treeShape(root).split('\n')).toHaveLength(6);
  });

  it('places a node box where the geometry says', () => {
    const { graph, geometry } = scene();
    const root = createUiNode({ name: 'canvas' });
    drawGraph(geometry, graph, root, THEME);
    expect(drawnNodeBox(geometry, 2, box)).toBe(true);
    expect([...box]).toEqual([340, 200, 140, 42]);
    const node = root.children[1];
    expect([node?.x, node?.y, node?.width, node?.height]).toEqual([340, 200, 140, 42]);
  });

  it('strokes a link as one rotated quad a segment, off the same points', () => {
    const { geometry } = scene();
    const batch = createSpriteBatch(64);
    strokeGraphLinks(geometry, batch, -1, 3, null);
    expect(batch.count).toBe(LINK_SEGMENTS);

    /* The first segment runs from (140, 28) to the curve's first sample; the quad's long edge is
       that segment, so its length is the distance between them. */
    const first = geometry.linkPoints;
    const dx = (first[2] as number) - (first[0] as number);
    const dy = (first[3] as number) - (first[1] as number);
    const ax = batch.instances[0] as number;
    const ay = batch.instances[1] as number;
    expect(Math.sqrt(ax * ax + ay * ay)).toBeCloseTo(Math.sqrt(dx * dx + dy * dy), 4);

    /*
     * And the segment runs down the middle of the quad rather than along one of its edges: the
     * origin plus half the short edge is the point the hit test measures from. A stroke hung off
     * its own line is drawn half a thickness from where it can be clicked. To three places, because
     * the batch is `Float32Array` and 140 comes back as 140.0000037 — a miss here is 1.5 out.
     */
    const bx = batch.instances[2] as number;
    const by = batch.instances[3] as number;
    expect((batch.instances[12] as number) + bx / 2).toBeCloseTo(first[0] as number, 3);
    expect((batch.instances[13] as number) + by / 2).toBeCloseTo(first[1] as number, 3);
  });

  it('skips a link that names a port which is not there', () => {
    /* A vocabulary can change under a saved graph, and a link left pointing at a port that has
       gone must not be drawn along a curve to nowhere. */
    const graph = createGraph();
    addNode(graph, 'source', 0, 0);
    addNode(graph, 'one', 340, 200);
    graph.links.push({ from: 1, fromPort: 3, to: 2, toPort: 0 });
    const view = createGraphView();
    const geometry = createGraphGeometry();
    buildGraphGeometry(graph, VOCABULARY, view, geometry);
    expect(geometry.linkCount).toBe(0);
    expect(hitTestGraph(geometry, 199.375, 59.25)).toBeNull();
  });

  it('reuses its arrays when the graph has stopped growing', () => {
    const { geometry, rebuild } = scene();
    const rects = geometry.nodeRects;
    const points = geometry.linkPoints;
    const keys = geometry.portKeys;
    rebuild();
    expect(geometry.nodeRects).toBe(rects);
    expect(geometry.linkPoints).toBe(points);
    expect(geometry.portKeys).toBe(keys);
  });

  it('draws a node whose kind is not in the vocabulary rather than dropping it', () => {
    const graph = createGraph();
    addNode(graph, 'not-a-kind', 5, 6);
    const view = createGraphView();
    const geometry = createGraphGeometry();
    buildGraphGeometry(graph, VOCABULARY, view, geometry);
    expect(drawnNodeBox(geometry, 1, box)).toBe(true);
    expect(box[0]).toBe(5);
    expect(drawnPortPoint(geometry, 1, 'output', 0, xy)).toBe(false);
  });
});

describe('dragging a link', () => {
  it('begins at an output and its loose end follows the pointer', () => {
    const { view, graph, geometry, rebuild } = scene(false);
    view.zoom = 2;
    rebuild();

    expect(
      routeGraphPointer(view, geometry, graph, VOCABULARY, pointerEvent('down', 280, 56)),
    ).toBe(null);
    expect(view.drag).toEqual({ kind: 'link', from: 1, fromPort: 0, x: 140, y: 28 });

    routeGraphPointer(view, geometry, graph, VOCABULARY, pointerEvent('move', 600, 400));
    expect(view.drag).toEqual({ kind: 'link', from: 1, fromPort: 0, x: 300, y: 200 });

    rebuild();
    expect(geometry.pendingActive).toBe(true);
    const last = (LINK_SEGMENTS + 1) * 2 - 2;
    expect(geometry.pendingPoints[last]).toBeCloseTo(600, 8);
    expect(geometry.pendingPoints[last + 1]).toBeCloseTo(400, 8);
  });

  it('connects when it lands on an input that can take it', () => {
    const { view, graph, geometry } = scene(false);
    const stack = createUndoStack(8);
    routeGraphPointer(view, geometry, graph, VOCABULARY, pointerEvent('down', 140, 28));
    routeGraphPointer(view, geometry, graph, VOCABULARY, pointerEvent('move', 300, 200));
    const command = routeGraphPointer(
      view,
      geometry,
      graph,
      VOCABULARY,
      pointerEvent('up', 340, 228),
    );
    if (command === null) throw new Error('the drop connected nothing');
    stack.push(command);
    expect(inputLink(graph, 2, 0)).toEqual({ from: 1, fromPort: 0, to: 2, toPort: 0 });
    expect(view.drag).toBeNull();

    stack.undo();
    expect(linksOf(graph)).toHaveLength(0);
  });

  it('refuses an input that carries a different type', () => {
    const graph = createGraph();
    addNode(graph, 'paint', 0, 0);
    addNode(graph, 'one', 340, 200);
    const view = createGraphView();
    const geometry = createGraphGeometry();
    buildGraphGeometry(graph, VOCABULARY, view, geometry);

    routeGraphPointer(view, geometry, graph, VOCABULARY, pointerEvent('down', 140, 28));
    expect(
      routeGraphPointer(view, geometry, graph, VOCABULARY, pointerEvent('up', 340, 228)),
    ).toBeNull();
    expect(linksOf(graph)).toHaveLength(0);
    expect(view.drag).toBeNull();
  });

  it("refuses an output, which would otherwise connect to that node's input of the same number", () => {
    /*
     * The drop reads the port index off whatever it landed on. Landing on node 2's *output* 0 and
     * connecting to its input 0 is a link the person never drew, and it is the shape of mistake
     * that looks like the editor connected the right thing.
     */
    const { view, graph, geometry } = scene(false);
    routeGraphPointer(view, geometry, graph, VOCABULARY, pointerEvent('down', 140, 28));
    expect(
      routeGraphPointer(view, geometry, graph, VOCABULARY, pointerEvent('up', 480, 228)),
    ).toBeNull();
    expect(linksOf(graph)).toHaveLength(0);
  });

  it('drops on nothing without complaint', () => {
    const { view, graph, geometry } = scene(false);
    routeGraphPointer(view, geometry, graph, VOCABULARY, pointerEvent('down', 140, 28));
    expect(
      routeGraphPointer(view, geometry, graph, VOCABULARY, pointerEvent('up', 900, 900)),
    ).toBeNull();
    expect(view.drag).toBeNull();
    expect(linksOf(graph)).toHaveLength(0);
  });

  it("does not begin on a link, which is the palette's business to select", () => {
    const { view, graph, geometry } = scene();
    expect(hitTestGraph(geometry, 199.375, 59.25)?.kind).toBe('link');
    expect(
      routeGraphPointer(view, geometry, graph, VOCABULARY, pointerEvent('down', 199.375, 59.25)),
    ).toBeNull();
    expect(view.drag).toBeNull();
  });

  it('does not begin at an input, which moves the node instead', () => {
    const { view, graph, geometry } = scene(false);
    routeGraphPointer(view, geometry, graph, VOCABULARY, pointerEvent('down', 340, 228));
    expect(view.drag?.kind).toBe('node');
  });
});

describe('dragging a node', () => {
  it('moves it by the pointer, in graph units', () => {
    const { view, graph, geometry, rebuild } = scene();
    view.zoom = 2;
    rebuild();
    const stack = createUndoStack(8);

    routeGraphPointer(view, geometry, graph, VOCABULARY, pointerEvent('down', 140, 20));
    expect(view.drag?.kind).toBe('node');
    const moved = routeGraphPointer(
      view,
      geometry,
      graph,
      VOCABULARY,
      pointerEvent('move', 200, 100),
    );
    if (moved === null) throw new Error('the drag moved nothing');
    stack.push(moved);
    /* Sixty screen pixels at twice the zoom is thirty graph units. */
    expect([nodeOf(graph, 1)?.x, nodeOf(graph, 1)?.y]).toEqual([30, 40]);
  });

  it('is one undo entry however many frames it took', () => {
    const { view, graph, geometry } = scene();
    const stack = createUndoStack(8);
    routeGraphPointer(view, geometry, graph, VOCABULARY, pointerEvent('down', 70, 10));
    for (const at of [80, 90, 100]) {
      const command = routeGraphPointer(
        view,
        geometry,
        graph,
        VOCABULARY,
        pointerEvent('move', at, 10),
      );
      if (command !== null) stack.push(command);
    }
    routeGraphPointer(view, geometry, graph, VOCABULARY, pointerEvent('up', 100, 10));
    /* Released, so the next move over the canvas is a hover and not more of this drag. */
    expect(view.drag).toBeNull();
    expect(nodeOf(graph, 1)?.x).toBe(30);
    expect(stack.undo()).toBe(true);
    expect(nodeOf(graph, 1)?.x).toBe(0);
    expect(stack.canUndo()).toBe(false);
  });

  it('moves the whole selection when the pressed node is in it', () => {
    const { view, graph, geometry } = scene();
    const stack = createUndoStack(8);
    routeGraphPointer(view, geometry, graph, VOCABULARY, pointerEvent('down', 70, 10), [1, 2]);
    const command = routeGraphPointer(
      view,
      geometry,
      graph,
      VOCABULARY,
      pointerEvent('move', 75, 10),
      [1, 2],
    );
    if (command === null) throw new Error('the drag moved nothing');
    stack.push(command);
    expect(nodeOf(graph, 1)?.x).toBe(5);
    expect(nodeOf(graph, 2)?.x).toBe(345);
  });
});

describe('panning and zooming the canvas', () => {
  it('pans from a press on nothing', () => {
    const { view, graph, geometry } = scene();
    expect(
      routeGraphPointer(view, geometry, graph, VOCABULARY, pointerEvent('down', 900, 900)),
    ).toBe(null);
    expect(view.drag?.kind).toBe('pan');
    routeGraphPointer(view, geometry, graph, VOCABULARY, pointerEvent('move', 925, 890));
    expect([...graphToScreen(view, 0, 0, xy)]).toEqual([25, -10]);
    routeGraphPointer(view, geometry, graph, VOCABULARY, pointerEvent('up', 925, 890));
    expect(view.drag).toBeNull();
  });

  it('pans from the middle button wherever the pointer is', () => {
    const { view, graph, geometry } = scene();
    routeGraphPointer(view, geometry, graph, VOCABULARY, pointerEvent('down', 70, 10, 1));
    expect(view.drag?.kind).toBe('pan');
  });

  it('zooms on the wheel about the pointer', () => {
    const { view, graph, geometry } = scene();
    const under = [...screenToGraph(view, 200, 150, xy)];
    routeGraphPointer(view, geometry, graph, VOCABULARY, wheelEvent(200, 150, 0, -100));
    expect(view.zoom).toBeCloseTo(1.1, 8);
    const now = [...graphToScreen(view, under[0] as number, under[1] as number, xy)];
    expect(now[0]).toBeCloseTo(200, 8);
    expect(now[1]).toBeCloseTo(150, 8);
  });

  it('zooms out when the wheel goes the other way', () => {
    const { view, graph, geometry } = scene();
    routeGraphPointer(view, geometry, graph, VOCABULARY, wheelEvent(0, 0, 0, 100));
    expect(view.zoom).toBeLessThan(1);
  });
});
