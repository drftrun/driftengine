import { describe, expect, it } from 'vitest';

import type { Expr, Stmt } from './ast.ts';
import { parseScript } from './parse.ts';

/** An expression as a compact S-expression, so an expected tree reads as one line. */
function show(e: Expr): string {
  switch (e.k) {
    case 'num':
      return (e.negative ? '-' : '') + e.text;
    case 'str':
      return JSON.stringify(e.value);
    case 'bool':
      return String(e.value);
    case 'name':
      return (e.dollar ? '$' : '') + e.path.join('.');
    case 'unary':
      return `(${e.op} ${show(e.operand)})`;
    case 'binary':
      return `(${e.op} ${show(e.left)} ${show(e.right)})`;
    case 'member':
      return `(. ${show(e.target)} ${e.name})`;
    case 'index':
      return `([] ${show(e.target)} ${show(e.index)})`;
    case 'call':
      return `(${show(e.callee)} ${e.args.map(show).join(' ')})`;
    case 'init':
      return e.named
        ? `{${e.named.map((m) => `${m.key}: ${show(m.value)}`).join(', ')}}`
        : `{${e.items.map(show).join(', ')}}`;
    case 'vector':
      return `[${e.items.map(show).join(', ')}]`;
    case 'range':
      return `${show(e.from)}..${show(e.to)}`;
    case 'match':
      return `(match ${show(e.subject)} ${e.cases.map((c) => `${c.label ? show(c.label) : '_'}: ${show(c.value)}`).join(' | ')})`;
    case 'pair':
      return `(${show(e.first)}, ${show(e.second)})`;
    case 'has':
      return `(has ${show(e.what)})`;
    case 'script':
      return `(script ${e.body.length})`;
  }
}

function parse(source: string): Stmt[] {
  const parsed = parseScript(source, 'fixture');
  expect(parsed.errors).toEqual([]);
  return [...parsed.statements];
}

function only<K extends Stmt['k']>(statements: Stmt[], k: K): Extract<Stmt, { k: K }> {
  expect(statements).toHaveLength(1);
  const s = statements[0] as Stmt;
  expect(s.k).toBe(k);
  return s as Extract<Stmt, { k: K }>;
}

describe('the script parser', () => {
  it('A LINE THAT BEGINS WITH AN OPERATOR CONTINUES THE ONE BEFORE, IN STATEMENTS AND INITIALISERS', () => {
    const c = only(parse('const a = x * 2\n    + y\n    - z\n'), 'const');
    expect(show(c.value)).toBe('(- (+ (* x 2) y) z)');

    const box = only(parse('Box: {w\n    * 0.5, h,\n    t + 1\n        + u}\n'), 'component');
    expect(show(box.value)).toBe('{(* w 0.5), h, (+ (+ t 1) u)}');

    const trailing = only(parse('const b = x +\n    y\n'), 'const');
    expect(show(trailing.value)).toBe('(+ x y)');
  });

  it('but a line that begins with a minus in a match is the next case', () => {
    const c = only(parse('const m = match k {\n    0: a\n    -1: b\n    _: c\n}\n'), 'const');
    expect(show(c.value)).toBe('(match k 0: a | -1: b | _: c)');
  });

  it('ends a statement at a newline, and at the next statement on the same line', () => {
    const [entity] = parse('_ { Box: {1, 2, 3} Position3: {0, -1.1, 0} }\n');
    expect(entity?.k).toBe('entity');
    const body = entity?.k === 'entity' ? entity.body : [];
    expect(body.map((s) => (s.k === 'component' ? `${s.name} ${show(s.value)}` : s.k))).toEqual([
      'Box {1, 2, 3}',
      'Position3 {0, -1.1, 0}',
    ]);
  });

  it('tells an entity with a base from a component with a value', () => {
    const [row, tint, anon] = parse(
      'p0 : PalRow {}\nRgba: tint\n_ : BldLedge { Box: {1, 1, 1} }\n',
    );
    expect(row).toMatchObject({ k: 'entity', name: ['p0'], bases: ['PalRow'] });
    expect(tint?.k === 'component' ? show(tint.value) : '').toBe('tint');
    expect(anon).toMatchObject({ k: 'entity', name: null, bases: ['BldLedge'] });
  });

  it('binds operators by the language’s precedence', () => {
    const c = only(parse('const p = !a && b || c == d + e * -f % 2\n'), 'const');
    expect(show(c.value)).toBe('(|| (&& (! a) b) (== c (+ d (% (* e (- f)) 2))))');
  });

  it('reads keywords as keys, annotations to the end of their line, and interpolated names', () => {
    const [styled] = parse('@name Two Words\n@tree Parent\nx { Row: {slot: 1, prefab: P} }\n');
    expect(styled?.annotations).toEqual({ name: 'Two Words', tree: 'Parent' });
    const row = styled?.k === 'entity' ? styled.body[0] : undefined;
    expect(row?.k === 'component' ? show(row.value) : '').toBe('{slot: 1, prefab: P}');

    const named = only(parse('"post_{i}_{p + 1}" : Post {}\n'), 'entity');
    expect(named.name?.map((part) => (typeof part === 'string' ? part : show(part)))).toEqual([
      'post_',
      'i',
      '_',
      '(+ p 1)',
    ]);
  });

  it('reads the forms only the interface and input layers use', () => {
    const [kind, singleton] = parse(
      'Control walk(key: "W A S D", action: "Walk")\n$ {\n  Map: [keys.W: { Forward }]\n  B: [script {\n    await pressed(Fwd)\n  }]\n}\n',
    );
    expect(kind).toMatchObject({ k: 'entity', kind: 'Control', name: ['walk'] });
    expect(kind?.k === 'entity' && kind.args ? show(kind.args) : '').toBe(
      '{key: "W A S D", action: "Walk"}',
    );
    const body = singleton?.k === 'entity' ? singleton.body : [];
    expect(body.map((s) => (s.k === 'component' ? show(s.value) : s.k))).toEqual([
      '[(keys.W, {Forward})]',
      '[(script 1)]',
    ]);
    const has = only(parse('const playing = $?[(State, Playing)]\n'), 'const');
    expect(show(has.value)).toBe('(has (State, Playing))');
  });

  it('reads loops, branches and the member, index and call forms', () => {
    const [loop, vector, branch] = parse(
      'for i in 0..(n + 1) { }\nfor (k, g) in gates { }\nif a > 0 { } else if b { } else { }\n',
    );
    expect(loop?.k === 'for' ? show(loop.over) : '').toBe('0..(+ n 1)');
    expect(vector).toMatchObject({ k: 'for', vars: ['k', 'g'] });
    const inner = branch?.k === 'if' ? branch.otherwise?.[0] : undefined;
    expect(inner?.k === 'if' && inner.otherwise).toEqual([]);

    const c = only(
      parse('const v = path[i + 1].x * math.min(rng.u(3), 1) + $this[State].hover\n'),
      'const',
    );
    expect(show(c.value)).toBe(
      '(+ (* (. ([] path (+ i 1)) x) (math.min (rng.u 3) 1)) (. ([] $this State) hover))',
    );
  });

  it('records a statement it cannot read and carries on with the next line', () => {
    const parsed = parseScript('const a = ) + +\nconst b = 2\n', 'fixture');
    expect(parsed.errors).toHaveLength(1);
    expect(parsed.errors[0]).toMatch(/^fixture:1: /);
    expect(parsed.statements.map((s) => s.k)).toEqual(['const']);
  });
});
