/**
 * That a stranger can `import` these packages from Node, checked the only way it can be.
 *
 * **This class of defect is invisible from inside the workspace, and that is the whole reason the
 * script exists.** Node refuses to strip types for any file under `node_modules` —
 * `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`, categorical rather than a resolution failure. In a
 * workspace every `@driftengine/*` resolves through a **symlink whose real path has no
 * `node_modules` segment in it**, so the refusal never fires and every local check passes. From a
 * real install it is a real directory under `node_modules`, and it fires on the first import.
 *
 * `driftscript` learned this by publishing: five of seven consumption paths failed while all 892 of
 * its tests passed. This engine reproduced it on 2026-09-04 before writing a line of the build.
 *
 * **The tarballs are extracted rather than installed through npm**, deliberately. `npm install
 * a.tgz b.tgz` resolves each tarball's `@driftengine/*` ranges against the registry, so this would
 * test whatever version is published rather than the tree in front of it — and it cannot run at
 * all before a first publish. Extracting each into
 * `node_modules/@driftengine/<name>` produces exactly the directory layout a consumer's install has
 * — which is the condition being tested, since it is the `node_modules` path that triggers the
 * refusal.
 *
 * **Outside the checkout**, in the system temp directory, so nothing here can resolve back into the
 * repository by accident.
 *
 * Usage:
 *   node scripts/cleanroom.mjs           every package
 *   node scripts/cleanroom.mjs --keep    leave the room behind for inspection
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { missingModules } from './emitModules.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const KEEP = process.argv.includes('--keep');

const manifests = readdirSync(path.join(ROOT, 'packages'))
  .map((dir) => ({ dir, file: path.join(ROOT, 'packages', dir, 'package.json') }))
  .filter((p) => existsSync(p.file))
  .map((p) => ({ ...p, manifest: JSON.parse(readFileSync(p.file, 'utf8')) }));

const missing = manifests.filter((p) => !existsSync(path.join(ROOT, 'packages', p.dir, 'dist')));
if (missing.length > 0) {
  console.error(
    `cleanroom: ${missing.map((p) => p.manifest.name).join(', ')} have no dist — run npm run build`,
  );
  process.exit(1);
}

const room = mkdtempSync(path.join(tmpdir(), 'drift-cleanroom-'));
const modules = path.join(room, 'node_modules', '@driftengine');
mkdirSync(modules, { recursive: true });
writeFileSync(
  path.join(room, 'package.json'),
  `${JSON.stringify({ name: 'cleanroom', private: true, version: '1.0.0', type: 'module' }, null, 2)}\n`,
);

console.log(`clean room: ${room}\n`);

/*
 * Third-party dependencies first, from the registry, because a consumer would have them. Only the
 * non-scoped ones: every `@driftengine/*` range is satisfied by the extraction below.
 *
 * **Before the extraction, not after, and the order is not cosmetic.** `npm install` reconciles
 * `node_modules` against the manifest, and this room's manifest declares nothing — so running it
 * second deletes every package just extracted and the whole run fails with `ERR_MODULE_NOT_FOUND`
 * for all twenty-five entry points.
 */
/*
 * **Optional dependencies too**, because a consumer's `npm install` fetches them unless told not to:
 * the native host's window, device and audio are three, and its barrel loads the window's binding
 * when it is imported.
 */
const external = new Set();
for (const p of manifests) {
  for (const [name, range] of Object.entries({
    ...p.manifest.dependencies,
    ...p.manifest.optionalDependencies,
  })) {
    if (!name.startsWith('@driftengine/')) external.add(`${name}@${range}`);
  }
}
if (external.size > 0) {
  execFileSync('npm', ['install', '--no-save', '--silent', ...external], {
    cwd: room,
    stdio: 'pipe',
  });
}

/* Pack, then extract into the layout an install produces. */
for (const p of manifests) {
  const packed = execFileSync('npm', ['pack', '--pack-destination', room, '--silent'], {
    cwd: path.join(ROOT, 'packages', p.dir),
    encoding: 'utf8',
  })
    .trim()
    .split('\n')
    .pop();
  const target = path.join(modules, p.manifest.name.split('/')[1]);
  mkdirSync(target, { recursive: true });
  execFileSync('tar', ['-xzf', path.join(room, packed), '-C', target, '--strip-components=1']);
}

/*
 * **Every module a package starts by URL, in the tarball.** A worker is not an import, so importing
 * each entry point below never reaches one, and a `dist` naming a worker it does not hold imports
 * cleanly. `emitModules.mjs` has the history.
 */
let failed = 0;
for (const p of manifests) {
  const missing = missingModules(path.join(modules, p.manifest.name.split('/')[1], 'dist'));
  for (const line of missing) console.log(`  ${p.manifest.name}: ${line}`);
  failed += missing.length;
}

/* Every entry point every package declares, imported under plain node, one process each. */
let checked = 0;
for (const p of manifests) {
  const entries = Object.keys(p.manifest.exports ?? { '.': true });
  for (const entry of entries) {
    /*
     * Patterns are not specifiers. `"./*": "./*"` keeps a package open the way it was before it
     * declared `exports` at all — importing `@driftengine/core/*` is meaningless, and checking it
     * failed fifteen entry points that were never entry points.
     */
    if (entry.includes('*')) continue;
    const specifier =
      entry === '.' ? p.manifest.name : `${p.manifest.name}/${entry.replace(/^\.\//, '')}`;
    if (specifier.endsWith('.json')) continue;
    checked++;
    process.stdout.write(`  ${specifier.padEnd(34)}`);
    try {
      execFileSync(
        process.execPath,
        ['--input-type=module', '-e', `await import(${JSON.stringify(specifier)});`],
        {
          cwd: room,
          stdio: 'pipe',
        },
      );
      console.log('ok');
    } catch (error) {
      failed++;
      console.log('FAILED');
      const text = String(error.stderr ?? '');
      const line = text.split('\n').find((l) => /Error|error/.test(l)) ?? text.split('\n')[0];
      console.log(`      ${line.trim()}`);
    }
  }
}

if (!KEEP) rmSync(room, { recursive: true, force: true });
console.log(
  failed === 0
    ? `\n${checked} entry points import under plain node`
    : `\n${failed} of ${checked} entry points failed`,
);
process.exit(failed === 0 ? 0 : 1);
