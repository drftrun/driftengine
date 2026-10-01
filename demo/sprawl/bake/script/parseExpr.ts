/**
 * Expressions of the script language, and the token cursor the statement parser shares.
 *
 * **Where a newline ends an expression is the one subtle part.** Newlines end statements, so an
 * expression on a statement ends at one — unless the line ended on an operator, or the next line
 * begins with one, which the corpus uses to continue long sums and products, in statements and
 * inside initialisers alike. Inside `(…)` and `[…]` newlines mean nothing. Inside `{…}` they
 * separate elements. A `match` is the exception to the leading operator: there a line beginning
 * with a minus is the next case (`-1: value`), not the last one continued.
 *
 * Precedence, lowest first: `||`, `&&`, `|`, `&`, `== !=`, `< > <= >=`, `<< >>`, `+ -`, `* / %`,
 * then unary `-` and `!`, then member, index and call.
 */
import type { Expr, Stmt } from './ast.ts';
import type { Token } from './lex.ts';

/**
 * How newlines behave where an expression is being read: `statement` and `element` end at one
 * unless the next line continues with an operator, `case` ends at one regardless, and `free`
 * ignores them.
 */
export type NewlineMode = 'statement' | 'element' | 'case' | 'free';

const PRECEDENCE: Record<string, number> = {
  '||': 1,
  '&&': 2,
  '|': 3,
  '&': 4,
  '==': 5,
  '!=': 5,
  '<': 6,
  '>': 6,
  '<=': 6,
  '>=': 6,
  '<<': 7,
  '>>': 7,
  '+': 8,
  '-': 8,
  '*': 9,
  '/': 9,
  '%': 9,
};

export class ParseError extends Error {}

export abstract class ExprParser {
  protected i = 0;

  constructor(
    protected readonly tokens: readonly Token[],
    protected readonly file: string,
  ) {}

  /** The statements of a `{ … }` block; the statement parser supplies it for `script { }`. */
  protected abstract block(): Stmt[];

  protected peek(offset = 0): Token {
    return this.tokens[Math.min(this.i + offset, this.tokens.length - 1)] as Token;
  }

  protected next(): Token {
    const token = this.peek();
    if (this.i < this.tokens.length - 1) this.i += 1;
    return token;
  }

  /** Whether the token at `offset` is the punctuation or identifier `text`. */
  protected is(text: string, offset = 0): boolean {
    const token = this.peek(offset);
    return (token.kind === 'p' || token.kind === 'id') && token.text === text;
  }

  protected eat(text: string): boolean {
    if (!this.is(text)) return false;
    this.next();
    return true;
  }

  protected expect(text: string): void {
    if (!this.eat(text)) this.fail(`expected '${text}', found '${this.peek().text}'`);
  }

  protected identifier(): string {
    const token = this.peek();
    if (token.kind !== 'id') this.fail(`expected a name, found '${token.text}'`);
    this.next();
    return token.text;
  }

  protected skipNewlines(): void {
    while (this.peek().kind === 'nl' || this.is(';')) this.next();
  }

  protected fail(message: string): never {
    throw new ParseError(`${this.file}:${this.peek().line}: ${message}`);
  }

  expression(mode: NewlineMode): Expr {
    return this.binary(1, mode);
  }

  private binary(least: number, mode: NewlineMode): Expr {
    let left = this.unary(mode);
    for (;;) {
      if (mode === 'free') this.skipNewlines();
      else if (mode !== 'case' && this.peek().kind === 'nl') {
        let j = 0;
        while (this.peek(j).kind === 'nl') j += 1;
        const after = this.peek(j);
        if (after.kind !== 'p' || PRECEDENCE[after.text] === undefined) break;
        this.i += j;
      }
      const token = this.peek();
      const precedence = token.kind === 'p' ? PRECEDENCE[token.text] : undefined;
      if (precedence === undefined || precedence < least) break;
      this.next();
      this.skipNewlines();
      const right = this.binary(precedence + 1, mode);
      left = { k: 'binary', op: token.text, left, right };
    }
    return left;
  }

  private unary(mode: NewlineMode): Expr {
    if (this.eat('-')) {
      const operand = this.unary(mode);
      return operand.k === 'num' && !operand.negative
        ? { k: 'num', text: operand.text, negative: true }
        : { k: 'unary', op: '-', operand };
    }
    if (this.eat('!')) return { k: 'unary', op: '!', operand: this.unary(mode) };
    return this.postfix(this.primary());
  }

