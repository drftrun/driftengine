/**
 * The behaviour vocabulary: what a node in a behaviour graph can be.
 *
 * **Built from the project rather than written down here.** Materials have a fixed vocabulary
 * because the decode program has a fixed set of operations; a behaviour graph's nouns are the
 * project's components and its own helper functions, which this file has no way of knowing. So
 * `createBehaviourVocabulary` is given them and generates a kind per component and per field —
 * which also means a component that has been renamed makes every node referring to it fail
 * `validateGraph` by name rather than compiling to a reference to something that is not there.
 *
 * **Declarations are nodes, and that is the load-bearing decision.** `reads:X` and `writes:X` put
 * `reads X` and `writes X` in the emitted system; `set:X.f` writes the field. Nothing derives one
 * from the other. A graph can therefore write a component it never declared — and DriftScript's
 * compiler refuses it, which is the point: the effect check happens once, in the language, and a
 * graph is checked by exactly the same thing that checks hand-written code.
 *
 * **There is no `dt` node.** It is the first thing anybody reaches for and the language does not
 * provide it inside a system's `update` body: compiling one against the real compiler gives DS0205,
 * `dt` is not defined. A palette offering it would produce graphs that cannot compile, discovered
 * by whoever built one rather than by this file.
 */
import { createVocabulary, type NodeSpec, type PortType, type Vocabulary } from '../model.ts';

/** A component the project has declared, and the fields a graph may reach. */
export interface ComponentSpec {
  readonly name: string;
  readonly fields: readonly string[];
}

/** A DriftScript function the project has written by hand, which a graph may call. */
export interface FunctionSpec {
  readonly name: string;
  readonly arity: number;
}

export interface BehaviourWorld {
  readonly components: readonly ComponentSpec[];
  readonly functions?: readonly FunctionSpec[];
}

/**
 * Everything a behaviour graph carries is one number.
 *
 * `f64` is what a component field is in the corpus, and a graph that could also carry a vector
 * would need a vector type in the emitted source for every operation to be written against. That
 * is a language question rather than a graph one, and the graph should not answer it first.
 */
const VALUE: PortType = 'number';

export const READS = 'reads:';
export const WRITES = 'writes:';
export const QUERY = 'query:';
export const GET = 'get:';
export const SET = 'set:';
export const CALL = 'call:';

/** The binary operations, and the DriftScript operator each becomes. */
export const BEHAVIOUR_OPERATORS: Readonly<Record<string, string>> = {
  add: '+',
  sub: '-',
  mul: '*',
  div: '/',
};

export function createBehaviourVocabulary(world: BehaviourWorld): Vocabulary {
  const specs: NodeSpec[] = [
    /** A literal. `params.value`. */
    { kind: 'const', inputs: [], outputs: [{ name: 'value', type: VALUE }] },
  ];

  for (const kind of Object.keys(BEHAVIOUR_OPERATORS)) {
    specs.push({
      kind,
      inputs: [
        { name: 'a', type: VALUE, required: true },
        { name: 'b', type: VALUE, required: true },
      ],
      outputs: [{ name: 'value', type: VALUE }],
    });
  }

  for (const component of world.components) {
    /* Declarations and the query are markers: their presence is the whole of what they say. */
    specs.push({ kind: `${READS}${component.name}`, inputs: [], outputs: [] });
    specs.push({ kind: `${WRITES}${component.name}`, inputs: [], outputs: [] });
    specs.push({ kind: `${QUERY}${component.name}`, inputs: [], outputs: [] });
    for (const field of component.fields) {
      specs.push({
        kind: `${GET}${component.name}.${field}`,
        inputs: [],
        outputs: [{ name: field, type: VALUE }],
      });
      specs.push({
        kind: `${SET}${component.name}.${field}`,
        inputs: [{ name: field, type: VALUE, required: true }],
        outputs: [],
      });
    }
  }

  for (const fn of world.functions ?? []) {
    const inputs = [];
    for (let at = 0; at < fn.arity; at += 1) {
      inputs.push({ name: `a${String(at)}`, type: VALUE, required: true });
    }
    specs.push({
      kind: `${CALL}${fn.name}`,
      inputs,
      outputs: [{ name: 'value', type: VALUE }],
    });
  }

  return createVocabulary(specs);
}

/** The component a `reads:`, `writes:` or `query:` node names, or null. */
export function declaredComponent(kind: string, prefix: string): string | null {
  return kind.startsWith(prefix) ? kind.slice(prefix.length) : null;
}

/** The component and field a `get:` or `set:` node names, or null. */
export function fieldReference(
  kind: string,
  prefix: string,
): { readonly component: string; readonly field: string } | null {
  if (!kind.startsWith(prefix)) return null;
  const rest = kind.slice(prefix.length);
  const dot = rest.indexOf('.');
  if (dot <= 0 || dot === rest.length - 1) return null;
  return { component: rest.slice(0, dot), field: rest.slice(dot + 1) };
}
