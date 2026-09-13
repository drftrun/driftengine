import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** The two fields Node compares to decide whether two paths are the same thing. */
export interface Identity {
  readonly dev: bigint;
  readonly ino: bigint;
}

/**
 * Node's own `areIdentical`, which is what decides whether a copy is refused.
 *
 * The two zeros are excluded there and here: a filesystem that hands out no index answers 0, and
 * Node declines to believe it.
 *
 * **`bigint` and not `number`.** A Windows file index is 64 bits and loses precision as a double
 * exactly in the high half where those values live, so two different indices can arrive equal and
 * two equal ones different — the check would be wrong in both directions on precisely the platform
 * it exists for.
 */
export function sameIdentity(a: Identity, b: Identity): boolean {
  return a.ino !== 0n && a.dev !== 0n && a.ino === b.ino && a.dev === b.dev;
}

/**
 * Refuse a filesystem that cannot tell a file from a directory, before a build spends its minutes.
 *
 * **The failure this replaces is a sentence about the one thing that is not happening.** `stage.ts`
 * copies `drift.package.json` into the staging directory, and Node's `fs.cp` refuses to copy a
 * thing into itself — deciding that by walking the destination's ancestors and comparing each
 * one's `dev` and `ino` against the source's. On a filesystem that reports those honestly it never
 * fires. On a network share it can, and what comes out is
 *
 *     cannot copy …\drift.package.json to a subdirectory of self …\out\win-x64\stage\…
 *
 * ten minutes into a build, about the thing furthest from the cause you could imagine. Reported
 * from a Windows VM building over a mapped drive, where a file and a directory both answered
 * `dev=66313 ino=-112686486700016`: a redirector that gets no file index from the server invents a
 * constant one, and on Windows `dev` is already the volume serial number.
 *
 * **The witnesses are not the directories Node will really compare, and that is fine.**
 * `checkParentPaths` walks up from `out/<target>/stage` and stops at the source's parent, so it
 * compares `stage`, `<target>` and `out` — which on a first build do not exist yet and cannot be
 * stat'ed here. What is being established is not *which* directory collides but that this volume
 * gives a file and a directory the same identity, which is a property of the volume. The project
 * root and `out/` are witnesses as good as any.
 *
 * **The remedy it names is `--out=<dir>`, and that is what changed.** Until that flag existed the
 * only answer was to clone onto a local disk, which for a project with tens of gigabytes of assets
 * is a real cost. Now the output can simply be sent somewhere that tells the truth, and the copy is
 * the second suggestion rather than the first.
 *
 * **`look` is a seam and exists for one reason**: the condition cannot be reproduced on any
 * filesystem this suite can create, so without it the refusal — the whole point of the function —
 * would ship having never been seen to fire. The default is `statSync` and no caller passes
 * anything else.
 */
export function refuseLyingFilesystem(
  cwd: string,
  outRoot: string | undefined,
  look: (path: string) => Identity = (path) => statSync(path, { bigint: true }),
): void {
  /* Already pointed off this volume: whatever it answers about itself no longer decides a copy. */
  if (outRoot !== undefined && !resolve(process.cwd(), outRoot).startsWith(resolve(cwd))) return;

  const manifest = join(cwd, 'drift.package.json');
  if (!existsSync(manifest)) return;
  const its = look(manifest);

  for (const witness of [cwd, join(cwd, 'out')]) {
    if (!existsSync(witness)) continue;
    const theirs = look(witness);
    if (!sameIdentity(its, theirs)) continue;
    throw new Error(
      `${cwd} is on a filesystem that gives a file and a directory the same identity.\n\n` +
        `  ${manifest}\n      dev=${its.dev} ino=${its.ino}\n` +
        `  ${witness}\n      dev=${theirs.dev} ino=${theirs.ino}\n\n` +
        'Node uses those two fields to avoid copying something into itself, so the first copy of ' +
        'the staging step fails with "cannot copy … to a subdirectory of self …" — a message ' +
        'about the thing furthest from the cause, ten minutes into a build. It is what a network ' +
        'share does: the redirector invents a constant file index when the server gives it none.\n\n' +
        'Send the output somewhere that tells the truth:\n\n' +
        '    drift-package build --out=/a/local/disk\n\n' +
        'Or build from a local copy of the project, if the assets are small enough to move.',
    );
  }
}
