/**
 * Which links leave the application, and which are refused outright.
 *
 * **A link to the web opens in the person's own browser.** That is what a packaged application is
 * expected to do — their bookmarks, their session, their extensions, an address bar and a way back
 * — and it is also the safer of the two: a second Electron window is a browser with no address bar
 * that nobody is maintaining, showing a page that can then see how it was opened.
 *
 * **Everything else is refused, and that list is short on purpose.** `shell.openExternal` hands a
 * string to the operating system: `file:` opens whatever it names, and a handler-registered scheme
 * can launch another application with an argument. A page that controls a link would then control
 * that. So three schemes leave — `http`, `https` and `mailto` — and everything else, including the
 * game's own `drift://`, answers null.
 *
 * Pure, so every one of those refusals is a test rather than a comment.
 */
const ALLOWED = new Set(['http:', 'https:', 'mailto:']);

export function externalTarget(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    /* Not a URL at all. A relative link inside the game never reaches here — it resolves against
       drift:// before anything asks — so this is a malformed one, and nothing opens it. */
    return null;
  }
  return ALLOWED.has(parsed.protocol) ? url : null;
}
