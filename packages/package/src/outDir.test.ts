import { join, resolve, win32 } from 'node:path';
import { describe, expect, it } from 'vitest';

import { outFor } from './outDir.ts';

describe('outFor', () => {
  it('puts output under the project when nothing says otherwise', () => {
    expect(outFor('/p', 'win-x64', {})).toBe(join('/p', 'out', 'win-x64'));
  });

  /* The whole point of the flag: an absolute --out escapes the project's filesystem entirely,
     which is what a share that misreports file identity needs. */
  it('honours an absolute --out and keeps the per-target layout', () => {
    expect(outFor('/p', 'win-x64', { outRoot: '/drift-out' })).toBe(join('/drift-out', 'win-x64'));
  });

  /*
   * **Resolved against the invoking directory and deliberately not against `--project=`.** Those
   * two differ exactly when this flag matters — a tool run from somewhere other than the project —
   * and resolving against the project would put the output back inside the thing the flag exists
   * to escape.
   */
  it('resolves a relative --out against the invoking directory, not the project', () => {
    expect(outFor('/somewhere/else', 'linux-x64', { outRoot: 'build' })).toBe(
      join(resolve(process.cwd(), 'build'), 'linux-x64'),
    );
  });

  /*
   * **The case the flag exists for, and the suite does not run on the platform it happens on.**
   * A Windows VM building from a share is the whole reason `--out=` was asked for, and on Linux
   * `C:\\drift-out` is a *relative* path, so `outFor` cannot be driven through that case here.
   *
   * What it rests on is one platform fact: that `resolve` treats a drive-letter path as absolute
   * and `join` keeps it that way. Asserted directly, against the exact example the packager's
   * README prints, so a Node that changed it would fail here instead of on somebody's VM twenty
   * minutes into a build.
   */
  it('puts a Windows build where the README says it does, on Windows', () => {
    const root = win32.resolve('C:\\src\\project', 'C:\\drift-out');
    expect(root).toBe('C:\\drift-out');
    expect(win32.join(root, 'win-x64')).toBe('C:\\drift-out\\win-x64');
    expect(win32.join(win32.join(root, 'win-x64'), 'stage')).toBe('C:\\drift-out\\win-x64\\stage');
  });

  /* And a relative one there resolves the same way it does here: against the invoking directory. */
  it('resolves a relative --out against the invoking directory on Windows too', () => {
    expect(win32.join(win32.resolve('C:\\somewhere', 'build'), 'win-x64')).toBe(
      'C:\\somewhere\\build\\win-x64',
    );
  });

  /* Every target keeps its own directory under the root, so nothing that reads `out/<target>/…`
     has to learn a second layout. */
  it('gives every target its own directory under the root', () => {
    expect(outFor('/p', 'mac-arm64', { outRoot: '/o' })).toBe(join('/o', 'mac-arm64'));
    expect(outFor('/p', 'android', { outRoot: '/o' })).toBe(join('/o', 'android'));
  });
});
