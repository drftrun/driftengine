/**
 * Statements of the script language, into the tree `ast.ts` describes.
 *
 * **One ambiguity decides most of it**: `Name: …` is a component when what follows the colon is a
 * value, and an entity with bases when it is a list of names followed by a block on the same line
 * (`p0 : PalRowCrimson {}`). The parser tries the second and falls back to the first.
 *
 * A statement that fails to parse is recorded and skipped to the end of its line, so one file
 * reports every error it has rather than the first.
 */
import type { Expr, NamePart, Stmt } from './ast.ts';
import { lex } from './lex.ts';
import { ExprParser, ParseError } from './parseExpr.ts';

export interface ParsedFile {
  readonly file: string;
  readonly statements: readonly Stmt[];
  readonly errors: readonly string[];
}

/** Every statement of `source`, and every error met on the way. */
export function parseScript(source: string, file: string): ParsedFile {
  const parser = new StatementParser(lex(source, file), file);
  const statements = parser.statements('eof');
  return { file, statements, errors: parser.errors };
}

type Body = Stmt extends infer S
  ? S extends Stmt
    ? Omit<S, 'line' | 'annotations'>
    : never
  : never;

class StatementParser extends ExprParser {
  readonly errors: string[] = [];

  statements(end: '}' | 'eof'): Stmt[] {
    const out: Stmt[] = [];
    let annotations: Record<string, string> | undefined;
    for (;;) {
      this.skipNewlines();
      const token = this.peek();
      if (token.kind === 'eof' || (end === '}' && this.is('}'))) break;
      if (token.kind === 'ann') {
        this.next();
        const space = token.text.indexOf(' ');
        annotations ??= {};
        annotations[space < 0 ? token.text : token.text.slice(0, space)] =
          space < 0 ? '' : token.text.slice(space + 1).trim();
        continue;
      }
      const line = token.line;
      try {
        const body = this.statement();
        out.push({ ...body, line, ...(annotations ? { annotations } : {}) } as Stmt);
      } catch (error) {
        if (!(error instanceof ParseError)) throw error;
        this.errors.push(error.message);
        while (this.peek().kind !== 'nl' && this.peek().kind !== 'eof') this.next();
      }
      annotations = undefined;
    }
    return out;
  }

  protected block(): Stmt[] {
    this.skipNewlines();
    this.expect('{');
    const body = this.statements('}');
    this.expect('}');
    return body;
  }

  /** `a.b.c`, and `a.b.*` where a `using` imports children. */
  private path(allowStar = false): string {
    let path = this.identifier();
    while (this.is('.') && (this.peek(1).kind === 'id' || (allowStar && this.is('*', 1)))) {
      this.next();
      path += `.${this.next().text}`;
    }
    return path;
  }

  private statement(): Body {
    const token = this.peek();
    if (token.kind === 'id') {
      switch (token.text) {
        case 'module':
          this.next();
          return { k: 'module', path: this.path() };
        case 'using':
          this.next();
          return { k: 'using', path: this.path(true) };
        case 'include': {
          this.next();
          let path = '';
          while (this.peek().kind !== 'nl' && this.peek().kind !== 'eof') path += this.next().text;
          return { k: 'include', path };
        }
        case 'export': {
          this.next();
          const inner = this.statement();
          if (inner.k !== 'const') this.fail('only a const or mut can be exported');
          return { ...inner, exported: true };
        }
        case 'const':
        case 'mut': {
          this.next();
          const name = this.identifier();
          const type = this.eat(':') ? this.path() : null;
          this.expect('=');
          this.skipNewlines();
          const value = this.expression('statement');
          return { k: 'const', name, type, value, exported: false, mutable: token.text === 'mut' };
        }
        case 'prop': {
          this.next();
          const name = this.identifier();
          const type = this.eat(':') ? this.path() : null;
          const value = this.eat('=') ? this.expression('statement') : null;
          return { k: 'prop', name, type, value };
        }
        case 'template':
          this.next();
          return { k: 'template', name: this.identifier(), body: this.block() };
        case 'prefab': {
          this.next();
          const name = this.path();
          const bases = this.eat(':') ? this.baseList() : [];
          return { k: 'prefab', name, bases, body: this.optionalBlock() };
        }
        case 'for':
          return this.forStatement();
        case 'if':
          return this.ifStatement();
        case 'with': {
          this.next();
          const items: Expr[] = [this.expression('element')];
          while (this.eat(',')) items.push(this.expression('element'));
          return { k: 'with', items, body: this.block() };
        }
        case 'struct':
          this.next();
          return { k: 'struct', name: this.identifier(), body: this.block() };
        case 'enum': {
          this.next();
          const name = this.identifier();
          this.expect('(');
          const constants: string[] = [];
          while (!this.is(')')) {
            this.skipNewlines();
            constants.push(this.identifier());
            this.skipNewlines();
            if (!this.eat(',')) break;
          }
          this.expect(')');
          return { k: 'enum', name, constants };
        }
        case 'await':
          this.next();
          return { k: 'await', value: this.expression('statement') };
        case '_': {
          this.next();
          const bases = this.eat(':') ? this.baseList() : [];
          return this.entity(null, bases);
        }
      }
      return this.named();
    }
    if (this.is('(')) {
      this.next();
      const first = this.expression('free');
      this.expect(',');
      this.skipNewlines();
      const second = this.expression('free');
      this.expect(')');
      const value = this.eat(':') ? this.expression('statement') : null;
      return { k: 'pair', first, second, value };
    }
    if (this.is('$') && this.is('{', 1)) {
      this.next();
      return this.entity(['$'], []);
    }
    if (this.is('{')) return this.entity(null, []);
    if (token.kind === 'str') {
      this.next();
      const name = this.interpolated(token.text);
      const bases = this.eat(':') ? this.baseList() : [];
      return this.entity(name, bases);
    }
    return this.fail(`unexpected '${token.text}' at the start of a statement`);
  }

