import { describe, expect, it } from 'vitest';
import {
  createUndoStack,
  createPanelRoot,
  keyEvent,
  pointerEvent,
  treeShape,
  wheelEvent,
} from '@driftengine/tools';
import {
  addLink,
  addNode,
  createGraph,
  nodeOf,
  type Graph,
  type Vocabulary,
} from '../graph/model.ts';
import { MATERIAL_VOCABULARY } from '../graph/material/nodes.ts';
import { PARTICLE_VOCABULARY } from '../graph/particle/nodes.ts';
import { createBehaviourVocabulary, type BehaviourWorld } from '../graph/behaviour/nodes.ts';
import { drawnPortPoint } from '../graph/view.ts';
import {
  canvasWidth,
  createGraphPanel,
  createGraphPanelView,
  previewLines,
  type GraphPanelView,
  type GraphWorld,
} from './graph.ts';

const BEHAVIOUR_WORLD: BehaviourWorld = {
  components: [{ name: 'Position', fields: ['x', 'y'] }],
};
const BEHAVIOUR_VOCABULARY = createBehaviourVocabulary(BEHAVIOUR_WORLD);

function sized(view: GraphPanelView, width: number, height: number): ReturnType<typeof root> {
  const node = root();
  node.width = width;
  node.height = height;
  view.width = width;
  view.height = height;
  return node;
}

function root(): ReturnType<typeof createPanelRoot> {
  return createPanelRoot({ id: 'graph' });
}

function material(): GraphWorld {
  const graph = createGraph();
  const colour = addNode(graph, 'constant', 0, 0);
  const out = addNode(graph, 'output', 300, 0);
  const node = nodeOf(graph, colour);
  if (node === undefined) throw new Error('no node');
  node.params = { r: 0.25, g: 0.5, b: 0.75, a: 1 };
  addLink(graph, MATERIAL_VOCABULARY, { from: colour, fromPort: 0, to: out, toPort: 0 });
  return { kind: 'material', graph, vocabulary: MATERIAL_VOCABULARY };
}

function particle(): GraphWorld {
  const graph = createGraph();
  const emitter = addNode(graph, 'emitter', 0, 0);
  const rate = addNode(graph, 'constant', 0, 0);
  const life = addNode(graph, 'constant', 0, 0);
  (nodeOf(graph, rate) as { params: Record<string, number> }).params = { value: 20 };
  (nodeOf(graph, life) as { params: Record<string, number> }).params = { value: 1 };
  addLink(graph, PARTICLE_VOCABULARY, { from: rate, fromPort: 0, to: emitter, toPort: 0 });
  addLink(graph, PARTICLE_VOCABULARY, { from: life, fromPort: 0, to: emitter, toPort: 1 });
  return { kind: 'particle', graph, vocabulary: PARTICLE_VOCABULARY };
}

function behaviour(): GraphWorld {
  const graph = createGraph();
  addNode(graph, 'query:Position', 0, 0);
  addNode(graph, 'writes:Position', 0, 0);
  const value = addNode(graph, 'const', 0, 0);
  const set = addNode(graph, 'set:Position.x', 300, 0);
  (nodeOf(graph, value) as { params: Record<string, number> }).params = { value: 5 };
  addLink(graph, BEHAVIOUR_VOCABULARY, { from: value, fromPort: 0, to: set, toPort: 0 });
  return {
    kind: 'behaviour',
    graph,
    vocabulary: BEHAVIOUR_VOCABULARY,
    behaviour: { name: 'Mover' },
  };
}

