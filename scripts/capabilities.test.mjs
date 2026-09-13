import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * The generated capability snapshot is current.
 *
 * **`packages/script/capabilities.json` is data a consumer's *build* reads**, not something the
 * suite touches: `driftScript()` in a bundler links against it, and the language server reads the
 * same file. So a capability added to the registry and not regenerated here passes every test in
 * this repository and fails in a consumer's production build, naming a capability the engine
 * plainly has.
 *
 * That is what happened when `std/math` gained `exp`: 3,262 tests green, and a consumer's build
 * refused `math.exp` with `DS0236`. `npm run capabilities:check` already existed and nothing ran
 * it, which is the whole of the gap — a guard nobody invokes is a guard that does not exist.
 */
test('the generated capability snapshot matches the registry', () => {
  try {
    execFileSync(
      'npx',
      [
        'tsx',
        '--conditions=drift-source',
        path.join(ROOT, 'scripts', 'capabilities.ts'),
        '--check',
      ],
      {
        cwd: ROOT,
        stdio: 'pipe',
      },
    );
  } catch (error) {
    const output = `${error.stdout ?? ''}${error.stderr ?? ''}`.trim();
    assert.fail(
      `packages/script/capabilities.json is stale — run \`npm run capabilities\`.\n${output}`,
    );
  }
});
