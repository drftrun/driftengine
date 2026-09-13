import { describe, expect, it } from 'vitest';

import { withDefaults } from './withDefaults.ts';

/**
 * **The spread this replaces destroys the default it was written to preserve.**
 *
 * A caller building a partial from optional data — `{ lambda: settings.lambda }` where
 * `settings.lambda` may be absent — means "leave it alone". A spread means "set it to nothing", and
 * what comes out of the arithmetic downstream is `NaN`. TypeScript permits it here, because this
 * repository does not run `exactOptionalPropertyTypes`.
 */
describe('withDefaults', () => {
  const DEFAULTS = { lambda: 14, speed: 12, label: 'crane' };

  it('takes the values that were given', () => {
    expect(withDefaults(DEFAULTS, { lambda: 3 })).toEqual({ lambda: 3, speed: 12, label: 'crane' });
  });

  /** The case the spread gets wrong, and the whole reason this is a function. */
  it('keeps the default where a key is present and undefined', () => {
    const given = { lambda: undefined } as { lambda?: number };
    expect(withDefaults(DEFAULTS, given).lambda).toBe(14);
    /* And the spelling it replaces, so the difference is on the page rather than in a comment. */
    expect({ ...DEFAULTS, ...given }.lambda).toBeUndefined();
  });

  it('keeps every default when nothing is given', () => {
    expect(withDefaults(DEFAULTS, {})).toEqual(DEFAULTS);
  });

  /** Zero, empty and false are values somebody chose, and are not absence. */
  it('does not confuse a falsy value with an absent one', () => {
    const merged = withDefaults({ ...DEFAULTS, on: true }, { lambda: 0, label: '', on: false });
    expect(merged).toEqual({ lambda: 0, speed: 12, label: '', on: false });
  });

  it('does not mutate either argument', () => {
    const given = { lambda: 3 };
    const merged = withDefaults(DEFAULTS, given);
    merged.lambda = 99;
    expect(DEFAULTS.lambda).toBe(14);
    expect(given.lambda).toBe(3);
  });
});
