/**
 * Does clustering actually light lamps the fixed path cannot?
 *
 * **The positive control this feature has no evidence without.** Every published scene is gated at
 * zero pixels with clustering off, which proves the arm is inert and says nothing about it
 * working; `cluster-check.mjs` proves the two binners agree, and two binners wrong in the same way
 * agree perfectly. This is the one that reads the picture.
 *
 * It counts rather than compares means. `demo/dev/clustered.ts` puts forty lamps on a floor far
 * enough apart that their pools do not touch, and reports where each lands on screen; this samples
 * the floor under each and asks whether it is lit. The fixed path shades against the first sixteen
 * entries of the light array, so the answer should be sixteen with clustering off and forty with
 * it on — a count, not a brightness, and therefore not a judgement.
 *
 * It is not a `*.test.mjs` and `npm run test:scripts` does not pick it up: it needs a dev server
 * and a real GPU, which is the same reason `shots.mjs` is run by hand.
 *
 *     (setsid npx vite demo/dev --port 5202 > /tmp/vite.log 2>&1 < /dev/null &) ; sleep 7
 *     node scripts/cluster-lights-check.mjs --base=http://localhost:5202
 *     node scripts/cluster-lights-check.mjs --base=http://localhost:5202 --backend=webgl2
 *
 * Exits non-zero on the first failed check, so it can gate a commit.
 */
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { launch } from '../packages/core/scripts/browser.mjs';
import { connect } from '../packages/core/scripts/cdp.mjs';
import { decodePng } from '../packages/core/scripts/png.mjs';

/** Must match `LAMPS` in `demo/dev/clustered.ts`. */
const LAMPS = 40;
/** How many of them the uniform-slot path can reach. `MAX_POINT_LIGHTS`. */
const FIXED = 16;

const CSS_WIDTH = 1280;
const CSS_HEIGHT = 720;
/** Well inside a lamp's pool, so this measures illumination rather than its edge. */
const SAMPLE_RADIUS_PX = 10;
/**
 * Above this a patch of floor counts as lit.
 *
 * The floor is unlit black — the scene has no sun and no ambient — so the gap between a lit patch
 * and an unlit one is the whole range rather than a margin. Ten of 255 is far above sensor noise
 * and far below anything a lamp produces.
 */
const LIT = 10;

function argOf(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
}

/** Mean luminance of a disc centred where the page reported drawing that lamp. */
function litness(image, cell) {
  if (cell.x < 0) return 0;
  const scale = image.width / CSS_WIDTH;
  const cx = cell.x * scale;
  const cy = cell.y * scale;
  const r = SAMPLE_RADIUS_PX * scale;
  let sum = 0;
  let n = 0;
  for (let y = Math.floor(cy - r); y <= cy + r; y++) {
    for (let x = Math.floor(cx - r); x <= cx + r; x++) {
      if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) continue;
      if (x < 0 || y < 0 || x >= image.width || y >= image.height) continue;
      const i = (y * image.width + x) * image.channels;
      sum += 0.2126 * image.pixels[i] + 0.7152 * image.pixels[i + 1] + 0.0722 * image.pixels[i + 2];
      n++;
    }
  }
  return n === 0 ? 0 : sum / n;
}

async function capture(base, backend, clustered) {
  const out = mkdtempSync(path.join(tmpdir(), 'cluster-'));
  const browser = await launch();
  const client = await connect(browser.port);
  const page = await client.page(
    `${base}/clustered.html?backend=${backend}&clustered=${clustered}`,
    CSS_WIDTH,
    CSS_HEIGHT,
  );
  await page.settled('globalThis.__drawn', { settleMs: 3000 });
  const file = path.join(out, `${clustered}.png`);
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

const off = await capture(base, backend, 0);
const on = await capture(base, backend, 1);

let failed = 0;
function check(name, ok, detail) {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${detail}`);
}

const litOff = off.cells.filter((cell) => litness(off.image, cell) > LIT);
const litOn = on.cells.filter((cell) => litness(on.image, cell) > LIT);

console.log(`\n${backend}, ${off.image.width}x${off.image.height}, ${LAMPS} lamps\n`);
check(
  'the page draws without complaint',
  off.complaints.length === 0 && on.complaints.length === 0,
  [...off.complaints, ...on.complaints].join(' | ') || 'clean',
);
check(
  `the fixed path lights the first ${FIXED} and no more`,
  litOff.length === FIXED,
  `${litOff.length} lamps lit`,
);
check(
  'and they are the first sixteen, in array order, rather than sixteen chosen some other way',
  litOff.every((cell) => cell.lamp < FIXED),
  litOff.map((c) => c.lamp).join(','),
);
check('clustering lights every lamp', litOn.length === LAMPS, `${litOn.length} lamps lit`);
/*
 * The failure that would otherwise read as success. A froxel table nobody filled leaves the floor
 * black, and a page that drew nothing at all would pass "40 unlit" checks written the other way
 * round — so the count is asserted upward, and the two states are asserted to differ.
 */
check(
  'and the two states genuinely differ',
  litOn.length > litOff.length,
  `${litOff.length} -> ${litOn.length}`,
);

console.log(`\n${failed === 0 ? 'all checks passed' : `${failed} check(s) failed`}`);
process.exit(failed === 0 ? 0 : 1);
