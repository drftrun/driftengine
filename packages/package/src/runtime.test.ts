import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { electronRuntimeState } from './runtime.ts';

const home = (): string => mkdtempSync(join(tmpdir(), 'drift-runtime-'));

describe('electronRuntimeState', () => {
  /*
   * **The state this repository was in when this was written**, measured 2026-08-29 with npm
   * 10.9.8 and `npm config get ignore-scripts` answering `false`: `install.js` present, `dist` and
   * `path.txt` absent, and `installedElectronVersion()` answering 43.4.1 against it. That gap is
   * the whole defect — a version resolves, so `build` proceeds, and electron-builder finds nothing
   * to package several steps later.
   */
  it('calls a package with no dist missing, which is what a skipped postinstall leaves', () => {
    const dir = home();
    writeFileSync(join(dir, 'install.js'), '');
    expect(electronRuntimeState(dir)).toBe('missing');
  });

  /*
   * `path.txt` as well as `dist`, because it is what Electron's own resolution reads. A half-
   * finished download can leave the directory and not the file, and a check that looked only at
   * the directory would call that present.
   */
  it('wants path.txt as well as dist', () => {
    const dir = home();
    mkdirSync(join(dir, 'dist'));
    expect(electronRuntimeState(dir)).toBe('missing');
  });

  it('is present only when both are there', () => {
    const dir = home();
    mkdirSync(join(dir, 'dist'));
    writeFileSync(join(dir, 'path.txt'), 'electron');
    expect(electronRuntimeState(dir)).toBe('present');
  });

  it('calls an empty directory missing rather than throwing', () => {
    expect(electronRuntimeState(home())).toBe('missing');
  });
});
