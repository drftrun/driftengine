/**
 * Does a mip chain stop minified type losing strokes, and does it do it on both backends?
 *
 * **The defect this measures was reported by a player and by no instrument.** A consumer bakes one
 * glyph page per weight at 96 px and draws body copy at 11 to 13, which is about a 7x
 * minification. `linear` reads four texels out of a footprint covering dozens, so a `t` crossbar
 * two texels tall lands on roughly a quarter of a pixel and survives or not depending on where the
 * sample falls: `Step-In Uppercut` came out as `Slep-In Uppercul`, and because the sample point
 * moves with the glyph's position the same letter reads differently in different words.
 *
 * **So the assertion is not "is there ink" — it is how much identical copies disagree.**
 * `demo/dev/glyphMip.ts` draws one glyph twelve times at deliberately different subpixel offsets,
 * once through a plain sampler and once through a chain. Undersampled, each copy keeps a different
 * part of the letter and the ink varies between them; with a chain, a lower level has already
 * averaged the strokes and every copy carries the same ink. A build that samples well by luck
 * passes an ink threshold and fails this.
 *
 * **Both backends, every run, and WebGL2 printed first** — the 2026-08-23 rule. The two have
 * separate implementations of the same idea here: `gl.generateMipmap` and one enum against a
 * per-level blit and a sampler with a `mipmapFilter`. A number that moves on one and not the other
 * is the interesting failure, so they are compared against each other as well as against the
 * threshold.
 *
 * It is not a `*.test.mjs` and `npm run test:scripts` does not pick it up, deliberately: it needs
 * a dev server and a real GPU, the same as `batch-uniforms-check.mjs`.
 *
 *     npx vite demo/dev --port 5202 &
 *     node scripts/glyph-mip-check.mjs --base=http://localhost:5202
 */
import { launch } from '../packages/core/scripts/browser.mjs';
import { connect } from '../packages/core/scripts/cdp.mjs';
import { readPng } from '../packages/core/scripts/png.mjs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

function argOf(name, fallback) {
  const hit = process.argv.find((entry) => entry.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
}

const base = argOf('base', 'http://localhost:5202').replace(/\/$/, '');
const out = mkdtempSync(path.join(tmpdir(), 'glyphmip-'));

/**
 * How much the copies may disagree once the chain is on, as a standard deviation of ink.
 *
 * Measured at **0.0020** on an RX 9070 XT, both backends, against **0.0130** without — so this is
 * a little over twice the measured value, which leaves room for a driver that filters slightly
 * differently without leaving room for the defect, whose signature is six times larger.
 */
const STEADY_SD = 0.005;

/** And how much better than the plain sampler it has to be, so the check cannot pass on a tie. */
const MIN_IMPROVEMENT = 3;

let failed = 0;
function check(name, ok, detail) {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${detail}`);
}

/** Mean ink inside one glyph's box, as a fraction of full white. */
function ink(png, left, top, size) {
  const { width, channels, pixels } = png;
  let sum = 0;
  let count = 0;
  for (let y = Math.round(top); y < Math.round(top + size); y++) {
    for (let x = Math.round(left); x < Math.round(left + size); x++) {
      const at = (y * width + x) * channels;
      if (at < 0 || at >= pixels.length) continue;
      sum += ((pixels[at] ?? 0) + (pixels[at + 1] ?? 0) + (pixels[at + 2] ?? 0)) / 3;
      count++;
    }
  }
  return count === 0 ? 0 : sum / count / 255;
}

/** The spread of ink across the copies of one row: the reported symptom, as a number. */
function rowStats(png, measured, y, dpr) {
  const values = [];
  for (let copy = 0; copy < measured.copies; copy++) {
    values.push(
      ink(png, (measured.firstX + copy * measured.step) * dpr, y * dpr, measured.drawn * dpr),
    );
  }
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const sd = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length);
  return { mean, sd, spread: Math.max(...values) - Math.min(...values) };
}

const results = {};
const browser = await launch();
const client = await connect(browser.port);

for (const backend of ['webgl2', 'webgpu']) {
  console.log(`\n--- ${backend} ---`);
  const page = await client.page(`${base}/glyphMip.html?backend=${backend}`, 900, 300);
  await page.settled('globalThis.__drawn', { settleMs: 1200 });
  const failure = await page.eval("document.getElementById('error').textContent");
  if (failure) {
    check(`${backend} draws at all`, false, failure.slice(0, 200));
    await page.close?.();
    continue;
  }
  const measured = await page.eval('globalThis.__measured');
  const dpr = await page.eval('devicePixelRatio');
  const shot = path.join(out, `glyph-${backend}.png`);
  await page.screenshot(shot);
  const png = readPng(shot);
  await page.close?.();

  const plain = rowStats(png, measured, measured.rows.plain, dpr);
  const mipped = rowStats(png, measured, measured.rows.mipped, dpr);
  results[backend] = { plain, mipped };

  /*
   * The premise, asserted rather than assumed: if neither row drew, every comparison below would
   * compare two zeroes and pass. That is the shape `volume-cones-check.mjs` names.
   */
  check(
    `${backend} drew both rows`,
    plain.mean > 0.01 && mipped.mean > 0.01,
    `ink ${plain.mean.toFixed(4)} plain, ${mipped.mean.toFixed(4)} mipped`,
  );
  check(
    `${backend} without a chain, copies disagree`,
    plain.sd > STEADY_SD,
    `sd ${plain.sd.toFixed(4)}, spread ${plain.spread.toFixed(4)} — this is the reported defect`,
  );
  check(
    `${backend} with a chain, copies agree`,
    mipped.sd <= STEADY_SD,
    `sd ${mipped.sd.toFixed(4)} against a ceiling of ${STEADY_SD}`,
  );
  check(
    `${backend} the chain is what did it`,
    plain.sd / Math.max(mipped.sd, 1e-9) >= MIN_IMPROVEMENT,
    `${(plain.sd / Math.max(mipped.sd, 1e-9)).toFixed(1)}x less disagreement`,
  );
}

await browser.close?.();

/*
 * The two backends implement the same idea separately, so they are held against each other too: a
 * chain built by `generateMipmap` and one built by a blit per level should land in the same place,
 * and a number that moves on one alone is the failure worth catching.
 */
if (results.webgl2 && results.webgpu) {
  const drift = Math.abs(results.webgl2.mipped.mean - results.webgpu.mipped.mean);
  check(
    'the two backends agree about a mipmapped glyph',
    drift < 0.01,
    `${results.webgl2.mipped.mean.toFixed(4)} against ${results.webgpu.mipped.mean.toFixed(4)}`,
  );
}

console.log(`\n${failed === 0 ? 'all checks passed' : `${failed} check(s) failed`}`);
process.exit(failed === 0 ? 0 : 1);
