/**
 * A game packaged for the native host: a Node, the game bundled with the host and the engine, the
 * modules that cannot be bundled, the game's own files, a launcher and the licences, in one archive.
 *
 *     <executable>/              what the archive holds, and what a Steam depot uploads
 *       <executable>             the launcher: the Node beside it, running the game
 *       runtime/node             the Node that ran this build
 *       app/game.mjs             the game, the host and the engine, bundled for Node
 *       app/modules/             each module the bundle starts by URL: workers, the thread bootstrap
 *       app/node_modules/        the modules that cannot be bundled, what they load, and the
 *                                libraries a licence keeps replaceable
 *       app/public/              the game's web build, which its `fetch` of a relative path reads
 *       licenses/                Node's licence and every package's, with INDEX.txt
 *     <name>-<version>-linux-x64.tar.gz
 *
 * **The runtime is the Node running this build**, as the desktop target ships the Electron that is
 * installed: the artifact is made of what this machine has, so it is built on the machine it is for
 * — Linux on x64 — and the binaries beside the host are this machine's too. **The host comes from
 * the game's own tree**, at the packager's own version, because the host depends on the packager and
 * a range back would be a build cycle; a game that never builds this target never downloads a
 * native binary.
 *
 * **The entry is generated, not written by the game.** A game's native entry exports
 * `mount(canvas)`; the generated one starts the host in the manifest's window, hands the game its
 * files and its store — the file the desktop shell keeps under the same name, so a player moving
 * between the two builds keeps their saves — and prints when the first frame reached the screen
 * under `DRIFT_STARTUP_REPORT=1`, which is how the target's start is measured.
 *
 * **No copyleft library is bundled.** One under the LGPL stays a file of its own, as the Opus
 * decoder's Ogg parser does (`LINKED_LIBRARIES`), with the GPL's text beside it, which that licence
 * asks for; any other that would land in the bundle stops the build, naming it.
 *
 * What it gives up: the game's whole web build is copied to `public/`, its page and scripts
 * included, where the game reads only its assets; and the archive is `.tar.gz`, made by the
 * system's `tar`, with no installer and no desktop entry.
 */

import { spawn } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { chmod, copyFile, cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { refuseLyingFilesystem } from './identity.ts';
import type { PackageManifest } from './manifest.ts';
import { bundleNative, NATIVE_MODULES } from './nativeBundle.ts';
import { copyPackages, findPackage, packageDirOf, runtimeClosure } from './nativeCopy.ts';
import { copyleftOf, type FetchText, nodeLicense, writeLicenses } from './nativeLicenses.ts';
import { consumerVersion } from './stage.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOST = '@driftengine/native-host';

/**
 * What each copied module declares and does not load: the two bindings' install scripts download
 * or build their binary with these, and at run time they load that binary and nothing else.
 */
const INSTALL_ONLY: Readonly<Record<string, readonly string[]>> = {
  '@kmamal/gpu': ['node-addon-api', 'node-gyp', 'tar'],
  '@kmamal/sdl': ['tar'],
};

const LAUNCHER = `#!/bin/sh
# Starts this game on DriftEngine's native host: the Node in runtime/ runs app/game.mjs.
here=$(dirname "$(readlink -f "$0")")
exec "$here/runtime/node" "$here/app/game.mjs" "$@"
`;

export interface NativeOptions {
  /** The Node the artifact ships, and its version; the one running this build by default. */
  readonly node?: { readonly path: string; readonly version: string };
  /** How Node's licence is fetched when no copy is on this machine. */
  readonly fetchText?: FetchText;
  /** Package conditions resolved before `default`: `drift-source` bundles the engine's source. */
  readonly conditions?: readonly string[];
}

/** Why this machine cannot build the native target, or null. */
export function nativeMachineRefusal(platform: string, arch: string): string | null {
  if (platform === 'linux' && arch === 'x64') return null;
  const which = platform === 'linux' ? `on ${arch}` : `on ${platform}`;
  return (
    `native-linux-x64 ships the Node that builds it and the binaries installed beside the host, so ` +
    `it is built on Linux on x64, and this is ${which}.`
  );
}

/** The version of this packager, which the host has to match. */
export function packagerVersion(): string {
  const manifest = JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf8')) as {
    version: string;
  };
  return manifest.version;
}

/** The host's directory in the game's tree, at `version`, or a refusal naming the install. */
export function nativeHost(cwd: string, version: string): string {
  const dir = findPackage(HOST, cwd);
  if (dir === null) {
    throw new Error(
      `native-linux-x64 runs the game on ${HOST}, and ${cwd} does not have it. ` +
        `\`npm install ${HOST}@${version}\` there. It is kept out of the packager so that a game ` +
        'that never builds this target never downloads a native binary.',
    );
  }
  const found = (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { version: string })
    .version;
  if (found !== version) {
    throw new Error(
      `${HOST} is ${found} in ${cwd} and this packager is ${version}; the host is the engine's ` +
        `own code and has to be the same release. \`npm install ${HOST}@${version}\` there.`,
    );
  }
  return dir;
}

/** The module the bundle starts from: the host, started on the game at `game`. */
export function nativeEntrySource(manifest: PackageManifest, host: string, game: string): string {
  const text = JSON.stringify;
  return `import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configDirectory, runGame } from ${text(host)};

const here = dirname(fileURLToPath(import.meta.url));
await runGame({
  title: ${text(manifest.name)},
  width: ${text(manifest.window.width)},
  height: ${text(manifest.window.height)},
  mode: ${text(manifest.window.mode)},
  resizable: ${text(manifest.window.resizable)},
  publicDir: join(here, 'public'),
  storePath: join(configDirectory(), ${text(manifest.name)}, 'store.json'),
  startupReport: process.env.DRIFT_STARTUP_REPORT === '1',
  load: () => import(${text(game)}),
});
`;
}

