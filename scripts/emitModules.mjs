/**
 * What `tsc` leaves out of a package's `dist`, put back: the modules the package starts by URL.
 *
 * **A module named by URL is not an import, so `tsc` does not see it.** The engine starts a worker
 * the way a page does, `new Worker(new URL('./islandWorker.ts', import.meta.url))`, and every
 * bundler resolves that — but `rewriteRelativeImportExtensions` rewrites import specifiers and
 * nothing else, so the emitted `dist/workerPool.js` still named `./islandWorker.ts`, beside a `dist`
 * holding only `islandWorker.js`. And a module written as `.mjs`, which `tsc` does not compile, was
 * not copied into `dist` at all. A consumer resolving the default condition — the build, since
 * 2026-09-13 — got a worker URL that named nothing, and the workspace, which resolves source, could
 * not see it. Found 2026-09-19, packaging a game for the native host from the build.
 *
 * So after `tsc`: every non-test `.mjs` under `src/` is copied to the same place under `dist/`, and a
 * relative module URL naming `.ts` or `.mts` is renamed to `.js` or `.mjs`, as its import would be.
 * `missingModules` is the check that nothing named by URL is absent, which `cleanroom.mjs` runs
 * against the real tarballs.
 *
 * What it gives up: a URL built at run time rather than written as a literal is not seen, the same
 * limit every bundler has.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { withoutCommentsOrStrings } from './platform.mjs';

const MODULE_URL =
  /new URL\(\s*(['"])(\.{1,2}\/[^'"]+?)\.(ts|mts|js|mjs)\1\s*,\s*import\.meta\.url\s*\)/g;

function files(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) files(full, out);
    else out.push(full);
  }
  return out;
}

/**
 * Whether the `new URL(` at an offset of `source` is code rather than prose in a comment. The
 * stripper keeps every line and column, so its text at the same offset answers.
 */
function codeAt(source) {
  const code = withoutCommentsOrStrings(source);
  return (offset) => code.startsWith('new URL(', offset);
}

/** `code` with each relative module URL naming TypeScript renamed to the JavaScript `tsc` emits. */
export function rewriteModuleUrls(code) {
  const isCode = codeAt(code);
  return code.replace(MODULE_URL, (match, quote, stem, extension, offset) => {
    if (!isCode(offset) || (extension !== 'ts' && extension !== 'mts')) return match;
    const emitted = extension === 'ts' ? 'js' : 'mjs';
    return `new URL(${quote}${stem}.${emitted}${quote}, import.meta.url)`;
  });
}

/** Copy `src`'s hand-written modules into `dist`, and rename the module URLs in its emit. */
export function emitModules(src, dist) {
  for (const file of files(src)) {
    if (!file.endsWith('.mjs') || file.endsWith('.test.mjs')) continue;
    const target = path.join(dist, path.relative(src, file));
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(file, target);
  }
  for (const file of files(dist)) {
    if (!file.endsWith('.js') && !file.endsWith('.mjs')) continue;
    const code = readFileSync(file, 'utf8');
    const renamed = rewriteModuleUrls(code);
    if (renamed !== code) writeFileSync(file, renamed);
  }
}

/** Each module a file under `dist` names by URL that is not there, as `file names ./x, which …`. */
export function missingModules(dist) {
  const missing = [];
  for (const file of files(dist)) {
    if (!file.endsWith('.js') && !file.endsWith('.mjs')) continue;
    const source = readFileSync(file, 'utf8');
    const isCode = codeAt(source);
    for (const match of source.matchAll(MODULE_URL)) {
      if (!isCode(match.index)) continue;
      const named = `${match[2]}.${match[3]}`;
      if (!existsSync(path.resolve(path.dirname(file), named))) {
        missing.push(`${path.relative(dist, file)} names ${named}, which is not there`);
      }
    }
  }
  return missing;
}
