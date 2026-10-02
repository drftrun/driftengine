/**
 * The syntax tree of the script language: statements and expressions as plain data, each carrying
 * the line it began on for the evaluator's messages.
 */

export type Expr =
  /** A number as written; `negative` when a unary minus stood directly on it. */
  | { readonly k: 'num'; readonly text: string; readonly negative: boolean }
  | { readonly k: 'str'; readonly value: string }
  | { readonly k: 'bool'; readonly value: boolean }
  /**
   * A name, possibly dotted: a variable and its members (`tint.r`), an exported value
   * (`cfg.cityScale`), a function (`math.min`), an entity path (`sky.atmosphere`). Which one is
   * the evaluator's decision; `dollar` marks the explicit variable form (`$mat`, `$this`).
   */
  | { readonly k: 'name'; readonly path: readonly string[]; readonly dollar: boolean }
  | { readonly k: 'unary'; readonly op: '-' | '!'; readonly operand: Expr }
  | { readonly k: 'binary'; readonly op: string; readonly left: Expr; readonly right: Expr }
  | { readonly k: 'member'; readonly target: Expr; readonly name: string }
  | { readonly k: 'index'; readonly target: Expr; readonly index: Expr }
  | { readonly k: 'call'; readonly callee: Expr; readonly args: readonly Expr[] }
  /** `{…}`: named when every element is `key: value`, positional otherwise; `{}` is positional. */
  | {
      readonly k: 'init';
      readonly named: readonly { readonly key: string; readonly value: Expr }[] | null;
      readonly items: readonly Expr[];
    }
  | { readonly k: 'vector'; readonly items: readonly Expr[] }
  | { readonly k: 'range'; readonly from: Expr; readonly to: Expr }
  | {
      readonly k: 'match';
      readonly subject: Expr;
      /** A null label is the `_` case. */
      readonly cases: readonly { readonly label: Expr | null; readonly value: Expr }[];
    }
  | { readonly k: 'pair'; readonly first: Expr; readonly second: Expr }
  /** `$?[(A, B)]` or `$?[C]`: whether the singleton has it. */
  | { readonly k: 'has'; readonly what: Expr }
  /** `script { … }`: a behaviour block, kept and never run by the bake. */
  | { readonly k: 'script'; readonly body: readonly Stmt[] };

/** An entity's name: literal text and interpolated expressions, in order. */
export type NamePart = string | Expr;

interface At {
  readonly line: number;
  /** Annotations written above the statement: `name` and `tree`. */
  readonly annotations?: Readonly<Record<string, string>>;
}

export type Stmt = At &
  (
    | { readonly k: 'module'; readonly path: string }
    | { readonly k: 'using'; readonly path: string }
    | { readonly k: 'include'; readonly path: string }
    | {
        readonly k: 'const';
        readonly name: string;
        readonly type: string | null;
        readonly value: Expr;
        readonly exported: boolean;
        readonly mutable: boolean;
      }
    | {
        readonly k: 'prop';
        readonly name: string;
        readonly type: string | null;
        readonly value: Expr | null;
      }
    | {
        readonly k: 'entity';
        /**
         * Null for an anonymous entity (`_ { }` or `{ }`); `['$']` for the singleton scope; a
         * dotted path has several parts joined by the evaluator.
         */
        readonly name: readonly NamePart[] | null;
        readonly bases: readonly string[];
        /** The kind form: `Kind name(key: value) { }`. */
        readonly kind: string | null;
        readonly args: Expr | null;
        readonly body: readonly Stmt[];
      }
    | {
        readonly k: 'prefab';
        readonly name: string;
        readonly bases: readonly string[];
        readonly body: readonly Stmt[];
      }
    | { readonly k: 'template'; readonly name: string; readonly body: readonly Stmt[] }
    | { readonly k: 'component'; readonly name: string; readonly value: Expr }
    | { readonly k: 'tag'; readonly name: string }
    | {
        readonly k: 'pair';
        readonly first: Expr;
        readonly second: Expr;
        readonly value: Expr | null;
      }
    | {
        readonly k: 'for';
        readonly vars: readonly string[];
        /** A `range` for `for i in a..b`, anything else for `for (i, e) in vector`. */
        readonly over: Expr;
        readonly body: readonly Stmt[];
      }
    | {
        readonly k: 'if';
        readonly condition: Expr;
        readonly body: readonly Stmt[];
        readonly otherwise: readonly Stmt[] | null;
      }
    | { readonly k: 'with'; readonly items: readonly Expr[]; readonly body: readonly Stmt[] }
    | { readonly k: 'struct'; readonly name: string; readonly body: readonly Stmt[] }
    | { readonly k: 'enum'; readonly name: string; readonly constants: readonly string[] }
    /** `await expression`, inside a behaviour block only. */
    | { readonly k: 'await'; readonly value: Expr }
  );
