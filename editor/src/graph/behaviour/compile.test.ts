import { describe, expect, it } from 'vitest';
import { compileDriftScript, singleFileHost } from 'driftscript/compiler';
import { addLink, addNode, createGraph, nodeOf, type Graph } from '../model.ts';
import { GET, createBehaviourVocabulary, fieldReference, type BehaviourWorld } from './nodes.ts';
import { compileBehaviourGraph } from './compile.ts';

const WORLD: BehaviourWorld = {
  components: [
    { name: 'Position', fields: ['x', 'y'] },
    { name: 'Velocity', fields: ['x', 'y'] },
  ],
  functions: [
    { name: 'wobble', arity: 1 },
    { name: 'mix', arity: 2 },
  ],
};

const VOCABULARY = createBehaviourVocabulary(WORLD);

/**
 * What the project already has. The graph is given it and passes it through untouched — components
 * are shared between systems and a graph does not own them.
 */
const PREAMBLE = `component Position {
    x: f64 = 0
    y: f64 = 0
}

component Velocity {
    x: f64 = 0
    y: f64 = 0
}

@pure
fn wobble(v: f64) -> f64 {
    return v * 2
}

@pure
fn mix(a: f64, b: f64) -> f64 {
    return (a + b) * 0.5
}
`;

/**
 * The real DriftScript compiler, which is the whole point of this task: the graph emits source and
 * something that is not the graph decides whether it is a program.
 *
 * Warnings are kept out of the list because an over-wide `reads` declaration is one — DS0291 — and
 * a graph is allowed to be imprecise in a way a person is warned about rather than stopped for.
 */
function errorsIn(source: string): readonly string[] {
  const result = compileDriftScript(source, {
    filename: 'Behaviour.drs',
    host: singleFileHost(),
    mode: 'development',
  });
  return result.diagnostics.filter((one) => one.severity !== 'warning').map((one) => one.code);
}

function messagesIn(source: string): readonly string[] {
  const result = compileDriftScript(source, {
    filename: 'Behaviour.drs',
    host: singleFileHost(),
    mode: 'development',
  });
  return result.diagnostics.filter((one) => one.severity !== 'warning').map((one) => one.message);
}

function movement(): Graph {
  const graph = createGraph();
  addNode(graph, 'query:Position', 0, 0);
  addNode(graph, 'query:Velocity', 0, 0);
  addNode(graph, 'reads:Velocity', 0, 0);
  addNode(graph, 'writes:Position', 0, 0);
  const px = addNode(graph, 'get:Position.x', 0, 0);
  const vx = addNode(graph, 'get:Velocity.x', 0, 0);
  const sum = addNode(graph, 'add', 0, 0);
  const set = addNode(graph, 'set:Position.x', 0, 0);
  addLink(graph, VOCABULARY, { from: px, fromPort: 0, to: sum, toPort: 0 });
  addLink(graph, VOCABULARY, { from: vx, fromPort: 0, to: sum, toPort: 1 });
  addLink(graph, VOCABULARY, { from: sum, fromPort: 0, to: set, toPort: 0 });
  return graph;
}

describe('an empty graph is still a program', () => {
  it('compiles to a system DriftScript accepts', () => {
    const { source, error } = compileBehaviourGraph(createGraph(), VOCABULARY, {
      name: 'Behaviour',
    });
    expect(error).toBeNull();
    expect(source).toBe('system Behaviour {\n    update {\n    }\n}\n');
    expect(errorsIn(source)).toEqual([]);
  });
});

