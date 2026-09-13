import { join, normalize, sep } from 'node:path';

/**
 * A path inside the packaged application, or null when it is not inside it.
 *
 * **Separate from the protocol handler so it can be tested at all.** This is the only part of the
 * main process with a security consequence: the renderer runs with `nodeIntegration: false` and
 * `sandbox: true`, so `drift://` is the single filesystem surface it can reach, and a traversal
 * through it hands a compromised renderer the disk.
 *
 * The separator in the comparison is load-bearing. A plain `startsWith(root)` accepts
 * `/app-secrets` for a root of `/app`, which is a sibling directory rather than a child.
 */
export function resolveWithinRoot(root: string, pathname: string): string | null {
  const resolved = normalize(join(root, pathname));
  if (resolved === root) return resolved;
  return resolved.startsWith(root + sep) ? resolved : null;
}

/**
 * A content type, from the extension, for the handful a game serves.
 *
 * **A wrong one is not cosmetic here.** A module served as `text/plain` is refused by the module
 * loader with a message about MIME type, and a `.wasm` served as anything but
 * `application/wasm` cannot be streamed-compiled. Everything unrecognised is
 * `application/octet-stream`, which is correct for the container and for every asset.
 */
export function contentTypeFor(path: string): string {
  const dot = path.lastIndexOf('.');
  switch (dot === -1 ? '' : path.slice(dot + 1).toLowerCase()) {
    case 'html':
      return 'text/html; charset=utf-8';
    case 'js':
    case 'mjs':
      return 'text/javascript; charset=utf-8';
    case 'css':
      return 'text/css; charset=utf-8';
    case 'json':
      return 'application/json; charset=utf-8';
    case 'wasm':
      return 'application/wasm';
    case 'svg':
      /* An `<img>` refuses an SVG served as anything else, and the shell's own badge is one:
         the splash showed a broken-image icon until this case existed. */
      return 'image/svg+xml';
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'webp':
      return 'image/webp';
    case 'gif':
      return 'image/gif';
    case 'ico':
      return 'image/x-icon';
    case 'txt':
      return 'text/plain; charset=utf-8';
    case 'ktx2':
      return 'image/ktx2';
    case 'ogg':
      return 'audio/ogg';
    case 'mp3':
      return 'audio/mpeg';
    case 'wav':
      return 'audio/wav';
    default:
      return 'application/octet-stream';
  }
}
