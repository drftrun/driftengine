import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { copyPackages, packageDirOf, runtimeClosure } from './nativeCopy.ts';

/**
 * **What this file is for: a native module arriving in the artifact with what it loads, and without
 * what it was installed with.** A module holding a compiled binary cannot be bundled, so it is copied
 * — and a copy that misses one package it imports fails on a player's machine at launch, while one
 * that follows every declared dependency ships a C++ build system beside the game.
 */

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'native-copy-'));
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), contents);
  }
  return root;
}

const manifest = (name: string, version: string, dependencies: Record<string, string> = {}) =>
  JSON.stringify({ name, version, dependencies });

describe('the native modules a build copies', () => {
  it('FOLLOWS WHAT A MODULE LOADS, and leaves what it only installs with', () => {
    const root = tree({
      'node_modules/host/package.json': manifest('host', '1.0.0'),
      'node_modules/audio/package.json': manifest('audio', '2.0.0', { fetch: '^3' }),
      'node_modules/fetch/package.json': manifest('fetch', '3.1.0', { blob: '^1' }),
      /* Nested under the package that needs it, where npm puts a second version. */
      'node_modules/fetch/node_modules/blob/package.json': manifest('blob', '1.2.0'),
      'node_modules/binding/package.json': manifest('binding', '0.2.0', { tar: '^7' }),
      'node_modules/tar/package.json': manifest('tar', '7.0.0'),
    });
    const host = join(root, 'node_modules', 'host');
    const found = runtimeClosure(
      [
        { name: 'audio', from: host },
        { name: 'binding', from: host },
      ],
      { binding: ['tar'] },
    );
    expect(found.map((entry) => `${entry.name}@${entry.version}`)).toEqual([
      'audio@2.0.0',
      'fetch@3.1.0',
      'blob@1.2.0',
      'binding@0.2.0',
    ]);
    expect(found[2]?.dir).toBe(join(root, 'node_modules', 'fetch', 'node_modules', 'blob'));
  });

  /*
   * **A library the bundle imports from inside another package is found from there**, where npm put
   * the version that package asked for — the LGPL library the host links is one, imported by the
   * Opus decoder rather than by the host.
   */
  it('FINDS A MODULE FROM THE PACKAGE THAT IMPORTS IT, not from the top of the tree', () => {
    const root = tree({
      'node_modules/parser/package.json': manifest('parser', '1.0.0'),
      'node_modules/decoder/package.json': manifest('decoder', '1.0.0', { parser: '^2' }),
      'node_modules/decoder/node_modules/parser/package.json': manifest('parser', '2.0.0'),
    });
    const found = runtimeClosure(
      [{ name: 'parser', from: join(root, 'node_modules', 'decoder') }],
      {},
    );
    expect(found.map((entry) => entry.version)).toEqual(['2.0.0']);
  });

  it('REFUSES A MODULE THAT IS NOT INSTALLED, naming who needed it', () => {
    const root = tree({
      'node_modules/audio/package.json': manifest('audio', '2.0.0', { x: '1' }),
    });
    expect(() => runtimeClosure([{ name: 'audio', from: root }], {})).toThrow(
      /"x", which audio loads/,
    );
  });

  /*
   * **One directory per name in the artifact**, so two versions of one package cannot both be copied
   * where they were: the second would silently replace the first under a module that asked for it.
   */
  it('REFUSES TWO VERSIONS OF ONE PACKAGE rather than keeping whichever was copied last', () => {
    const root = tree({
      'node_modules/a/package.json': manifest('a', '1.0.0', { shared: '^1' }),
      'node_modules/shared/package.json': manifest('shared', '1.0.0'),
      'node_modules/b/package.json': manifest('b', '1.0.0', { shared: '^2' }),
      'node_modules/b/node_modules/shared/package.json': manifest('shared', '2.0.0'),
    });
    expect(() =>
      runtimeClosure(
        [
          { name: 'a', from: root },
          { name: 'b', from: root },
        ],
        {},
      ),
    ).toThrow(/shared 1\.0\.0 and 2\.0\.0/);
  });

  /*
   * **A binary built for another machine stays behind.** The Web Audio engine ships seven, one per
   * platform, and loads one: 41 MB installed, about 7 in the artifact.
   */
  it('COPIES A PACKAGE WITHOUT ITS OTHER PLATFORMS BINARIES, OR ITS OWN NODE_MODULES', async () => {
    const root = tree({
      'node_modules/audio/package.json': manifest('audio', '2.0.0'),
      'node_modules/audio/index.js': 'export {}',
      'node_modules/audio/audio.linux-x64-gnu.node': 'mine',
      'node_modules/audio/audio.darwin-arm64.node': 'theirs',
      'node_modules/audio/audio.linux-arm64-gnu.node': 'theirs',
      'node_modules/audio/audio.win32-x64-msvc.node': 'theirs',
      'node_modules/audio/dist/binding.node': 'untagged, so mine',
      'node_modules/audio/node_modules/dep/package.json': manifest('dep', '1.0.0'),
    });
    const into = join(root, 'app', 'node_modules');
    const [audio] = runtimeClosure([{ name: 'audio', from: root }], {});
    if (audio === undefined) throw new Error('no package found');
    await copyPackages([audio], into, { platform: 'linux', arch: 'x64' });
    const has = (path: string) => existsSync(join(into, 'audio', path));
    expect([
      has('index.js'),
      has('audio.linux-x64-gnu.node'),
      has('dist/binding.node'),
      has('audio.darwin-arm64.node'),
      has('audio.linux-arm64-gnu.node'),
      has('audio.win32-x64-msvc.node'),
      has('node_modules'),
    ]).toEqual([true, true, true, false, false, false, false]);
    expect(readFileSync(join(into, 'audio', 'package.json'), 'utf8')).toContain('"audio"');
  });

  /*
   * A built package often carries a `package.json` of its own in `dist/` saying only
   * `{"type":"module"}`, which is not the package.
   */
  it('FINDS THE PACKAGE A FILE BELONGS TO, past a manifest that names none', () => {
    const root = tree({
      'node_modules/lib/package.json': manifest('lib', '4.0.0'),
      'node_modules/lib/dist/package.json': '{"type":"module"}',
      'node_modules/lib/dist/index.js': '',
    });
    expect(packageDirOf(join(root, 'node_modules', 'lib', 'dist', 'index.js'))).toBe(
      join(root, 'node_modules', 'lib'),
    );
    expect(packageDirOf(join(root, 'loose.js'))).toBeNull();
  });
});