describe('the preview says what the engine will run', () => {
  it('shows a material graph as the decode program it compiled to, not as a shader', () => {
    const lines = previewLines(material());
    expect(lines[0]).toBe('DTEX decode program');
    expect(lines[1]).toContain('operations');
    /* The colour the constant carries, decoded by the same `decodeCpu` a baked texture goes
       through — so what the panel shows and what a frame draws come from one evaluator. */
    expect(lines.some((line) => line.includes('0.250 0.500 0.750 1.000'))).toBe(true);
  });

  it('shows a particle graph as emitter parameters and what a second of them does', () => {
    const lines = previewLines(particle());
    expect(lines[0]).toBe('emitter parameters');
    expect(lines.join('\n')).toContain('rate 20/s   life 1s');
    /* Twenty a second living one second is twenty alive at once, and a second of stepping gets
       there — from the real `ParticlePool`, not from a description of one. */
    expect(lines.join('\n')).toContain('capacity 20');
    /* Twenty, not "some of twenty": a preview that emitted nothing would still read "0 alive of
       20" and look like a sentence about a working emitter. */
    expect(lines.at(-1)).toBe('  20 alive of 20');
  });

  it('shows a behaviour graph as the DriftScript it emits, first and by default', () => {
    const lines = previewLines(behaviour());
    expect(lines[0]).toBe('DriftScript source');
    expect(lines.join('\n')).toContain('system Mover {');
    expect(lines.join('\n')).toContain('e.Position.x = 5');
  });

  it('says what is wrong rather than showing nothing', () => {
    /* An output with nothing feeding it: the normal state of a graph somebody is in the middle of
       making, and the preview's job is to say what it is waiting for. */
    const graph = createGraph();
    addNode(graph, 'output', 0, 0);
    const lines = previewLines({ kind: 'material', graph, vocabulary: MATERIAL_VOCABULARY });
    expect(lines[0]).toBe('DTEX decode program — not yet');
    expect(lines[1]).toContain('needs input "colour"');
  });

  it('does not run away with a long program', () => {
    const world = behaviour();
    for (let i = 0; i < 80; i += 1) {
      const value = addNode(world.graph, 'const', 0, 0);
      const set = addNode(world.graph, 'set:Position.y', 0, 0);
      addLink(world.graph, BEHAVIOUR_VOCABULARY, { from: value, fromPort: 0, to: set, toPort: 0 });
    }
    const lines = previewLines(world);
    expect(lines.length).toBeLessThan(50);
    expect(lines.at(-1)).toContain('more');
  });
});

describe('the panel is a canvas and a preview beside it', () => {
  it('opens with the preview showing', () => {
    const view = createGraphPanelView();
    expect(view.previewOpen).toBe(true);
    const panel = createGraphPanel('graph:material', 'Material');
    const node = sized(view, 800, 600);
    panel.build(material(), view, node);
    expect(node.children.map((child) => child.name)).toEqual(['graph:canvas', 'graph:preview']);
    expect([node.children[0]?.width, node.children[1]?.x]).toEqual([560, 560]);

    /* And the canvas has the graph in it. Checking only that the canvas exists would pass for a
       panel that drew an empty box, which is what a graph editor looks like when it is broken. */
    expect(node.children[0]?.children.map((child) => child.name)).toEqual([
      'gnode:1',
      'gnode:2',
      'gport:1:o0',
      'gport:2:i0',
    ]);
  });

  it('gives the canvas the whole panel when the preview is closed', () => {
    const view = createGraphPanelView();
    view.previewOpen = false;
    expect(canvasWidth(view)).toBe(0);
    const panel = createGraphPanel('graph:material', 'Material');
    const node = sized(view, 800, 600);
    panel.build(material(), view, node);
    expect(node.children.map((child) => child.name)).toEqual(['graph:canvas']);
    expect(node.children[0]?.width).toBe(800);
  });

  it('builds the same tree twice over the same world and view', () => {
    const view = createGraphPanelView();
    const panel = createGraphPanel('graph:behaviour', 'Behaviour');
    const world = behaviour();
    const first = sized(view, 800, 600);
    panel.build(world, view, first);
    const shape = treeShape(first);
    const second = sized(view, 800, 600);
    panel.build(world, view, second);
    expect(treeShape(second)).toBe(shape);
  });

  it('takes the size off its root, so a panel moved to another dock re-splits', () => {
    const view = createGraphPanelView();
    const panel = createGraphPanel('graph:material', 'Material');
    const node = root();
    node.width = 400;
    node.height = 300;
    panel.build(material(), view, node);
    expect(view.width).toBe(400);
    expect(canvasWidth(view)).toBe(160);
  });

  it('never gives the canvas a negative width, however narrow the dock', () => {
    const view = createGraphPanelView();
    const panel = createGraphPanel('graph:material', 'Material');
    const node = sized(view, 100, 300);
    panel.build(material(), view, node);
    expect(canvasWidth(view)).toBe(0);
    expect(node.children[0]?.width).toBe(0);
  });
});

