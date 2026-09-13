/**
 * Release notes, read and ordered in one place so every consumer shows the same list.
 *
 * **The engine's `CHANGELOG.json` is the source of truth and this is how it is read.** Four things
 * display these notes — the game, the studio, the website and the engine's own site — and each used
 * to parse and sort them itself, with a copy of the data pushed between repositories by hand after
 * every release. One reader, one ordering, and a consumer regenerates from the engine at build time
 * rather than waiting for somebody to republish.
 *
 * **A product's own history is ordered by version, never by date.** That is the bug this was
 * written for: a date-first order put 2.5.0 above 2.6.0 because 2.5.0 carried a date somebody had
 * guessed, so the list a player read disagreed with the numbers in it. A date is metadata and can
 * be wrong; a version cannot.
 *
 * **Plain Node, beside `browser.mjs` and `cdp.mjs`**, because the things that read it are build
 * scripts in four other repositories rather than anything a game bundles. `scripts/releases.test.mjs`
 * in this repository is its suite.
 */
/**
 * A release is `{ product, version, date, entries, reports? }`, and an entry is
 * `{ kind, text, short? }`. Described here rather than declared: this is the shape four
 * repositories read, and `releases.d.ts` in the design system types it for the ones that care.
 */

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

/**
 * Sortable rank for a semver string.
 *
 * Hand-rolled rather than taken from a dependency, and by *number* rather than by string — a
 * string comparison puts `2.10.0` below `2.9.0`, which is the second ordering bug this file
 * exists to make impossible.
 */
function rank(version) {
  const match = SEMVER.exec(version);
  if (match === null) throw new Error(`not a semver version: ${version}`);
  return Number(match[1]) * 1_000_000 + Number(match[2]) * 1_000 + Number(match[3]);
}

/**
 * One product's releases, newest first, field by field.
 *
 * Copied field by field rather than spread, so a key added to a changelog has to be added here
 * before it can reach a reader: this output is published, and a changelog is edited far more
 * casually than a published surface deserves.
 */
export function parseChangelog(raw, product) {
  if (!Array.isArray(raw)) throw new Error(`${product}: a changelog is an array of releases`);

  const releases = raw.map((release) => {
    if (typeof release.version !== 'string' || typeof release.date !== 'string') {
      throw new Error(`${product}: a release needs a version and a date`);
    }
    rank(release.version);

    const entries = Array.isArray(release.entries) ? release.entries : [];
    const out = {
      product,
      version: release.version,
      date: release.date,
      entries: entries.map((entry) => {
        const carried = {
          kind: typeof entry.kind === 'string' ? entry.kind : 'changed',
          text: typeof entry.text === 'string' ? entry.text : '',
        };
        return typeof entry.short === 'string' && entry.short.length > 0
          ? { ...carried, short: entry.short }
          : carried;
      }),
    };
    return Array.isArray(release.reports) && release.reports.length > 0
      ? { ...out, reports: release.reports.map(String) }
      : out;
  });

  return releases.sort((a, b) => rank(b.version) - rank(a.version));
}

/**
 * Several products' releases as one list, newest first.
 *
 * **Across products there is nothing but the date to interleave by**, so that is what is used —
 * but a date that would break a product's own version order is clamped rather than obeyed. A
 * release cannot sort above a newer release of the same product, whatever its date says, which is
 * what keeps a single wrong date from scrambling the whole list instead of just its own row.
 *
 * The displayed date is the authored one. Only the ordering is clamped, because showing a
 * corrected date would hide the error rather than survive it.
 */
export function mergeReleases(products) {
  const order = new Map();
  for (const product of products) {
    let ceiling = null;
    /* Newest first already, so each release is clamped to the one above it. */
    for (const release of product) {
      const effective = ceiling === null || release.date <= ceiling ? release.date : ceiling;
      order.set(release, effective);
      ceiling = effective;
    }
  }

  return products.flat().sort((a, b) => {
    const dateA = order.get(a) ?? a.date;
    const dateB = order.get(b) ?? b.date;
    if (dateA !== dateB) return dateA < dateB ? 1 : -1;
    if (a.product !== b.product) return a.product < b.product ? -1 : 1;
    return rank(b.version) - rank(a.version);
  });
}
