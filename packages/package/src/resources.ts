import { access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Where the packager's own resources are: `assets/`, `android/` and `ios/`.
 *
 * **This module exists because four call sites climbed out of `src/` on their own, and a consumer
 * could not tell them where to look instead.** `stage.ts` and `ios.ts` copied `../assets`,
 * `android.ts` copied `../android`, `ios.ts` copied `../ios`, and `build.ts` reached into
 * `../assets/icon.png` for a default icon — each computed from its own module's URL, with no
 * option, flag or variable that moved any of them. The first of those runs on **every** desktop
 * build: the whole assets directory becomes the artifact's `drift://shell/` origin.
 *
 * That is fine inside this repository and a wall outside it. **A consumer that vendors engine
 * source** copies `packages/<name>/src/**` to `<name>/**`
 * — which flattens away exactly the level those four paths climbed to. Reported from outside,
 * where the workaround was a layout exception in the vendor script: this one package kept the
 * engine's own shape while the other ten were copied flat, plus a directory-copying branch so
 * every asset still landed in the integrity hash, plus a per-package entry in the bundler's alias
 * table. Small, and permanently in the way of reading that file.
 *
 * **What it cost before it was understood** is the part worth keeping: copied flat, `cp` threw
 * `ENOENT` on a directory nobody would think to look for, before a single artifact existed, naming
 * a path that is not in the project. `resourceDir` refuses instead, naming both the path it looked
 * in and the way to move it.
 *
 * **Two doors and deliberately not three.** A caller passes `resourceRoot`; the CLI takes
 * `--resources=<dir>` and fills it. There is no environment variable: a build's inputs should be
 * visible in the command that ran it, and an environment variable is the one input that is invisible
 * in a log somebody is reading a week later. **What would change that** is a consumer whose build
 * system cannot pass an argument, which no consumer here has.
 */

/** The three directories this package ships beside its sources. */
export type ResourceName = 'assets' | 'android' | 'ios';

/**
 * A file only the real thing has, one per directory, so a directory is identified and not merely
 * named.
 *
 * **Reported from outside 2026-08-28, the day the root became configurable.** A vendored consumer
 * flattens each package's `src`, so the *default* root — one level above this package's sources —
 * is the vendor root, the directory holding every copied package. One of those packages is
 * `@driftengine/assets`. So `join(root, 'assets')` exists, an existence check passes, and the
 * packager stages a directory of TypeScript source as the shell: verified from this repository,
 * `shell/` came out holding 25 files — `assetPath.ts`, `gltf.ts`, `fbx.ts` — and no `splash.html`,
 * with no error at any stage. The artifact builds, installs and launches, and the badge is a 404
 * nobody sees, because the splash is what would have shown it.
 *
 * **That failure mode is one the old arrangement did not have**, which is the part worth keeping:
 * copied flat with no root given, `cp` threw `ENOENT` and stopped. Making the path configurable
 * made its absence quiet in exactly one layout — the common one.
 *
 * **Each marker is a file the packager itself reads**, so it cannot be deleted without breaking
 * something louder than this check: `main/splash.ts` loads `drift://shell/splash.html`, `ios.ts`
 * reads and rewrites `project.yml`, and Gradle will not open a project without its settings file. A
 * marker nothing used would be a sentinel that could rot while the check went on passing.
 */
const MARKER: Readonly<Record<ResourceName, string>> = {
  assets: 'splash.html',
  android: 'settings.gradle.kts',
  ios: 'project.yml',
};

/**
 * The root the three live under: the given one, or this package's own directory.
 *
 * Resolved against the working directory when it is relative, because a flag typed on a command
 * line is relative to where somebody typed it.
 */
export function resourceRoot(given?: string | undefined): string {
  if (given !== undefined && given.length > 0) return resolve(process.cwd(), given);
  return join(dirname(fileURLToPath(import.meta.url)), '..');
}

/**
 * One resource directory, checked before anything is copied out of it.
 *
 * **The check is the point.** Every caller's next move is a recursive `cp`, whose failure names a
 * path a consumer has never seen and says nothing about what would fix it. This says both, once,
 * before the build has done any work — which is what `AGENTS.md` means by failing fast at init with
 * an actionable message.
 */
export async function resourceDir(name: ResourceName, given?: string | undefined): Promise<string> {
  const root = resourceRoot(given);
  const dir = join(root, name);
  const marker = MARKER[name];
  const move =
    '— pass `--resources=<dir>` (or `resourceRoot` to the API) naming the directory that holds ' +
    'assets/, android/ and ios/.';
  try {
    await access(dir);
  } catch {
    throw new Error(
      `[drift-package] the packager's own \`${name}\` directory is not at ${dir}. It ships beside ` +
        `this package's sources, so a copy of the engine that flattened them has moved it ${move}`,
    );
  }
  try {
    await access(join(dir, marker));
    return dir;
  } catch {
    /*
     * **The confusing one, so the message explains the coincidence rather than the rule.** A
     * consumer meeting this has a directory of the right name in the right place, and it is
     * somebody else's — `@driftengine/assets` sitting in a vendor root beside the packager.
     */
    throw new Error(
      `[drift-package] ${dir} exists and is not the packager's \`${name}\` directory: it has no ` +
        `\`${marker}\`. A vendored engine puts every package in one directory, and one of them is ` +
        `\`@driftengine/assets\` — so a root that looks right can hold a package's source instead ` +
        `of the shell's. Staging that produces an artifact that launches with no splash and no ` +
        `error ${move}`,
    );
  }
}

/** One file inside a resource directory, checked the same way. */
export async function resourceFile(
  name: ResourceName,
  file: string,
  given?: string | undefined,
): Promise<string> {
  return join(await resourceDir(name, given), file);
}

/** What every entry point takes so a caller can move the three. */
export interface ResourceOptions {
  /**
   * Where `assets/`, `android/` and `ios/` are, if not beside this package's sources.
   *
   * A vendored engine is the case this is for: a copy that flattened every package's `src` has left
   * the three somewhere this package cannot compute.
   */
  readonly resourceRoot?: string;

  /**
   * Where builds write, if not `out/` inside the project.
   *
   * **A staging copy that cannot leave the project is a copy that can refuse itself.** `fs.cp`
   * compares `dev` and `ino` up the destination's ancestors, and a shared or network folder can
   * answer the same identity for a file and a directory — at which point the very first copy of a
   * build fails, naming the one thing that is not happening. See `outDir.ts` for the measurement.
   *
   * The same two doors and no third: a caller passes `outRoot`, the CLI takes `--out=<dir>` and
   * fills it. No environment variable, for the reason this module's header already gives.
   */
  readonly outRoot?: string;
}
