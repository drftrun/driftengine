/**
 * The page's own files, answered from disk: the `fetch` a scene calls, under a host.
 *
 * **A published scene fetches by a path relative to its page**: the showroom's model, the voxel
 * sandbox's tiles. A browser resolves that against the server that sent the page, and a host has no
 * server — so it answers those paths from the directory the dev server serves (`demo/dev/public`),
 * and a `file:` URL, which is what `new URL(path, import.meta.url)` makes, as the file it names.
 * Anything carrying a scheme of its own is the network's, and goes to the platform's `fetch`.
 *
 * **A missing file is a 404, not a throw**, because that is what the scenes already handle: the
 * sandbox paints a missing tile magenta, and the showroom asks with `HEAD` whether a model is there.
 * A path that climbs out of the served directory is a 404 too, as it would be from a server.
 */

import { readFile, stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const TYPES: Record<string, string> = {
  png: 'image/png',
  json: 'application/json',
  drft: 'application/octet-stream',
};

function typeOf(path: string): string {
  return TYPES[path.slice(path.lastIndexOf('.') + 1).toLowerCase()] ?? 'application/octet-stream';
}

/** The file a request names, or null where it is the network's or outside what is served. */
function pathOf(root: string, url: string): string | null {
  if (url.startsWith('file:')) return fileURLToPath(url);
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return null;
  const clean = url.split(/[?#]/)[0] ?? '';
  const path = resolve(root, `.${clean.startsWith('/') ? '' : '/'}${clean}`);
  const inside = path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
  return inside ? path : '';
}

export function hostFetch(root: string, network: Fetch): Fetch {
  const served = resolve(root);
  return async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = (
      init?.method ?? (input instanceof Request ? input.method : 'GET')
    ).toUpperCase();
    const path = pathOf(served, url);
    if (path === null) return network(input, init);
    if (path === '') return new Response(null, { status: 404 });
    try {
      const found = await stat(path);
      if (!found.isFile()) return new Response(null, { status: 404 });
      const headers = { 'content-type': typeOf(path), 'content-length': String(found.size) };
      if (method === 'HEAD') return new Response(null, { status: 200, headers });
      return new Response(await readFile(path), { status: 200, headers });
    } catch {
      return new Response(null, { status: 404 });
    }
  };
}
