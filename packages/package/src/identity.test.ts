import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { refuseLyingFilesystem, sameIdentity } from './identity.ts';

const stat = (dev: bigint, ino: bigint): { dev: bigint; ino: bigint } => ({ dev, ino });

describe('sameIdentity', () => {
  /*
   * Node's own `areIdentical`, and the two zeros are excluded there as here: a filesystem that
   * hands out no index answers 0, and Node declines to believe it.
   */
  it('is true only when both fields agree and neither is zero', () => {
    expect(sameIdentity(stat(66313n, 1n), stat(66313n, 1n))).toBe(true);
    expect(sameIdentity(stat(66313n, 1n), stat(66313n, 2n))).toBe(false);
    expect(sameIdentity(stat(1n, 5n), stat(2n, 5n))).toBe(false);
    expect(sameIdentity(stat(0n, 0n), stat(0n, 0n))).toBe(false);
    expect(sameIdentity(stat(66313n, 0n), stat(66313n, 0n))).toBe(false);
  });

  /*
   * **The measured case**, reported from a Windows VM building over a share: a file and a directory
   * answering one identity. A redirector that gets no file index from the server invents a constant
   * one, and on Windows `dev` is already the volume serial number — the same for the whole drive.
   * Two equal fields, and Node refuses a copy that is perfectly legitimate.
   */
  it('catches a file and a directory sharing one identity', () => {
    const both = stat(66313n, -112686486700016n);
    expect(sameIdentity(both, stat(66313n, -112686486700016n))).toBe(true);
  });

  /*
   * **`bigint` and not `Number`, which is the reason this takes bigints at all.** A Windows file
   * index is 64 bits and loses precision as a double exactly in the high half where these values
   * live, so two different indices could arrive equal — the check would be wrong in both
   * directions on precisely the platform it exists for. These two differ only below the 53-bit
   * boundary.
   */
  it('separates two indices a double would round together', () => {
    const a = stat(66313n, 9007199254740993n);
    const b = stat(66313n, 9007199254740992n);
    expect(Number(a.ino) === Number(b.ino)).toBe(true);
    expect(sameIdentity(a, b)).toBe(false);
  });
});

describe('refuseLyingFilesystem', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'drift-identity-'));
  writeFileSync(join(cwd, 'drift.package.json'), '{}');

  /* An honest filesystem: every path is its own thing, and a build is not interrupted. */
  it('says nothing when a file and a directory differ', () => {
    let next = 1n;
    expect(() =>
      refuseLyingFilesystem(cwd, undefined, () => ({ dev: 9n, ino: next++ })),
    ).not.toThrow();
  });

  /*
   * The refusal itself, which is the whole point of the function and which no filesystem this
   * suite can create would trigger. It names both stats and it names the flag first.
   */
  it('refuses when they share one identity, naming the stats and the flag', () => {
    const lying = (): { dev: bigint; ino: bigint } => ({ dev: 66313n, ino: -112686486700016n });
    expect(() => refuseLyingFilesystem(cwd, undefined, lying)).toThrow(/same identity/);
    expect(() => refuseLyingFilesystem(cwd, undefined, lying)).toThrow(/--out=/);
    expect(() => refuseLyingFilesystem(cwd, undefined, lying)).toThrow(/dev=66313/);
  });

  /* Output already sent off this volume: what it says about itself no longer decides a copy. */
  it('stays quiet once --out points somewhere else', () => {
    const lying = (): { dev: bigint; ino: bigint } => ({ dev: 66313n, ino: 7n });
    expect(() => refuseLyingFilesystem(cwd, '/somewhere/else', lying)).not.toThrow();
  });

  /* No manifest, nothing to package: this is not the place to complain about that. */
  it('says nothing where there is no manifest', () => {
    const empty = mkdtempSync(join(tmpdir(), 'drift-identity-empty-'));
    expect(() =>
      refuseLyingFilesystem(empty, undefined, () => ({ dev: 1n, ino: 1n })),
    ).not.toThrow();
  });
});
