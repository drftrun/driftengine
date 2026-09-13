import { join, resolve } from 'node:path';

import type { Target } from './manifest.ts';
import type { ResourceOptions } from './resources.ts';

/**
 * Where a build writes, which used to be `join(cwd, 'out', target)` in four places and nowhere
 * else.
 *
 * **This is a flag and not tidiness, and the reason is a copy that refuses itself.** Node's
 * `fs.cp` will not copy a thing into itself and decides that by walking the destination's
 * ancestors comparing each one's `dev` and `ino` against the source's. On a filesystem that
 * reports those honestly it never fires. On a shared or network folder it can: measured by a
 * consumer on a Windows VM with the project on a drive mapped to a folder on a Linux machine,
 * `drift.package.json` and `out/` both answered `dev=66313 ino=-112686486700016` — the same
 * identity for a file and for a directory — and the first staging copy failed with
 *
 *     cannot copy …\drift.package.json to a subdirectory of self …\out\win-x64\stage\…
 *
 * which is a sentence about the one thing that is not happening. A junction at `out/` closes it,
 * because the walk calls `stat` and not `lstat`, and that is a filesystem trick standing in for
 * this flag.
 *
 * **The layout under the root is unchanged**, so `--out=C:\drift-out` gives
 * `C:\drift-out\win-x64\stage` and nothing that reads `out/<target>/…` has to learn a second
 * shape.
 *
 * **A relative root resolves against the invoking directory and deliberately not against
 * `--project=`.** Those two differ exactly when the flag matters — a packager run from somewhere
 * other than the project it is packaging — and resolving against the project would put the output
 * back inside the thing the flag exists to escape.
 */
export function outFor(cwd: string, target: Target, options: ResourceOptions): string {
  const root =
    options.outRoot === undefined ? join(cwd, 'out') : resolve(process.cwd(), options.outRoot);
  return join(root, target);
}
