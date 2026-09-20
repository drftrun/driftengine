import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterAll, describe, expect, test } from 'vitest';

import { hostFetch } from './files.ts';

/**
 * **What this file is for: the page's own files, answered from disk.** A published scene fetches by
 * a path relative to the page — the showroom's `car.drft`, the voxel sandbox's `voxelpack/` tiles —
 * and a page resolves that against the server that sent it. A host has no server, so it answers
 * those paths from the directory the dev server serves, and hands anything with a scheme of its own
 * to the platform's fetch.
 */

const root = mkdtempSync(join(tmpdir(), 'driftengine-host-files-'));
mkdirSync(join(root, 'voxelpack'));
writeFileSync(join(root, 'car.drft'), Buffer.from([1, 2, 3, 4]));
writeFileSync(join(root, 'voxelpack', 'grass.png'), Buffer.from([9, 8, 7]));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const refused: string[] = [];
const fetch = hostFetch(root, (input) => {
  refused.push(String(input));
  return Promise.resolve(new Response('from the network'));
});

describe('the files a page fetches, under a host', () => {
  test('A PATH RELATIVE TO THE PAGE IS READ FROM THE SERVED DIRECTORY', async () => {
    const response = await fetch('car.drft');
    expect(response.ok).toBe(true);
    expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual([1, 2, 3, 4]);
    const tile = await fetch('voxelpack/grass.png');
    expect(Array.from(new Uint8Array(await tile.arrayBuffer()))).toEqual([9, 8, 7]);
    /* Rooted at the page's own root, as a page's `/car.drft` is. */
    expect((await fetch('/car.drft')).ok).toBe(true);
  });

  test('A FILE URL IS READ AS IT IS, which is what `new URL(x, import.meta.url)` makes', async () => {
    const response = await fetch(pathToFileURL(join(root, 'car.drft')).href);
    expect(response.ok).toBe(true);
    expect((await response.arrayBuffer()).byteLength).toBe(4);
  });

  test('A MISSING FILE IS A 404, which the scenes already expect of a server', async () => {
    const response = await fetch('voxelpack/missing.png');
    expect(response.ok).toBe(false);
    expect(response.status).toBe(404);
  });

  test('HEAD ANSWERS WHETHER IT IS THERE, and carries no body', async () => {
    const there = await fetch('car.drft', { method: 'HEAD' });
    expect(there.ok).toBe(true);
    expect((await there.arrayBuffer()).byteLength).toBe(0);
    expect((await fetch('nothing.drft', { method: 'HEAD' })).status).toBe(404);
  });

  test('A PATH THAT CLIMBS OUT OF THE SERVED DIRECTORY IS REFUSED, as a server would', async () => {
    expect((await fetch('../../etc/passwd')).status).toBe(404);
  });

  test('ANYTHING WITH A SCHEME OF ITS OWN GOES TO THE PLATFORM', async () => {
    const response = await fetch('https://example.invalid/asset');
    expect(await response.text()).toBe('from the network');
    expect(refused).toEqual(['https://example.invalid/asset']);
  });
});
