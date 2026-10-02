/**
 * Running statements: entities, prefabs, templates, components, loops and branches, in source
 * order, so every generator draws exactly where and when the reference's does.
 *
 * **A component value keeps or replaces by how it was written.** A named initialiser changes only
 * the members it names and keeps what the entity already has — its own value or an inherited one;
 * a positional initialiser or any other expression replaces the whole value. A component named
 * after a template instantiates it: the template's props take the initialiser's members over
 * their defaults, and its body runs with the entity as `$this`.
 *
 * A statement that fails records `file:line: message` and the next one runs, so a report names
 * every failure rather than the first.
 */
import type { Stmt } from './ast.ts';
import { evaluate } from './evalExpr.ts';
import type { Ctx } from './names.ts';
import { convert } from './numeric.ts';
import { ScriptRng } from './rng.ts';
import { memberType, schemaOf } from './schema.ts';
import type { Member } from './schema.ts';
import { coerce, describe, merge, named, numberOf } from './values.ts';
import type { Value } from './values.ts';
import { effective } from './world.ts';
import type { Prop, ScriptEntity, Template } from './world.ts';

export interface StmtCtx extends Ctx {
  /** Tags a `with` block adds to every entity created inside it. */
  readonly withTags: readonly string[];
  /** Runs an included file as a unit of its own. */
  readonly include: (path: string) => void;
  readonly errors: string[];
}

const nested = (ctx: StmtCtx, self: ScriptEntity): StmtCtx => ({
  ...ctx,
  self,
  scope: { vars: new Map(), parent: ctx.scope },
});

export function runStatements(statements: readonly Stmt[], ctx: StmtCtx): void {
  for (const s of statements) {
    try {
      runStatement(s, ctx);
    } catch (error) {
      ctx.errors.push(`${ctx.unit.file}:${s.line}: ${(error as Error).message}`);
    }
  }
}

/** A declared type's value: a generator for `math.Rng`, otherwise the value stored into the type. */
function declared(value: Value, type: string | null, ctx: Ctx): Value {
  if (type === null) return value;
  if (ctx.world.enums.has(type)) return value;
  const stored = coerce(value, type, ctx.world.schemas);
  if (type !== 'math.Rng') return stored;
  const seed = stored.k === 'struct' ? stored.fields?.get('seed') : undefined;
  return { k: 'rng', rng: new ScriptRng(BigInt(seed ? numberOf(seed, 'a seed') : 0)) };
}

function base(entity: ScriptEntity, name: string, ctx: StmtCtx): void {
  const found = ctx.world.resolve(name.split('.'), ctx.unit, ctx.self);
  if (found === null) throw new Error(`no base named ${name}`);
  if (!entity.bases.includes(found)) entity.bases.push(found);
}

/** Instantiates `template` on `target`, `given` holding the props the caller sets. */
export function instantiate(
  template: Template,
  given: ReadonlyMap<string, Value>,
  target: ScriptEntity,
  ctx: StmtCtx,
): void {
  const vars = new Map<string, Value>();
  for (const prop of template.props) {
    const value = given.get(prop.name);
    vars.set(prop.name, value === undefined ? prop.value : declared(value, prop.type, ctx));
  }
  for (const key of given.keys()) {
    if (!vars.has(key)) throw new Error(`${template.name} has no prop ${key}`);
  }
  target.components.set(template.name, named(vars));
  runStatements(template.body, {
    ...ctx,
    unit: template.unit,
    self: target,
    scope: { vars, parent: template.unit.scope },
  });
}

function component(name: string, s: Extract<Stmt, { k: 'component' }>, ctx: StmtCtx): void {
  const template = ctx.world.templates.get(name);
  const value = evaluate(s.value, ctx, name);
  if (template !== undefined) {
    if (value.k !== 'struct') throw new Error(`${name} instantiated from ${describe(value)}`);
    const given = new Map<string, Value>();
    if (value.fields !== null) for (const [key, v] of value.fields) given.set(key, v);
    else value.items.forEach((v, i) => given.set(template.props[i]?.name ?? `#${i}`, v));
    instantiate(template, given, ctx.self, ctx);
    return;
  }
  const schema = schemaOf(name, ctx.world.schemas);
  if (value.k === 'struct' && value.fields !== null && s.value.k === 'init') {
    const update = new Map<string, Value>();
    for (const [key, v] of value.fields) {
      const type = memberType(schema, key);
      if (schema !== null && type === null) throw new Error(`${name} has no member ${key}`);
      update.set(key, coerce(v, type, ctx.world.schemas));
    }
    const current = effective(ctx.self, name);
    const inherited = current && schema ? coerce(current, name, ctx.world.schemas) : current;
    ctx.self.components.set(name, merge(inherited, update));
    return;
  }
  ctx.self.components.set(
    name,
    schema ? coerce(value, name, ctx.world.schemas) : coerce(value, null, ctx.world.schemas),
  );
}

function entityName(s: Extract<Stmt, { k: 'entity' }>, ctx: StmtCtx): string | null {
  if (s.name === null) return null;
  return s.name
    .map((part) => {
      if (typeof part === 'string') return part;
      const v = evaluate(part, ctx, null);
      return v.k === 'num' ? String(v.v) : v.k === 'str' ? v.v : describe(v);
    })
    .join('');
}