/** What the desktop shell does for this manifest that the native host does not. */
export function nativeNotes(manifest: PackageManifest): string[] {
  const notes: string[] = [];
  if (manifest.splash.show) {
    notes.push(
      'no engine badge: the desktop shell shows it in a window of its own and a page draws it as ' +
        'markup, and the host draws only the game',
    );
  }
  if (manifest.steam.appId !== null) {
    notes.push(
      `steam.appId is ${manifest.steam.appId} and the host has no store: achievements, presence ` +
        'and cloud saves are absent from this build',
    );
  }
  return notes;
}

/**
 * The launcher's name, and the archive's directory: the id's last label, which is also the name the
 * desktop target's Linux build gives its executable (`stage.ts`). Reverse-DNS keeps it to letters,
 * digits and hyphens.
 */
export function executableName(manifest: PackageManifest): string {
  return manifest.id.split('.').pop() ?? 'app';
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.text();
}

/**
 * The archive, owned by nobody in particular: `--owner=0 --group=0` so it does not carry the
 * builder's account name to every player's machine.
 */
function tarGz(dir: string, entry: string, archive: string): Promise<void> {
  const args = ['--owner=0', '--group=0', '--numeric-owner', '-czf', archive, '-C', dir, entry];
  return new Promise((done, fail) => {
    const child = spawn('tar', args, { stdio: ['ignore', 'inherit', 'inherit'] });
    child.on('error', (cause) => fail(new Error(`tar could not be run: ${String(cause)}`)));
    child.on('close', (code) => {
      if (code === 0) done();
      else fail(new Error(`tar ${args.join(' ')} exited ${String(code)}`));
    });
  });
}

/** Build the native artifact for `manifest` into `outDir`, and answer the archive's path. */
export async function buildNative(
  manifest: PackageManifest,
  cwd: string,
  outDir: string,
  options: NativeOptions = {},
): Promise<string> {
  const refusal = nativeMachineRefusal(process.platform, process.arch);
  if (refusal !== null) throw new Error(refusal);
  if (manifest.native === null) {
    throw new Error('native-linux-x64 needs "native.entry" in drift.package.json');
  }
  /* Everything that can refuse, before anything is written — the copy's own refusal first, as
     `stageApp` makes it (see `identity.ts`). */
  refuseLyingFilesystem(cwd, outDir);
  const hostDir = nativeHost(cwd, packagerVersion());
  const hosted = NATIVE_MODULES.map((name) => ({ name, from: hostDir }));
  runtimeClosure(hosted, INSTALL_ONLY);
  const node = options.node ?? { path: process.execPath, version: process.version };
  const licence = await nodeLicense(node.path, node.version, options.fetchText ?? fetchText);
  for (const note of nativeNotes(manifest))
    console.warn(`[drift-package] native-linux-x64: ${note}`);

  const executable = executableName(manifest);
  const root = join(outDir, executable);
  const app = join(root, 'app');
  await rm(root, { recursive: true, force: true });
  await mkdir(app, { recursive: true });

  const game = resolve(cwd, manifest.native.entry);
  const bundle = await bundleNative(
    nativeEntrySource(manifest, HOST, game),
    app,
    cwd,
    options.conditions,
  );
  /* The game's own package is the game's to license, and is left out of both. */
  const own = realpathSync(cwd);
  const bundled = new Set<string>();
  for (const file of bundle.inputs) {
    const dir = packageDirOf(file);
    if (dir !== null && dir !== own) bundled.add(dir);
  }
  const held = copyleftOf(bundled);
  if (held.length > 0) {
    throw new Error(
      `native-linux-x64 would bundle ${held.join(', ')} into one file with the game. A library ` +
        'under such a licence has to stay a file a person can replace, which the native build does ' +
        'for the libraries in LINKED_LIBRARIES (nativeBundle.ts); this one is not among them.',
    );
  }
  const modules = runtimeClosure([...hosted, ...bundle.linked], INSTALL_ONLY);
  await copyPackages(modules, join(app, 'node_modules'), { platform: 'linux', arch: 'x64' });
  await cp(resolve(cwd, dirname(manifest.entry)), join(app, 'public'), { recursive: true });
  await mkdir(join(root, 'runtime'));
  await copyFile(node.path, join(root, 'runtime', 'node'));
  await writeFile(join(root, executable), LAUNCHER);
  /* After writing rather than as a write option, which the umask would narrow. */
  await chmod(join(root, 'runtime', 'node'), 0o755);
  await chmod(join(root, executable), 0o755);

  /* The host carries the GPL's text, because the LGPL library it brings in asks for it. */
  const gpl = readFileSync(join(hostDir, 'licenses', 'GPL-3.0.txt'), 'utf8');
  await writeLicenses(
    [...bundled, ...modules.map((found) => found.dir)],
    { version: node.version, text: licence },
    join(root, 'licenses'),
    gpl,
  );

  const archive = join(outDir, `${manifest.name}-${await consumerVersion(cwd)}-linux-x64.tar.gz`);
  await rm(archive, { force: true });
  await tarGz(outDir, executable, archive);
  console.log(`[drift-package] native-linux-x64: ${archive}`);
  return archive;
}
