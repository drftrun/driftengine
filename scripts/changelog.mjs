#!/usr/bin/env node
/**
 * Release notes, printed from the changelog the engine already ships.
 *
 *   npm run changelog                 → the latest DriftEngine release
 *   npm run changelog -- 0.4.0        → that release
 *
 * The point of the changelog being structured data rather than prose is that
 * more than one consumer reads it. This is the second consumer: a tag message
 * or a GitHub release body is a `>` away, and it can never disagree with the
 * version the build reports, because both come from the same file.
 *
 * Markdown out, stdout only — anything that wants a different shape can read
 * the JSON directly rather than have this grow flags.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TITLE = 'DriftEngine';
const CHANGELOG = join(ROOT, 'packages/core/CHANGELOG.json');

/**
 * Printed in this order, whatever order the entries were written in.
 *
 * **A kind absent from this list is silently dropped**, which is how 3.9.0 shipped a `note` entry
 * that appeared in no release note anywhere: the entry was written, the renderer did not know the
 * word, and nothing said so. `scripts/changelog.test.mjs` asserts every kind in `CHANGELOG.json`
 * appears here, so the next one fails instead of vanishing.
 *
 * `note` is last because it is context rather than a change — what a release deliberately does
 * *not* contain, which this project treats as a deliverable and a consumer deciding whether to
 * upgrade needs to read.
 */
const KINDS = [
  ['added', 'Added'],
  ['changed', 'Changed'],
  ['fixed', 'Fixed'],
  ['note', 'Notes'],
];

function fail(message) {
  console.error(`[changelog] ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  let version = null;
  for (const arg of argv) {
    if (arg.startsWith('-')) fail(`unknown option ${arg}`);
    else if (version === null) version = arg;
    else fail('one version at a time');
  }
  return version;
}

function readReleases(path) {
  let releases;
  try {
    releases = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    fail(`cannot read ${path}: ${error.message}`);
  }
  if (!Array.isArray(releases) || releases.length === 0) fail(`${path} has no releases`);
  return releases;
}

function render(release) {
  const lines = [`## ${TITLE} ${release.version} — ${release.date}`];
  for (const [kind, heading] of KINDS) {
    const entries = release.entries.filter((entry) => entry.kind === kind);
    if (entries.length === 0) continue;
    lines.push('', `### ${heading}`, '');
    for (const entry of entries) lines.push(`- ${entry.text}`);
  }
  return lines.join('\n');
}

function main() {
  const version = parseArgs(process.argv.slice(2));
  const releases = readReleases(CHANGELOG);

  // Newest first, so no argument means the head of the file.
  const release =
    version === null ? releases[0] : releases.find((candidate) => candidate.version === version);
  if (release === undefined) {
    fail(`${TITLE} has no ${version}. Released: ${releases.map((r) => r.version).join(', ')}`);
  }

  console.log(render(release));
}

main();
