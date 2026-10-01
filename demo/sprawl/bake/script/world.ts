/**
 * What evaluating the scripts builds: a tree of entities with components, tags, pairs and bases,
 * the templates by name, and the diagnostics met on the way.
 *
 * **An entity's effective value** for a component is its own if it has one, else the nearest
 * base's, depth first in base order — which is what a named initialiser merges over, and what a
 * consumer of the tree reads. A prefab's children belong to every entity based on it; `children`
 * holds an entity's own, and a consumer walks the bases for the rest.
 *
 * **Names resolve** against the current module and each `using`, then from the root, each a path
 * of children; a name found nowhere is not an error here, because the engine the scripts were
 * written for declares enums this reader never sees (the evaluator makes it a symbol and counts it).
 */
import type { Stmt } from './ast.ts';
import type { Member } from './schema.ts';
import type { Value } from './values.ts';

export interface ScriptEntity {
  readonly id: number;
  readonly name: string;
  readonly parent: ScriptEntity | null;
  readonly children: ScriptEntity[];
  readonly named: Map<string, ScriptEntity>;
  prefab: boolean;
  readonly bases: ScriptEntity[];
  readonly components: Map<string, Value>;
  readonly tags: Set<string>;
  readonly pairs: { readonly first: Value; readonly second: Value; readonly value: Value | null }[];
  /** `export const` inside the entity's block, read elsewhere as `entity.name`. */
  readonly exports: Map<string, Value>;
  /** `@name`: the entity's display name, for maps and labels. */
  label: string | null;
}

/** Variables visible where a statement runs, innermost first. */
export interface Scope {
  readonly vars: Map<string, Value>;
  readonly parent: Scope | null;
}

/** One file's context: where its entities go, what it names without a path, its constants. */
export interface Unit {
  readonly file: string;
  module: ScriptEntity;
  /**
   * Each `using`, as a path: resolved at every lookup rather than when declared, because a file
   * may name a module that a later file creates, and creating it early would put a phantom
   * entity in the way of names that are not entities at all (`flecs.doc.Description`).
   */
  readonly usings: (readonly string[])[];
  readonly scope: Scope;
}

export interface Prop {
  readonly name: string;
  readonly type: string | null;
  readonly value: Value;
}

export interface Template {
  readonly name: string;
  readonly unit: Unit;
  readonly props: readonly Prop[];
  readonly body: readonly Stmt[];
  /** The entity a re-opened template block writes to: its documentation. */
  readonly doc: ScriptEntity;
}

export class ScriptWorld {
  readonly root: ScriptEntity;
  readonly templates = new Map<string, Template>();
  /** Schemas the scripts declare: every template's props, and the corpus's one `struct`. */
  readonly schemas = new Map<string, readonly Member[]>();
  /** Enums the scripts declare, constant names in order. */
  readonly enums = new Map<string, readonly string[]>();
  /** Reads of state that exists only when the reference runs, which the bake cannot answer. */
  readonly notices: string[] = [];
  /** Names resolved to nothing and taken as the engine's own enum constants, with a count. */
  readonly symbols = new Map<string, number>();
  private nextId = 0;

  constructor() {
    this.root = this.create('', null);
  }

  create(name: string, parent: ScriptEntity | null): ScriptEntity {
    const entity: ScriptEntity = {
      id: this.nextId++,
      name,
      parent,
      children: [],
      named: new Map(),
      prefab: false,
      bases: [],
      components: new Map(),
      tags: new Set(),
      pairs: [],
      exports: new Map(),
      label: null,
    };
    if (parent !== null) {
      parent.children.push(entity);
      if (name !== '') parent.named.set(name, entity);
    }
    return entity;
  }

  /** The named child of `parent`, created if absent: a block that names an entity re-opens it. */
  child(parent: ScriptEntity, name: string): ScriptEntity {
    return parent.named.get(name) ?? this.create(name, parent);
  }

  /** The entity at `path` below `from`, creating each step. */
  ensure(from: ScriptEntity, path: readonly string[]): ScriptEntity {
    let at = from;
    for (const step of path) at = this.child(at, step);
    return at;
  }

  /** The entity at `path` below `from`, or null. */
  static walk(from: ScriptEntity, path: readonly string[]): ScriptEntity | null {
    let at: ScriptEntity | undefined = from;
    for (const step of path) {
      at = at.named.get(step);
      if (at === undefined) return null;
    }
    return at;
  }

  /** The entity `path` names from `unit`: its module and parents, each `using`, then the root. */
  resolve(path: readonly string[], unit: Unit, near: ScriptEntity | null): ScriptEntity | null {
    for (let at = near; at !== null; at = at.parent) {
      const found = ScriptWorld.walk(at, path);
      if (found) return found;
    }
    for (let at: ScriptEntity | null = unit.module; at !== null; at = at.parent) {
      const found = ScriptWorld.walk(at, path);
      if (found) return found;
    }
    for (const using of unit.usings) {
      const from = ScriptWorld.walk(this.root, using);
      const found = from && ScriptWorld.walk(from, path);
      if (found) return found;
    }
    return null;
  }

  /** Every entity below `from` (itself included) that owns `component`, in creation order. */
  query(component: string, from: ScriptEntity = this.root): ScriptEntity[] {
    const out: ScriptEntity[] = [];
    const visit = (entity: ScriptEntity): void => {
      if (entity.components.has(component)) out.push(entity);
      for (const child of entity.children) visit(child);
    };
    visit(from);
    return out;
  }
}

/** The value `entity` has for `component`: its own, else the nearest base's. */
export function effective(entity: ScriptEntity, component: string): Value | undefined {
  const own = entity.components.get(component);
  if (own !== undefined) return own;
  for (const base of entity.bases) {
    const inherited = effective(base, component);
    if (inherited !== undefined) return inherited;
  }
  return undefined;
}

/** Whether `entity` has `tag`, itself or through a base. */
export function hasTag(entity: ScriptEntity, tag: string): boolean {
  return entity.tags.has(tag) || entity.bases.some((base) => hasTag(base, tag));
}

/** The dotted path from the root, for messages and for a consumer's lookups. */
export function pathOf(entity: ScriptEntity): string {
  const parts: string[] = [];
  for (let at: ScriptEntity | null = entity; at !== null && at.parent !== null; at = at.parent) {
    parts.push(at.name === '' ? `#${at.id}` : at.name);
  }
  return parts.reverse().join('.');
}
