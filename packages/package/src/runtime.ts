import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

/**
 * Whether the Electron runtime a desktop build packages is actually on this machine.
 *
 * **Because the package being installed proves nothing about the runtime, and `build` could not
 * tell the difference.** `installedElectronVersion()` in `build.ts` resolves
 * `electron/package.json` and reads its `version`. That file is in the npm tarball. The binary is
 * not: a postinstall downloads it into `node_modules/electron/dist` and writes `path.txt` beside
 * it. So a version always resolves, a build always proceeds, and electron-builder fails several
 * steps later with a sentence about packaging rather than about a missing runtime.
 *
 * **Measured in this repository on 2026-08-29**, npm 10.9.8, Node 22.23.2:
 * `installedElectronVersion()` answered `43.4.1` while `dist` did not exist — with
 * `npm config get ignore-scripts` answering `false`. So this is not only npm refusing to run
 * scripts, which is the case a consumer hit and reported: it is the plainer fact that a postinstall
 * which downloads something can fail to finish, for a proxy, a slow link, a sandbox or a CI image,
 * and nothing downstream is told.
 *
 * **Both files, not just the directory.** `path.txt` is what Electron's own resolution reads, and a
 * download interrupted after creating `dist` would otherwise read as present.
 */
export function electronRuntimeState(packageDir: string): 'present' | 'missing' {
  const hasDist = existsSync(join(packageDir, 'dist'));
  const hasPath = existsSync(join(packageDir, 'path.txt'));
  return hasDist && hasPath ? 'present' : 'missing';
}

/**
 * Fetch the Electron runtime if it is not here, before a build spends its minutes.
 *
 * **It runs the installer instead of telling somebody to.** The first version of this refusal, in a
 * consumer's own wrapper, printed the command and stopped; they watched a person read it and re-run
 * the script unchanged, three times, and changed it to do the thing. A check that knows the remedy,
 * and whose remedy has no alternatives, should apply it.
 *
 * `install.js` is `__dirname`-based, so the working directory does not matter, and it returns
 * immediately when the binary is already there — so this costs nothing on every run after the
 * first. It is the same script npm would have run.
 *
 * **What would make it wrong** is a consumer who deliberately packages against a runtime they
 * supply themselves, which nothing here supports today and which would want a flag rather than a
 * removal.
 */
export async function ensureElectronRuntime(): Promise<void> {
  const require = createRequire(import.meta.url);
  let installer: string;
  try {
    installer = require.resolve('electron/install.js');
  } catch {
    throw new Error(
      'electron is not installed, so there is no runtime to package a desktop build against. ' +
        'Run `npm install` in the project being packaged.',
    );
  }

  const packageDir = dirname(installer);
  if (electronRuntimeState(packageDir) === 'present') return;

  console.log(
    '[drift-package] the Electron package is here and its runtime is not, which is what a ' +
      'postinstall that did not finish leaves behind. Fetching it.',
  );
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [installer], { stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`electron's installer exited ${String(code)}`));
    });
  });

  if (electronRuntimeState(packageDir) === 'missing') {
    throw new Error(
      `The Electron installer ran and ${join(packageDir, 'path.txt')} is still missing, so there ` +
        'is no runtime to package and no point going on.\n\n' +
        'If it printed a download error, it is the network: a proxy, or the ELECTRON_MIRROR and ' +
        'ELECTRON_CUSTOM_DIR variables if this machine needs them.\n' +
        'If npm is blocking install scripts, let it run this one: ' +
        '`npm install-scripts approve electron`.',
    );
  }
  console.log('[drift-package] ok: the Electron runtime is present');
}
