import { describe, expect, it } from 'vitest';

import { missingReferences } from './assetCheck.ts';

describe('missingReferences', () => {
  /*
   * **The bug this exists for.** A game built by Vite references `/assets/index-abc.js` — absolute,
   * from the site root. Serve that game from a subdirectory and every one of those resolves to
   * nothing: the HTML loads, the CSS and the script do not, and what a player sees is an unstyled
   * page with the words still on it. Nothing fails: the request 404s where no console is open.
   */
  it('names an absolute reference that is not under the root', () => {
    const html = '<script src="/assets/index-abc.js"></script><link href="/assets/main.css">';
    const present = new Set(['index.html']);
    expect(missingReferences(html, present)).toEqual(['/assets/index-abc.js', '/assets/main.css']);
  });

  it('is satisfied when the files are where the references point', () => {
    const html = '<script src="/assets/index-abc.js"></script>';
    const present = new Set(['index.html', 'assets/index-abc.js']);
    expect(missingReferences(html, present)).toEqual([]);
  });

  it('takes relative references as satisfied by their own resolution', () => {
    const html = '<script src="./main.js"></script><link href="style.css">';
    expect(missingReferences(html, new Set(['index.html']))).toEqual([]);
  });

  /* Anything with a scheme is somebody else's server, and not this check's business. */
  it('ignores what is not served from here', () => {
    const html =
      '<a href="https://example.com/x">x</a><img src="data:image/png;base64,AAAA">' +
      '<link href="//cdn.example.com/a.css">';
    expect(missingReferences(html, new Set(['index.html']))).toEqual([]);
  });

  /* A query string and a fragment are not part of the file name on disk. */
  it('looks past a query string', () => {
    const html = '<script src="/main.js?v=2"></script>';
    expect(missingReferences(html, new Set(['main.js']))).toEqual([]);
  });
});
