/**
 * The operators a graph may name: what each one's output shape is, and how it is evaluated.
 *
 * **One table, and a graph naming anything not in it is refused at validation, by name** — the
 * runtime lacking an operator is a fact about the model, and a caller learns it when the model is
 * loaded rather than at its first frame. Adding an operator is adding a row here, with its reference
 * in `linear.ts`, `attention.ts` or `spatial.ts` and its device kernel in core.
 *
 * **`linear` is the upstream layer, `x·Wᵀ + b`, with its weight in the upstream layout `[out][in]`,
 * and the bias added in double precision before the one rounding** — which is what makes a
 * perceptron written as a graph agree with `evalNetwork` bit for bit, and is the evidence there is
 * one runtime rather than two.
 *
 * Shapes are checked before anything runs; a shape function returns the output shape, or a sentence
 * saying why there is none.
 */
import { DENSE_OPERATORS } from './denseOperators.ts';
import type { Operator } from './operatorKit.ts';
import { SHAPE_OPERATORS } from './shapeOperators.ts';
import { SPATIAL_OPERATORS } from './spatialOperators.ts';

export type { AttributeValue, Attributes, Operator } from './operatorKit.ts';

export const OPERATORS: ReadonlyMap<string, Operator> = new Map<string, Operator>([
  ...DENSE_OPERATORS,
  ...SPATIAL_OPERATORS,
  ...SHAPE_OPERATORS,
]);
