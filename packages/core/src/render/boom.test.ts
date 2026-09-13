import { expect, test } from 'vitest';

import { Boom } from './boom.ts';

/**
 * **A timing whose value is present and undefined keeps the default.**
 *
 * Reported as a class rather than as this case: forty call sites in this tree pass an optional
 * straight into an optional slot, which is ordinary and correct, and a receiver that merges with a
 * spread turns it into a deleted default. Measured here before the fix: `{ retractLambda:
 * undefined }` took the arm's fraction from 0.96 to `NaN` on the first step, which is a camera that
 * never recovers. Nothing in this repository's typecheck can see it, because it does not run
 * `exactOptionalPropertyTypes`.
 */
test('a timing key that is present and undefined keeps the default', () => {
  const honest = new Boom();
  const given = { retractLambda: undefined } as { retractLambda?: number };
  const clobbered = new Boom(given);
  honest.reset(1);
  clobbered.reset(1);
  const expected = honest.step(0.4, 5, 1 / 60);
  const actual = clobbered.step(0.4, 5, 1 / 60);
  expect(Number.isNaN(actual)).toBe(false);
  expect(actual).toBe(expected);
});
