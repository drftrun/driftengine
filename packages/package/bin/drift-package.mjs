#!/usr/bin/env node
/**
 * The `drift-package` executable.
 *
 * JavaScript because npm's `bin` runs under plain Node, starting a CLI that is TypeScript because
 * everything else in this repository is. `tsx` is the same bridge `scripts/` uses.
 *
 * **`tsx` is launched with this Node and never through `npx`, and that is not a preference.** On
 * Windows `npx` is `npx.cmd`, and a `.cmd` is not something `CreateProcess` knows how to launch: it
 * needs `cmd.exe`, that is `shell: true`, which reopens quoting on the one platform where paths
 * contain spaces as a matter of course. Without it `spawnSync` fails with `ENOENT`, leaves `status`
 * at `null`, and a bare `status ?? 1` exits 1 **printing nothing at all** — because the reason is in
 * `result.error`, which nothing read. Reported from a Windows VM, where it presented as
 *
 *     > node scripts/package.mjs doctor
 *     npm run package:doctor failed with exit code 1.
 *
 * and above that line, the nothing that invited you to read. It cost a consumer half a day and is
 * most of why they wrote a launcher of their own instead of using this one.
 *
 * Launching the Node that is already running answers all of it: no shell, no `.cmd`, no npx
 * resolution, and the copy of `tsx` is the one this project locked rather than whichever npx finds.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

/**
 * `tsx`'s own entry point, read from the `bin` it declares.
 *
 * Not a path written here: a version of tsx that moves its entry would then break this file
 * silently, and this is the layer whose failures are hardest to see.
 */
function tsxEntry() {
  let manifest;
  try {
    manifest = require.resolve('tsx/package.json');
  } catch {
    console.error(
      'tsx is not installed. drift-package runs its TypeScript CLI through it; install the ' +
        "packager's dependencies and try again.",
    );
    process.exit(1);
  }
  const bin = JSON.parse(readFileSync(manifest, 'utf8')).bin;
  const relative = typeof bin === 'string' ? bin : bin?.tsx;
  if (typeof relative !== 'string') {
    console.error(`${manifest} declares no \`bin\` that can be launched.`);
    process.exit(1);
  }
  const entry = path.join(path.dirname(manifest), relative);
  if (!existsSync(entry)) {
    console.error(`${entry} is missing, so tsx is installed but incomplete. Reinstall it.`);
    process.exit(1);
  }
  return entry;
}

const result = spawnSync(process.execPath, [tsxEntry(), cli, ...process.argv.slice(2)], {
  stdio: 'inherit',
});

/*
 * **`spawnSync` does not throw**, and leaving this out is what made the bug above invisible. A
 * process that never starts leaves `status` at `null` and puts the reason in `result.error`, so a
 * bare `process.exit(status ?? 1)` turns "I could not launch anything" into "it failed with 1" —
 * the same exit as a real failure, with nothing above it to read.
 */
if (result.error !== undefined) {
  console.error(`drift-package could not launch ${process.execPath}: ${String(result.error)}`);
  process.exit(1);
}
if (result.signal !== null && result.signal !== undefined) {
  console.error(`drift-package was terminated by signal ${result.signal}.`);
  process.exit(1);
}
process.exit(result.status ?? 1);