describe('routing reaches the canvas and stops at the preview', () => {
  it('drags a node on the canvas and returns the command for it', () => {
    const view = createGraphPanelView();
    const panel = createGraphPanel('graph:material', 'Material');
    const world = material();
    panel.build(world, view, sized(view, 800, 600));

    expect(panel.route(world, view, pointerEvent('down', 70, 10))).toBeNull();
    const moved = panel.route(world, view, pointerEvent('move', 100, 40));
    if (moved === null) throw new Error('the drag moved nothing');
    createUndoStack(8).push(moved);
    expect([nodeOf(world.graph, 1)?.x, nodeOf(world.graph, 1)?.y]).toEqual([30, 30]);
  });

  it('connects a port on the canvas', () => {
    const view = createGraphPanelView();
    const panel = createGraphPanel('graph:behaviour', 'Behaviour');
    const world = behaviour();
    panel.build(world, view, sized(view, 800, 600));

    const from = new Float64Array(2);
    const to = new Float64Array(2);
    expect(drawnPortPoint(view.geometry, 3, 'output', 0, from)).toBe(true);
    expect(drawnPortPoint(view.geometry, 4, 'input', 0, to)).toBe(true);
    panel.route(world, view, pointerEvent('down', from[0] as number, from[1] as number));
    const command = panel.route(world, view, pointerEvent('up', to[0] as number, to[1] as number));
    /* Already connected by the fixture, so this replaces the link with the identical one — a
       command either way, which is what proves the drop reached the canvas. */
    expect(command?.label).toBe('Connect');
  });

  it('ignores a pointer over the preview, so a node cannot be grabbed through it', () => {
    const view = createGraphPanelView();
    const panel = createGraphPanel('graph:material', 'Material');
    const world = material();
    panel.build(world, view, sized(view, 800, 600));
    /* 600 is past the canvas's right edge at 560. Without the check the canvas would pan, because
       empty space is a pan and the preview is empty space as far as the geometry knows. */
    expect(panel.route(world, view, pointerEvent('down', 600, 10))).toBeNull();
    expect(view.view.drag).toBeNull();
    expect(panel.route(world, view, wheelEvent(600, 10, 0, -100))).toBeNull();
    expect(view.view.zoom).toBe(1);
  });

  it('zooms on the wheel over the canvas', () => {
    const view = createGraphPanelView();
    const panel = createGraphPanel('graph:material', 'Material');
    const world = material();
    panel.build(world, view, sized(view, 800, 600));
    panel.route(world, view, wheelEvent(200, 150, 0, -100));
    expect(view.view.zoom).toBeCloseTo(1.1, 8);
  });

  it('hides the preview on a key and shows it again', () => {
    const view = createGraphPanelView();
    const panel = createGraphPanel('graph:material', 'Material');
    const world = material();
    expect(panel.route(world, view, keyEvent('p'))).toBeNull();
    expect(view.previewOpen).toBe(false);
    panel.route(world, view, keyEvent('p'));
    expect(view.previewOpen).toBe(true);
    /* Not with a modifier: ctrl+p is a host's own, and taking it is how an editor annoys people. */
    panel.route(world, view, keyEvent('p', false, true));
    expect(view.previewOpen).toBe(true);
  });

  it('never writes the world, whichever event it is given', () => {
    const view = createGraphPanelView();
    const panel = createGraphPanel('graph:behaviour', 'Behaviour');
    const world = behaviour();
    panel.build(world, view, sized(view, 800, 600));
    const before = JSON.stringify(world.graph);
    for (const event of [
      pointerEvent('down', 70, 10),
      pointerEvent('move', 120, 60),
      pointerEvent('up', 120, 60),
      wheelEvent(100, 100, 0, -100),
      keyEvent('p'),
    ]) {
      panel.route(world, view, event);
    }
    /* Every change is a command the caller applies, so the graph itself is untouched. */
    expect(JSON.stringify(world.graph)).toBe(before);
  });
});

describe('three panels, one implementation', () => {
  it('differs only in what the preview says', () => {
    const kinds: readonly [string, GraphWorld, string][] = [
      ['graph:material', material(), 'DTEX decode program'],
      ['graph:particle', particle(), 'emitter parameters'],
      ['graph:behaviour', behaviour(), 'DriftScript source'],
    ];
    for (const [id, world, expected] of kinds) {
      const view = createGraphPanelView();
      const panel = createGraphPanel(id, id);
      const node = sized(view, 800, 600);
      panel.build(world, view, node);
      expect(panel.id).toBe(id);
      expect(node.children.map((child) => child.name)).toEqual(['graph:canvas', 'graph:preview']);
      expect(node.children[1]?.children[0]?.text).toBe(expected);
    }
  });
});

/** The vocabularies are real ones, so a panel is never tested against a shape nothing ships. */
describe('the vocabularies are the shipped ones', () => {
  it('uses each vocabulary as its own compiler does', () => {
    const each: readonly Vocabulary[] = [
      MATERIAL_VOCABULARY,
      PARTICLE_VOCABULARY,
      BEHAVIOUR_VOCABULARY,
    ];
    for (const vocabulary of each) expect(vocabulary.size).toBeGreaterThan(3);
    const empty: Graph = createGraph();
    expect(empty.nodes).toHaveLength(0);
  });
});
