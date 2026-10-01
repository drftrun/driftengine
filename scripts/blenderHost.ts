/**
 * Asking the person's own Blender to export a `.blend`, for the baker.
 *
 * **Which Blender.** `BLENDER` when it is set, naming an executable; then `blender` on the path;
 * then Blender installed from Flathub; then the places the official installers put it on macOS and
 * Windows. The first that answers `--version` is used, and the baker prints which.
 *
 * **Why the output goes beside the bake rather than in a temporary directory**: Blender from
 * Flathub runs in a sandbox with its own private `/tmp`, so a path under the system's temporary
 * directory is a path that sandbox cannot see. The folder the bake is being written to is one it
 * can, by definition, and it is removed afterwards.
 *
 * Driving a separate process is not linking: Blender is GPL, this engine ships none of it, and the
 * export is done by Blender's bundled glTF exporter, which is Apache-2.0. See docs/FORMAT.md §2.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface BlenderInstall {
  /** The command and the arguments that come before Blender's own. */
  readonly command: string;
  readonly prefix: readonly string[];
  /** What `--version` said, first line. */
  readonly version: string;
}

const SCRIPT = fileURLToPath(new URL('./blender/export_gltf.py', import.meta.url));

function answers(command: string, prefix: readonly string[]): string | null {
  const result = spawnSync(command, [...prefix, '--version'], {
    encoding: 'utf8',
    timeout: 60_000,
  });
  if (result.error !== undefined || result.status !== 0) return null;
  const line = result.stdout.split('\n').find((l) => l.startsWith('Blender'));
  return line?.trim() ?? null;
}

/** The Blender this machine has, or null. */
export function findBlender(env: NodeJS.ProcessEnv = process.env): BlenderInstall | null {
  const candidates: [string, string[]][] = [];
  if (env['BLENDER'] !== undefined && env['BLENDER'] !== '') candidates.push([env['BLENDER'], []]);
  candidates.push(['blender', []]);
  candidates.push(['flatpak', ['run', '--die-with-parent', 'org.blender.Blender']]);
  candidates.push(['/Applications/Blender.app/Contents/MacOS/Blender', []]);
  const programs = env['ProgramFiles'] ?? 'C:\\Program Files';
  for (const version of ['5.2', '5.1', '5.0', '4.5', '4.4', '4.3', '4.2']) {
    candidates.push([
      path.join(programs, 'Blender Foundation', `Blender ${version}`, 'blender.exe'),
      [],
    ]);
  }
  for (const [command, prefix] of candidates) {
    if (path.isAbsolute(command) && !existsSync(command)) continue;
    const version = answers(command, prefix);
    if (version !== null) return { command, prefix, version };
  }
  return null;
}

/**
 * Export `blend` to glTF with `export_gltf.py`, and return the `.glb`'s bytes and what Blender said.
 *
 * `workIn` is a directory the bake may write in. Absolute paths throughout: Blender from Flathub
 * starts in its own working directory.
 */
export function exportWithBlender(
  blender: BlenderInstall,
  blend: string,
  workIn: string,
): { glb: Uint8Array; log: string[] } {
  const scratch = mkdtempSync(path.join(path.resolve(workIn), '.blender-export-'));
  const out = path.join(scratch, `${path.basename(blend, path.extname(blend))}.glb`);
  try {
    const result = spawnSync(
      blender.command,
      [
        ...blender.prefix,
        '--background',
        '--factory-startup',
        path.resolve(blend),
        '--python',
        SCRIPT,
        '--',
        out,
      ],
      { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
    );
    const lines = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.split('\n');
    const log = lines
      .filter((l) => l.startsWith('drift-export:') || /\b(ERROR|Error|WARNING)\b/.test(l))
      .map((l) => l.trim());
    if (result.status !== 0 || !existsSync(out)) {
      const tail = lines
        .filter((l) => l.trim() !== '')
        .slice(-12)
        .join('\n');
      throw new Error(
        `Blender did not export ${blend} (exit ${result.status ?? 'none'}):\n${tail}`,
      );
    }
    return { glb: new Uint8Array(readFileSync(out)), log };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
