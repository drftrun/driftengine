import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { PackageManifest } from './manifest.ts';
import { stageApp } from './stage.ts';

/**
 * **The refusal belongs to the copy, not to the command that usually comes before it.**
 *
 * `doctor` refuses a filesystem that gives a file and a directory one identity, and does it earlier,
 * which is right for a person's time. But that is a guarantee about the order of two calls, and this
 * package's `exports` map is `"./*": "./*"` — so `stageApp` is importable directly and a route that
 * skips `doctor` gets `cp` explaining itself in terms of subdirectories of itself, ten minutes into
 * a build. Two consumers wrote the same check in their own launchers rather than receive this one.
 */
describe('staging on a filesystem that misreports identity', () => {
  const MANIFEST: PackageManifest = {
    id: 'dev.example.title',
    name: 'Title',
    entry: 'dist/index.html',
    window: { width: 1280, height: 720, mode: 'windowed', resizable: true },
    backend: { webgpu: 'prefer', allowSoftwareRenderer: false },
    features: { clipExport: false, gamepad: true },
    targets: ['linux-x64'],
    steam: { appId: null },
    splash: { show: true, minMs: 1400 },
    publisher: 'example',
    icon: null,
  };

  /** A project directory with a manifest file in it, which is what the check looks at. */
  function project(): string {
    const dir = mkdtempSync(join(tmpdir(), 'stage-'));
    writeFileSync(join(dir, 'drift.package.json'), JSON.stringify(MANIFEST));
    return dir;
  }

  /** What a share answers: one identity for every path on it. */
  const oneIdentity = () => ({ dev: 66313n, ino: -46694802482992n });

  it('refuses with a sentence about the filesystem, not about subdirectories of itself', async () => {
    const dir = project();
    await expect(
      stageApp(MANIFEST, dir, join(dir, 'out', 'linux-x64', 'stage'), {
        development: false,
        look: oneIdentity,
      }),
    ).rejects.toThrow(/gives a file and a directory the same identity/);
  });

  /*
   * **And it refuses before deleting anything.** Staging begins by removing the previous stage
   * directory, so a check that ran after it would cost a build its last good output to tell it the
   * build could never have worked.
   */
  it('does not delete the previous stage on the way to refusing', async () => {
    const dir = project();
    const stageDir = join(dir, 'out', 'linux-x64', 'stage');
    mkdirSync(stageDir, { recursive: true });
    writeFileSync(join(stageDir, 'main.cjs'), 'the previous build');
    await expect(
      stageApp(MANIFEST, dir, stageDir, { development: false, look: oneIdentity }),
    ).rejects.toThrow(/identity/);
    expect(existsSync(join(stageDir, 'main.cjs'))).toBe(true);
    expect(readFileSync(join(stageDir, 'main.cjs'), 'utf8')).toBe('the previous build');
  });

  /** On a filesystem that answers honestly it is not this that stops a build. */
  it('does not refuse a filesystem that tells the truth', async () => {
    const dir = project();
    let n = 0n;
    const honest = () => ({ dev: 66313n, ino: (n += 1n) });
    const outcome = await stageApp(MANIFEST, dir, join(dir, 'out', 'linux-x64', 'stage'), {
      development: false,
      look: honest,
    }).then(
      () => 'staged',
      (error: unknown) => String(error),
    );
    expect(outcome).not.toMatch(/same identity/);
  });
});
