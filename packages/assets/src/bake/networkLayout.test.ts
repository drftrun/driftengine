import { expect, test } from 'vitest';
import { nnetWeightCount } from '@driftengine/drft';
import { networkWeightCount } from '@driftengine/texture';

/**
 * **The container's weight layout and the evaluator's are one convention, held here.**
 *
 * `@driftengine/drft` refuses an `NNET` network whose weight count disagrees with its shape, and
 * `@driftengine/texture` evaluates weights in that layout — but neither package can import the
 * other, so each carries the formula. This package writes networks and imports both, which makes it
 * the one place a test can see the two copies side by side. A layout changed in one and not the
 * other is a network the container accepts and the evaluator reads wrongly.
 */
test('the container and the evaluator count a shape’s weights the same way', () => {
  let checked = 0;
  for (let inputs = 1; inputs <= 6; inputs += 1) {
    for (let outputs = 1; outputs <= 5; outputs += 1) {
      for (const hidden of [[], [1], [16], [3, 7], [16, 16], [2, 5, 9, 4]]) {
        expect(nnetWeightCount(inputs, hidden, outputs), `${inputs} ${hidden} ${outputs}`).toBe(
          networkWeightCount({ inputs, hidden, outputs }),
        );
        checked += 1;
      }
    }
  }
  expect(checked).toBe(180);
});
