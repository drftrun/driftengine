/**
 * Whether a page's own references land on files that are actually there.
 *
 * **This exists because of a failure with no error in it.** A game built by Vite references
 * `/assets/index-abc.js` — absolute, from the site root. Host that game from a subdirectory and
 * every such reference resolves to nothing: the HTML loads and the CSS and the script do not, so
 * the page appears as unstyled text with no console open to say why. Measured on a real APK, which
 * installed, launched, and showed a title in Times New Roman.
 *
 * Checked at build time rather than trusted, because the alternative is finding out from a phone.
 */
const REFERENCE = /(?:src|href)\s*=\s*"([^"]+)"/g;

export function missingReferences(html: string, present: ReadonlySet<string>): string[] {
  const missing: string[] = [];
  for (const [, raw] of html.matchAll(REFERENCE)) {
    if (raw === undefined) continue;
    /* Anything with a scheme, a protocol-relative host, or a fragment belongs to somebody else. */
    if (!raw.startsWith('/') || raw.startsWith('//')) continue;
    const path = raw.slice(1).split(/[?#]/)[0] ?? '';
    if (path.length === 0) continue;
    if (!present.has(path)) missing.push(raw);
  }
  return missing;
}
