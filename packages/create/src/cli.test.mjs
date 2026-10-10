/**
 * `create-driftengine`, run the way `npm create @driftengine` runs it: arguments, files, exit code.
 *
 * `node --test` rather than vitest because half of a command's contract is its exit code, and an
 * agent driving it reads nothing else: a refusal that exits 0 is a project the agent believes it
 * created.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { main, parseArgs } from './cli.ts';
import { packageName } from './scaffold.ts';

const ENGINE = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;

function run(args, cwd) {
  const out = [];
  const err = [];
  const code = main(
    args,
    cwd,
    (line) => out.push(line),
    (line) => err.push(line),
  );
  return { code, out: out.join('\n'), err: err.join('\n') };
}

const scratch = () => mkdtempSync(path.join(tmpdir(), 'create-driftengine-'));

test('A NEW PROJECT IS A RUNNABLE GAME, ITS AGENT INSTRUCTIONS AND THE SKILL IN BOTH PLACES AGENTS LOOK', () => {
  const cwd = scratch();
  const result = run(['space-rocks'], cwd);
  assert.equal(result.code, 0, result.err);
  const dir = path.join(cwd, 'space-rocks');
  for (const file of [
    'package.json',
    'index.html',
    'src/main.ts',
    'src/spin.drs',
    'src/drs.d.ts',
    'vite.config.ts',
    'tsconfig.json',
    '.gitignore',
    'AGENTS.md',
    'README.md',
    'scripts/look.mjs',
    '.agents/skills/driftengine/SKILL.md',
    '.agents/skills/driftengine/references/manual.md',
    '.claude/skills/driftengine/SKILL.md',
  ]) {
    assert.ok(existsSync(path.join(dir, file)), `${file} is written`);
  }

  const manifest = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
  assert.equal(manifest.name, 'space-rocks');
  assert.equal(manifest.dependencies['@driftengine/core'], `^${ENGINE}`);
  assert.equal(manifest.dependencies['@driftengine/script'], `^${ENGINE}`);
  /* The language exactly, never a range: two compilers in one tree refuse every script. */
  assert.match(manifest.dependencies.driftscript, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.scripts.check, 'npm run typecheck && npm test && npm run look');

  /* The placeholder is gone everywhere the name goes. */
  assert.match(readFileSync(path.join(dir, 'index.html'), 'utf8'), /<title>space-rocks<\/title>/);
  assert.match(readFileSync(path.join(dir, 'vite.config.ts'), 'utf8'), /name: 'space-rocks'/);
  assert.match(readFileSync(path.join(dir, 'AGENTS.md'), 'utf8'), /^# space-rocks$/m);
  assert.match(result.out, /cd space-rocks/);
});

test('the first-game template brings the audio package its program imports', () => {
  const cwd = scratch();
  assert.equal(run(['game', '--template', 'first-game'], cwd).code, 0);
  const manifest = JSON.parse(readFileSync(path.join(cwd, 'game', 'package.json'), 'utf8'));
  assert.equal(manifest.dependencies['@driftengine/audio'], `^${ENGINE}`);
  assert.ok(existsSync(path.join(cwd, 'game', 'src', 'round.test.ts')));
});

test('a directory with anything in it is refused with exit 1, and nothing is written', () => {
  const cwd = scratch();
  mkdirSync(path.join(cwd, 'taken'));
  writeFileSync(path.join(cwd, 'taken', 'notes.txt'), 'mine');
  const result = run(['taken'], cwd);
  assert.equal(result.code, 1);
  assert.match(result.err, /is not empty/);
  assert.ok(!existsSync(path.join(cwd, 'taken', 'package.json')));
});

test('a directory holding only a repository is somewhere a project may go', () => {
  const cwd = scratch();
  mkdirSync(path.join(cwd, 'fresh', '.git'), { recursive: true });
  assert.equal(run(['fresh'], cwd).code, 0);
});

test('an unknown template is refused with exit 1 and the list of real ones', () => {
  const result = run(['x', '--template', 'nope'], scratch());
  assert.equal(result.code, 1);
  assert.match(result.err, /no template called nope.*starter/s);
});

test('--skill writes only the skill into an existing project, and refreshes an older copy', () => {
  const cwd = scratch();
  writeFileSync(path.join(cwd, 'package.json'), '{"name":"existing"}');
  mkdirSync(path.join(cwd, '.claude', 'skills', 'driftengine'), { recursive: true });
  writeFileSync(path.join(cwd, '.claude', 'skills', 'driftengine', 'SKILL.md'), 'an old copy');

  const result = run(['--skill'], cwd);
  assert.equal(result.code, 0, result.err);
  assert.match(
    readFileSync(path.join(cwd, '.claude/skills/driftengine/SKILL.md'), 'utf8'),
    /^---\nname: driftengine/,
  );
  assert.ok(existsSync(path.join(cwd, '.agents/skills/driftengine/SKILL.md')));
  assert.equal(readFileSync(path.join(cwd, 'package.json'), 'utf8'), '{"name":"existing"}');
  assert.ok(!existsSync(path.join(cwd, 'AGENTS.md')));
});

test('it never waits for an answer: no arguments at all is a project called my-game', () => {
  assert.deepEqual(parseArgs([]), {
    directory: 'my-game',
    template: 'starter',
    skill: false,
    help: false,
  });
  assert.deepEqual(parseArgs(['--template=first-game', 'a']), {
    directory: 'a',
    template: 'first-game',
    skill: false,
    help: false,
  });
  assert.throws(() => parseArgs(['--interactive']), /unknown option --interactive/);
  assert.throws(() => parseArgs(['a', 'b']), /one directory at a time/);
});

test('a directory name becomes a name npm accepts', () => {
  assert.equal(packageName('/tmp/My Great Game!'), 'my-great-game');
  assert.equal(packageName('/tmp/___'), 'my-game');
});

test('--help lists every template and exits 0', () => {
  const result = run(['--help'], scratch());
  assert.equal(result.code, 0);
  assert.match(result.out, /starter\s+A lit cube/);
  assert.match(result.out, /first-game\s+A complete 3D game/);
});
