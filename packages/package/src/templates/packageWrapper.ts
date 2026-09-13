import type { PackageManifest } from '../manifest.ts';

/**
 * The Node launcher a consumer puts in their own repository, and why it cannot be a line in
 * `package.json`.
 *
 * Every line below is a failure somebody has already had on a Windows machine, where the person
 * who wrote the script is not the person watching it fail.
 */
export function packageWrapperScript(manifest: PackageManifest): string {
  return `#!/usr/bin/env node
/**
 * \`drift-package\` for ${manifest.name}.
 *
 *   node scripts/package.mjs doctor
 *   node scripts/package.mjs build --target=win-x64
 *
 * Written by \`drift-package init\`. Edit it and it is yours; init will not overwrite it without
 * --force.
 *
 * **The CLI is launched with this Node, never through npx.** On Windows \`npx\` is \`npx.cmd\`, and a
 * \`.cmd\` is not something CreateProcess knows how to launch: it needs cmd.exe, that is
 * \`shell: true\`, which reopens quoting on a platform where paths contain spaces. Launching the
 * Node that is already running avoids the question, and uses the copy of the tool this project
 * locked rather than whichever one npx decides to find.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

/*
 * Where the packager's executable is.
 *
 * \`@driftengine/package\` declares no \`exports\`, so its \`package.json\` resolves by the old rules and
 * the \`bin\` it names is read from there rather than guessed at. A copy of the engine that was
 * vendored instead of installed will not resolve at all, and the message says which of the two
 * situations you are in instead of a module-not-found.
 */
let bin;
try {
  const manifest = require.resolve('@driftengine/package/package.json');
  const declared = JSON.parse(readFileSync(manifest, 'utf8')).bin;
  const relative = typeof declared === 'string' ? declared : declared?.['drift-package'];
  bin = path.join(path.dirname(manifest), relative);
} catch {
  console.error(
    'Could not resolve @driftengine/package. If the engine is installed, run npm ci. If it is ' +
      'vendored, point \`bin\` below at the vendored bin/drift-package.mjs and keep the rest of ' +
      'this file as it is: what the rest of it does is report failures npm and Windows would ' +
      'otherwise swallow.',
  );
  process.exit(1);
}

const result = spawnSync(process.execPath, [bin, ...process.argv.slice(2)], {
  cwd: REPO_ROOT,
  stdio: 'inherit',
});

/*
 * **spawnSync does not throw**, and this is the half that is easy to leave out. If the process
 * never starts it puts the reason in \`result.error\` and leaves \`status\` at null, so a bare
 * \`process.exit(status ?? 1)\` turns "I could not launch anything" into "it failed with 1" — the
 * same exit as a real failure, with nothing above it to read. On a Windows machine that looked like
 * a bare "failed with exit code 1" and cost half a day.
 */
if (result.error !== undefined) {
  console.error(\`Could not launch \${process.execPath}: \${String(result.error)}\`);
  process.exit(1);
}
if (result.signal !== null && result.signal !== undefined) {
  console.error(\`drift-package was terminated by signal \${result.signal}.\`);
  process.exit(1);
}
process.exit(result.status ?? 1);
`;
}
