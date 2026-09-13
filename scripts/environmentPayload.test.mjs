/**
 * The environment loader stays opt-in, so the zero-texture-files rule is kept rather than waived.
 *
 * `AGENTS.md` says colour comes from vertex data and procedural shaders, not image assets, and an
 * environment map is an image asset. The resolution is the one `parseSdfFont` established: the
 * capability is **opt-in per consumer**, so a game that never loads an environment fetches nothing,
 * ships no decoder, and this engine carries no image of its own — exactly as a game that never
 * calls `createSdfText` ships no font.
 *
 * That promise is worth nothing the moment `core` reaches for the decoder itself: every consumer
 * would then bundle a Radiance parser whether or not it will ever open a `.hdr`, and the promise
 * becomes false with nothing failing. Which is the failure `docs/README.md` opens by describing, so
 * it is asserted here rather than left to review.
 *
 * A `.mjs` under `scripts/` rather than a Vitest file beside the module, because it reads the tree
 * with `node:fs` and the packages' own `tsconfig` does not type Node's APIs — the same reason
 * `boundaries.test.mjs` lives here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const CORE = path.join(ROOT, 'packages/core/src');

function walk(dir, keep, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, keep, out);
    else if (keep(full)) out.push(full);
  }
  return out;
}

/**
 * Import statements rather than mentions.
 *
 * The barrel's own comment names both the decoder and the package it lives in, to say where a
 * consumer finds one and that core is not it. A check that cannot tell a sentence from a dependency
 * would forbid documenting the very rule it enforces.
 */
const IMPORTS = /(?:^|\n)\s*(?:import|export)[^\n]*from\s*['"]([^'"]+)['"]/g;

test('core never imports the Radiance decoder', () => {
  const offenders = walk(CORE, (f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .filter((file) => {
      const code = readFileSync(file, 'utf8');
      IMPORTS.lastIndex = 0;
      for (let m = IMPORTS.exec(code); m !== null; m = IMPORTS.exec(code)) {
        if (/radianceHdr|@driftengine\/assets/.test(m[1] ?? '')) return true;
      }
      return false;
    })
    .map((file) => path.relative(ROOT, file));

  assert.deepEqual(
    offenders,
    [],
    `these reach for the decoder, so every consumer would bundle it:\n${offenders.join('\n')}`,
  );
});

/**
 * And nothing in the tree ships an environment of its own.
 *
 * A committed `.hdr` keeps the import graph spotless and breaks the same promise, which is why this
 * looks for bytes rather than for imports. `demo/dev/public/` is excluded because nothing under it
 * is committed — it is the one place a person drops a file to look at something.
 */
test('the engine ships no environment image', () => {
  const images = walk(path.join(ROOT, 'packages'), (f) => /\.(hdr|exr|ktx2?)$/i.test(f)).map(
    (file) => path.relative(ROOT, file),
  );
  assert.deepEqual(images, [], `these ship an environment: ${images.join(', ')}`);
});
