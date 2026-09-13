/**
 * Does a `.sog` capture survive the browser's own WebP decoder?
 *
 * **The half `scripts/sog-reader.test.mjs` cannot reach.** That test supplies texels Pillow
 * produced, because Node has no WebP decoder and this engine will not vendor one — so
 * `browserWebpDecoder`, which is the function every consumer actually calls, is untested code
 * there. This runs it, against the same committed bundle, and asserts the same bounds.
 *
 * **The bounds are the quantiser's own resolution rather than numbers chosen to pass**: sixteen
 * bits over the capture's span for position, 256-entry codebooks for scale and colour, and eight
 * bits for opacity — where 1/255 is exactly one step and nothing can do better.
 *
 * It is not a `*.test.mjs` and `npm run test:scripts` does not pick it up: it needs a dev server
 * and a browser, which is the same reason `medium-check.mjs` is run by hand.
 *
 *     (setsid npx vite demo/dev --port 5202 > /tmp/vite.log 2>&1 < /dev/null &) ; sleep 9
 *     node scripts/sog-check.mjs --base=http://localhost:5202
 */
import { launch } from '../packages/core/scripts/browser.mjs';
import { connect } from '../packages/core/scripts/cdp.mjs';

function argOf(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
}

const base = argOf('base', 'http://localhost:5202').replace(/\/$/, '');

const browser = await launch();
const client = await connect(browser.port);
const page = await client.page(`${base}/sog.html`, 1000, 700);
await page.settled('globalThis.__drawn', { settleMs: 1500 });
const result = JSON.parse(await page.eval('JSON.stringify(globalThis.__sogCheck ?? null)'));
const error = await page.eval('document.getElementById("error").textContent');
/*
 * The favicon, which every page in demo/dev answers with a 404 and none of them owns — and the
 * driver's own performance notes, which are not complaints about this page.
 *
 * **`GPU stall due to ReadPixels` is the decoder working as designed**, not a fault: reading a
 * texture back synchronises the pipeline once per image, which is the price of the only browser
 * route that does not premultiply. It happens at load, five times for this capture, and
 * `imageTexels.ts` states it where the trade is made. Filtering it here rather than widening the
 * bound, so an actual error still fails this check.
 */
const complaints = page
  .complaints()
  .filter((line) => !line.includes('404') && !line.includes('GL Driver Message'));
await page.close?.();
await browser.close?.();

let failed = 0;
function check(name, ok, detail) {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${detail}`);
}

console.log('');
check(
  'the page ran without complaint',
  complaints.length === 0 && error === '',
  [...complaints, error].join(' | ') || 'clean',
);
if (result === null) {
  console.log('FAIL  the page produced no result: nothing to read');
  process.exit(1);
}

check(
  'the bundle unpacks to a manifest and five images',
  result.entries.length === 6 && result.entries.includes('meta.json'),
  result.entries.join(', '),
);
/*
 * One to one: sixty-four distinct Gaussians, not one matched sixty-four times, which is what a
 * decode that returned a constant would produce and would otherwise clear every bound below.
 */
check(
  'every Gaussian comes back, matched one to one',
  result.count === result.expected && result.matched === result.expected,
  `${result.count} read, ${result.matched} of ${result.expected} matched`,
);
check(
  "the browser decodes positions to the quantiser's own resolution",
  result.worst.position < 1e-3,
  `${result.worst.position.toExponential(2)} m worst over a four-metre cloud`,
);
/*
 * **The decoder against a reference decode of the same bytes**, which is the check that found what
 * a 2d canvas does to these images: it stores colour premultiplied, so every RGB value round-trips
 * through `round(c * a) / a` and lands several codebook entries away wherever a Gaussian is
 * transparent. Through a canvas this read 3 of 255; through `ImageDecoder` it is 0.
 *
 * Exact, not close. A lossless WebP has one right answer and two decoders that disagree about it
 * are not both right.
 */
check(
  'the browser decodes the images to the same texels a reference decoder does',
  result.worstTexel === 0,
  `worst channel off by ${result.worstTexel} of 255${result.worstTexelIn ? ` in ${result.worstTexelIn}` : ''}`,
);
check(
  'scale and colour survive their codebooks',
  result.worst.scale < 0.01 && result.worst.colour < 0.005,
  `${(result.worst.scale * 100).toFixed(3)}% relative on scale, ${result.worst.colour.toExponential(2)} on colour`,
);
/*
 * **Opacity is where a premultiplying decode shows**, and it is the reason `browserWebpDecoder`
 * asks for `premultiplyAlpha: 'none'`. `sh0.webp` carries three codebook *indices* in RGB and the
 * opacity in alpha; a decoder that premultiplied would scale the indices by the opacity and hand
 * back a capture whose colours dim with its own transparency — which reads as a moody capture
 * rather than as a decode error.
 */
check(
  'opacity is within one eight-bit step',
  result.worst.opacity <= 1 / 255 + 1e-6,
  `${result.worst.opacity.toExponential(2)} against a step of ${(1 / 255).toExponential(2)}`,
);
check(
  'the rotation is the same rotation',
  result.worst.rotation < 1e-3,
  `${result.worst.rotation.toExponential(2)} of 1 - |dot|`,
);
check(
  'no spherical harmonics are invented where the capture carries none',
  result.sh1 === false,
  result.sh1 ? 'a band was produced' : 'none, as the manifest says',
);

console.log(
  failed === 0
    ? "\nthe reader holds against the browser's own decoder"
    : `\n${failed} check(s) failed`,
);
process.exit(failed === 0 ? 0 : 1);
