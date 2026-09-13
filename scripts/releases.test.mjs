import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { mergeReleases, parseChangelog } from '../packages/core/scripts/releases.mjs';

const engine = [
  { version: '2.6.0', date: '2026-08-23', entries: [{ kind: 'added', text: 'a' }] },
  { version: '2.5.0', date: '2026-08-25', entries: [{ kind: 'fixed', text: 'b', short: 'B' }] },
  { version: '2.4.0', date: '2026-08-23', entries: [{ kind: 'added', text: 'c' }] },
];

describe('parseChangelog', () => {
  it('carries the fields a reader is shown, and drops the rest', () => {
    const [first] = parseChangelog(engine, 'engine');
    assert.equal(first.product, 'engine');
    assert.equal(first.version, '2.6.0');
    assert.deepEqual(first.entries[0], { kind: 'added', text: 'a' });
  });

  it('keeps a short form only where there is one', () => {
    const releases = parseChangelog(engine, 'engine');
    assert.equal(releases[1].entries[0].short, 'B');
    assert.equal(releases[0].entries[0].short, undefined);
  });

  /*
   * **A product's own history is ordered by version, always.** This is the bug it was written
   * for: a date-first order put 2.5.0 above 2.6.0 because 2.5.0 carried a date somebody had
   * guessed, and the list a player reads then disagreed with the numbers in it. A date is
   * metadata and can be wrong; a version cannot.
   */
  it('orders one product by version even when its dates disagree', () => {
    const versions = parseChangelog(engine, 'engine').map((release) => release.version);
    assert.deepEqual(versions, ['2.6.0', '2.5.0', '2.4.0']);
  });

  it('orders by number rather than by string, so 10 comes after 9', () => {
    const versions = parseChangelog(
      [
        { version: '2.9.0', date: '2026-08-24', entries: [] },
        { version: '2.10.0', date: '2026-08-24', entries: [] },
        { version: '2.1.0', date: '2026-08-01', entries: [] },
      ],
      'engine',
    ).map((release) => release.version);
    assert.deepEqual(versions, ['2.10.0', '2.9.0', '2.1.0']);
  });

  it('refuses a version it cannot order rather than sorting it somewhere', () => {
    assert.throws(
      () => parseChangelog([{ version: 'next', date: '2026-08-24', entries: [] }], 'x'),
      /semver/i,
    );
  });
});

describe('mergeReleases', () => {
  /*
   * Across products there is nothing but the date to go on, so that is what interleaves them —
   * and within each product the version order above still holds, whatever the dates say.
   */
  it('interleaves two products by date and keeps each ones own order', () => {
    const merged = mergeReleases([
      parseChangelog(engine, 'engine'),
      parseChangelog(
        [
          { version: '0.15.0', date: '2026-08-24', entries: [] },
          { version: '0.14.0', date: '2026-08-22', entries: [] },
        ],
        'game',
      ),
    ]);
    assert.deepEqual(
      merged.map((release) => `${release.product} ${release.version}`),
      ['game 0.15.0', 'engine 2.6.0', 'engine 2.5.0', 'engine 2.4.0', 'game 0.14.0'],
    );
  });

  /* Two products released on one day are ordered by name, so a generated file cannot churn. */
  it('breaks a tie by product, so the order is total', () => {
    const merged = mergeReleases([
      parseChangelog([{ version: '1.0.0', date: '2026-08-24', entries: [] }], 'zed'),
      parseChangelog([{ version: '1.0.0', date: '2026-08-24', entries: [] }], 'alpha'),
    ]);
    assert.deepEqual(
      merged.map((release) => release.product),
      ['alpha', 'zed'],
    );
  });
});
