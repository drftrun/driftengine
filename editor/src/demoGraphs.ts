/**
 * One graph of each kind, so the three graph panels open on something.
 *
 * **The same argument `demoScene.ts` and `demoCapture.ts` make.** A graph panel's whole reason for
 * existing is that the preview beside the canvas says what the engine will actually run; a panel
 * opened on an empty graph shows a compile error and proves nothing about either half. Nothing
 * under `models/` is committed and a project of graphs is not the engine's to ship, so the editor
 * carries one of each and a host with real assets passes its own.
 *
 * **Each one compiles.** The material to a `DTEX` decode program, the particle to the parameters
 * `ParticlePool` already takes, and the behaviour to DriftScript the language's own compiler
 * accepts — which is what makes them worth opening on rather than three shapes on a canvas.
 */
import { addLink, addNode, createGraph, nodeOf, type Graph } from './graph/model.ts';
import { MATERIAL_VOCABULARY } from './graph/material/nodes.ts';
import { PARTICLE_VOCABULARY } from './graph/particle/nodes.ts';
import { createBehaviourVocabulary, type BehaviourWorld } from './graph/behaviour/nodes.ts';
import type { GraphWorld } from './panels/graph.ts';

/** Set a node's parameters and hand its identifier back, so a graph reads as one expression. */
function withParams(graph: Graph, id: number, values: Record<string, number>): number {
  const node = nodeOf(graph, id);
  if (node !== undefined) node.params = { ...values };
  return id;
}

/** A flat colour through the output, which is the smallest thing that decodes to a texture. */
function materialGraph(): Graph {
  const graph = createGraph();
  const colour = withParams(graph, addNode(graph, 'constant', 40, 60), {
    r: 0.62,
    g: 0.44,
    b: 0.29,
    a: 1,
  });
  const noise = withParams(graph, addNode(graph, 'noise', 40, 160), { seed: 7, octaves: 3 });
  const blend = addNode(graph, 'blend', 220, 100);
  const out = addNode(graph, 'output', 400, 100);
  addLink(graph, MATERIAL_VOCABULARY, { from: noise, fromPort: 0, to: blend, toPort: 0 });
  addLink(graph, MATERIAL_VOCABULARY, { from: colour, fromPort: 0, to: blend, toPort: 1 });
  addLink(graph, MATERIAL_VOCABULARY, { from: blend, fromPort: 0, to: out, toPort: 0 });
  return graph;
}

/** A plume: ten a second, living two seconds, growing and reddening as it rises. */
function particleGraph(): Graph {
  const graph = createGraph();
  const emitter = addNode(graph, 'emitter', 420, 120);
  const inputs: [number, number][] = [
    [withParams(graph, addNode(graph, 'constant', 40, 20), { value: 10 }), 0],
    [withParams(graph, addNode(graph, 'constant', 40, 60), { value: 2 }), 1],
    [withParams(graph, addNode(graph, 'vector', 40, 100), { x: 0, y: 3, z: 0 }), 2],
    [withParams(graph, addNode(graph, 'constant', 40, 160), { value: 1.5 }), 3],
    [withParams(graph, addNode(graph, 'curve', 40, 200), { start: 0.5, end: 2 }), 4],
    [
      withParams(graph, addNode(graph, 'gradient', 40, 240), {
        r0: 1,
        g0: 0.35,
        b0: 0.1,
        r1: 0.2,
        g1: 0.2,
        b1: 0.25,
      }),
      5,
    ],
    [withParams(graph, addNode(graph, 'constant', 40, 300), { value: 0.5 }), 9],
    [withParams(graph, addNode(graph, 'constant', 40, 340), { value: 1234 }), 10],
  ];
  for (const [from, port] of inputs) {
    addLink(graph, PARTICLE_VOCABULARY, { from, fromPort: 0, to: emitter, toPort: port });
  }
  return graph;
}

/** What a project of two components looks like to the behaviour vocabulary. */
const BEHAVIOUR_WORLD: BehaviourWorld = {
  components: [
    { name: 'Position', fields: ['x', 'y'] },
    { name: 'Velocity', fields: ['x', 'y'] },
  ],
  functions: [],
};

const BEHAVIOUR_PREAMBLE = `component Position {
    x: f64 = 0
    y: f64 = 0
}

component Velocity {
    x: f64 = 0
    y: f64 = 0
}
`;

/** Position advanced by velocity: the smallest system that declares what it touches. */
function behaviourGraph(vocabulary: ReturnType<typeof createBehaviourVocabulary>): Graph {
  const graph = createGraph();
  addNode(graph, 'query:Position', 40, 20);
  addNode(graph, 'query:Velocity', 40, 60);
  addNode(graph, 'reads:Velocity', 40, 100);
  addNode(graph, 'writes:Position', 40, 140);
  const px = addNode(graph, 'get:Position.x', 40, 200);
  const vx = addNode(graph, 'get:Velocity.x', 40, 240);
  const sum = addNode(graph, 'add', 220, 220);
  const set = addNode(graph, 'set:Position.x', 400, 220);
  addLink(graph, vocabulary, { from: px, fromPort: 0, to: sum, toPort: 0 });
  addLink(graph, vocabulary, { from: vx, fromPort: 0, to: sum, toPort: 1 });
  addLink(graph, vocabulary, { from: sum, fromPort: 0, to: set, toPort: 0 });
  return graph;
}

export function demoGraphs(): readonly GraphWorld[] {
  const behaviourVocabulary = createBehaviourVocabulary(BEHAVIOUR_WORLD);
  return [
    { kind: 'material', graph: materialGraph(), vocabulary: MATERIAL_VOCABULARY },
    { kind: 'particle', graph: particleGraph(), vocabulary: PARTICLE_VOCABULARY },
    {
      kind: 'behaviour',
      graph: behaviourGraph(behaviourVocabulary),
      vocabulary: behaviourVocabulary,
      behaviour: { name: 'Movement', preamble: BEHAVIOUR_PREAMBLE },
    },
  ];
}