describe('what the graph emits, DriftScript judges', () => {
  it('writes out a system a person can read, exactly', () => {
    const { source, error } = compileBehaviourGraph(movement(), VOCABULARY, {
      name: 'Movement',
      preamble: PREAMBLE,
    });
    expect(error).toBeNull();
    /* No `reads Position`, and the source below compiles clean: `writes` grants the read too. */
    expect(source).toBe(
      `${PREAMBLE}
system Movement {
    reads Velocity
    writes Position

    update {
        for e in query<Position, Velocity>() {
            e.Position.x = e.Position.x + e.Velocity.x
        }
    }
}
`,
    );
    expect(errorsIn(source)).toEqual([]);
  });

  it('leaves an undeclared write for the DriftScript compiler to refuse', () => {
    /*
     * The declarations come from declaration nodes, not from the write nodes — so a graph can say
     * one thing and do another, exactly as hand-written DriftScript can. If this compiler derived
     * `writes` from the set nodes the mistake would be impossible and the effect check would be
     * happening twice, in two places, which is the thing this whole task exists to avoid.
     */
    const graph = movement();
    const declaration = graph.nodes.find((node) => node.kind === 'writes:Position');
    if (declaration === undefined) throw new Error('no declaration to remove');
    graph.nodes.splice(graph.nodes.indexOf(declaration), 1);

    const { source, error } = compileBehaviourGraph(graph, VOCABULARY, {
      name: 'Movement',
      preamble: PREAMBLE,
    });
    expect(error).toBeNull();
    expect(source).toContain('e.Position.x = ');
    expect(source).not.toContain('writes Position');

    /*
     * Two of them, and the second is the one worth writing down: `writes Position` grants the read
     * as well, which is why the working version above declares no `reads Position` while reading
     * the field. Take the declaration away and the read is undeclared too.
     */
    expect(errorsIn(source)).toEqual(['DS0288', 'DS0288']);
    const said = messagesIn(source);
    expect(said[0]).toContain('writes `Position` and does not declare it');
    expect(said[1]).toContain('reads `Position` and does not declare it');
  });

  it('passes a hand-written function through unchanged and calls it', () => {
    const graph = createGraph();
    addNode(graph, 'query:Position', 0, 0);
    addNode(graph, 'writes:Position', 0, 0);
    const px = addNode(graph, 'get:Position.x', 0, 0);
    const call = addNode(graph, 'call:wobble', 0, 0);
    const set = addNode(graph, 'set:Position.x', 0, 0);
    addLink(graph, VOCABULARY, { from: px, fromPort: 0, to: call, toPort: 0 });
    addLink(graph, VOCABULARY, { from: call, fromPort: 0, to: set, toPort: 0 });

    const { source, error } = compileBehaviourGraph(graph, VOCABULARY, {
      name: 'Wobbler',
      preamble: PREAMBLE,
    });
    expect(error).toBeNull();
    expect(source).toContain('e.Position.x = wobble(e.Position.x)');
    expect(source).toContain('fn wobble(v: f64) -> f64 {\n    return v * 2\n}');
    expect(errorsIn(source)).toEqual([]);
  });

  it('emits a rate the language has its own form for', () => {
    const { source } = compileBehaviourGraph(movement(), VOCABULARY, {
      name: 'Movement',
      preamble: PREAMBLE,
      rateHz: 20,
    });
    expect(source).toContain('    update at 20Hz {');
    expect(errorsIn(source)).toEqual([]);
  });
});

describe('the source does not move on its own', () => {
  it('lists the declarations alphabetically, not in the order somebody added the nodes', () => {
    /* Added Velocity first and Position second, so node order and alphabetical order disagree. */
    const graph = createGraph();
    addNode(graph, 'query:Position', 0, 0);
    addNode(graph, 'reads:Velocity', 0, 0);
    addNode(graph, 'reads:Position', 0, 0);
    addNode(graph, 'writes:Velocity', 0, 0);
    addNode(graph, 'writes:Position', 0, 0);
    const { source } = compileBehaviourGraph(graph, VOCABULARY, { name: 'Declarer' });
    expect(source).toContain(
      '    reads Position\n    reads Velocity\n    writes Position\n    writes Velocity\n',
    );
  });

  it('is byte-identical between two compiles', () => {
    const graph = movement();
    const first = compileBehaviourGraph(graph, VOCABULARY, { name: 'Movement' }).source;
    const second = compileBehaviourGraph(graph, VOCABULARY, { name: 'Movement' }).source;
    expect(second).toBe(first);
  });

  it('does not change when the nodes are dragged about', () => {
    /*
     * Statement order is by identifier, which is creation order, and deliberately not by position:
     * tidying a graph must not rewrite the program, and a diff caused by moving a box is a diff
     * nobody can review.
     */
    const graph = createGraph();
    addNode(graph, 'query:Position', 0, 0);
    addNode(graph, 'writes:Position', 0, 0);
    const one = addNode(graph, 'const', 0, 0);
    const two = addNode(graph, 'const', 0, 0);
    const setX = addNode(graph, 'set:Position.x', 0, 0);
    const setY = addNode(graph, 'set:Position.y', 0, 0);
    (nodeOf(graph, one) as { params: Record<string, number> }).params['value'] = 3;
    (nodeOf(graph, two) as { params: Record<string, number> }).params['value'] = 4;
    addLink(graph, VOCABULARY, { from: one, fromPort: 0, to: setX, toPort: 0 });
    addLink(graph, VOCABULARY, { from: two, fromPort: 0, to: setY, toPort: 0 });

    const before = compileBehaviourGraph(graph, VOCABULARY, { name: 'Setter' }).source;
    expect(before).toContain('            e.Position.x = 3\n            e.Position.y = 4\n');

    for (const node of graph.nodes) {
      node.x = node.id * -313;
      node.y = 1000 - node.id * 71;
    }
    expect(compileBehaviourGraph(graph, VOCABULARY, { name: 'Setter' }).source).toBe(before);
  });
});

