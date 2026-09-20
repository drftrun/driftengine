/**
 * A behaviour graph, as DriftScript source.
 *
 * **The target is source and not semantics, and that is the whole design.** The graph emits a
 * `.drs` module; the existing compiler checks the effects, the component accesses, the capabilities
 * and the annotations. Nothing about what a program *means* is decided here. That is what makes a
 * graph and hand-written code equivalent — a project may mix them freely, one may be pasted into
 * the other, and neither gets a guarantee the other lacks — and it is what stops this becoming a
 * second language that has to be kept in step with the first.
 *
 * **So a graph can emit a program DriftScript refuses, and it is meant to.** `reads` and `writes`
 * come from declaration nodes, and a `set` node writes whatever it writes. A graph that writes an
 * undeclared component compiles here without complaint and is refused by the DriftScript compiler
 * with DS0288, in the same words a person hand-writing that file would get. Deriving the
 * declarations from the write nodes would make the mistake unreachable and would put the effect
 * check in two places, which is the shape of duplication that eventually disagrees.
 *
 * **What is checked here is structure, not effects.** A missing input, a cycle, a kind the
 * vocabulary lacks and a write with no query to write into: the last is the only judgement call,
 * and it is here because `e` would simply not exist in the emitted body, and *"`e` is not defined"*
 * is a poor way to learn that a query node is missing.
 *
 * **Statement order is by node identifier, which is creation order.** Deliberately not by position:
 * tidying a graph must not rewrite the program, because a diff caused by dragging a box is a diff
 * nobody can review — and the generated source is content, which gets read and committed.
 */
import { validateGraph, type Graph, type GraphNode, type Vocabulary } from '../model.ts';
import { inputLink, nodeOf } from '../model.ts';
import {
  BEHAVIOUR_OPERATORS,
  CALL,
  GET,
  QUERY,
  READS,
  SET,
  WRITES,
  declaredComponent,
  fieldReference,
} from './nodes.ts';

export interface BehaviourOptions {
  /** The system's name, which is what the schedule and every diagnostic call it. */
  readonly name: string;
  /**
   * DriftScript the project already has — its components, its hand-written helpers — placed above
   * the system unchanged.
   *
   * The graph does not own a component: components are shared between systems, and a graph that
   * emitted its own would declare a second `Position` the moment a second graph existed. What it
   * owes instead is that whatever it was handed comes out the other side byte for byte.
   */
  readonly preamble?: string;
  /** Steps a second, emitted as the language's own `update at <n>Hz` form. */
  readonly rateHz?: number;
}

export interface CompiledBehaviour {
  /** The module. Empty where `error` is set, because half a program is worse than none. */
  readonly source: string;
  /** What is structurally wrong with the graph, or null. Never an effect or a type. */
  readonly error: string | null;
}

export function compileBehaviourGraph(
  graph: Graph,
  vocabulary: Vocabulary,
  options: BehaviourOptions,
): CompiledBehaviour {
  const invalid = validateGraph(graph, vocabulary, { forCompile: true });
  if (invalid !== null) return { source: '', error: invalid };

  const reads = componentsNamed(graph, READS);
  const writes = componentsNamed(graph, WRITES);
  const query = componentsNamed(graph, QUERY);

  const sets = graph.nodes.filter((node) => node.kind.startsWith(SET)).sort((a, b) => a.id - b.id);

  if (sets.length > 0 && query.length === 0) {
    const first = sets[0] as GraphNode;
    return {
      source: '',
      error: `node ${String(first.id)} (${first.kind}) writes a component and no query node says what to write it on`,
    };
  }

  const statements: string[] = [];
  for (const node of sets) {
    const target = fieldReference(node.kind, SET);
    if (target === null) continue;
    statements.push(
      `e.${target.component}.${target.field} = ${expression(graph, vocabulary, node, 0)}`,
    );
  }

  const lines: string[] = [];
  const preamble = options.preamble ?? '';
  if (preamble.trim().length > 0) lines.push(`${preamble.trimEnd()}\n`);

  lines.push(`system ${options.name} {`);
  const declared = [
    ...reads.map((name) => `    reads ${name}`),
    ...writes.map((name) => `    writes ${name}`),
  ];
  if (declared.length > 0) lines.push(...declared, '');

  const rate = options.rateHz === undefined ? '' : ` at ${String(options.rateHz)}Hz`;
  lines.push(`    update${rate} {`);
  if (query.length > 0) {
    lines.push(`        for e in query<${query.join(', ')}>() {`);
    for (const statement of statements) lines.push(`            ${statement}`);
    lines.push('        }');
  }
  lines.push('    }', '}');

  return { source: `${lines.join('\n')}\n`, error: null };
}

