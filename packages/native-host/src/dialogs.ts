/**
 * Open and save dialogs from the desktop, since SDL 2 gives a window none.
 *
 * **The desktop's own dialog program, asked and waited for**: zenity, which GNOME and the GTK
 * desktops carry, and kdialog where zenity is not installed. What comes back is what the desktop
 * shell hands a game (`main/ipc.ts`): a picked file's name and bytes, `null` for a cancelled pick,
 * and `false` for a cancelled save — a cancellation being exit code 1 for both programs.
 *
 * **A filter is the extensions the game named**, `.json` becoming `*.json`; a MIME type has no
 * pattern either program takes, so it is left out rather than guessed at.
 *
 * What it gives up: Windows and macOS, which carry neither program and are Task 7's; the desktop
 * portal, which is what a sandboxed Linux build would need and answers over D-Bus signals rather
 * than an exit code; and where neither program is installed, `desktopFiles` answers null and the
 * bridge reports every pick cancelled.
 */

import { spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, delimiter, join } from 'node:path';

import type { NativeFiles } from './bridge.ts';

/** Run a dialog program and hand back its exit code and what it printed. */
export type DialogRunner = (
  command: string,
  args: readonly string[],
) => Promise<{ code: number; stdout: string }>;

const spawnRunner: DialogRunner = (command, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code: code ?? 1, stdout }));
  });

/** Whether `name` is an executable on the search path. */
function onPath(name: string): boolean {
  for (const directory of (process.env['PATH'] ?? '').split(delimiter)) {
    try {
      accessSync(join(directory, name), constants.X_OK);
      return true;
    } catch {
      /* Not in this one. */
    }
  }
  return false;
}

const patternsOf = (accept: readonly string[]) =>
  accept.filter((entry) => entry.startsWith('.')).map((extension) => `*${extension}`);

/** The chosen path, or null when the person cancelled; anything else is a fault and says so. */
function chosen(command: string, answer: { code: number; stdout: string }): string | null {
  if (answer.code === 0) return answer.stdout.replace(/\r?\n$/, '');
  if (answer.code !== 1) console.warn(`[driftengine] ${command} ended with code ${answer.code}`);
  return null;
}

export function desktopFiles(
  available: (name: string) => boolean = onPath,
  run: DialogRunner = spawnRunner,
): NativeFiles | null {
  const command = available('zenity') ? 'zenity' : available('kdialog') ? 'kdialog' : null;
  if (command === null) return null;
  const zenity = command === 'zenity';
  return {
    async openFile(accept) {
      const patterns = patternsOf(accept);
      const args = zenity
        ? [
            '--file-selection',
            ...(patterns.length > 0
              ? [`--file-filter=${patterns.join(' ')} | ${patterns.join(' ')}`]
              : []),
          ]
        : ['--getopenfilename', '.', ...(patterns.length > 0 ? [patterns.join(' ')] : [])];
      const path = chosen(command, await run(command, args));
      if (path === null) return null;
      return { name: basename(path), bytes: new Uint8Array(await readFile(path)) };
    },
    async saveFile(name, bytes) {
      const args = zenity
        ? ['--file-selection', '--save', `--filename=${name}`]
        : ['--getsavefilename', name];
      const path = chosen(command, await run(command, args));
      if (path === null) return false;
      await writeFile(path, bytes);
      return true;
    },
  };
}
