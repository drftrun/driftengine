import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { desktopFiles } from './dialogs.ts';
import type { DialogRunner } from './dialogs.ts';

/**
 * **What this file is for: a game's open and save dialogs, where SDL has none.** A browser gives a
 * page a file picker; SDL 2 does not give a window one. So the host asks the desktop's own dialog —
 * zenity, and kdialog where zenity is not installed — and hands the bytes back the way the desktop
 * shell does: a name and the contents, `null` for a cancelled pick, `false` for a cancelled save.
 * These tests stand in for the dialog program and check what it is asked and what is made of its
 * answer.
 */

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'drift-dialog-'));
  dirs.push(dir);
  return dir;
}

function runner(answers: { code: number; stdout: string }[]) {
  const asked: string[][] = [];
  const run: DialogRunner = (command, args) => {
    asked.push([command, ...args]);
    return Promise.resolve(answers.shift() ?? { code: 1, stdout: '' });
  };
  return { run, asked };
}

describe('file dialogs from the desktop', () => {
  test('ZENITY IS ASKED FOR A FILE OF THE KINDS THE GAME TAKES, and its bytes come back', async () => {
    const dir = scratch();
    const picked = join(dir, 'level.json');
    writeFileSync(picked, '{"rooms":3}');
    const { run, asked } = runner([{ code: 0, stdout: `${picked}\n` }]);
    /* Both installed, as on a desktop with GTK and KDE applications: zenity is asked. */
    const files = desktopFiles((name) => name === 'zenity' || name === 'kdialog', run);
    const opened = await files?.openFile(['.json', '.txt', 'image/png']);
    expect(asked).toEqual([
      ['zenity', '--file-selection', '--file-filter=*.json *.txt | *.json *.txt'],
    ]);
    expect(opened?.name).toBe('level.json');
    expect(new TextDecoder().decode(opened?.bytes)).toBe('{"rooms":3}');
  });

  test('A CANCELLED PICK IS NULL, and a cancelled save is false', async () => {
    const { run } = runner([
      { code: 1, stdout: '' },
      { code: 1, stdout: '' },
    ]);
    const files = desktopFiles((name) => name === 'zenity', run);
    expect(await files?.openFile(['.json'])).toBeNull();
    expect(await files?.saveFile('replay.bin', new Uint8Array([1]))).toBe(false);
  });

  test('A SAVE WRITES THE BYTES WHERE THE PERSON CHOSE, suggesting the game’s name', async () => {
    const dir = scratch();
    const chosen = join(dir, 'mine.bin');
    const { run, asked } = runner([{ code: 0, stdout: `${chosen}\n` }]);
    const files = desktopFiles((name) => name === 'zenity', run);
    expect(await files?.saveFile('replay.bin', new Uint8Array([1, 2, 3]))).toBe(true);
    expect(asked).toEqual([['zenity', '--file-selection', '--save', '--filename=replay.bin']]);
    expect(Array.from(readFileSync(chosen))).toEqual([1, 2, 3]);
  });

  test('KDIALOG WHERE THERE IS NO ZENITY, and nothing where there is neither', async () => {
    const { run, asked } = runner([
      { code: 1, stdout: '' },
      { code: 1, stdout: '' },
    ]);
    const files = desktopFiles((name) => name === 'kdialog', run);
    await files?.openFile(['.png']);
    await files?.saveFile('shot.png', new Uint8Array([1]));
    expect(asked).toEqual([
      ['kdialog', '--getopenfilename', '.', '*.png'],
      ['kdialog', '--getsavefilename', 'shot.png'],
    ]);
    expect(desktopFiles(() => false, run)).toBeNull();
  });
});
