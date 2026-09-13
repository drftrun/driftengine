/**
 * The package reaches nothing it did not declare, and declares only core.
 *
 * `scripts/boundaries.test.mjs` asserts the general rule for every package: a bare
 * import of a sibling that is not in `dependencies` resolves through the workspace's
 * hoisted `node_modules` and fails the moment somebody installs from a registry.
 *
 * This asserts the specific rule Track O rests on. §47 of the parent design claims
 * AI-0 through AI-4 gate on nothing, and that claim is only true while this package
 * names core and nothing else. `@driftengine/entities` joins at Task 32 and the
 * expectation below moves in that same commit — deliberately, so the arrow is
 * added on purpose rather than acquired by an import somebody did not think about.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const HERE = path.resolve(import.meta.dirname, '..');

function manifest(dir) {
  return JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
}

test('the package carries the engine version, in lockstep with core', () => {
  const core = manifest(path.resolve(HERE, '..', 'core'));
  assert.equal(manifest(HERE).version, core.version);
});

test('the package declares core and entities, and no other engine package', () => {
  /*
   * `@driftengine/entities` joined at AI-6, deliberately and in one commit, rather than
   * being acquired by an import nobody thought about. Through AI-5 this list was core
   * alone, which is what made §47's "AI-0 through AI-4 gate on nothing" a property
   * rather than an aspiration.
   *
   * The arrow points ai -> entities and never back, so the entity provider splits into
   * its own package mechanically if a consumer wanting AI over a non-entity world model
   * ever finds the install objectionable.
   */
  const deps = manifest(HERE).dependencies ?? {};
  assert.deepEqual(Object.keys(deps).sort(), ['@driftengine/core', '@driftengine/entities']);
});

test('the package pins every engine dependency exactly rather than ranging it', () => {
  /*
   * An engine release is twenty-four places, and a range in one of them means a
   * consumer resolving two different cores in one build. The workspace version
   * gate asserts this across every manifest; this catches it in the package being
   * added, where the mistake is easiest to make and cheapest to fix.
   */
  const deps = manifest(HERE).dependencies ?? {};
  for (const [name, range] of Object.entries(deps)) {
    assert.match(range, /^\d+\.\d+\.\d+$/, `${name} is ranged rather than pinned`);
  }
});