  private postfix(expr: Expr): Expr {
    for (;;) {
      if (this.is('.') && this.peek(1).kind === 'id') {
        this.next();
        const name = this.next().text;
        expr =
          expr.k === 'name'
            ? { k: 'name', path: [...expr.path, name], dollar: expr.dollar }
            : { k: 'member', target: expr, name };
      } else if (this.is('[')) {
        this.next();
        this.skipNewlines();
        const index = this.expression('free');
        this.expect(']');
        expr = { k: 'index', target: expr, index };
      } else if (this.is('(')) {
        this.next();
        const args: Expr[] = [];
        this.skipNewlines();
        while (!this.is(')')) {
          args.push(this.expression('free'));
          if (!this.eat(',')) break;
          this.skipNewlines();
        }
        this.expect(')');
        expr = { k: 'call', callee: expr, args };
      } else {
        return expr;
      }
    }
  }

  private primary(): Expr {
    const token = this.peek();
    if (token.kind === 'num') {
      this.next();
      return { k: 'num', text: token.text, negative: false };
    }
    if (token.kind === 'str') {
      this.next();
      return { k: 'str', value: token.text };
    }
    if (token.kind === 'id') {
      if (token.text === 'true' || token.text === 'false') {
        this.next();
        return { k: 'bool', value: token.text === 'true' };
      }
      if (token.text === 'match') return this.match();
      if (token.text === 'script' && this.is('{', 1)) {
        this.next();
        return { k: 'script', body: this.block() };
      }
      this.next();
      return { k: 'name', path: [token.text], dollar: false };
    }
    if (this.is('$')) {
      this.next();
      if (this.eat('?')) {
        this.expect('[');
        this.skipNewlines();
        const what = this.expression('free');
        this.expect(']');
        return { k: 'has', what };
      }
      return { k: 'name', path: [this.identifier()], dollar: true };
    }
    if (this.is('(')) {
      this.next();
      this.skipNewlines();
      const first = this.expression('free');
      if (this.eat(',')) {
        this.skipNewlines();
        const second = this.expression('free');
        this.expect(')');
        return { k: 'pair', first, second };
      }
      this.expect(')');
      return first;
    }
    if (this.is('{')) return this.initializer();
    if (this.is('[')) {
      this.next();
      const items: Expr[] = [];
      this.skipNewlines();
      while (!this.is(']')) {
        const item = this.expression('free');
        /* A map's entries, `key: value`: the one in the corpus binds keys to actions. */
        items.push(
          this.eat(':') ? { k: 'pair', first: item, second: this.expression('free') } : item,
        );
        this.skipNewlines();
        if (!this.eat(',')) break;
        this.skipNewlines();
      }
      this.expect(']');
      return { k: 'vector', items };
    }
    return this.fail(`unexpected '${token.text}' in an expression`);
  }

  /** `{a, b}` or `{key: value, …}`; keywords may be keys (`slot:`, `prefab:`). */
  protected initializer(close = '}'): Expr {
    this.next();
    const named: { key: string; value: Expr }[] = [];
    const items: Expr[] = [];
    this.skipNewlines();
    while (!this.is(close)) {
      const token = this.peek();
      if (token.kind === 'id' && this.is(':', 1)) {
        this.next();
        this.next();
        this.skipNewlines();
        named.push({ key: token.text, value: this.expression('element') });
      } else {
        items.push(this.expression('element'));
      }
      this.skipNewlines();
      this.eat(',');
      this.skipNewlines();
    }
    this.expect(close);
    if (named.length > 0 && items.length > 0)
      this.fail('an initializer mixes named and positional');
    return named.length > 0 ? { k: 'init', named, items: [] } : { k: 'init', named: null, items };
  }

  private match(): Expr {
    this.next();
    const subject = this.expression('element');
    this.expect('{');
    const cases: { label: Expr | null; value: Expr }[] = [];
    this.skipNewlines();
    while (!this.is('}')) {
      const label = this.eat('_') ? null : this.expression('case');
      this.expect(':');
      this.skipNewlines();
      cases.push({ label, value: this.expression('case') });
      this.skipNewlines();
      this.eat(',');
      this.skipNewlines();
    }
    this.expect('}');
    return { k: 'match', subject, cases };
  }
}