/** The components named by every node of one declaration kind, deduplicated and in a fixed order. */
function componentsNamed(graph: Graph, prefix: string): readonly string[] {
  const names = new Set<string>();
  for (const node of graph.nodes) {
    const name = declaredComponent(node.kind, prefix);
    if (name !== null) names.add(name);
  }
  /* Alphabetical rather than by node identifier: a reader scanning a system's declarations wants
     them in an order they can predict, and it is the order a person writes them in by hand. */
  return [...names].sort();
}

/**
 * The DriftScript expression feeding one input.
 *
 * Recursion terminates because `validateGraph` has already refused a cycle — the one thing that
 * could make a graph walk forever, checked in the model where every consumer gets it.
 */
function expression(graph: Graph, vocabulary: Vocabulary, node: GraphNode, port: number): string {
  const link = inputLink(graph, node.id, port);
  if (link === undefined) return '0';
  const source = nodeOf(graph, link.from);
  if (source === undefined) return '0';
  return value(graph, vocabulary, source);
}

function value(graph: Graph, vocabulary: Vocabulary, node: GraphNode): string {
  const field = fieldReference(node.kind, GET);
  if (field !== null) return `e.${field.component}.${field.field}`;

  if (node.kind === 'const') return number(node.params['value'] ?? 0);

  const operator = BEHAVIOUR_OPERATORS[node.kind];
  if (operator !== undefined) {
    return `${operand(graph, vocabulary, node, 0)} ${operator} ${operand(graph, vocabulary, node, 1)}`;
  }

  if (node.kind.startsWith(CALL)) {
    const name = node.kind.slice(CALL.length);
    /*
     * The arity is the declared one, not the number of inputs that happen to be wired. Counting
     * the wired ones gives the same answer today and only because a call's inputs are `required`
     * and `validateGraph` has already refused a gap — two facts that have to stay true together.
     * Perturbing either alone shows it: dropping `required` makes the counting version emit
     * `mix(a)`, a call the language refuses, from a graph that said nothing was wrong.
     */
    const args: string[] = [];
    const arity = vocabulary.get(node.kind)?.inputs.length ?? 0;
    for (let at = 0; at < arity; at += 1) args.push(expression(graph, vocabulary, node, at));
    return `${name}(${args.join(', ')})`;
  }

  return '0';
}

/**
 * One operand of a binary operation, bracketed where it is itself one.
 *
 * Both sides get them rather than only the side where precedence would bite. `a + b * c` needs none
 * and `(a + b) * c` needs them, and a reader cannot tell which they are looking at without knowing
 * what precedence the generator assumed — so the generated source never asks them to know.
 */
function operand(graph: Graph, vocabulary: Vocabulary, node: GraphNode, port: number): string {
  const link = inputLink(graph, node.id, port);
  const source = link === undefined ? undefined : nodeOf(graph, link.from);
  const inner = expression(graph, vocabulary, node, port);
  if (source !== undefined && BEHAVIOUR_OPERATORS[source.kind] !== undefined) return `(${inner})`;
  return inner;
}

/** A parameter as a DriftScript literal. Integers stay integers, so `3` is not written `3.0`. */
function number(value: number): string {
  if (!Number.isFinite(value)) return '0';
  return String(value);
}
