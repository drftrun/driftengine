/**
 * Does a cutout cast the shape in its texture rather than its quad?
 *
 * `demo/dev/cutoutShadows.html` holds three cards with a lattice of holes cut out of each by its
 * alpha. The left one is a mesh caster and the centre one an instanced caster, and both offer their
 * material; the right one offers none. **The right card is the control within the frame**: it casts
 * the solid quad every alpha-cut surface cast before 4.4.0, so a left or centre shadow darker by
 * the same count as the right one is the feature not working, whatever the picture looks like.
 *
 * **And `?cutout=0` is the control across frames**: no caster offers anything, so all three shadows
 * must be solid and equal. Without it a left shadow with fewer dark pixels could be a card that is
 * simply placed differently.
 *
 * A shadow pixel is a floor pixel well below the lit floor's brightness, and not the card's green.
 * The frame is cut into three columns at the gaps between the shadows, and each is counted.
 * The holes are π · 0.3² of each card, 28 per cent, so a cutout shadow should hold about 72 per
 * cent of a solid one's pixels, and the two backends are also held to each other.
 *
 * Needs a dev server and a real GPU, so it is run by hand like every `*-check.mjs`:
 *
 *     npx vite demo/dev --port 5202 &
 *     node scripts/cutout-shadow-check.mjs --base=http://localhost:5202
 */
import { readFileSync } from 'node:fs';
import { launch, requireHardwareGpu } from '../packages/core/scripts/browser.mjs';
import { connect } from '../packages/core/scripts/cdp.mjs';
import { decodePng } from '../packages/core/scripts/png.mjs';

const WIDTH = 1280;
const HEIGHT = 720;

/**
 * A cutout shadow's share of a solid one, allowed. The holes alone predict 1 − π · 0.3² = 0.717,
 * and both backends measured 0.716 on both paths when this was written, so the band is the
 * penumbra's slack and not the claim's.
 */
const CUT_LOW = 0.66;
const CUT_HIGH = 0.78;

/** How far a shadow that should be unchanged may move, as a share of itself. */
const SAME = 0.02;

/** How far the two backends may disagree about a cutout shadow's share. */
const PARITY = 0.03;

/** Below this many pixels a column holds no shadow worth a ratio. */
const MIN_SHADOW = 2000;

function argOf(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
}

async function shoot(base, backend, query, file) {
  const browser = await launch();
  try {
    const client = await connect(browser.port);
    const renderer = await requireHardwareGpu(client);
    const page = await client.page(
      `${base}/cutoutShadows.html?backend=${backend}${query}`,
      WIDTH,
      HEIGHT,
    );
    await page.settled('globalThis.__drawn === true', { settleMs: 800 });
    const error = String(await page.eval(`document.getElementById('error')?.textContent ?? ''`));
    const stats = String(await page.eval(`document.getElementById('stats')?.textContent ?? ''`));
    await page.screenshot(file);
    const complaints = page.complaints().filter((line) => !/favicon|404/.test(line));
    await page.close?.();
    return { renderer, error, stats, complaints, image: decodePng(readFileSync(file)) };
  } finally {
    await browser.close?.();
  }
}

/**
 * Shadow pixels in each third of the frame, and how many pixels are lit floor.
 *
 * Only rows below the cards are read: the floor fills them from edge to edge, so nothing dark
 * there is the clear colour, and the cards themselves are above. A shadow pixel is dark; the lit
 * floor is about four times brighter, so the threshold sits far from both.
 */
function measure({ width, height, pixels, channels }) {
  const columns = [0, 0, 0];
  let floor = 0;
  for (let y = Math.floor(height * 0.38); y < Math.floor(height * 0.92); y++) {
    for (let x = 0; x < width; x++) {
      const g = pixels[(y * width + x) * channels + 1] ?? 0;
      if (g < 70) columns[x < width * 0.41 ? 0 : x < width * 0.56 ? 1 : 2]++;
      else floor++;
    }
  }
  return { columns, floor };
}

const base = argOf('base', 'http://localhost:5202').replace(/\/$/, '');
let failed = 0;
function check(name, ok, detail) {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${detail}`);
}

const share = {};
for (const backend of ['webgpu', 'webgl2']) {
  console.log(`\n=== ${backend} ===`);
  const on = await shoot(base, backend, '', `shots/cutout/on-${backend}.png`);
  const off = await shoot(base, backend, '&cutout=0', `shots/cutout/off-${backend}.png`);
  console.log(`      ${on.renderer}`);
  console.log(`      ${on.stats}`);
  for (const line of [...on.complaints, ...off.complaints]) console.log(`      ! ${line}`);
  check('the page drew', on.error === '' && off.error === '', on.error || off.error || 'no error');

  const a = measure(on.image);
  const b = measure(off.image);
  console.log(`      offered : ${a.columns.join(' · ')} shadow px · ${a.floor} floor px`);
  console.log(`      withheld: ${b.columns.join(' · ')} shadow px · ${b.floor} floor px`);
  check(
    'every column holds a shadow',
    b.columns.every((c) => c > MIN_SHADOW),
    b.columns.join(', '),
  );
  const [left, centre, right] = a.columns.map((c, k) => c / (b.columns[k] || 1));
  check(
    'the control casts the same solid shadow either way',
    Math.abs((right ?? 0) - 1) < SAME,
    `right ${(right ?? 0).toFixed(3)} of itself`,
  );
  check(
    'a mesh cutout casts its holes',
    (left ?? 0) > CUT_LOW && (left ?? 0) < CUT_HIGH,
    `left ${(left ?? 0).toFixed(3)} of solid`,
  );
  check(
    'an instanced cutout casts its holes',
    (centre ?? 0) > CUT_LOW && (centre ?? 0) < CUT_HIGH,
    `centre ${(centre ?? 0).toFixed(3)} of solid`,
  );
  share[backend] = { left, centre };
}

const gpu = share.webgpu;
const gl = share.webgl2;
if (gpu !== undefined && gl !== undefined) {
  console.log('\n=== parity ===');
  check(
    'both backends cut the same share',
    Math.abs(gpu.left - gl.left) < PARITY && Math.abs(gpu.centre - gl.centre) < PARITY,
    `left ${gpu.left.toFixed(3)} / ${gl.left.toFixed(3)} · centre ${gpu.centre.toFixed(3)} / ${gl.centre.toFixed(3)}`,
  );
}

console.log(failed === 0 ? '\nall claims hold' : `\n${failed} claim(s) failed`);
process.exit(failed === 0 ? 0 : 1);
