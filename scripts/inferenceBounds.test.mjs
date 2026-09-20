/**
 * The device parity check's bounds, held against the worst case their derivations name.
 *
 * `inference-parity.mjs` needs a GPU and is run by hand, so nothing on a machine without one says
 * whether a bound it uses is still a bound. The one worth holding here is the dot product's, because
 * every multiply and convolution is checked through it: the worst recursive sum is known in closed
 * form, single precision can be simulated exactly with `Math.fround`, and a bound whose multiplier
 * drifted below the number of taps would pass this machine's device and fail a worse one.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { U, dotBound } from './inferenceBounds.mjs';

test('A DOT BOUND IS NOT BELOW THE WORST RECURSIVE SUM, and not far above it', () => {
  /*
   * A bias of 1 and n products just under half a unit of it: each addition rounds back to 1, so a
   * sum in single precision loses all n of them, and the error is n·v against a bound of about
   * (n + 3)·u. Simulated operation by operation, as a gather kernel adds its taps.
   */
  const n = 1000;
  const v = Math.fround(U * (1 - 2 ** -10));
  let sum = Math.fround(1);
  for (let i = 0; i < n; i += 1) sum = Math.fround(sum + v);
  assert.equal(sum, 1);
  const reference = Math.fround(1 + n * v);
  const error = Math.abs(sum - reference);
  const bound = dotBound(n, 1 + n * v, reference);
  assert.ok(error <= bound, `the sum lost ${error}, beyond its bound of ${bound}`);
  assert.ok(error > bound / 2, `a bound of ${bound} is more than twice the worst case, ${error}`);
});
