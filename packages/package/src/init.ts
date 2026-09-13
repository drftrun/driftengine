import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { PackageManifest } from './manifest.ts';
import { buildWindowsScript } from './templates/buildWindows.ts';
import { packageWrapperScript } from './templates/packageWrapper.ts';

/** A file `init` writes, and where it goes relative to the project. */
export interface InitFile {
  readonly path: string;
  readonly content: string;
}

/**
 * The files a consumer cannot avoid owning, and deliberately only those.
 *
 * **The rule that decides what is here**: if it can be done once inside `drift-package`, it is not
 * allowed to be in a file somebody copies. A Windows build needs a `.ps1` because something has to
 * start Node on that machine and that something cannot live inside a Node program; a project needs
 * a launcher because the engine may be vendored, where `npx drift-package` resolves nothing.
 * Everything else the first three-platform consumer wrote — 421 lines of it — is now `runtime.ts`,
 * `identity.ts`, `outDir.ts` and the deletion at the top of `cli.ts`.
 */
export function initFiles(manifest: PackageManifest): readonly InitFile[] {
  return [
    { path: 'scripts/build-windows.ps1', content: buildWindowsScript(manifest) },
    { path: 'scripts/package.mjs', content: packageWrapperScript(manifest) },
  ];
}

/**
 * Write them into a project, refusing to overwrite without `--force`.
 *
 * **The refusal names the file rather than the directory**, because a consumer who has edited one
 * of these has edited a specific one and wants to know which is in the way.
 */
export async function init(cwd: string, manifest: PackageManifest, force: boolean): Promise<void> {
  const files = initFiles(manifest);
  if (!force) {
    const existing = files.map((f) => join(cwd, f.path)).filter((p) => existsSync(p));
    if (existing.length > 0) {
      throw new Error(
        `init would overwrite:\n${existing.map((p) => `  ${p}`).join('\n')}\n\n` +
          'These are yours once you have edited them. Pass --force to replace them anyway, or ' +
          'move them aside first and diff.',
      );
    }
  }
  for (const file of files) {
    const full = join(cwd, file.path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, file.content, 'utf8');
    console.log(`ok: ${full}`);
  }
  console.log(
    `\n  node scripts/package.mjs doctor\n  node scripts/package.mjs build --target=${
      manifest.targets[0] ?? 'linux-x64'
    }\n`,
  );
}
