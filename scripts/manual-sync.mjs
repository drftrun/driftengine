/*
 * Rewrite every sampled block in the manual from the region it names.
 *
 * `manual.test.mjs` fails when a block and its region differ, and this is the other half: the
 * command that makes them agree. A block is only ever rewritten from its region, never the other
 * way round, because the region is the half the compiler checks.
 *
 * Usage: `npm run manual:sync`, after changing an example a page quotes.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SAMPLED_LANGUAGES,
  fencesOf,
  manualFiles,
  parseFrontmatter,
  resolveSample,
} from './manual.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function syncManual(root = ROOT) {
  const changed = [];
  const problems = [];
  for (const relative of manualFiles(root)) {
    const file = path.join(root, relative);
    const text = readFileSync(file, 'utf8').replaceAll('\r\n', '\n');
    const { body } = parseFrontmatter(text, relative);
    const head = text.slice(0, text.length - body.length);
    const lines = body.split('\n');

    let rewrote = false;
    for (const fence of fencesOf(body).reverse()) {
      if (!SAMPLED_LANGUAGES.has(fence.lang) || fence.sample === null) continue;
      const resolved = resolveSample(root, fence.sample);
      if (resolved.error !== undefined) {
        problems.push(`${relative}:${fence.line}: ${resolved.error}`);
        continue;
      }
      if (resolved.code === fence.code) continue;
      lines.splice(fence.line, fence.length, ...resolved.code.split('\n'));
      rewrote = true;
    }

    if (rewrote) {
      writeFileSync(file, head + lines.join('\n'), 'utf8');
      changed.push(relative);
    }
  }
  return { changed, problems };
}

if (import.meta.filename === process.argv[1]) {
  const { changed, problems } = syncManual();
  for (const relative of changed) console.log(`manual:sync rewrote ${relative}`);
  for (const problem of problems) console.error(problem);
  if (changed.length === 0 && problems.length === 0)
    console.log('manual:sync: every block matches its region');
  if (problems.length > 0) process.exitCode = 1;
}