describe('arithmetic reads the way it is meant', () => {
  it('parenthesises a nested operation and leaves the outer one bare', () => {
    /* `a + b * c` as a graph is an `add` fed by a `mul`; written without the brackets it would
       still be right here, and would not be for `(a + b) * c`. Both get them, so neither relies
       on the reader knowing the precedence the generator assumed. */
    const graph = createGraph();
    addNode(graph, 'query:Position', 0, 0);
    addNode(graph, 'writes:Position', 0, 0);
    const px = addNode(graph, 'get:Position.x', 0, 0);
    const py = addNode(graph, 'get:Position.y', 0, 0);
    const two = addNode(graph, 'const', 0, 0);
    const product = addNode(graph, 'mul', 0, 0);
    const sum = addNode(graph, 'add', 0, 0);
    const set = addNode(graph, 'set:Position.x', 0, 0);
    (nodeOf(graph, two) as { params: Record<string, number> }).params['value'] = 0.5;
    addLink(graph, VOCABULARY, { from: py, fromPort: 0, to: product, toPort: 0 });
    addLink(graph, VOCABULARY, { from: two, fromPort: 0, to: product, toPort: 1 });
    addLink(graph, VOCABULARY, { from: px, fromPort: 0, to: sum, toPort: 0 });
    addLink(graph, VOCABULARY, { from: product, fromPort: 0, to: sum, toPort: 1 });
    addLink(graph, VOCABULARY, { from: sum, fromPort: 0, to: set, toPort: 0 });

    const { source } = compileBehaviourGraph(graph, VOCABULARY, {
      name: 'Skew',
      preamble: PREAMBLE,
    });
    expect(source).toContain('e.Position.x = e.Position.x + (e.Position.y * 0.5)');
    expect(errorsIn(source)).toEqual([]);
  });
});

describe('what this compiler refuses itself', () => {
  it('refuses a set with nothing feeding it, naming the node', () => {
    const graph = createGraph();
    addNode(graph, 'query:Position', 0, 0);
    addNode(graph, 'writes:Position', 0, 0);
    addNode(graph, 'set:Position.x', 0, 0);
    const { error } = compileBehaviourGraph(graph, VOCABULARY, { name: 'Broken' });
    expect(error).toContain('node 3');
    expect(error).toContain('set:Position.x');
  });

  it('refuses a kind the vocabulary does not have', () => {
    const graph = createGraph();
    addNode(graph, 'set:Nowhere.z', 0, 0);
    const { error } = compileBehaviourGraph(graph, VOCABULARY, { name: 'Broken' });
    expect(error).toContain('not in the vocabulary');
  });

  it('refuses a write with no query to write into, which is a graph fault and not an effect', () => {
    /* `e` would simply not exist, and "`e` is not defined" is a poor way to learn that a query
       node is missing. Scope is this compiler's to check; what a system may touch is not. */
    const graph = createGraph();
    addNode(graph, 'writes:Position', 0, 0);
    const value = addNode(graph, 'const', 0, 0);
    const set = addNode(graph, 'set:Position.x', 0, 0);
    addLink(graph, VOCABULARY, { from: value, fromPort: 0, to: set, toPort: 0 });
    const { error } = compileBehaviourGraph(graph, VOCABULARY, { name: 'Broken' });
    expect(error).toContain('query');
  });

  it('refuses a cycle by name, which the model already does', () => {
    const graph = createGraph();
    addNode(graph, 'query:Position', 0, 0);
    const a = addNode(graph, 'add', 0, 0);
    const b = addNode(graph, 'add', 0, 0);
    graph.links.push({ from: a, fromPort: 0, to: b, toPort: 0 });
    graph.links.push({ from: b, fromPort: 0, to: a, toPort: 0 });
    const { error } = compileBehaviourGraph(graph, VOCABULARY, { name: 'Broken' });
    expect(error).toContain('cycle');
  });
});

