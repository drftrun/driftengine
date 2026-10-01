import { describe, expect, it } from 'vitest';

import { ScriptRng, splitMix } from './rng.ts';

/**
 * Every expectation here was printed by the language's own C generator, compiled from its source
 * as written; none was produced by the code under test.
 */
describe('the script generator', () => {
  it("SPLITMIX'S FIRST OUTPUT FOR SEED ZERO IS THE PUBLISHED ONE", () => {
    /* The first value of Vigna's `splitmix64.c` from state 0, which the C harness printed too. */
    expect(splitMix(0n)).toBe(0xe220a8397b1dcdafn);
  });

  it("THE GENERATOR MATCHES THE REFERENCE LANGUAGE'S, BIT FOR BIT", () => {
    const expected: [bigint, bigint[]][] = [
      [0n, [0x901e1eb9f0e51b0an, 0x2412602568df46fdn, 0x2be57c73dc613b28n, 0x57887f53b1ad40f5n]],
      [1n, [0x74f58d48af4d5efbn, 0x98ae70895c3b1313n, 0x76bddc8286432522n, 0xe9dbc4466b996947n]],
      [42n, [0x2a7fb76607e49ce4n, 0x6790e266602de2c4n, 0x752dc00f1a7f1da3n, 0x54ac527161fd4033n]],
      [
        1234567n,
        [0x6fae0c8b16b88e74n, 0xc069b6ab2b938d60n, 0x7ed498c4ac155178n, 0x263bbfadb144427dn],
      ],
    ];
    for (const [seed, raw] of expected) {
      const rng = new ScriptRng(seed);
      expect([rng.next(), rng.next(), rng.next(), rng.next()]).toEqual(raw);
    }
  });

  it('forms u() and f() as the language does, interleaved as a template draws them', () => {
    const rng = new ScriptRng(7n);
    expect(rng.u(3n)).toBe(1n);
    expect(rng.f(0.75)).toBe(0.7312490471249804);
    expect(rng.u(10n)).toBe(7n);
    expect(rng.f(1)).toBe(0.9912498357810983);
    /* u(2.9) in a script: the bound truncates to 2 before it reaches the generator. */
    expect(rng.u(2n)).toBe(0n);
    /* A bound where dividing first and multiplying afterwards rounds differently. */
    expect(new ScriptRng(7n).f(1.7)).toBe(0.42178947613926576);
  });

  it('reads its seed on the first draw, not at construction', () => {
    const rng = new ScriptRng(0n);
    rng.seed = 42n;
    expect(rng.next()).toBe(0x2a7fb76607e49ce4n);
  });
});
