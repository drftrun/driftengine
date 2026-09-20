import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { bundleNative, rewriteModuleUrls } from './nativeBundle.ts';

/**
 * **What this file is for: a worker the engine starts still being there after the game is bundled.**
 * The engine starts its workers as a page does, `new Worker(new URL('./islandWorker.ts',
 * import.meta.url))`, and a browser bundler turns each such module into a file of its own beside the
 * bundle. esbuild does not, so the native build does it here: every module a file names that way
 * becomes an entry of its own, and the reference is rewritten to where that entry is written.
 */
describe('module URLs in a native bundle', () => {
  it('RENAMES A MODULE A FILE NAMES BY URL to its own entry beside the bundle, and collects it', () => {
    const found = new Map<string, string>();
    const code = [
      "const worker = new Worker(new URL('./islandWorker.ts', import.meta.url), { type: 'module' });",
      'const scope = new URL("../threads/workerScope.mjs", import.meta.url);',
    ].join('\n');
    const out = rewriteModuleUrls(code, '/src/physics/workerPool.ts', './modules/', found);
    expect(out).toBe(
      [
        "const worker = new Worker(new URL('./modules/islandWorker-1.mjs', import.meta.url), { type: 'module' });",
        "const scope = new URL('./modules/workerScope-2.mjs', import.meta.url);",
      ].join('\n'),
    );
    expect([...found]).toEqual([
      ['/src/physics/islandWorker.ts', 'islandWorker-1.mjs'],
      ['/src/threads/workerScope.mjs', 'workerScope-2.mjs'],
    ]);
  });

  it('NAMES ONE MODULE ONCE, however many files name it', () => {
    const found = new Map<string, string>();
    const line = "new URL('./islandWorker.ts', import.meta.url)";
    rewriteModuleUrls(line, '/src/physics/a.ts', './modules/', found);
    const again = rewriteModuleUrls(line, '/src/physics/b.ts', './', found);
    expect([again, found.size]).toEqual(["new URL('./islandWorker-1.mjs', import.meta.url)", 1]);
  });

  it('LEAVES A URL TO ANYTHING BUT A MODULE, and one not relative to the file, as it was', () => {
    const found = new Map<string, string>();
    const code = [
      "new URL('./icon.png', import.meta.url)",
      "new URL('https://example.com/x.js', import.meta.url)",
      'new URL(name, import.meta.url)',
    ].join('\n');
    expect(rewriteModuleUrls(code, '/src/a.ts', './modules/', found)).toBe(code);
    expect(found.size).toBe(0);
  });
});

/**
 * **A library whose licence asks that a person can replace it stays a file of its own.** The Opus
 * decoder the host uses reads Ogg pages with `codec-parser`, which is LGPL-3.0: bundled into one
 * file with the game, nobody could put a modified copy in its place, which that licence requires of
 * a work that uses it.
 */
describe('a library the bundle links rather than holds', () => {
  it('IS LEFT AN IMPORT, found from the package that imports it, and still loads', async () => {
    const project = mkdtempSync(join(tmpdir(), 'native-bundle-'));
    const files: Record<string, string> = {
      'node_modules/decoder/package.json': '{"name":"decoder","type":"module","main":"index.js"}',
      'node_modules/decoder/index.js':
        "import parse from 'codec-parser';\nexport const decode = () => `decoded by ${parse()}`;\n",
      'node_modules/codec-parser/package.json':
        '{"name":"codec-parser","type":"module","main":"index.js","license":"LGPL-3.0-or-later"}',
      'node_modules/codec-parser/index.js': "export default () => 'THE LIBRARY';\n",
    };
    for (const [path, contents] of Object.entries(files)) {
      mkdirSync(dirname(join(project, path)), { recursive: true });
      writeFileSync(join(project, path), contents);
    }
    const app = join(project, 'app');
    const bundled = await bundleNative(
      "import { decode } from 'decoder';\nconsole.log(decode());\n",
      app,
      project,
    );
    expect([...bundled.linked]).toEqual([
      { name: 'codec-parser', from: realpathSync(join(project, 'node_modules', 'decoder')) },
    ]);
    const code = readFileSync(join(app, 'game.mjs'), 'utf8');
    expect(code).not.toContain('THE LIBRARY');
    expect([...bundled.inputs].some((file) => file.includes('codec-parser'))).toBe(false);
    expect(execFileSync(process.execPath, [join(app, 'game.mjs')], { encoding: 'utf8' })).toBe(
      'decoded by THE LIBRARY\n',
    );
  });
});
