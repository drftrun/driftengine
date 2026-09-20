import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { copyleftOf, nodeLicense, writeLicenses } from './nativeLicenses.ts';

/**
 * **What this file is for: an artifact that carries the licence of everything in it.** The native
 * build ships a Node, four copied modules and a bundle of every package the game imports; most of
 * that is MIT or BSD, whose one condition is that the notice travels with the copy. Nothing about a
 * bundle does that by itself.
 */

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'native-licenses-'));
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), contents);
  }
  return root;
}

const NODE = 'Node.js is licensed for use as follows:\n\n"""\nCopyright Node.js contributors.';
const refuse = (url: string): Promise<string> => Promise.reject(new Error(`offline: ${url}`));

describe("Node's licence", () => {
  it('IS READ FROM BESIDE THE BINARY, where the release archive puts it', async () => {
    const root = tree({ 'node/bin/node': '', 'node/LICENSE': NODE });
    expect(await nodeLicense(join(root, 'node', 'bin', 'node'), 'v22.23.2', refuse)).toBe(NODE);
  });

  /* `n` copies the binary out of the archive and keeps the archive, licence and all, in its cache. */
  it("IS READ FROM n's CACHE, where n keeps the archive it installed from", async () => {
    const root = tree({ 'bin/node': '', 'n/versions/node/22.23.2/LICENSE': NODE });
    expect(await nodeLicense(join(root, 'bin', 'node'), 'v22.23.2', refuse)).toBe(NODE);
  });

  /** A `LICENSE` one directory above `/usr/local/bin` can be anybody's. */
  it("PASSES OVER A LICENCE THAT IS NOT NODE'S, and fetches the one at the exact release", async () => {
    const root = tree({ 'bin/node': '', LICENSE: 'MIT License\n\nCopyright somebody else' });
    const asked: string[] = [];
    const text = await nodeLicense(join(root, 'bin', 'node'), 'v22.23.2', (url) => {
      asked.push(url);
      return Promise.resolve(NODE);
    });
    expect([text, asked]).toEqual([
      NODE,
      ['https://raw.githubusercontent.com/nodejs/node/v22.23.2/LICENSE'],
    ]);
  });

  it('REFUSES THE BUILD when there is no copy here and none can be fetched', async () => {
    const root = tree({ 'bin/node': '' });
    await expect(nodeLicense(join(root, 'bin', 'node'), 'v22.23.2', refuse)).rejects.toThrow(
      /Node's licence.*v22\.23\.2.*offline/s,
    );
  });

  it("REFUSES A FETCHED TEXT THAT IS NOT NODE'S LICENCE", async () => {
    const root = tree({ 'bin/node': '' });
    await expect(
      nodeLicense(join(root, 'bin', 'node'), 'v22.23.2', () => Promise.resolve('404: Not Found')),
    ).rejects.toThrow(/not Node's licence/);
  });
});

describe('the licences directory', () => {
  it('HOLDS EACH PACKAGE LICENCE FILES, and an index by name saying what each is under', async () => {
    const root = tree({
      'mit/package.json': JSON.stringify({ name: 'mit', version: '1.0.0', license: 'MIT' }),
      'mit/LICENSE': 'MIT License',
      'scoped/package.json': JSON.stringify({
        name: '@scope/apache',
        version: '2.0.0',
        license: 'Apache-2.0',
      }),
      'scoped/LICENSE.txt': 'Apache License',
      'scoped/NOTICE': 'a notice',
      'scoped/README.md': 'not a licence',
      'bare/package.json': JSON.stringify({ name: 'bare', version: '0.1.0', license: 'ISC' }),
    });
    const into = join(root, 'out');
    await writeLicenses(
      [join(root, 'mit'), join(root, 'scoped'), join(root, 'bare')],
      { version: 'v22.23.2', text: NODE },
      into,
      null,
    );
    expect(readFileSync(join(into, 'node', 'LICENSE'), 'utf8')).toBe(NODE);
    expect(readFileSync(join(into, 'mit', 'LICENSE'), 'utf8')).toBe('MIT License');
    expect(readFileSync(join(into, '@scope+apache', 'NOTICE'), 'utf8')).toBe('a notice');
    expect(readFileSync(join(into, 'INDEX.txt'), 'utf8').split('\n').slice(2, 6)).toEqual([
      'node v22.23.2 — node/LICENSE',
      '@scope/apache 2.0.0 (Apache-2.0) — @scope+apache/LICENSE.txt, @scope+apache/NOTICE',
      'bare 0.1.0 (ISC) — the package carries no licence file; its manifest names ISC',
      'mit 1.0.0 (MIT) — mit/LICENSE',
    ]);
  });

  /*
   * **The LGPL is the GPL plus permissions, and asks for both texts.** Its section 4 has a work that
   * uses the library carry the GPL beside it, and the library's own package carries only the LGPL.
   */
  it('CARRIES THE GPL BESIDE AN LGPL-3.0 PART, and refuses to leave it out', async () => {
    const root = tree({
      'lib/package.json': JSON.stringify({
        name: 'lib',
        version: '2.5.0',
        license: 'LGPL-3.0-or-later',
      }),
      'lib/LICENSE': 'GNU LESSER GENERAL PUBLIC LICENSE',
    });
    const node = { version: 'v22.23.2', text: NODE };
    await expect(
      writeLicenses([join(root, 'lib')], node, join(root, 'none'), null),
    ).rejects.toThrow(/lib is LGPL-3\.0-or-later.*GPL/s);
    const into = join(root, 'out');
    await writeLicenses([join(root, 'lib')], node, into, 'GNU GENERAL PUBLIC LICENSE');
    expect(readFileSync(join(into, 'GPL-3.0.txt'), 'utf8')).toBe('GNU GENERAL PUBLIC LICENSE');
    expect(readFileSync(join(into, 'INDEX.txt'), 'utf8')).toContain(
      '\nGPL-3.0 — GPL-3.0.txt, which the LGPL-3.0 above is written against and asks to accompany it\n',
    );
  });
});

describe('what a bundle may not hold', () => {
  /*
   * **A copyleft library bundled into one file with the game is a library a person cannot replace**,
   * which the LGPL requires of a work that uses it; the GPL and its kin reach further. Each such
   * package is named, so the build stops instead of shipping it inside the bundle.
   */
  it('NAMES EVERY COPYLEFT PACKAGE, and none that is permissive', () => {
    const packages: Record<string, string> = {
      a: 'MIT',
      b: 'Apache-2.0',
      c: 'BSD-3-Clause',
      d: 'ISC',
      e: 'LGPL-3.0-or-later',
      f: 'GPL-2.0-only',
      g: 'MPL-2.0',
      h: 'AGPL-3.0',
      i: '(MIT OR GPL-3.0)',
    };
    const files: Record<string, string> = {};
    for (const [name, license] of Object.entries(packages)) {
      files[`${name}/package.json`] = JSON.stringify({ name, version: '1.0.0', license });
    }
    const root = tree(files);
    expect(copyleftOf(Object.keys(packages).map((name) => join(root, name)))).toEqual([
      'e (LGPL-3.0-or-later)',
      'f (GPL-2.0-only)',
      'g (MPL-2.0)',
      'h (AGPL-3.0)',
    ]);
  });
});
