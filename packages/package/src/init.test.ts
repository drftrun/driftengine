import { describe, expect, it } from 'vitest';

import { initFiles } from './init.ts';
import type { PackageManifest } from './manifest.ts';

const manifest: PackageManifest = {
  id: 'dev.example.title',
  name: 'Title',
  entry: 'dist/index.html',
  window: { width: 1280, height: 720, mode: 'windowed', resizable: true },
  backend: { webgpu: 'prefer', allowSoftwareRenderer: false },
  features: { clipExport: false, gamepad: true },
  targets: ['linux-x64', 'win-x64'],
  steam: { appId: null },
  android: { permissions: [], cleartextTraffic: false },
  splash: { show: true, minMs: 1400 },
  publisher: 'example',
  icon: null,
};

const fileFor = (suffix: string): string =>
  initFiles(manifest).find((f) => f.path.endsWith(suffix))?.content ?? '';

describe('initFiles', () => {
  it("writes the two files that have to live in the consumer's repository", () => {
    expect(initFiles(manifest).map((f) => f.path)).toEqual([
      'scripts/build-windows.ps1',
      'scripts/package.mjs',
    ]);
  });

  /*
   * **Windows PowerShell 5.1 reads a BOM-less `.ps1` in the system ANSI codepage, not as UTF-8.**
   * So one typographic character in a comment arrives as mojibake and takes the *parser* with it:
   * an em dash became `a<200><174>` and killed a script with "Unexpected token 'a' in expression
   * or statement", four errors deep, pointing at lines whose content was fine. Nothing on Linux
   * would ever show it, which is why it is asserted rather than trusted.
   */
  it('emits pure ASCII PowerShell', () => {
    const ps1 = fileFor('.ps1');
    expect(ps1).not.toBe('');
    const offenders = [...ps1].filter((c) => c.charCodeAt(0) > 127);
    expect(offenders).toEqual([]);
  });

  /*
   * **`$ErrorActionPreference = 'Stop'` governs cmdlets, not native commands.** `npm` is an
   * external program: a non-zero exit sets `$LASTEXITCODE` and does nothing else. Unchecked, a
   * failing `npm ci` lets the script run on and the reader is left holding a complaint about a
   * missing output directory while the real error has scrolled off. PowerShell 7.3 has
   * `$PSNativeCommandUseErrorActionPreference`; 5.1, which is what a fresh machine runs, does not.
   */
  it('routes every native command through a step that checks $LASTEXITCODE', () => {
    const ps1 = fileFor('.ps1');
    expect(ps1).toContain('function Invoke-Step');
    expect(ps1).toContain('$LASTEXITCODE');
    const bare = ps1
      .split('\n')
      .filter((line) => /^\s*(npm|node)\s/.test(line))
      .filter((line) => !line.includes('Invoke-Step'));
    expect(bare).toEqual([]);
  });

  /* robocopy's exit code is a bitmask: under 8 is success, and 1 means "files were copied", which
     reads as failure to every other tool. */
  it('knows robocopy succeeds with a non-zero exit code', () => {
    const ps1 = fileFor('.ps1');
    expect(ps1).toContain('robocopy');
    expect(ps1).toMatch(/LASTEXITCODE -ge 8/);
  });

  /* Relocating a build off a share and forgetting to bring the artifacts back is a fix that
     creates the next problem: the build succeeds, says so, and out/ in the checkout is empty. */
  it('copies the artifacts back when it relocated the build', () => {
    expect(fileFor('.ps1')).toContain('copying the artifacts back');
  });

  it('names the game, so the script is about their project and not a template', () => {
    expect(fileFor('.ps1')).toContain('Title');
  });

  /*
   * **`spawnSync` does not throw.** A process that never starts leaves `status` at `null` and the
   * reason in `result.error`, so a bare `process.exit(status ?? 1)` turns "I could not launch
   * anything" into "it failed with 1" with nothing above it to read. That is exactly how `npx` on
   * Windows presented — `npx.cmd` is not something `CreateProcess` can launch — and it cost half a
   * day.
   */
  it('emits a wrapper that reads result.error and never launches npx', () => {
    const mjs = fileFor('.mjs');
    expect(mjs).toContain('result.error');
    expect(mjs).toContain('process.execPath');
    expect(mjs).not.toMatch(/spawnSync\(\s*['"`]npx/);
  });

  it('emits a wrapper that reports a signal separately from an exit code', () => {
    expect(fileFor('.mjs')).toContain('result.signal');
  });

  /* A consumer who edits these owns them, and the file says so where they will read it. */
  it('says in both files that the consumer owns them once edited', () => {
    expect(fileFor('.ps1')).toContain('drift-package init');
    expect(fileFor('.mjs')).toContain('drift-package init');
  });
});
