/**
 * Does each batch in a frame draw with its own uniforms, in the four passes that share a slot?
 *
 * **`drawBolts`, `drawFlock`, `drawWindStreaks` and `drawCaustics` write their per-draw uniforms
 * into one shared buffer with `queue.writeBuffer`, then record a draw.** Queue writes are ordered
 * on the queue timeline and the frame's encoder is submitted after all of them, so the *last*
 * write reaches every draw: two batches of any of these come out wearing the second one's colour,
 * width, time and placement. Water had exactly this and lost three bodies of four, 387,837 pixels
 * of a 921,600-pixel frame. One batch of each is correct, which is why nothing has ever shown it.
 *
 * **The assertion is colour presence, not a pixel identity, and that is forced by the four blend
 * modes.** Bolts add (`src-alpha`, `one`) and caustics add (`one`, `one`), so an additive identity
 * would work for those two — but a flock is opaque and writes depth, and wind streaks are alpha
 * blended and therefore order-dependent, and no arithmetic identity survives either. What survives
 * all four is that a frame drawing both batches must contain *both* signatures. Under the defect
 * the first batch wears the second's tint and its own signature vanishes completely.
 *
 * So `batches.html` tints batch 0 red and batch 1 blue, and this counts channel-dominant pixels.
 *
 * **Every claim has its control.** A signature count means nothing unless the solo captures show
 * that each batch can produce its own and does not produce the other's — a page where batch 0
 * landed off screen would otherwise pass every assertion here by drawing nothing.
 *
 * It is not a `*.test.mjs` and `npm run test:scripts` does not pick it up, deliberately: it needs a
 * dev server and a real GPU, which is the same reason `shots.mjs` is run by hand.
 *
 *     npx vite demo/dev --port 5202 &
 *     node scripts/batch-uniforms-check.mjs --base=http://localhost:5202
 *
 * **Both backends, every run, and WebGL2 printed first** — the 2026-08-23 rule. WebGL2 sets its
 * uniforms and draws in one stream, so it cannot have this defect: it is the control that says the
 * page itself draws two distinguishable batches, and any effect failing on *both* backends is a
 * fault in this instrument rather than in the pass.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { launch } from '../packages/core/scripts/browser.mjs';
import { connect } from '../packages/core/scripts/cdp.mjs';
import { readPng } from '../packages/core/scripts/png.mjs';

const CSS_WIDTH = 1280;
const CSS_HEIGHT = 720;
/** The first row the page's readout occupies. Everything below it is text, not scene. */
const READOUT_TOP = 660;
const EFFECTS = ['bolts', 'caustics', 'flock', 'streaks'];

function argOf(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
}

/**
 * How many pixels each signature owns.
 *
 * **A margin rather than a maximum**, because these effects are drawn over a floor and blended:
 * a red filament at half strength is still unambiguously red-dominant, and a threshold on
 * absolute brightness would count only the core.
 *
 * **Six, and it was measured rather than picked.** Everything in the page that is not an effect is
 * exactly grey — the clear, the floor, the ambient and the sun — so the background scores 0 red and
 * 0 blue even at a margin of 4. The bar is set by the faintest effect: a wind streak's alpha is
 * `vFade * taper^2 * 0.13` with `vFade` carrying `rx^3`, so its strongest pixel on this page is
 * rgb(29, 4, 4), a margin of 25, and the count falls from 1,023 pixels at a margin of 6 to 16 at a
 * margin of 18. A first version of this used 18 and could not see wind streaks at all.
 */
function signatures(image) {
  const margin = 6;
  let red = 0;
  let blue = 0;
  const rows = Math.min(image.height, Math.floor((READOUT_TOP * image.width) / CSS_WIDTH));
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < image.width; x++) {
      const i = (y * image.width + x) * image.channels;
      const r = image.pixels[i];
      const g = image.pixels[i + 1];
      const b = image.pixels[i + 2];
      if (r > b + margin && r > g + margin) red++;
      else if (b > r + margin && b > g + margin) blue++;
    }
  }
  return { red, blue, pixels: rows * image.width };
}

async function shoot(base, backend, query, shot) {
  const browser = await launch();
  const client = await connect(browser.port);
  const page = await client.page(
    `${base}/batches.html?backend=${backend}&${query}`,
    CSS_WIDTH,
    CSS_HEIGHT,
  );
  await page.settled('globalThis.__drawn', { settleMs: 1500 });
  await page.screenshot(shot);
  const complaints = page.complaints().filter((line) => !line.includes('404'));
  await page.close?.();
  await browser.close?.();
  return { complaints, image: readPng(shot) };
}

const base = argOf('base', 'http://localhost:5202').replace(/\/$/, '');
const only = argOf('effect', null);
const out = mkdtempSync(path.join(tmpdir(), 'batchuniforms-'));

let failed = 0;
function check(name, ok, detail) {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${detail}`);
}

for (const backend of ['webgl2', 'webgpu']) {
  console.log(`\n=== ${backend} ===`);
  for (const effect of only === null ? EFFECTS : [only]) {
    const both = await shoot(
      base,
      backend,
      `effect=${effect}`,
      path.join(out, `${backend}-${effect}-both.png`),
    );
    const first = await shoot(
      base,
      backend,
      `effect=${effect}&only=0`,
      path.join(out, `${backend}-${effect}-0.png`),
    );
    const second = await shoot(
      base,
      backend,
      `effect=${effect}&only=1`,
      path.join(out, `${backend}-${effect}-1.png`),
    );

    const b = signatures(both.image);
    const s0 = signatures(first.image);
    const s1 = signatures(second.image);

    /*
     * The controls, and they come first because every assertion after them is meaningless if one
     * of these fails: batch 0 alone must be red and not blue, batch 1 alone must be blue and not
     * red. A page drawing nothing passes the real assertion trivially.
     */
    const floor = Math.max(200, Math.floor(b.pixels * 0.0002));
    check(
      `${backend} ${effect}: batch 0 alone is red`,
      s0.red > floor && s0.blue < s0.red / 8,
      `${s0.red} red, ${s0.blue} blue`,
    );
    check(
      `${backend} ${effect}: batch 1 alone is blue`,
      s1.blue > floor && s1.red < s1.blue / 8,
      `${s1.blue} blue, ${s1.red} red`,
    );

    /*
     * **The assertion.** Both signatures present, and each within reach of what that batch draws
     * on its own. Half is the bar rather than equality because the two overlap on screen for the
     * streaks and can occlude for the flock, so a batch may legitimately lose some of its own
     * pixels to the other. What the defect does is not lose some of them: it loses all of them.
     */
    check(
      `${backend} ${effect}: both batches keep their own uniforms`,
      b.red > s0.red / 2 && b.blue > s1.blue / 2,
      `both: ${b.red} red of ${s0.red} alone, ${b.blue} blue of ${s1.blue} alone`,
    );

    const complaints = [...both.complaints, ...first.complaints, ...second.complaints];
    if (complaints.length > 0) {
      check(`${backend} ${effect}: draws without complaint`, false, complaints.join(' | '));
    }
  }
}

rmSync(out, { recursive: true, force: true });
console.log(failed === 0 ? '\nall checks passed' : `\n${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
