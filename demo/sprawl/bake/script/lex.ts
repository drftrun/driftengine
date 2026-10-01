/**
 * Tokens of the script language the reference's world is written in.
 *
 * Newlines are tokens, because they end statements; the parser decides where one does not. A
 * number never carries its sign — a leading minus is an operator, and the parser folds it into a
 * literal where it stands alone. An annotation (`@name The Rest Of The Line`) is one token holding
 * the rest of its line, spaces included. Only `//` comments exist in the corpus; `/* … *\/` is
 * accepted too, since the language has it.
 */

export type TokenKind = 'nl' | 'id' | 'num' | 'str' | 'ann' | 'p' | 'eof';

export interface Token {
  readonly kind: TokenKind;
  /** The identifier, the number's text, the string's unescaped value, the annotation or the punctuation. */
  readonly text: string;
  readonly line: number;
}

/** Longest first, so `..` wins over `.` and `<=` over `<`. */
const PUNCTUATION = [
  '..',
  '<=',
  '>=',
  '==',
  '!=',
  '&&',
  '||',
  '<<',
  '>>',
  '{',
  '}',
  '(',
  ')',
  '[',
  ']',
  ',',
  ':',
  ';',
  '=',
  '+',
  '-',
  '*',
  '/',
  '%',
  '<',
  '>',
  '!',
  '&',
  '|',
  '.',
  '$',
  '?',
];

const isDigit = (c: string | undefined): boolean => c !== undefined && c >= '0' && c <= '9';
const isIdStart = (c: string | undefined): boolean =>
  c !== undefined && ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_');
const isIdPart = (c: string | undefined): boolean => isIdStart(c) || isDigit(c);

const ESCAPES: Record<string, string> = { n: '\n', t: '\t', '"': '"', '\\': '\\' };

/** The tokens of `source`, ending in one `eof`. Throws on a character the language has no use for. */
export function lex(source: string, file: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  let line = 1;
  const push = (kind: TokenKind, text: string): void => {
    out.push({ kind, text, line });
  };
  while (i < source.length) {
    const c = source[i] as string;
    if (c === '\n') {
      push('nl', '\n');
      line += 1;
      i += 1;
    } else if (c === ' ' || c === '\t' || c === '\r') {
      i += 1;
    } else if (c === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i += 1;
    } else if (c === '/' && source[i + 1] === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        if (source[i] === '\n') line += 1;
        i += 1;
      }
      i += 2;
    } else if (c === '@') {
      let j = i + 1;
      while (j < source.length && source[j] !== '\n') j += 1;
      push('ann', source.slice(i + 1, j).trim());
      i = j;
    } else if (c === '"') {
      let j = i + 1;
      let value = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\') {
          const next = source[j + 1] as string;
          value += ESCAPES[next] ?? `\\${next}`;
          j += 2;
          continue;
        }
        if (source[j] === '\n') line += 1;
        value += source[j];
        j += 1;
      }
      if (j >= source.length) throw new Error(`${file}:${line}: unterminated string`);
      push('str', value);
      i = j + 1;
    } else if (isDigit(c) || (c === '.' && isDigit(source[i + 1]) && source[i - 1] !== '.')) {
      let j = i;
      while (isDigit(source[j])) j += 1;
      /* A dot followed by a dot is a range, not a fraction: `0..count`. */
      if (source[j] === '.' && source[j + 1] !== '.') {
        j += 1;
        while (isDigit(source[j])) j += 1;
      }
      push('num', source.slice(i, j));
      i = j;
    } else if (isIdStart(c)) {
      let j = i;
      while (isIdPart(source[j])) j += 1;
      push('id', source.slice(i, j));
      i = j;
    } else {
      const p = PUNCTUATION.find((candidate) => source.startsWith(candidate, i));
      if (p === undefined) throw new Error(`${file}:${line}: unexpected character '${c}'`);
      push('p', p);
      i += p.length;
    }
  }
  push('eof', '');
  return out;
}
