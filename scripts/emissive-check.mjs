/**
 * Does the emissive map reach the picture, and does it stop where it should?
 *
 * **The positive control.** No published scene binds an emissive map, so the capture gate on those
 * proves the term is inert and proves nothing about it working. This measures `demo/dev/emissive.html`,
 * which puts four panels side by side with the map as the only difference between them.
 *
 * It measures **variance across a panel** rather than brightness. A map that is not reaching the
 * shader leaves a panel uniform, and a uniform panel and a patterned one can have the same mean —
 * which is how a mean-based check would pass a feature that does nothing. The rings in the page are
 * a radial ramp for the same reason: a checker aliases to flat grey at some sampling radius.
 *
 * It is not a `*.test.mjs` and `npm run test:scripts` does not pick it up: it needs a dev server and
 * a real GPU, which is the same reason `shots.mjs` is run by hand.
 *
 *     (setsid npx vite demo/dev --port 5202 > /tmp/vite.log 2>&1 < /dev/null &) ; sleep 7
 *     node scripts/emissive-check.mjs --base=http://localhost:5202
 *     node scripts/emissive-check.mjs --base=http://localhost:5202 --backend=webgl2
 *
 * Exits non-zero on the first failed check, so it can gate a commit.
 */
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { launch } from '../packages/core/scripts/browser.mjs';
import { connect } from '../packages/core/scripts/cdp.mjs';
import { decodePng } from '../packages/core/scripts/png.mjs';

const CSS_WIDTH = 1280;
const CSS_HEIGHT = 720;
/** Well inside a panel, so this measures the surface rather than its silhouette. */
const SAMPLE_RADIUS_PX = 60;

function argOf(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
}

/** Mean luminance and its standard deviation over a disc where the page drew that panel. */
function patch(image, cell) {
  const scale = image.width / CSS_WIDTH;
  const cx = cell.x * scale;
  const cy = cell.y * scale;
  const r = SAMPLE_RADIUS_PX * scale;
  const values = [];
  for (let y = Math.floor(cy - r); y <= cy + r; y++) {
    for (let x = Math.floor(cx - r); x <= cx + r; x++) {
      if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) continue;
      if (x < 0 || y < 0 || x >= image.width || y >= image.height) continue;
      const i = (y * image.width + x) * image.channels;
      values.push(
        0.2126 * image.pixels[i] + 0.7152 * image.pixels[i + 1] + 0.0722 * image.pixels[i + 2],
      );
    }
  }
  if (values.length === 0) return { mean: 0, deviation: 0 };
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  return { mean, deviation: Math.sqrt(variance) };
}

async function capture(base, backend, mapped) {
  const out = mkdtempSync(path.join(tmpdir(), 'emissive-'));
  const browser = await launch();
  const client = await connect(browser.port);
  const page = await client.page(
    `${base}/emissive.html?backend=${backend}&emissivemap=${mapped}`,
    CSS_WIDTH,
    CSS_HEIGHT,
  );
  await page.settled('globalThis.__drawn', { settleMs: 3000 });
  const file = path.join(out, `${mapped}.png`);
  await page.screenshot(file);
  const image = decodePng(readFileSync(file));
  const cells = JSON.parse(await page.eval('JSON.stringify(globalThis.__cells)'));
  /* The favicon, which every page in demo/dev answers with a 404 and none of them owns. */
  const complaints = page.complaints().filter((line) => !line.includes('404'));
  await page.close?.();
  await browser.close?.();
  return { image, cells, complaints };
}

const base = argOf('base', 'http://localhost:5202').replace(/\/$/, '');
const backend = argOf('backend', 'webgpu');

const on = await capture(base, backend, 1);
const off = await capture(base, backend, 0);

/**
 * The mean a panel has to reach before a claim about its *evenness* means anything.
 *
 * **Nothing is perfectly even.** Measured 2026-09-04 by deleting the emissive term — one factor of
 * zero on `lit +=` in `flat/main.ts` — after which four of this script's seven claims still passed,
 * two of them these: a panel that emits nothing has a deviation of about zero and reads as an even
 * glow. Both now say what they are even *about*, against the same floor the claim above them uses.
 *
 * A deviation bound alone is a claim that the term is not doing something wrong. It was standing in
 * for a claim that the term is doing something.
 */
const GLOWING = 20;

let failed = 0;
function check(name, ok, detail) {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${detail}`);
}

const plain = patch(on.image, on.cells[0]);
const mapped = patch(on.image, on.cells[1]);
const scaled = patch(on.image, on.cells[2]);
const unlit = patch(on.image, on.cells[3]);
const mappedOff = patch(off.image, off.cells[1]);

console.log(`\n${backend}, ${on.image.width}x${on.image.height}\n`);
check(
  'the page draws without complaint',
  on.complaints.length === 0 && off.complaints.length === 0,
  [...on.complaints, ...off.complaints].join(' | ') || 'clean',
);
check('the unmapped panel glows', plain.mean > GLOWING, `mean ${plain.mean.toFixed(1)}`);
check(
  'and glows evenly, which is what the mapped one is measured against',
  plain.mean > GLOWING && plain.deviation < 4,
  `deviation ${plain.deviation.toFixed(2)}`,
);
/*
 * The claim. A map that never reaches the shader leaves this panel exactly as uniform as panel 1,
 * and the two can share a mean while differing entirely in what they show.
 */
check(
  'the mapped panel is patterned rather than uniform',
  mapped.deviation > plain.deviation * 4,
  `deviation ${mapped.deviation.toFixed(2)} against ${plain.deviation.toFixed(2)}`,
);
check(
  'emissiveScale multiplies it',
  scaled.mean > mapped.mean * 1.4,
  `mean ${scaled.mean.toFixed(1)} against ${mapped.mean.toFixed(1)}`,
);
/*
 * glTF's rule, and the one thing about this map that surprises people: emission is the factor
 * times the texture, so a surface emitting nothing emits nothing however bright the image.
 */
check(
  'a mesh that emits nothing stays dark however bright the map',
  unlit.mean < 8,
  `mean ${unlit.mean.toFixed(1)}`,
);
/* And the control: with the map dropped, panel 2 is panel 1 again. */
check(
  'dropping the map returns the panel to a flat glow',
  mappedOff.mean > GLOWING && mappedOff.deviation < 4,
  `deviation ${mappedOff.deviation.toFixed(2)}`,
);

console.log(`\n${failed === 0 ? 'all checks passed' : `${failed} check(s) failed`}`);
process.exit(failed === 0 ? 0 : 1);
