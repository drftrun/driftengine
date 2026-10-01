/**
 * The faces the reference's pictures draw their words in, fetched once and kept in the data folder.
 *
 * **B612 (SIL Open Font Licence) in its two weights, from Google Fonts**, which is where the spec
 * says it comes from and is the licence decision this bake takes: nothing is vendored, and the
 * files live beside the other derived data, never in the tree. **One katakana glyph B612 cannot
 * draw falls back to Noto Sans JP**, subset by Google to exactly the characters asked for, and is
 * declared as more of the B612 family under a katakana unicode range, so the picture that uses it
 * needs no edit.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Face {
  readonly family: string;
  readonly weight: number;
  readonly unicodeRange: string | null;
  /** The woff2 bytes. */
  readonly bytes: Uint8Array;
}

/** A browser's own, so the service answers with woff2 rather than a format for an older one. */
const AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';

const SOURCES: readonly { family: string; query: string; range: string | null }[] = [
  { family: 'B612', query: 'family=B612:wght@400;700', range: null },
  {
    family: 'B612',
    query: `family=Noto+Sans+JP:wght@400;700&text=${encodeURIComponent('カ')}`,
    range: 'U+30A0-30FF',
  },
];

async function fetched(url: string): Promise<Response> {
  const response = await fetch(url, { headers: { 'user-agent': AGENT } });
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  return response;
}

/** Every face, from `dir` where it was fetched before and from the service where it was not. */
export async function ensureFaces(dir: string): Promise<Face[]> {
  mkdirSync(dir, { recursive: true });
  const faces: Face[] = [];
  for (const [index, source] of SOURCES.entries()) {
    for (const weight of [400, 700]) {
      const file = join(dir, `${source.family}-${index}-${weight}.woff2`);
      if (!existsSync(file)) {
        const css = await (
          await fetched(`https://fonts.googleapis.com/css2?${source.query}`)
        ).text();
        const block = css.split('@font-face').find((b) => b.includes(`font-weight: ${weight}`));
        const url = block?.match(/src:\s*url\(([^)]+)\)/)?.[1];
        if (url === undefined) throw new Error(`no ${weight} face in ${source.query}`);
        writeFileSync(file, new Uint8Array(await (await fetched(url)).arrayBuffer()));
      }
      faces.push({
        family: source.family,
        weight,
        unicodeRange: source.range,
        bytes: readFileSync(file),
      });
    }
  }
  return faces;
}

/** The faces as CSS a picture carries inside itself: an SVG drawn as an image may fetch nothing. */
export function faceRules(faces: readonly Face[]): string {
  return faces
    .map(
      (f) =>
        `@font-face{font-family:'${f.family}';font-weight:${f.weight};` +
        `src:url(data:font/woff2;base64,${Buffer.from(f.bytes).toString('base64')}) format('woff2');` +
        (f.unicodeRange === null ? '' : `unicode-range:${f.unicodeRange};`) +
        '}',
    )
    .join('');
}
