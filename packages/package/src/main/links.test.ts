import { describe, expect, it } from 'vitest';

import { externalTarget } from './links.ts';

describe('externalTarget', () => {
  /*
   * A link to the outside opens in the person's own browser, with their bookmarks, their session
   * and their extensions — not in a second window of the game that has no address bar and no way
   * back. That is what every packaged application is expected to do, and it is also the safer
   * behaviour: an in-app window is a browser nobody is maintaining.
   */
  it('sends the web to the browser', () => {
    expect(externalTarget('https://driftengine.dev/docs')).toBe('https://driftengine.dev/docs');
    expect(externalTarget('http://localhost:5173/')).toBe('http://localhost:5173/');
    expect(externalTarget('mailto:hello@example.com')).toBe('mailto:hello@example.com');
  });

  /* The game's own pages are the game. Sending those out would open the shell in a browser. */
  it('keeps the application to itself', () => {
    expect(externalTarget('drift://app/index.html')).toBeNull();
    expect(externalTarget('drift://shell/splash.html')).toBeNull();
  });

  /*
   * **The refusals are the point of the function.** `shell.openExternal` hands a string to the
   * operating system, and a `file:` URL opens whatever it names — so a page that can control a
   * link can open a document, a script or a network share. Only three schemes leave here.
   */
  it('refuses schemes that would hand the operating system a file or a command', () => {
    expect(externalTarget('file:///etc/passwd')).toBeNull();
    expect(externalTarget('javascript:alert(1)')).toBeNull();
    expect(externalTarget('smb://server/share')).toBeNull();
    expect(externalTarget('vscode://file/etc/passwd')).toBeNull();
    expect(externalTarget('not a url at all')).toBeNull();
  });
});
