import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, test } from 'vitest';

import { readStoreFile, writeStoreFile, writeStoreFileSync } from './storeFile.ts';

/**
 * **What this file is for: a store a crash cannot tear.** A shell keeps a game's preferences and
 * saves in one file and rewrites it whole. Written in place, a process that dies mid-write — a
 * crash, a power cut, a player ending the task — leaves the file cut short, and a store that does
 * not parse is read as an empty one, so every setting the player ever made is gone at the next boot
 * with nothing said. It was written in place until 2026-09-19.
 */

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'drift-store-'));
  dirs.push(dir);
  return dir;
}

describe('a store as one file', () => {
  test('WHAT IS WRITTEN IS READ BACK, and nothing is left beside it', async () => {
    const path = join(scratch(), 'store.json');
    writeStoreFileSync(path, [['volume', '0.8']]);
    expect(readStoreFile(path)).toEqual({ volume: '0.8' });
    await writeStoreFile(path, [
      ['volume', '0.5'],
      ['slot', 'forest'],
    ]);
    expect(readStoreFile(path)).toEqual({ volume: '0.5', slot: 'forest' });
    expect(readdirSync(join(path, '..'))).toEqual(['store.json']);
  });

  test('WRITES LAND IN THE ORDER THEY WERE ASKED FOR, however long each takes', async () => {
    const path = join(scratch(), 'store.json');
    const big = 'x'.repeat(4_000_000);
    const first = writeStoreFile(path, [['pad', big]]);
    const second = writeStoreFile(path, [['last', 'yes']]);
    await Promise.all([first, second]);
    expect(readStoreFile(path)).toEqual({ last: 'yes' });
  });

  test('A WRITE THAT FAILS LEAVES NOTHING BEHIND, and says so', async () => {
    const dir = scratch();
    /* A directory where the store should be: the rename is refused, after the write succeeded. */
    const path = join(dir, 'store.json');
    mkdirSync(path);
    expect(() => writeStoreFileSync(path, [['a', '1']])).toThrow();
    await expect(writeStoreFile(path, [['a', '1']])).rejects.toThrow();
    expect(readdirSync(dir)).toEqual(['store.json']);
  });

  test('A FILE THAT IS NOT A STORE READS AS AN EMPTY ONE, and a value that is not a string is dropped', () => {
    const dir = scratch();
    expect(readStoreFile(join(dir, 'absent.json'))).toEqual({});
    writeFileSync(join(dir, 'torn.json'), '{"volume": "0.');
    expect(readStoreFile(join(dir, 'torn.json'))).toEqual({});
    writeFileSync(join(dir, 'mixed.json'), '{"volume": "0.8", "count": 3}');
    expect(readStoreFile(join(dir, 'mixed.json'))).toEqual({ volume: '0.8' });
  });

  test('A STORE BEING REWRITTEN IS ONLY EVER READ WHOLE, and so is one whose writer was killed', async () => {
    /*
     * **Read while it is written, because that is what a crash leaves.** A kill does not land inside
     * a large write on Linux — the write finishes first — so killing a writer in place hardly ever
     * tears its file, and a test of that passes either way. A reader, though, sees the file exactly
     * as a crash at that instant would leave it: truncated to nothing, or part written.
     */
    const path = join(scratch(), 'store.json');
    const module = fileURLToPath(new URL('./storeFile.ts', import.meta.url));
    /* A child rewriting an 8 MB store as fast as it can. */
    const writer = `
      const { writeStoreFileSync } = await import(${JSON.stringify(module)});
      const pad = 'x'.repeat(8_000_000);
      for (let n = 0; ; n += 1) writeStoreFileSync(${JSON.stringify(path)}, [['n', String(n)], ['pad', pad]]);
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', writer], {
      stdio: 'ignore',
    });
    try {
      while (!existsSync(path)) await new Promise((resolve) => setTimeout(resolve, 2));
      let reads = 0;
      let torn = 0;
      const until = Date.now() + 600;
      while (Date.now() < until) {
        if (readStoreFile(path)['pad']?.length !== 8_000_000) torn += 1;
        reads += 1;
      }
      expect(reads, 'enough reads to have met a rewrite').toBeGreaterThan(10);
      expect(torn, `${torn} of ${reads} reads found a store part written`).toBe(0);
    } finally {
      child.kill('SIGKILL');
      await new Promise((resolve) => child.once('exit', resolve));
    }
    expect(readStoreFile(path)['pad']?.length, 'and the killed writer left a whole one').toBe(
      8_000_000,
    );
  }, 30_000);
});
