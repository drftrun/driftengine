/**
 * Reading a set of scripts into one world: each file parsed once and run as a unit of its own,
 * `include`s run where they stand, and templates callable by name afterwards.
 *
 * Pure: files arrive through `read`, so a test hands over a map and the bake hands over the disk.
 * Every path is relative to the source root and uses `/`.
 */
import type { Value } from './values.ts';
import { instantiate, runStatements } from './evalStmt.ts';
import type { StmtCtx } from './evalStmt.ts';
import type { EvalOptions } from './names.ts';
import { parseScript } from './parse.ts';
import { ScriptWorld } from './world.ts';
import type { ScriptEntity, Unit } from './world.ts';

export interface ScriptRead {
  readonly world: ScriptWorld;
  /** Every file run, in the order it ran. */
  readonly files: readonly string[];
  /** Parse errors, then evaluation errors, each `file:line: message`. */
  readonly errors: string[];
  /** Instantiates a template by name on a new child of `parent`, as the reference's host does. */
  instantiate(name: string, props: ReadonlyMap<string, Value>, parent?: ScriptEntity): ScriptEntity;
}

const directory = (file: string): string => file.slice(0, file.lastIndexOf('/') + 1);

/** Runs `entries` in order, and everything they include. */
export function readScripts(
  entries: readonly string[],
  read: (file: string) => string | null,
  options: Partial<EvalOptions> = {},
): ScriptRead {
  const world = new ScriptWorld();
  const errors: string[] = [];
  const files: string[] = [];
  const evalOptions: EvalOptions = {
    mobile: options.mobile ?? false,
    hosts: options.hosts ?? new Map(),
  };

  const context = (unit: Unit, self: ScriptEntity): StmtCtx => ({
    world,
    unit,
    scope: unit.scope,
    self,
    options: evalOptions,
    withTags: [],
    include: (path) => run(`${directory(unit.file)}${path}.flecs`),
    errors,
  });

  const run = (file: string): void => {
    if (files.includes(file)) {
      /* A file included twice runs once. In the corpus the second inclusion only re-sets named
         entities, which a second run would leave exactly as the first did. */
      world.notices.push(`${file}: included a second time; the second is skipped`);
      return;
    }
    const source = read(file);
    if (source === null) {
      errors.push(`${file}: not found`);
      return;
    }
    files.push(file);
    const parsed = parseScript(source, file);
    errors.push(...parsed.errors);
    const unit: Unit = {
      file,
      module: world.root,
      usings: [],
      scope: { vars: new Map(), parent: null },
    };
    /* Read the module afresh for every statement: a `module` line moves where the rest go. */
    for (const s of parsed.statements) runStatements([s], context(unit, unit.module));
  };

  for (const entry of entries) run(entry);

  return {
    world,
    files,
    errors,
    instantiate(name, props, parent = world.root) {
      const template = world.templates.get(name);
      if (template === undefined) throw new Error(`no template named ${name}`);
      const target = world.create('', parent);
      instantiate(template, props, target, context(template.unit, target));
      return target;
    },
  };
}
