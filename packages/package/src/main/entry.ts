import { app } from 'electron';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseManifest } from '../manifest.ts';
import type { Target } from '../manifest.ts';
import { startApp } from './window.ts';

/**
 * What the packaged application actually starts.
 *
 * The layout beside this file is fixed by the builder and is worth stating once, because three
 * files depend on it agreeing:
 *
 *     main.cjs                this, bundled
 *     preload.cjs             the bridge, bundled
 *     drift.package.json      the manifest, copied verbatim from the consumer's project
 *     app/                    the game's built web bundle, with index.html at its root
 *
 * **The target is derived rather than baked in.** A build produces one artifact per target and
 * each runs on exactly one platform, so asking the process it is running in cannot be wrong —
 * where a value written at build time can be, and would be discovered as the wrong Chromium flags
 * on somebody else's machine.
 */
function hostTarget(): Target {
  if (process.platform === 'win32') return 'win-x64';
  if (process.platform === 'darwin') return process.arch === 'x64' ? 'mac-x64' : 'mac-arm64';
  return 'linux-x64';
}

const here = __dirname;
const manifest = parseManifest(
  JSON.parse(readFileSync(join(here, 'drift.package.json'), 'utf8')) as unknown,
);

/**
 * Whether this is a development run, which decides what a person can open.
 *
 * **Absent means production, and that direction is the whole point.** A shipped artifact whose
 * marker file was lost must not fall back to exposing developer tools; a development run whose
 * marker is missing merely loses a convenience.
 */
function isDevelopment(): boolean {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(here, 'build.json'), 'utf8'));
    return (raw as { development?: unknown }).development === true;
  } catch {
    return false;
  }
}

startApp(manifest, join(here, 'app'), hostTarget(), { development: isDevelopment() }).catch(
  (cause: unknown) => {
    /*
     * A failure here is a failure to open a window at all, and there is nothing on screen to show
     * it on. The console is what a player can be asked to copy, and a non-zero exit is what a Steam
     * launch reports.
     */
    console.error('[drift-package] the application could not start:', cause);
    process.exitCode = 1;
    app.quit();
  },
);
