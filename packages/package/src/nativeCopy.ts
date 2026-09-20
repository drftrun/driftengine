/**
 * The modules a native build copies rather than bundles, found as Node would find them and copied
 * with what they load when they run.
 *
 * **Found by walking `node_modules` upwards, not by `require.resolve`**, because a package's
 * directory is what is copied and most of these do not export their `package.json`. That walk is
 * Node's own lookup for a bare name, so a module found here is the module the game would load, and
 * it starts from the real path of whoever asks, as Node does through a workspace link.
 *
 * **Every declared dependency is followed but the ones a module only installs with**, which are
 * named rather than inferred (`installOnly`): the two bindings declare `tar`, `node-gyp` and
 * `node-addon-api` for the script that downloads or builds their binary, and load nothing at run
 * time but that binary. Named rather than skipped wholesale, so a run-time dependency a later version
 * adds is copied, not lost.
 *
 * What it gives up: one directory per name. Two versions of one package in the copy are refused
 * rather than nested, which none of these four has needed.
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { cp } from 'node:fs/promises';
import { basename, dirname, join, relative, sep } from 'node:path';

export interface FoundPackage {
  readonly name: string;
  readonly version: string;
  readonly dir: string;
}

function manifestOf(dir: string): Record<string, unknown> | null {
  const path = join(dir, 'package.json');
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

/** The directory of the package `name` as a module in `from` would load it, or null. */
export function findPackage(name: string, from: string): string | null {
  let dir = existsSync(from) ? realpathSync(from) : from;
  for (;;) {
    const candidate = join(dir, 'node_modules', name);
    if (manifestOf(candidate) !== null) return realpathSync(candidate);
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/** The package `file` belongs to: the nearest directory above it whose manifest has a name. */
export function packageDirOf(file: string): string | null {
  let dir = dirname(file);
  for (;;) {
    const manifest = manifestOf(dir);
    if (manifest !== null && typeof manifest.name === 'string') return dir;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/** A package to copy, and the directory of the module that loads it, which is where it is found. */
export interface CopyRequest {
  readonly name: string;
  readonly from: string;
}

/** Each requested package as its importer would load it, and every package they load in turn, once. */
export function runtimeClosure(
  requests: readonly CopyRequest[],
  installOnly: Readonly<Record<string, readonly string[]>>,
): FoundPackage[] {
  const found: FoundPackage[] = [];
  const byName = new Map<string, FoundPackage>();
  const visit = (name: string, asker: string, askerDir: string): void => {
    const dir = findPackage(name, askerDir);
    if (dir === null) {
      throw new Error(
        `the native build needs "${name}", which ${asker} loads, and it is not installed where ` +
          `${asker} would find it. \`npm install\` in the game, and check it finished.`,
      );
    }
    const manifest = manifestOf(dir) ?? {};
    const version = typeof manifest.version === 'string' ? manifest.version : '0.0.0';
    const seen = byName.get(name);
    if (seen !== undefined) {
      if (seen.dir === dir) return;
      throw new Error(
        `the native build would copy ${name} ${seen.version} and ${version} into one ` +
          `node_modules (${seen.dir} and ${dir}); only one can be there. Align the two ranges.`,
      );
    }
    const entry = { name, version, dir };
    byName.set(name, entry);
    found.push(entry);
    const skip = installOnly[name] ?? [];
    const dependencies = (manifest.dependencies ?? {}) as Record<string, string>;
    for (const dependency of Object.keys(dependencies)) {
      if (!skip.includes(dependency)) visit(dependency, name, dir);
    }
  };
  for (const request of requests) visit(request.name, 'the bundle', request.from);
  return found;
}

/**
 * A compiled binary's platform, from the name napi-rs and its kind give it:
 * `name.linux-x64-gnu.node`, `name.darwin-arm64.node`. A binary with no such suffix is taken to be
 * this machine's, which is what a binding that builds or downloads its own writes.
 */
const TAGGED =
  /\.(darwin|win32|linux|freebsd|android|openbsd|sunos)-([a-z0-9]+)(?:-[a-z0-9]+)?\.node$/;

function keeps(path: string, host: { platform: string; arch: string }): boolean {
  const match = TAGGED.exec(basename(path));
  return match === null || (match[1] === host.platform && match[2] === host.arch);
}

/** Copy each package into `into/<name>`, leaving its own `node_modules` and other machines' binaries. */
export async function copyPackages(
  packages: readonly FoundPackage[],
  into: string,
  host: { readonly platform: string; readonly arch: string },
): Promise<void> {
  for (const found of packages) {
    await cp(found.dir, join(into, found.name), {
      recursive: true,
      filter: (source) => {
        const inside = relative(found.dir, source);
        if (inside.split(sep)[0] === 'node_modules') return false;
        return keeps(source, host);
      },
    });
  }
}
