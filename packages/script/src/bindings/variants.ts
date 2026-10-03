/**
 * A host enum's variants, as the values a script holds and hands back.
 *
 * An engine answer that is one of a few things is an enum on the script's side: DriftScript lets a
 * host declare one (`OpaqueType.variants`), a script names its variants and a `match` over it has
 * to cover them all. The engine keeps its own numbering, and this is the one place a number becomes
 * a variant and back. Before it, each such capability answered with the number and a sentence
 * saying what each number meant, and every script restated that sentence as constants.
 *
 * One frozen object per variant, made once, so answering allocates nothing. A script compares a
 * variant by its tag, so a script's own copy of `{ tag: 'Solid' }` equals this one.
 */
import type { OpaqueType } from 'driftscript';

export interface Variant {
  readonly tag: string;
}

export interface HostEnum {
  /** The type to register, so a script can name it. */
  readonly type: OpaqueType;
  /** The variant for an engine code, in the order the engine numbers them. */
  readonly of: readonly Variant[];
  /** The engine's code for a variant a script handed back, or -1 for anything else. */
  code(variant: Variant): number;
}

export function hostEnum(
  module: string,
  name: string,
  variants: readonly string[],
  doc: string,
): HostEnum {
  const of = variants.map((tag) => Object.freeze({ tag }));
  const codes = new Map(variants.map((tag, index) => [tag, index]));
  return {
    type: { module, name, doc, variants },
    of,
    code: (variant) => codes.get(variant.tag) ?? -1,
  };
}