  /** A statement that begins with a name: an entity, a component, a tag or the kind form. */
  private named(): Body {
    const line = this.peek().line;
    const name = this.path();
    if (this.is(':')) {
      const colon = this.i;
      this.next();
      const bases = this.tryBaseList();
      if (bases !== null && this.is('{') && this.peek().line === line) {
        return this.entity([name], bases);
      }
      this.i = colon + 1;
      this.skipNewlines();
      return { k: 'component', name, value: this.expression('statement') };
    }
    if (this.is('{')) return this.entity([name], []);
    const after = this.peek();
    if (after.kind === 'id' && after.line === line) {
      const entityName = this.path();
      const args = this.is('(') ? this.initializer(')') : null;
      const bases = this.eat(':') ? this.baseList() : [];
      return {
        k: 'entity',
        name: [entityName],
        bases,
        kind: name,
        args,
        body: this.is('{') ? this.block() : [],
      };
    }
    return { k: 'tag', name };
  }

  private entity(name: readonly NamePart[] | null, bases: readonly string[]): Body {
    return { k: 'entity', name, bases, kind: null, args: null, body: this.block() };
  }

  private optionalBlock(): Stmt[] {
    let j = 0;
    while (this.peek(j).kind === 'nl') j += 1;
    return this.is('{', j) ? this.block() : [];
  }

  private baseList(): string[] {
    const bases = [this.path()];
    while (this.eat(',')) bases.push(this.path());
    return bases;
  }

  /** A base list if one stands here, else null with the cursor wherever it stopped. */
  private tryBaseList(): string[] | null {
    if (this.peek().kind !== 'id') return null;
    const bases = [this.path()];
    while (this.eat(',')) {
      if (this.peek().kind !== 'id') return null;
      bases.push(this.path());
    }
    return bases;
  }

  private forStatement(): Body {
    this.next();
    const vars: string[] = [];
    if (this.eat('(')) {
      vars.push(this.identifier());
      while (this.eat(',')) vars.push(this.identifier());
      this.expect(')');
    } else {
      vars.push(this.identifier());
    }
    this.expect('in');
    const from = this.expression('element');
    const over: Expr = this.eat('..') ? { k: 'range', from, to: this.expression('element') } : from;
    return { k: 'for', vars, over, body: this.block() };
  }

  private ifStatement(): Body {
    this.next();
    const condition = this.expression('element');
    const body = this.block();
    let j = 0;
    while (this.peek(j).kind === 'nl') j += 1;
    if (!this.is('else', j)) return { k: 'if', condition, body, otherwise: null };
    this.i += j + 1;
    if (this.is('if')) {
      const line = this.peek().line;
      return { k: 'if', condition, body, otherwise: [{ ...this.ifStatement(), line } as Stmt] };
    }
    return { k: 'if', condition, body, otherwise: this.block() };
  }

  /** `"post_{i}_{p}"` as its literal runs and its expressions. */
  private interpolated(text: string): NamePart[] {
    const parts: NamePart[] = [];
    let literal = '';
    for (let i = 0; i < text.length; i += 1) {
      const c = text[i] as string;
      if (c !== '{') {
        literal += c;
        continue;
      }
      const close = text.indexOf('}', i);
      if (close < 0) this.fail(`an unclosed '{' in the name "${text}"`);
      if (literal !== '') parts.push(literal);
      literal = '';
      const inner = new StatementParser(lex(text.slice(i + 1, close), this.file), this.file);
      parts.push(inner.expression('free'));
      i = close;
    }
    if (literal !== '') parts.push(literal);
    return parts;
  }
}
