/**
 * What the game is allowed to load, and it is deliberately not strict about very much.
 *
 * **The one thing it forbids is a script from somewhere else.** That is the attack this is for: a
 * renderer that fetches a script over `http:` is a renderer whose network can hand it code, and it
 * runs beside a bridge to the filesystem. Everything a game legitimately does — inline module
 * preloads, a WebAssembly module, a blob worker, a texture from a data URL, a socket to its own
 * server — is allowed, because a policy that breaks an ordinary bundle is a policy somebody
 * switches off.
 *
 * **What would make this wrong** is a game that loads code from a CDN, which this refuses. That is
 * the intended refusal and the answer is to bundle it.
 *
 * **Its own module, and tested, because a directive missing one scheme is invisible.** This lived
 * as a constant in `window.ts`, which is Electron lifecycle and is not unit-tested — and it shipped
 * allowing `wss:` without `ws:`, so a packaged game could not reach a relay on its own network. The
 * shape of that failure is what makes it worth a test rather than a careful read: Chromium blocks
 * the connection before a packet leaves, so the relay logs nothing and the game reports only that
 * it did not connect. The two together point at the network. Seeing the actual line took a remote
 * debugging session against the packaged binary, and a packaged build has no developer tools.
 */
const DIRECTIVES = [
  "default-src 'self' drift: blob: data:",
  "script-src 'self' drift: blob: 'unsafe-inline' 'wasm-unsafe-eval'",
  "style-src 'self' drift: 'unsafe-inline'",
  "img-src 'self' drift: blob: data: https:",
  "media-src 'self' drift: blob: data: https:",
  "font-src 'self' drift: data: https:",
  "worker-src 'self' drift: blob:",
  /*
   * **`ws:` beside `wss:`, because a relay on a local network cannot hold a certificate.**
   *
   * `ws://192.168.1.20:8787` is the ordinary case for a desktop game with its own server, and no
   * certificate authority issues for a private address — so the secure scheme is not an
   * alternative there, it is a refusal. A public relay needs `wss:` regardless and is unaffected.
   *
   * **What this widens, stated rather than waved past.** Reaching an arbitrary host was already
   * permitted: `https:` and `wss:` are both open, so a compromised asset could already talk to a
   * server of its choosing. What `ws:` adds is plaintext, which is the developer's own choice about
   * their own traffic, and sockets to services on the machine itself, which `http:` being absent
   * still denies to everything else. Neither is the attack `script-src` is here for.
   *
   * **A manifest field was the other option and is not taken.** `drift.package.json` says nothing
   * about the policy today, and the first thing it said should not be a security surface a consumer
   * has to get right — particularly when the value it would carry is the one this line now has.
   */
  "connect-src 'self' drift: blob: data: https: wss: ws:",
];

/** The header value, as one string. */
export const CSP = DIRECTIVES.join('; ');

/** The source list for one directive, or an empty array when the policy does not carry it. */
export function sourcesFor(directive: string): readonly string[] {
  const found = DIRECTIVES.find((entry) => entry.startsWith(`${directive} `));
  return found === undefined ? [] : found.slice(directive.length + 1).split(' ');
}
