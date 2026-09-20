/**
 * The native artifact's `licenses/`: Node's licence, and each package's licence files, with an
 * index saying what every part is under.
 *
 * **Because a bundle drops them.** The desktop target ships Electron, whose own licence files come
 * with it, and a game's web build that its own bundler made. The native target bundles every
 * package the game and the host import into one file, and most of them are MIT or BSD, whose one
 * condition is that the notice goes with the copy — so this build is the one that has to carry it.
 *
 * **Node's licence is the binary's own**, and covers what Node carries inside it: V8, OpenSSL, ICU
 * and the rest. It is read from beside the binary where the release archive puts it, or from `n`'s
 * cache, and otherwise fetched at the exact release that is being shipped. A file there that does
 * not open as Node's does is passed over, because `LICENSE` one directory above `/usr/local/bin` can
 * be anybody's.
 *
 * **The LGPL 3.0 comes with the GPL 3.0**, because it is written as permissions on top of it and
 * asks for both texts; the library's own package carries only the first. And **a copyleft package is
 * named** (`copyleftOf`) so that the build can refuse to bundle one: a dual licence counts as
 * permissive when either half is.
 *
 * What it gives up: a package whose licence is only a word in its manifest has no text to copy, and
 * the index says so for each one rather than inventing one.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** What a package's licence files are called, and its notice, which Apache-2.0 asks to go too. */
const LICENCE_FILE = /^(licen[cs]e|copying|notice)([.-].*)?$/i;
const NODE_OPENS = 'Node.js is licensed';
/** The licences whose terms reach the file a library is bundled into, by their SPDX names. */
const COPYLEFT = /\b(?:AGPL|LGPL|GPL|MPL|EPL|EUPL|CDDL|OSL)-/i;
const LGPL3 = /\bLGPL-3\.0/i;

function manifestOf(dir: string): { name: string; version?: string; license?: unknown } {
  return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
    name: string;
    version?: string;
    license?: unknown;
  };
}

/**
 * Whether `license`, an SPDX expression, holds a work to a copyleft licence: every alternative of
 * an `OR` is copyleft, since otherwise a permissive one can be chosen.
 */
function copyleft(license: string): boolean {
  return license
    .replace(/[()]/g, '')
    .split(/\s+OR\s+/i)
    .every((alternative) => COPYLEFT.test(alternative));
}

/**
 * Each of `packageDirs` under a copyleft licence, as `name (licence)`. The native build refuses to
 * bundle one: the LGPL lets a work of any licence use its library so long as a person can put a
 * modified copy in its place, which one file with the game in it does not allow, and the others
 * reach further.
 */
export function copyleftOf(packageDirs: Iterable<string>): string[] {
  const found: string[] = [];
  for (const dir of packageDirs) {
    const { name, license } = manifestOf(dir);
    if (typeof license === 'string' && copyleft(license)) found.push(`${name} (${license})`);
  }
  return found;
}

export type FetchText = (url: string) => Promise<string>;

/** Node's licence for the binary at `execPath`, which is `version`, or a refusal naming both. */
export async function nodeLicense(
  execPath: string,
  version: string,
  fetchText: FetchText,
): Promise<string> {
  const prefix = dirname(dirname(execPath));
  for (const candidate of [
    join(prefix, 'LICENSE'),
    join(prefix, 'n', 'versions', 'node', version.replace(/^v/, ''), 'LICENSE'),
  ]) {
    if (!existsSync(candidate)) continue;
    const text = readFileSync(candidate, 'utf8');
    if (text.startsWith(NODE_OPENS)) return text;
  }
  const url = `https://raw.githubusercontent.com/nodejs/node/${version}/LICENSE`;
  let text: string;
  try {
    text = await fetchText(url);
  } catch (cause) {
    throw new Error(
      `the native artifact ships Node ${version} and must carry Node's licence, and there is no ` +
        `copy beside ${execPath} and none could be fetched from ${url}: ${String(cause)}`,
    );
  }
  if (!text.startsWith(NODE_OPENS)) {
    throw new Error(`${url} answered a text that is not Node's licence; nothing was written`);
  }
  return text;
}

/**
 * The licences directory for `packageDirs` and Node, written into `into`. `gpl` is the GPL's text,
 * which goes beside any part under the LGPL 3.0: that licence is written as permissions on top of
 * the GPL, and its section 4 asks for both texts to accompany a work that uses the library.
 */
export async function writeLicenses(
  packageDirs: Iterable<string>,
  node: { readonly version: string; readonly text: string },
  into: string,
  gpl: string | null,
): Promise<void> {
  const packages = [...packageDirs].map((dir) => ({ dir, manifest: manifestOf(dir) }));
  packages.sort((a, b) => (a.manifest.name < b.manifest.name ? -1 : 1));
  const lesser = packages.find(
    ({ manifest }) => typeof manifest.license === 'string' && LGPL3.test(manifest.license),
  );
  if (lesser !== undefined && gpl === null) {
    throw new Error(
      `${lesser.manifest.name} is ${String(lesser.manifest.license)}, which asks for the GPL's text ` +
        'to go with it, and none was given to write beside it',
    );
  }

  await mkdir(join(into, 'node'), { recursive: true });
  await writeFile(join(into, 'node', 'LICENSE'), node.text);
  const lines = [`node ${node.version} — node/LICENSE`];

  for (const { dir, manifest } of packages) {
    const folder = manifest.name.replace('/', '+');
    const named = typeof manifest.license === 'string' ? manifest.license : 'no licence';
    const files = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && LICENCE_FILE.test(entry.name))
      .map((entry) => entry.name)
      .sort();
    const heading = `${manifest.name} ${manifest.version ?? ''} (${named})`;
    if (files.length === 0) {
      lines.push(`${heading} — the package carries no licence file; its manifest names ${named}`);
      continue;
    }
    await mkdir(join(into, folder), { recursive: true });
    for (const file of files) await copyFile(join(dir, file), join(into, folder, file));
    lines.push(`${heading} — ${files.map((file) => `${folder}/${file}`).join(', ')}`);
  }

  if (lesser !== undefined && gpl !== null) {
    await writeFile(join(into, 'GPL-3.0.txt'), gpl);
    lines.push(
      'GPL-3.0 — GPL-3.0.txt, which the LGPL-3.0 above is written against and asks to accompany it',
    );
  }

  await writeFile(
    join(into, 'INDEX.txt'),
    [
      'Everything this application ships, and the licence each part is under.',
      '',
      ...lines,
      '',
    ].join('\n'),
  );
}
