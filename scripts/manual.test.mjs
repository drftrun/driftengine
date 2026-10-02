/*
 * The manual's structure, held where it can fail.
 *
 * A manual is the document most likely to be wrong about this engine, because it is the one that
 * shows code and names APIs while the code and the APIs move every week. Each test here closes one
 * way a page can stop being true without anything noticing.
 *
 * `node:` builtins only, so the documentation workflow can run it on a push that only moves
 * Markdown. What needs the declaration build, the API areas and the members of a type, is in
 * `manual-api.test.mjs` and runs with the rest of the scripts.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  DIRECTIVES,
  EXAMPLES_DIR,
  INLINE_LANGUAGES,
  MANUAL_DIR,
  SAMPLED_LANGUAGES,
  barrelNames,
  capabilityAreas,
  directivesOf,
  fencesOf,
  manualFiles,
  parseFrontmatter,
  packageNames,
  readManual,
  resolveSample,
  runDirectives,
  symbolMentions,
} from './manual.mjs';
import { GENERATORS, generatedBlocksOf } from './manual-generated.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manual = readManual(ROOT);
const pages = manual.sections.flatMap((section) =>
  section.pages.map((page) => ({ ...page, section: section.id })),
);
const present = pages.filter((page) => !page.missing);
const readJson = (name) => JSON.parse(readFileSync(path.join(ROOT, MANUAL_DIR, name), 'utf8'));

const FRONTMATTER_KEYS = new Set(['title', 'description', 'packages', 'areas', 'covers', 'plain']);

test('the manifest and the pages agree', () => {
  const problems = [];

  const sectionIds = manual.sections.map((section) => section.id);
  if (new Set(sectionIds).size !== sectionIds.length) problems.push('a section id appears twice');

  for (const page of pages) {
    if (page.missing) problems.push(`manual.json lists ${page.relative}, which does not exist`);
  }
  const slugs = pages.map((page) => `${page.section}/${page.slug}`);
  for (const slug of new Set(slugs)) {
    if (slugs.filter((other) => other === slug).length > 1)
      problems.push(`${slug} is listed twice`);
  }

  const listed = new Set(pages.map((page) => page.relative));
  for (const relative of manualFiles(ROOT)) {
    if (!listed.has(relative))
      problems.push(`${relative} is not in manual.json, so nothing links to it`);
  }

  for (const entry of readdirSync(path.join(ROOT, MANUAL_DIR))) {
    if (statSync(path.join(ROOT, MANUAL_DIR, entry)).isDirectory() && !sectionIds.includes(entry)) {
      problems.push(`${MANUAL_DIR}/${entry}/ is not a section in manual.json`);
    }
  }

  assert.deepEqual(problems, []);
});

test('every page says what it is, in the shape the site renders', () => {
  const problems = [];
  for (const page of present) {
    for (const key of Object.keys(page.frontmatter)) {
      if (!FRONTMATTER_KEYS.has(key))
        problems.push(`${page.relative}: unknown frontmatter key ${key}`);
    }
    if (page.title === '') problems.push(`${page.relative}: no title`);

    const headings = page.body.split('\n').filter((line) => line.startsWith('# '));
    if (headings.length !== 1) {
      problems.push(
        `${page.relative}: ${headings.length} top-level headings; a page has exactly one`,
      );
    } else if (headings[0].slice(2).trim() !== page.title) {
      problems.push(
        `${page.relative}: the heading "${headings[0].slice(2)}" is not the title "${page.title}"`,
      );
    }

    // A search result shows about this much, and a description longer than it is cut mid-word.
    const length = page.description.length;
    if (length < 50 || length > 160) {
      problems.push(`${page.relative}: description is ${length} characters; 50 to 160`);
    }
  }
  assert.deepEqual(problems, []);
});

test('every package a page names is a package', () => {
  const known = new Set(packageNames(ROOT));
  const problems = [];
  for (const page of present) {
    for (const name of page.packages) {
      if (!known.has(name))
        problems.push(`${page.relative}: ${name} is not a package in this repository`);
    }
  }
  assert.deepEqual(problems, []);
});

test('every block of TypeScript is a region the compiler checks, and says exactly what it says', () => {
  const problems = [];
  for (const page of present) {
    for (const fence of fencesOf(page.body)) {
      const where = `${page.relative}:${page.bodyLine + fence.line - 1}`;
      if (SAMPLED_LANGUAGES.has(fence.lang)) {
        if (fence.sample === null) {
          problems.push(
            `${where}: a ${fence.lang} block names no sample=; write it in examples/ and quote the region`,
          );
          continue;
        }
        const resolved = resolveSample(ROOT, fence.sample);
        if (resolved.error !== undefined) problems.push(`${where}: ${resolved.error}`);
        else if (resolved.code !== fence.code) {
          problems.push(`${where}: differs from ${fence.sample}; run npm run manual:sync`);
        }
      } else if (/from\s+['"]@driftengine\//.test(fence.code)) {
        problems.push(
          `${where}: an inline block imports an engine package; quote it from examples/ instead`,
        );
      } else if (!INLINE_LANGUAGES.has(fence.lang)) {
        problems.push(
          `${where}: a block in "${fence.lang || 'no language'}"; a page writes only ${[...INLINE_LANGUAGES].join(', ')} inline`,
        );
      }
    }
  }
  assert.deepEqual(problems, []);
});

/*
 * Every generated block says what its generator says today. A page that lists every function a
 * script can call is right the day it is written and wrong the day a function is added; this is what
 * notices, and `npm run manual:sync` is what fixes it.
 */