describe('a call takes as many arguments as it declares', () => {
  it('refuses one whose second argument is unwired, rather than emitting a shorter call', () => {
    /* The arity comes from the vocabulary, so a half-wired call cannot quietly become `mix(a)` —
       a call the language would refuse, from a graph that said nothing was wrong. */
    const graph = createGraph();
    addNode(graph, 'query:Position', 0, 0);
    addNode(graph, 'writes:Position', 0, 0);
    const px = addNode(graph, 'get:Position.x', 0, 0);
    const call = addNode(graph, 'call:mix', 0, 0);
    const set = addNode(graph, 'set:Position.x', 0, 0);
    addLink(graph, VOCABULARY, { from: px, fromPort: 0, to: call, toPort: 0 });
    addLink(graph, VOCABULARY, { from: call, fromPort: 0, to: set, toPort: 0 });

    const { source, error } = compileBehaviourGraph(graph, VOCABULARY, { name: 'Halfway' });
    expect(error).toContain('call:mix');
    expect(source).toBe('');
  });

  it('emits both arguments when both are wired', () => {
    const graph = createGraph();
    addNode(graph, 'query:Position', 0, 0);
    addNode(graph, 'writes:Position', 0, 0);
    const px = addNode(graph, 'get:Position.x', 0, 0);
    const py = addNode(graph, 'get:Position.y', 0, 0);
    const call = addNode(graph, 'call:mix', 0, 0);
    const set = addNode(graph, 'set:Position.x', 0, 0);
    addLink(graph, VOCABULARY, { from: px, fromPort: 0, to: call, toPort: 0 });
    addLink(graph, VOCABULARY, { from: py, fromPort: 0, to: call, toPort: 1 });
    addLink(graph, VOCABULARY, { from: call, fromPort: 0, to: set, toPort: 0 });

    const { source } = compileBehaviourGraph(graph, VOCABULARY, {
      name: 'Mixer',
      preamble: PREAMBLE,
    });
    expect(source).toContain('e.Position.x = mix(e.Position.x, e.Position.y)');
    expect(errorsIn(source)).toEqual([]);
  });
});

describe('a kind is parsed strictly', () => {
  it('takes a component and a field, and refuses anything that is not both', () => {
    expect(fieldReference('get:Position.x', GET)).toEqual({ component: 'Position', field: 'x' });
    expect(fieldReference('get:Position', GET)).toBeNull();
    expect(fieldReference('get:Position.', GET)).toBeNull();
    expect(fieldReference('get:.x', GET)).toBeNull();
    expect(fieldReference('set:Position.x', GET)).toBeNull();
  });
});

describe('the vocabulary is built from the project, not written down', () => {
  it('offers a kind for every component and every field, and nothing else', () => {
    const kinds = [...VOCABULARY.keys()].sort();
    expect(kinds).toEqual([
      'add',
      'call:mix',
      'call:wobble',
      'const',
      'div',
      'get:Position.x',
      'get:Position.y',
      'get:Velocity.x',
      'get:Velocity.y',
      'mul',
      'query:Position',
      'query:Velocity',
      'reads:Position',
      'reads:Velocity',
      'set:Position.x',
      'set:Position.y',
      'set:Velocity.x',
      'set:Velocity.y',
      'sub',
      'writes:Position',
      'writes:Velocity',
    ]);
  });

  it('has no `dt`, because a system body has no such thing', () => {
    /*
     * The obvious node to want, and the language does not provide it inside `update`: compiling
     * `e.Position.x + dt` against the real compiler gives DS0205, `dt` is not defined. Offering it
     * would have produced graphs that cannot compile, found by whoever built one.
     */
    expect(VOCABULARY.has('dt')).toBe(false);
    expect(
      errorsIn(
        `${PREAMBLE}\nsystem B {\n    writes Position\n\n    update {\n        for e in query<Position>() {\n            e.Position.x = dt\n        }\n    }\n}\n`,
      ),
    ).toEqual(['DS0205']);
  });

  it('gives a call as many inputs as the function takes', () => {
    const spec = VOCABULARY.get('call:wobble');
    expect(spec?.inputs).toHaveLength(1);
    expect(spec?.outputs).toHaveLength(1);
  });
});
