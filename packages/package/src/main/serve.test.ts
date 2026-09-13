import { describe, expect, it } from 'vitest';

import { contentTypeFor, resolveWithinRoot } from './serve.ts';

describe('resolveWithinRoot', () => {
  it('resolves an ordinary path inside the root', () => {
    expect(resolveWithinRoot('/app', '/index.html')).toBe('/app/index.html');
  });

  it('resolves a nested path', () => {
    expect(resolveWithinRoot('/app', '/assets/world.drft')).toBe('/app/assets/world.drft');
  });

  /*
   * The renderer is sandboxed and has no Node. The one filesystem surface it can reach is this
   * scheme, so a traversal here hands it the whole disk.
   */
  it('refuses a path that climbs out of the root', () => {
    expect(resolveWithinRoot('/app', '/../etc/passwd')).toBeNull();
  });

  it('refuses a climb hidden in the middle of a path', () => {
    expect(resolveWithinRoot('/app', '/assets/../../etc/passwd')).toBeNull();
  });

  /*
   * A prefix match on the string alone would accept this: "/app-secrets" starts with "/app".
   * The separator is what makes the check a directory check rather than a string check.
   */
  it('refuses a sibling directory whose name starts with the root', () => {
    expect(resolveWithinRoot('/app', '/../app-secrets/keys.txt')).toBeNull();
  });
});

/**
 * The type a file is served as, which decides whether the browser will use it at all.
 *
 * **Found in production, on the shell's own badge.** An `<img>` refuses an SVG served as
 * `application/octet-stream`, so the splash showed a broken-image icon in a packaged build while
 * rendering perfectly from a dev server that got the type right. Nothing in the build could see
 * it: the file was there, the request was a 200, and the picture was a broken icon.
 */
describe('contentTypeFor', () => {
  it('serves an SVG as an image, which is what makes it render at all', () => {
    expect(contentTypeFor('/shell/lockup.svg')).toBe('image/svg+xml');
  });

  it('serves the types a module loader is strict about', () => {
    expect(contentTypeFor('/app/index.html')).toMatch(/^text\/html/);
    expect(contentTypeFor('/app/main.js')).toMatch(/^text\/javascript/);
    expect(contentTypeFor('/app/main.mjs')).toMatch(/^text\/javascript/);
    expect(contentTypeFor('/app/physics.wasm')).toBe('application/wasm');
  });

  /* The container and every asset: octet-stream is correct for these rather than a fallback. */
  it('serves anything it does not recognise as bytes', () => {
    expect(contentTypeFor('/app/day-23.drft')).toBe('application/octet-stream');
    expect(contentTypeFor('/app/noextension')).toBe('application/octet-stream');
  });

  it('is not fooled by a capital letter or a dot in a directory name', () => {
    expect(contentTypeFor('/app/UI/Logo.SVG')).toBe('image/svg+xml');
    expect(contentTypeFor('/app/v1.2/index.html')).toMatch(/^text\/html/);
  });
});