function entity(s: Extract<Stmt, { k: 'entity' }>, ctx: StmtCtx): void {
  const name = entityName(s, ctx);
  const world = ctx.world;
  let target: ScriptEntity;
  if (name === null) target = world.create('', ctx.self);
  else if (name === '$') target = world.child(world.root, '$');
  else if (!ctx.self.named.has(name) && world.templates.has(name) && !name.includes('.')) {
    target = (world.templates.get(name) as Template).doc;
  } else target = world.ensure(ctx.self, name.split('.'));
  for (const b of s.bases) base(target, b, ctx);
  if (s.annotations?.name !== undefined) target.label = s.annotations.name;
  for (const tag of ctx.withTags) target.tags.add(tag);
  const inner = nested(ctx, target);
  if (s.kind !== null && s.args !== null) {
    component(s.kind, { k: 'component', name: s.kind, value: s.args, line: s.line }, inner);
  } else if (s.kind !== null) target.tags.add(s.kind);
  runStatements(s.body, inner);
}

function declareTemplate(s: Extract<Stmt, { k: 'template' }>, ctx: StmtCtx): void {
  const props: Prop[] = [];
  const body: Stmt[] = [];
  for (const statement of s.body) {
    if (statement.k !== 'prop') {
      body.push(statement);
      continue;
    }
    const value =
      statement.value === null
        ? coerce({ k: 'num', type: 'f32', v: 0 }, statement.type, ctx.world.schemas)
        : declared(evaluate(statement.value, ctx, statement.type), statement.type, ctx);
    props.push({ name: statement.name, type: statement.type, value });
  }
  const members: Member[] = props.map((p) => ({ name: p.name, type: p.type ?? 'any' }));
  ctx.world.schemas.set(s.name, members);
  ctx.world.templates.set(s.name, {
    name: s.name,
    unit: ctx.unit,
    props,
    body,
    doc: ctx.world.create(s.name, null),
  });
}

function runStatement(s: Stmt, ctx: StmtCtx): void {
  const world = ctx.world;
  switch (s.k) {
    case 'module':
      ctx.unit.module = world.ensure(world.root, s.path.split('.'));
      return;
    case 'using':
      ctx.unit.usings.push(s.path.replace(/\.\*$/, '').split('.'));
      return;
    case 'include':
      ctx.include(s.path);
      return;
    case 'const': {
      const value = declared(evaluate(s.value, ctx, s.type), s.type, ctx);
      ctx.scope.vars.set(s.name, value);
      if (s.exported) ctx.self.exports.set(s.name, value);
      return;
    }
    case 'prop':
      return;
    case 'entity':
      entity(s, ctx);
      return;
    case 'prefab': {
      const target = world.ensure(ctx.self, s.name.split('.'));
      target.prefab = true;
      for (const b of s.bases) base(target, b, ctx);
      runStatements(s.body, nested(ctx, target));
      return;
    }
    case 'template':
      declareTemplate(s, ctx);
      return;
    case 'component':
      component(s.name, s, ctx);
      return;
    case 'tag':
      ctx.self.tags.add(s.name);
      return;
    case 'pair': {
      const first = evaluate(s.first, ctx, null);
      const second = evaluate(s.second, ctx, null);
      if (first.k === 'symbol' && first.name === 'IsA') {
        if (second.k !== 'entity' || second.entity === null) {
          throw new Error(`a base that is ${describe(second)}`);
        }
        if (!ctx.self.bases.includes(second.entity)) ctx.self.bases.push(second.entity);
        return;
      }
      const value = s.value === null ? null : evaluate(s.value, ctx, null);
      ctx.self.pairs.push({ first, second, value });
      return;
    }
    case 'for': {
      if (s.over.k === 'range') {
        const from = convert(numberOf(evaluate(s.over.from, ctx, 'i32'), 'a loop bound'), 'i32');
        const to = convert(numberOf(evaluate(s.over.to, ctx, 'i32'), 'a loop bound'), 'i32');
        for (let i = from; i < to; i += 1) {
          const inner = nested(ctx, ctx.self);
          inner.scope.vars.set(s.vars[0] as string, { k: 'num', type: 'i32', v: i });
          runStatements(s.body, inner);
        }
        return;
      }
      const over = evaluate(s.over, ctx, null);
      if (over.k !== 'vector') throw new Error(`a for over ${describe(over)}`);
      over.items.forEach((item, i) => {
        const inner = nested(ctx, ctx.self);
        const [index, element] = s.vars.length > 1 ? s.vars : [null, s.vars[0]];
        if (index) inner.scope.vars.set(index, { k: 'num', type: 'i32', v: i });
        if (element) inner.scope.vars.set(element, item);
        runStatements(s.body, inner);
      });
      return;
    }
    case 'if': {
      const condition = evaluate(s.condition, ctx, null);
      if (condition.k === 'runtime') {
        ctx.world.notices.push(
          `${ctx.unit.file}:${s.line}: a condition on run-time state is taken`,
        );
      }
      const taken = condition.k === 'runtime' || numberOf(condition, 'a condition') !== 0;
      const branch = taken ? s.body : s.otherwise;
      if (branch !== null) runStatements(branch, nested(ctx, ctx.self));
      return;
    }
    case 'with': {
      const tags = s.items.map((item) =>
        item.k === 'name' ? item.path.join('.') : describe(evaluate(item, ctx, null)),
      );
      runStatements(s.body, { ...ctx, withTags: [...ctx.withTags, ...tags] });
      return;
    }
    case 'struct': {
      const members: Member[] = [];
      for (const m of s.body) {
        if (m.k !== 'entity' || m.name === null) continue;
        const spec = m.body.find((b) => b.k === 'component' && b.name === 'member');
        const type =
          spec?.k === 'component' && spec.value.k === 'init' && spec.value.items[0]?.k === 'name'
            ? spec.value.items[0].path.join('.')
            : 'f32';
        members.push({ name: String(m.name[0]), type });
      }
      world.schemas.set(s.name, members);
      return;
    }
    case 'enum':
      world.enums.set(s.name, s.constants);
      return;
    case 'await':
      return;
  }
}
