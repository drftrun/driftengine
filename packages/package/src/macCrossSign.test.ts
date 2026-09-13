import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { zipMacApp } from './macCrossSign.ts';

/*
 * **The archive step, which exists because electron-builder's own cannot be used off a Mac.**
 *
 * Its zip target picks 7-Zip everywhere but darwin, and 7-Zip dereferences symlinks. A
 * `.framework` is symlinks by construction, so the archive that produced held the framework's
 * payload twice and macOS rejected the layout — measured here as a 404 MB artifact with zero
 * symlink entries, against 353 MB on disk. Nothing about it failed at build time, which is what
 * makes it worth a test rather than a comment.
 */

const hasZip = spawnSync('zip', ['-v']).status === 0;

const temporaries: string[] = [];

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'drift-zip-test-'));
  temporaries.push(dir);
  return dir;
}

/** A directory shaped like the part of a `.app` that this step gets wrong when it gets it wrong. */
async function bundleWithFramework(root: string): Promise<string> {
  const app = join(root, 'Thing.app');
  const versionA = join(app, 'Contents', 'Frameworks', 'Some.framework', 'Versions', 'A');
  await mkdir(versionA, { recursive: true });
  await writeFile(join(versionA, 'Some'), 'binary');
  const framework = join(app, 'Contents', 'Frameworks', 'Some.framework');
  await symlink('A', join(framework, 'Versions', 'Current'));
  await symlink(join('Versions', 'Current', 'Some'), join(framework, 'Some'));
  return app;
}

afterEach(async () => {
  await Promise.all(temporaries.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe.skipIf(!hasZip)('zipMacApp', () => {
  it('keeps the symlinks a framework is built out of', async () => {
    const root = await scratch();
    const app = await bundleWithFramework(root);
    const archive = join(root, 'thing.zip');

    await zipMacApp(app, archive);

    /* `zipinfo`'s long listing marks a symlink entry with a leading `l`, the way `ls` does. */
    const listed = spawnSync('unzip', ['-Z', archive], { encoding: 'utf8' }).stdout;
    const symlinks = listed.split('\n').filter((line) => line.startsWith('l'));
    expect(symlinks).toHaveLength(2);
  });

  /*
   * The guard, checked by pointing it at a tree with no links at all — which is exactly what an
   * archiver that dereferenced them would have left behind.
   */
  it('refuses an archive that has no symlinks in it', async () => {
    const root = await scratch();
    const app = join(root, 'Flat.app');
    await mkdir(join(app, 'Contents'), { recursive: true });
    await writeFile(join(app, 'Contents', 'Info.plist'), '<plist/>');

    await expect(zipMacApp(app, join(root, 'flat.zip'))).rejects.toThrow(/symlink/i);
  });

  /* A rebuild must not inherit files from the build before it: `zip` updates in place by default. */
  it('replaces an existing archive rather than adding to it', async () => {
    const root = await scratch();
    const app = await bundleWithFramework(root);
    const archive = join(root, 'thing.zip');

    await zipMacApp(app, archive);
    await rm(join(app, 'Contents', 'Frameworks', 'Some.framework', 'Versions', 'A', 'Some'));
    await zipMacApp(app, archive);

    const listed = spawnSync('unzip', ['-Z1', archive], { encoding: 'utf8' }).stdout;
    expect(listed).not.toMatch(/Versions\/A\/Some$/m);
  });
});