test('every generated block matches what generates it', () => {
  const problems = [];
  for (const page of present) {
    for (const block of generatedBlocksOf(page.body)) {
      const where = `${page.relative}:${page.bodyLine + block.start - 1}`;
      const generate = GENERATORS[block.name];
      if (generate === undefined) problems.push(`${where}: no generator is called "${block.name}"`);
      else if (block.end < 0)
        problems.push(`${where}: "${block.name}" has no <!-- end generated -->`);
      else if (generate(ROOT) !== block.text)
        problems.push(`${where}: "${block.name}" is out of date; run npm run manual:sync`);
    }
  }
  assert.deepEqual(problems, []);
});

test('every directive a page places is one the site knows', () => {
  const problems = [];
  for (const page of present) {
    for (const directive of directivesOf(page.body)) {
      const where = `${page.relative}:${page.bodyLine + directive.line - 1}`;
      if (!(directive.name in DIRECTIVES)) {
        problems.push(
          `${where}: <!-- ${directive.name} --> is not a directive; known: ${Object.keys(DIRECTIVES).join(', ')}`,
        );
      } else if ((DIRECTIVES[directive.name] === null) !== (directive.arg === null)) {
        problems.push(
          `${where}: <!-- ${directive.name} --> ${directive.arg === null ? 'needs' : 'takes no'} argument`,
        );
      }
    }
  }
  assert.deepEqual(problems, []);
});

test('every example a page runs is an example', () => {
  const problems = [];
  for (const page of present) {
    for (const directive of runDirectives(page.body)) {
      const dir = path.join(ROOT, EXAMPLES_DIR, directive.slug);
      for (const file of ['index.html', 'main.ts']) {
        if (!existsSync(path.join(dir, file))) {
          problems.push(
            `${page.relative}: run: ${directive.slug} has no ${EXAMPLES_DIR}/${directive.slug}/${file}`,
          );
        }
      }
    }
  }
  assert.deepEqual(problems, []);
});

/*
 * The test that catches a rename.
 *
 * A barrel renames `Foo` to `Bar`, every sample is updated because it stops compiling, and the
 * sentence that explains `Foo` goes on explaining it. This is the only thing that notices.
 */
test('every API name a page mentions is one a consumer can import', () => {
  const names = barrelNames(ROOT);
  const everywhere = new Set(readJson('plain.json'));
  const problems = [];
  for (const page of present) {
    const plain = new Set(page.plain);
    for (const mention of symbolMentions(page.body)) {
      if (names.has(mention.name) || plain.has(mention.name) || everywhere.has(mention.name))
        continue;
      problems.push(
        `${page.relative}:${page.bodyLine + mention.line - 1}: \`${mention.name}\` is not exported by any package; ` +
          "fix the name, or list it under plain: if it is not the engine's",
      );
    }
    for (const name of page.plain) {
      if (names.has(name))
        problems.push(`${page.relative}: plain lists ${name}, which is an export; remove it`);
    }
  }
  assert.deepEqual(problems, []);
});

/*
 * Every capability the engine ships has a page.
 *
 * The capability map's first section is the list of what ships. A row with no page in the manual
 * is a feature a consumer finds only by reading the source, which on this engine is most of them
 * until somebody writes it down. So a page declares the rows it documents under `covers:`, and a
 * row nobody covers is a failure.
 *
 * `uncovered.json` is the list of rows still waiting while the manual is being written. **It can
 * only shrink**: an entry that a page now covers fails until it is removed, so the list cannot
 * quietly outlive the work it records.
 */
/*
 * Every package has a page that teaches it.
 *
 * A capability row can be covered by a page about something larger, and an API area can be listed
 * by a page that mentions it once. A package is what a consumer installs, and the question they
 * arrive with is "what does this one do and how do I start". So each must be named under some
 * page's `packages:`, which is also what puts its install line on that page.
 */
