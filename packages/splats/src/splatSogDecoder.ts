/**
 * The ordinary WebP decoder for `.sog` captures, which lives here and not beside the reader.
 *
 * **Its own module because it is the reader's only reason to name `@driftengine/core`**, and that
 * import has two costs worth avoiding: a consumer supplying its own decoder should not pull core
 * through this path, and `scripts/sog-reader.test.mjs` runs under Node's strip-only mode, where an
 * import that resolves through a `node_modules` symlink is refused outright — which is the trap
 * `docs/IMPROVEMENTS.md` records under proving a package from its tarball. The reader itself
 * imports nothing but its own package, so the test loads it and this file stays out of the way.
 */

import { createImageTexelDecoder } from '@driftengine/core';

import type { DecodedImage, WebpDecoder } from './splatSog.ts';

/**
 * The ordinary decoder: `@driftengine/core`'s exact texel read.
 *
 * **A thin forward, and the reason it is not implemented here is worth reading before anybody
 * inlines it.** Every browser API that hands back an image's pixels without a GPU premultiplies
 * on the way through — a 2D canvas by storing premultiplied, WebCodecs by decoding a WebP with
 * alpha to a premultiplied `BGRA` frame — so every RGB value comes back through
 * `round(round(c * a / 255) * 255 / a)`. On the committed fixture that is 3 of 255 out on
 * `sh0.webp`, whose RGB are *codebook indices* and whose alpha is the opacity: an index several
 * entries away wherever a Gaussian is transparent. `createImageTexelDecoder` reads the same file
 * exactly, and it lives in core because it is raw WebGL and `AGENTS.md` allows that only there.
 *
 * A consumer with its own decoder passes it instead; that is what the parameter is for.
 */
export function browserWebpDecoder(): WebpDecoder {
  const decode = createImageTexelDecoder();
  return async (bytes: Uint8Array): Promise<DecodedImage> => decode(bytes, 'image/webp');
}
