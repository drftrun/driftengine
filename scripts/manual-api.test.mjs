/*
 * The manual against the API reference, which only the declaration build can answer.
 *
 * `manual.test.mjs` holds what the barrels' text can settle and runs on a Markdown-only push. What
 * needs `tsc`, which areas exist and what members a type has, is here, and runs with the rest of
 * the scripts. A chapter-only commit that names a member that is not there is caught at the site
 * build instead; that gap is the price of keeping the documentation workflow cheap.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildApi } from './docs-api.mjs';
import { MANUAL_DIR, readManual, symbolMentions } from './manual.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const api = buildApi({ root: ROOT });
const manual = readManual(ROOT);
const pages = manual.sections.flatMap((section) => section.pages).filter((page) => !page.missing);
const waiting = JSON.parse(
  readFileSync(path.join(ROOT, MANUAL_DIR, 'uncovered.json'), 'utf8'),
).areas;

const symbols = new Map();
for (const group of api.groups) {
  for (const symbol of group.symbols)
    if (!symbols.has(symbol.name)) symbols.set(symbol.name, symbol);
}

/*
 * Every area of the reference is explained by a page. An area is what a reader finds in the
 * reference and wants the reasoning behind; a page naming it under `areas:` is where that is, and
 * the site links the two both ways.
 */
test('every API area has a page that explains it, or is listed as still waiting for one', () => {
  const areas = new Set(api.groups.map((group) => group.area));
  const named = new Set();
  const problems = [];
  for (const page of pages) {
    for (const area of page.areas) {
      if (!areas.has(area))
        problems.push(`${page.relative}: areas lists "${area}", which the reference does not have`);
      named.add(area);
    }
  }
  for (const area of waiting) {
    if (!areas.has(area))
      problems.push(`uncovered.json lists the area "${area}", which the reference does not have`);
    if (named.has(area))
      problems.push(
        `uncovered.json lists the area "${area}", which a page now explains; remove it`,
      );
  }
  for (const area of areas) {
    if (!named.has(area) && !waiting.includes(area))
      problems.push(`the area "${area}" has no page; name it under a page's areas:`);
  }
  assert.deepEqual(problems, []);
});

test('every Type.member a page mentions is a member of that type', () => {
  const problems = [];
  for (const page of pages) {
    for (const mention of symbolMentions(page.body)) {
      if (mention.member === null) continue;
      const symbol = symbols.get(mention.name);
      if (symbol === undefined) continue; // manual.test.mjs reports an unknown name.
      const members = (symbol.members ?? []).map((member) => member.name);
      if (!members.includes(mention.member)) {
        problems.push(
          `${page.relative}:${page.bodyLine + mention.line - 1}: ${mention.name} has no member ${mention.member}`,
        );
      }
    }
  }
  assert.deepEqual(problems, []);
});

/*
 * Every export says what it is.
 *
 * A reference page with no words on it is a signature a reader has to reverse-engineer, and a
 * third of the surface was that when the reference first printed whole comments. The list in
 * `undocumented.json` is what was found then. **It can only shrink**: an export that gains a
 * comment fails until it leaves the list, and an export added without one fails at once, so the
 * commit that adds a public symbol is the commit that says what it is.
 */
test('every export has a comment, or is listed as still waiting for one', () => {
  const waitingFor = new Set(
    JSON.parse(readFileSync(path.join(ROOT, MANUAL_DIR, 'undocumented.json'), 'utf8')),
  );
  const problems = [];
  const seen = new Set();
  for (const group of api.groups) {
    for (const symbol of group.symbols) {
      const key = `${group.area}/${symbol.name}`;
      seen.add(key);
      const bare = symbol.summary === '';
      if (bare && !waitingFor.has(key)) {
        problems.push(`${key} is exported with no comment; say what it is above its declaration`);
      }
      if (!bare && waitingFor.has(key)) {
        problems.push(`${key} has a comment now; remove it from undocumented.json`);
      }
    }
  }
  for (const key of waitingFor) {
    if (!seen.has(key)) problems.push(`undocumented.json lists ${key}, which is not exported`);
  }
  assert.deepEqual(problems, []);
});
