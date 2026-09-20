/**
 * Two-dimensional rotary position embedding, as Depth Anything 3's backbone applies it to queries
 * and keys, composed from the runtime's operators.
 *
 * **The rotation is `x·cos + rotate(x)·sin`, per head, with a head's first half turned by the
 * token's row and its second half by its column.** Within each half, `rotate` swaps the two
 * quarters and negates the first — so with the sign folded into the sine table it is a swap, and a
 * swap is two slices and a concatenation. The tables depend only on positions, which the graph's
 * shapes fix, so they are constants of the graph, rebuilt at every size.
 *
 * **What it gives up is a dispatch count**: eight small copies a rotation where a kernel of its own
 * would take one. At a depth model's shapes each is a few microseconds against an attention of a
 * millisecond and a half, and every operator used here already has a device bound; a `rope`
 * operator is the step to take when a measurement says the copies matter.
 *
 * **The tables are computed in single precision, operation by operation**, as the upstream's are:
 * a frequency as `100^(k/16)` rounded, an angle as position times frequency rounded, then its
 * cosine and sine. Computing them in double and rounding once would move an angle near 37 by
 * two millionths, which a parity check would then have to allow for. The transcendentals are the
 * engine's reproducible ones, so the tables are the same bits in every engine.
 */
import { exactCos, exactExp, exactSin } from '@driftengine/core';
import type { GraphBuilder, Weights } from '@driftengine/texture';

const f = Math.fround;

/*
 * The base every rotary and sinusoidal embedding in these models is built on, as its logarithm:
 * `100^e` is `exp(e · ln 100)`, through the engine's reproducible `exp`, since neither `**` nor
 * `Math.pow` gives the same bits on every engine and a capture reproduces.
 */
export const LOG_BASE = 4.605170185988092;

export interface RopeTables {
  /** `[tokens, heads · headDim]`: the cosine of each channel's angle. */
  readonly cos: Float32Array;
  /** The same shape: the sine, negated where `rotate` negates. */
  readonly sin: Float32Array;
}

/**
 * The tables for tokens at `positions` — a row and a column each, as integers — over `heads` of
 * `headDim` channels, at the upstream's base of 100.
 */
export function ropeTables(positions: Int32Array, heads: number, headDim: number): RopeTables {
  const tokens = positions.length / 2;
  const half = headDim / 2;
  const quarter = half / 2;
  const inverse = new Float32Array(quarter);
  for (let k = 0; k < quarter; k += 1) {
    inverse[k] = f(1 / f(exactExp(f((2 * k) / half) * LOG_BASE)));
  }
  const width = heads * headDim;
  const cos = new Float32Array(tokens * width);
  const sin = new Float32Array(tokens * width);
  for (let t = 0; t < tokens; t += 1) {
    for (let axis = 0; axis < 2; axis += 1) {
      const position = positions[2 * t + axis] as number;
      for (let j = 0; j < half; j += 1) {
        const angle = f(position * (inverse[j % quarter] as number));
        const c = f(exactCos(angle));
        const s = f(exactSin(angle)) * (j < quarter ? -1 : 1);
        for (let h = 0; h < heads; h += 1) {
          const at = t * width + h * headDim + axis * half + j;
          cos[at] = c;
          sin[at] = s;
        }
      }
    }
  }
  return { cos, sin };
}

/**
 * The rotation of `x`, `[tokens, heads · headDim]`, by tables already added to the graph as the
 * constants `cos` and `sin`.
 */
export function applyRope(
  graph: GraphBuilder,
  x: string,
  tokens: number,
  heads: number,
  headDim: number,
  cos: string,
  sin: string,
): string {
  const quarter = headDim / 4;
  const quarters = graph.node('reshape', [x], { shape: [tokens * heads * 2, 2, quarter] });
  const first = graph.node('slice', [quarters], { axis: 1, start: 0, end: 1 });
  const second = graph.node('slice', [quarters], { axis: 1, start: 1, end: 2 });
  const swapped = graph.node('reshape', [graph.node('concat', [second, first], { axis: 1 })], {
    shape: [tokens, heads * headDim],
  });
  return graph.node('add', [graph.node('mul', [x, cos]), graph.node('mul', [swapped, sin])]);
}

/** The tables as constants of the graph, named by `name`. */
export function ropeConstants(
  weights: Weights,
  name: string,
  positions: Int32Array,
  heads: number,
  headDim: number,
): { readonly cos: string; readonly sin: string } {
  const tables = ropeTables(positions, heads, headDim);
  const shape = [positions.length / 2, heads * headDim];
  return {
    cos: weights.constant(`${name}.cos`, shape, tables.cos),
    sin: weights.constant(`${name}.sin`, shape, tables.sin),
  };
}
