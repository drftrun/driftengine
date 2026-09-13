import { build as esbuild } from 'esbuild';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { refuseLyingFilesystem } from './identity.ts';
import type { Identity } from './identity.ts';
import type { PackageManifest } from './manifest.ts';
import { resourceDir } from './resources.ts';
import type { ResourceOptions } from './resources.ts';

/**
 * Everything the shell needs, laid out the way `main/entry.ts` expects to find it.
 *
 * **This exists because the workspace ships TypeScript and Electron runs JavaScript.** There is no
 * build step anywhere else here — a consumer bundles `src/index.ts` themselves — but a main
 * process is not bundled by anybody downstream, so the packager bundles its own two entry points
 * and nothing else. esbuild rather than tsc: it is already a dependency of this repository, it
 * emits CommonJS in one call, and a preload script has to be CommonJS whatever its source is.
 *
 * The layout is the contract between this file, `main/entry.ts` and `main/window.ts`:
 *
 *     main.cjs               the main process
 *     preload.cjs            the bridge, loaded before the game
 *     drift.package.json     the manifest, read at startup
 *     build.json             whether this is a development run or a shipped artifact
 *     shell/                 the packager's own assets, served as drift://shell/
 *     app/                   the game, served as drift://app/
 *
 * **Electron is external to both bundles.** It is resolved from the application's `node_modules`
 * at run time by the runtime itself; bundling it would be bundling a native module.
 */
const HERE = dirname(fileURLToPath(import.meta.url));

export async function stageApp(
  manifest: PackageManifest,
  projectDir: string,
  stageDir: string,
  options: {
    readonly development: boolean;
    /**
     * How a path's filesystem identity is read, for the refusal below.
     *
     * The same seam `refuseLyingFilesystem` carries and for the same reason: the condition cannot be
     * reproduced on any filesystem this suite can create, so without it the refusal would ship
     * having never been seen to fire. The default is `statSync` and no caller passes anything else.
     */
    readonly look?: (path: string) => Identity;
  } & ResourceOptions = { development: false },
): Promise<void> {
  /*
   * **Before the first copy, and before anything is deleted, because this is where the copy is.**
   *
   * `doctor` refuses this too and does it earlier, which is the right place for a person's time: a
   * build that cannot succeed should stop before it downloads a runtime. But that is a guarantee
   * about the order of two calls, and this package's `exports` map is `"./*": "./*"` — so
   * `stageApp` is importable directly, and a route that never passes through `doctor` is a route
   * where a `cp` explains itself in terms of subdirectories of itself. The check is two `stat`s.
   * It belongs to the copy rather than to the command that usually precedes it.
   */
  refuseLyingFilesystem(projectDir, stageDir, options.look);

  await rm(stageDir, { recursive: true, force: true });
  await mkdir(stageDir, { recursive: true });

  /* Two calls with explicit outfiles rather than one with two entry points: both entries are
     named `entry.ts`, so a shared `entryNames` would have them collide on the way out — and the
     two names are a contract `main/entry.ts` and `window.ts` both read. */
  for (const [from, to] of [
    [join(HERE, 'main', 'entry.ts'), join(stageDir, 'main.cjs')],
    [join(HERE, 'preload', 'entry.ts'), join(stageDir, 'preload.cjs')],
  ]) {
    await esbuild({
      entryPoints: [from],
      outfile: to,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node22',
      external: ['electron'],
      logLevel: 'warning',
    });
  }

  const version = await consumerVersion(projectDir);
  await writeFile(
    join(stageDir, 'package.json'),
    `${JSON.stringify(
      {
        name: manifest.id.split('.').pop() ?? 'app',
        productName: manifest.name,
        version,
        main: 'main.cjs',
        /* Both are read by installers rather than by code: electron-builder warns without them,
           and a Windows installer with no publisher is the one a person is asked to trust. */
        description: manifest.name,
        author: manifest.publisher,
        /* No dependencies: both entry points are bundled, and Electron is supplied by the
           runtime that is executing them. */
      },
      null,
      2,
    )}\n`,
  );

  await cp(join(projectDir, 'drift.package.json'), join(stageDir, 'drift.package.json'));
  /*
   * **Which kind of build this is, written into the artifact rather than read from an
   * environment variable.** A player's machine has whatever variables it has, and a game that
   * decided whether to expose developer tools from one of them would be a game somebody could
   * turn inside out by exporting a name. The file is written by the packager and is absent from
   * nothing: `entry.ts` treats a missing one as production, which is the safe direction.
   */
  await writeFile(
    join(stageDir, 'build.json'),
    `${JSON.stringify({ development: options.development }, null, 2)}\n`,
  );
  if (manifest.steam.appId !== null) {
    /*
     * **The store SDK is copied in, or the build says it is not there.**
     *
     * The staged application has no `node_modules` — both entry points are bundled — and
     * `steamworks.js` is a native module that cannot be bundled at all. So it is copied from the
     * consumer's own tree, which is also what makes it opt-in: a game that never installs it never
     * ships one, and this says so rather than producing a build whose achievements silently do
     * nothing.
     */
    const sdk = join(projectDir, 'node_modules', 'steamworks.js');
    try {
      await cp(sdk, join(stageDir, 'node_modules', 'steamworks.js'), { recursive: true });
      await writeFile(
        join(stageDir, 'node_modules', '.keep'),
        'the store SDK lives here; nothing else does\n',
        'utf8',
      );
    } catch {
      console.warn(
        `[drift-package] steam.appId is ${manifest.steam.appId} and steamworks.js is not ` +
          `installed in ${projectDir}. The build will run with no store: achievements, presence ` +
          'and cloud saves are absent. `npm install steamworks.js` in the game to change that.',
      );
    }
  }

  if (manifest.steam.appId !== null) {
    /*
     * **Steam looks for this file beside the executable** when a build is run outside its client,
     * which is every run during development. Without it `SteamAPI_Init` fails and a game that
     * degrades correctly reports no achievements — so the integration looks broken exactly while
     * somebody is building it, and works only after upload.
     */
    await writeFile(join(stageDir, 'steam_appid.txt'), `${manifest.steam.appId}\n`, 'utf8');
  }

  /* Through `resourceDir`, which is the one place that knows where this package's own three
     directories are and the only place a caller can move them. See `resources.ts`. */
  await cp(await resourceDir('assets', options.resourceRoot), join(stageDir, 'shell'), {
    recursive: true,
  });
  await cp(resolve(projectDir, dirname(manifest.entry)), join(stageDir, 'app'), {
    recursive: true,
  });
}

/**
 * The version the artifact carries, taken from the consumer's own manifest.
 *
 * A packaged application needs one — installers key upgrades on it — and inventing one here would
 * put a number on a release that matches nothing. Absent, it is `0.0.0`, which is visibly not a
 * release rather than plausibly one.
 */
export async function consumerVersion(projectDir: string): Promise<string> {
  try {
    const raw: unknown = JSON.parse(await readFile(join(projectDir, 'package.json'), 'utf8'));
    const version = (raw as { version?: unknown }).version;
    return typeof version === 'string' && version.length > 0 ? version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}