test('every package has a page, or is listed as still waiting for one', () => {
  const all = packageNames(ROOT);
  const waiting = readJson('uncovered.json').packages;
  const named = new Set(present.flatMap((page) => page.packages));
  const problems = [];
  for (const name of waiting) {
    if (!all.includes(name)) problems.push(`uncovered.json lists ${name}, which is not a package`);
    if (named.has(name))
      problems.push(`uncovered.json lists ${name}, which a page now teaches; remove it`);
  }
  for (const name of all) {
    if (!named.has(name) && !waiting.includes(name)) {
      problems.push(`${name} ships and no page names it under packages:; write one`);
    }
  }
  assert.deepEqual(problems, []);
});

test('every shipped capability has a page, or is listed as still waiting for one', () => {
  const rows = capabilityAreas(ROOT);
  const known = new Set(rows);
  const waiting = readJson('uncovered.json').capabilities;
  const covered = new Set();
  const problems = [];

  for (const page of present) {
    for (const row of page.covers) {
      if (!known.has(row))
        problems.push(
          `${page.relative}: covers "${row}", which is not a row of CAPABILITIES.md §1`,
        );
      covered.add(row);
    }
  }
  for (const row of waiting) {
    if (!known.has(row))
      problems.push(`uncovered.json lists "${row}", which is not a row of CAPABILITIES.md §1`);
    if (covered.has(row))
      problems.push(`uncovered.json lists "${row}", which a page now covers; remove it`);
  }
  for (const row of rows) {
    if (!covered.has(row) && !waiting.includes(row)) {
      problems.push(`"${row}" ships and no page covers it; write one, or extend a page's covers:`);
    }
  }
  assert.deepEqual(problems, []);
});

/**
 * A fence knows how many lines it spans, so a sync replaces exactly those.
 *
 * An empty block and a block holding one blank line both have the code `''`, and the sync used to
 * take the span from the code: it inserted a region above the blank line a formatter had put in an
 * empty block and left the line behind, so a first sync of a new chapter disagreed with its own
 * regions and a second one was needed.
 */
test('a fence spans the lines between its markers, blank or none', () => {
  const [empty, blank, two] = fencesOf(
    ['```ts sample=a.ts#x', '```', '```ts sample=a.ts#y', '', '```', '```ts', 'a', 'b', '```'].join(
      '\n',
    ),
  );
  assert.deepEqual(
    [empty?.code, empty?.length, blank?.code, blank?.length, two?.length],
    ['', 0, '', 1, 2],
  );
});

/** A list Prettier has broken over several lines reads as the one-line list it was. */
test('frontmatter reads a list broken over lines as Prettier breaks it', () => {
  const page = [
    '---',
    'title: T',
    'covers:',
    '  [',
    "    'one',",
    "    'two',",
    '  ]',
    'areas: []',
    '---',
    'body',
  ].join('\n');
  const { data } = parseFrontmatter(page);
  assert.deepEqual([data.covers, data.areas, data.title], [['one', 'two'], [], 'T']);
});

/*
 * The core package's README is the page npm shows, and its quickstart is the program a stranger
 * copies first. It is the starter example with its region markers taken out, so it is code the
 * typecheck compiles; this keeps the two from drifting apart, as `manual:sync` does for a chapter.
 */
test("the core README's quickstart is the starter example", () => {
  const readme = readFileSync(path.join(ROOT, 'packages/core/README.md'), 'utf8');
  const after = readme.slice(readme.indexOf('## Quickstart'));
  const block = /```ts\n([\s\S]*?)```/.exec(after);
  assert.ok(block, 'packages/core/README.md has no ts block under "## Quickstart"');
  const starter = readFileSync(path.join(ROOT, 'examples/starter/main.ts'), 'utf8');
  const program = starter
    .slice(starter.indexOf('// #region'))
    .split('\n')
    .filter((line) => !/^\s*\/\/ #(end)?region\b/.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  assert.equal(block[1].trim(), program);
  /* The page imports `spin.drs`, so the README carries it, held to the starter's the same way. */
  const rule = /```drs\n([\s\S]*?)```/.exec(after);
  assert.ok(rule, 'packages/core/README.md has no drs block under "## Quickstart"');
  const spin = readFileSync(path.join(ROOT, 'examples/starter/spin.drs'), 'utf8')
    .split('\n')
    .filter((line) => !/^\s*\/\/ #(end)?region\b/.test(line))
    .join('\n')
    .trim();
  assert.equal(rule[1].trim(), spin);
});
