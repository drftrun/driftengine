import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { resourceDir, resourceFile, resourceRoot } from './resources.ts';

/**
 * **Reported from outside 2026-08-28: the packager could not be told where its own assets are.**
 *
 * Four call sites climbed out of `src/` on their own — `../assets` twice, `../android`, `../ios`,
 * and a default icon inside the first — with no option, flag or variable that moved any of them.
 * The first runs on every desktop build. That is fine in this repository and a wall for a consumer
 * that vendors engine source rather than installing it: such a vendor
 * copies `packages/<name>/src/**` to `<name>/**`, and the flattening drops exactly the level those
 * paths climbed to.
 */
const made: string[] = [];

afterEach(async () => {
  for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** A file only the real directory has, which is what identifies it. See `MARKER` in `resources.ts`. */
const MARKER: Record<string, string> = {
  assets: 'splash.html',
  android: 'settings.gradle.kts',
  ios: 'project.yml',
};

/** A root holding the named directories, each with the marker that makes it the packager's. */
const laidOut = async (...names: readonly string[]): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'drift-resources-'));
  made.push(root);
  for (const name of names) {
    await mkdir(join(root, name), { recursive: true });
    const marker = MARKER[name];
    if (marker !== undefined) await writeFile(join(root, name, marker), '', 'utf8');
  }
  return root;
};

describe("where the packager's own resources are", () => {
  it('is beside this package sources when nobody says otherwise', () => {
    /* `src/resources.ts` climbing one level, which is the layout this repository ships and the one
       every caller computed for itself before this module existed. */
    expect(resourceRoot()).toMatch(/packages[/\\]package$/);
  });

  it('is what a caller passed, when one did', async () => {
    const root = await laidOut('assets');
    expect(resourceRoot(root)).toBe(root);
    expect(await resourceDir('assets', root)).toBe(join(root, 'assets'));
  });

  it('resolves a relative root against where the command was typed', () => {
    /* A flag on a command line means a path relative to the shell, not to this module. */
    expect(resourceRoot('somewhere/else')).toBe(join(process.cwd(), 'somewhere', 'else'));
  });

  it('answers each of the three from one root', async () => {
    const root = await laidOut('assets', 'android', 'ios');
    expect(await resourceDir('android', root)).toBe(join(root, 'android'));
    expect(await resourceDir('ios', root)).toBe(join(root, 'ios'));
  });

  it('names a file inside one', async () => {
    const root = await laidOut('assets');
    await writeFile(join(root, 'assets', 'icon.png'), '', 'utf8');
    expect(await resourceFile('assets', 'icon.png', root)).toBe(join(root, 'assets', 'icon.png'));
  });

  /**
   * The failure this replaces. Copied flat, `cp` threw `ENOENT` on a directory nobody would think
   * to look for, before a single artifact existed, naming a path that is not in the project — so
   * the message has to carry both the path it looked in and the thing that moves it.
   */
  it('refuses with the path it looked in and the flag that moves it', async () => {
    const root = await laidOut();
    await expect(resourceDir('assets', root)).rejects.toThrow(join(root, 'assets'));
    await expect(resourceDir('assets', root)).rejects.toThrow(/--resources=/);
    await expect(resourceDir('assets', root)).rejects.toThrow(/assets\/, android\/ and ios\//);
  });

  /**
   * **The failure the configurable root introduced, reported from outside the day after.** A
   * vendored engine puts every package in one directory, one of them is `@driftengine/assets`, and
   * the packager's default root in that layout *is* that directory — so an existence check passes
   * on a package's TypeScript source. Verified: `shell/` came out holding `gltf.ts` and `fbx.ts`
   * and no `splash.html`, with no error at any stage, and the artifact launched with a badge that
   * was a 404 nobody saw.
   *
   * Copied flat with no root given, the old arrangement threw `ENOENT` and stopped. Making the
   * path configurable made its absence quiet in exactly the layout it was written for.
   */
  it("refuses a directory that is correctly named and is somebody else's", async () => {
    const root = await mkdtemp(join(tmpdir(), 'drift-resources-'));
    made.push(root);
    /* What a vendor root holds: the `assets` *package*, whose source has nothing to do with a shell. */
    await mkdir(join(root, 'assets'), { recursive: true });
    await writeFile(join(root, 'assets', 'gltf.ts'), 'export const x = 1;\n', 'utf8');

    await expect(resourceDir('assets', root)).rejects.toThrow(/is not the packager's/);
    await expect(resourceDir('assets', root)).rejects.toThrow(/splash\.html/);
    /* The message has to name the coincidence, because the path and the name both look right. */
    await expect(resourceDir('assets', root)).rejects.toThrow(/@driftengine\/assets/);
    await expect(resourceDir('assets', root)).rejects.toThrow(/no splash and no error/);
  });

  it('identifies each of the three by a file only it has', async () => {
    const root = await mkdtemp(join(tmpdir(), 'drift-resources-'));
    made.push(root);
    for (const name of ['assets', 'android', 'ios']) {
      await mkdir(join(root, name), { recursive: true });
    }
    /* All three present, none of them the packager's. */
    for (const name of ['assets', 'android', 'ios'] as const) {
      await expect(resourceDir(name, root)).rejects.toThrow(/is not the packager's/);
    }
    /* And each marker admits exactly its own directory. */
    await writeFile(join(root, 'ios', 'project.yml'), '', 'utf8');
    await expect(resourceDir('ios', root)).resolves.toBe(join(root, 'ios'));
    await expect(resourceDir('android', root)).rejects.toThrow(/settings\.gradle\.kts/);
  });

  /**
   * The markers are files the packager reads, so this repository's own three must pass — and if a
   * marker is ever renamed, this fails here rather than in somebody's artifact.
   */
  it("admits this repository's own three", async () => {
    await expect(resourceDir('assets')).resolves.toMatch(/package[/\\]assets$/);
    await expect(resourceDir('android')).resolves.toMatch(/package[/\\]android$/);
    await expect(resourceDir('ios')).resolves.toMatch(/package[/\\]ios$/);
  });

  it('refuses per directory, so a root missing one is not read as missing all three', async () => {
    const root = await laidOut('assets');
    await expect(resourceDir('assets', root)).resolves.toContain('assets');
    await expect(resourceDir('android', root)).rejects.toThrow(/`android` directory/);
  });

  it('treats an empty string as unset rather than as the filesystem root', async () => {
    /* A flag typed with nothing after it, or a manifest field left blank. Resolving that against
       the working directory would answer the working directory, which is nobody's intent. */
    expect(resourceRoot('')).toBe(resourceRoot());
  });
});
