/** A value a node reads: its shape, and the values the reference reads. */
export interface CheckInput {
  readonly shape: readonly number[];
  readonly values: Float32Array;
}

export type CheckAttributes = Readonly<
  Record<string, number | string | boolean | readonly number[]>
>;

/** The reference on a graph of one node — a multiply and then GELU for a fused one. */
export function evaluateNode(
  op: string,
  attributes: CheckAttributes,
  inputs: readonly CheckInput[],
): { y: Float32Array; pre: Float32Array | null; shape: readonly number[] };

/** Each output's bound, derived from the inputs the reference was given. */
export function boundsFor(
  op: string,
  attributes: CheckAttributes,
  inputs: readonly CheckInput[],
  reference: Float32Array,
): Float64Array;

export interface CheckOutcome {
  readonly device: ArrayLike<number>;
  readonly reference: Float32Array;
  readonly bounds: Float64Array;
  /** The largest disagreement, and the largest share of its bound any output used. */
  readonly worst: number;
  readonly share: number;
  /** The outputs outside their bounds; −1 when the two differ in length. */
  readonly outside: readonly number[];
}

export function compareOutputs(
  device: ArrayLike<number>,
  reference: Float32Array,
  bounds: Float64Array,
): CheckOutcome;

/** One line for an outcome, and a line for each of its first three disagreements. */
export function describeOutcome(label: string, outcome: CheckOutcome): string[];
