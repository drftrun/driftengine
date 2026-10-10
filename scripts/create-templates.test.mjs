/**
 * The skill and the starter templates: current, valid, and claiming nothing the engine does not have.
 *
 * A skill is read by an agent that cannot tell a stale sentence from a true one and will build on
 * either, so every checkable claim in it is checked here: that its code is the examples' code,
 * that every name it gives an agent is a name the engine exports or declares, and that its
 * frontmatter is what the Agent Skills format requires, since a skill an agent's loader refuses is
 * a skill that silently is not there.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { SKILL, importedPackages, projectPage, stale } from './create-templates.mjs';
import { barrelNames, proseOf, symbolMentions } from './manual.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const skillText = readFileSync(path.join(ROOT, SKILL, 'SKILL.md'), 'utf8');

test('THE SKILL AND THE TEMPLATES ARE WHAT THE GENERATOR WOULD WRITE TODAY', () => {
  const problems = stale(ROOT);
  assert.deepEqual(problems, [], `run \`npm run create:templates\`:\n  ${problems.join('\n  ')}`);
});

test('the skill frontmatter is what the Agent Skills format requires', () => {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(skillText);
  assert.ok(match !== null, 'SKILL.md opens with frontmatter');
  const fields = Object.fromEntries(
    match[1].split('\n').map((line) => {
      const at = line.indexOf(':');
      return [line.slice(0, at), line.slice(at + 1).trim()];
    }),
  );
  /* 1-64 lower-case letters, digits and single hyphens, equal to the folder's name. */
  assert.match(fields.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  assert.ok(fields.name.length <= 64);
  assert.equal(fields.name, path.basename(SKILL));
  assert.ok(fields.description.length > 0 && fields.description.length <= 1024);
  assert.equal(fields.license, 'Apache-2.0');
  /* The format asks for under 500 lines, and the body is loaded whole when the skill is used. */
  assert.ok(skillText.split('\n').length < 500, 'SKILL.md is under 500 lines');
});

/**
 * Names the skill gives that belong to the platform, not the engine: the variable `look` reads for
 * a browser, and the two globals a game must not take randomness and time from. The manual's own
 * pages declare theirs the same way, in a `plain` list.
 */
const PLAIN = new Set(['CHROME_PATH', 'Math', 'Date']);

test('every type and constant the skill names is exported by a package', () => {
  const names = barrelNames(ROOT);
  const missing = symbolMentions(skillText.slice(skillText.indexOf('\n---\n') + 5))
    .filter((mention) => !names.has(mention.name) && !PLAIN.has(mention.name))
    .map((mention) => `${mention.name} (line ${mention.line})`);
  assert.deepEqual(missing, [], `the skill names what nothing exports:\n  ${missing.join('\n  ')}`);
});

/** Every `.ts` file under the engine packages' `src/`, read once. */
function engineSource() {
  const texts = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts'))
        texts.push(readFileSync(full, 'utf8'));
    }
  };
  for (const pkg of readdirSync(path.join(ROOT, 'packages'))) {
    const src = path.join(ROOT, 'packages', pkg, 'src');
    if (existsSync(src)) walk(src);
  }
  /* The instruments a project imports as `@driftengine/core/scripts/*.mjs`, which the skill names. */
  const instruments = path.join(ROOT, 'packages', 'core', 'scripts');
  for (const entry of readdirSync(instruments)) {
    if (entry.endsWith('.mjs')) texts.push(readFileSync(path.join(instruments, entry), 'utf8'));
  }
  texts.push(
    readFileSync(path.join(ROOT, 'node_modules', 'driftscript', 'dist', 'index.d.ts'), 'utf8'),
  );
  return texts.join('\n');
}

/**
 * Every function, method and option the skill names in its prose is declared somewhere.
 *
 * Looser than the check above, deliberately: an option field or a method has no export to look up,
 * so this asks only that the engine's source or the language's declarations contain the name as a
 * word. That is enough to catch the failure that matters, a name invented for the skill.
 */
test('every function and option the skill names occurs in the engine or the language', () => {
  const source = engineSource();
  const words = new Set();
  for (const match of proseOf(skillText).matchAll(/`([a-z][A-Za-z0-9]*)(?:\([^`]*\))?`/g)) {
    if (/[A-Z]/.test(match[1]) || match[0].includes('(')) words.add(match[1]);
  }
  const missing = [...words].filter((word) => !new RegExp(`\\b${word}\\b`).test(source));
  assert.deepEqual(
    missing,
    [],
    `the skill names what the source never mentions:\n  ${missing.join('\n  ')}`,
  );
});

test("a project's page loses the index's link, gains an icon, and finds its program in src", () => {
  const page = projectPage(`<!doctype html>
<html>
  <head>
    <meta name="viewport" content="width=device-width" />
    <title>An example · DriftEngine example</title>
    <style>
      #home {
        position: fixed;
      }
    </style>
  </head>
  <body>
    <!-- Only for the served index; delete this line when copying the folder into a project. -->
    <a id="home" href="../">all examples</a>
    <script type="module" src="./main.ts"></script>
  </body>
</html>`);
  assert.ok(!page.includes('id="home"') && !page.includes('#home') && !page.includes('Only for'));
  assert.ok(page.includes('<link rel="icon" href="data:," />'));
  assert.ok(page.includes('<title>my-game</title>'));
  assert.ok(page.includes('src="./src/main.ts"'));
});

test('an example page that has changed shape is refused by name, not copied half-rewritten', () => {
  assert.throws(
    () => projectPage('<html><title>t</title><script src="./main.ts"></script></html>', 'x.html'),
    /x\.html no longer has/,
  );
});

test('a template depends on exactly the engine packages and language its program imports', () => {
  assert.deepEqual(
    importedPackages([
      "import { a } from '@driftengine/core';",
      "import type { b } from '@driftengine/audio';",
      "import { c } from 'driftscript';\nimport { d } from 'driftscript/vite';",
      "import { e } from 'vitest';",
    ]),
    ['@driftengine/audio', '@driftengine/core', 'driftscript'],
  );
});
