/**
 * Measure `demo/dev/orm.html` rather than look at it.
 *
 * **This is what decides whether ORM maps work.** Every published scene binds no ORM map, so the
 * capture gate on those proves the feature is inert and proves nothing about whether it does
 * anything. The dev page is the other half, and a dev page judged by eye is not evidence: on the
 * normal-map page the eye got both answers backwards, calling a correct panel inverted at rms 6.2
 * and a broken one fine at rms 86.
 *
 * It is not a `*.test.mjs` and `npm run test:scripts` does not pick it up, deliberately: it needs a
 * dev server and a real GPU, which is the same reason `shots.mjs` is run by hand.
 *
 *     (setsid npx vite demo/dev --port 5210 > /tmp/vite.log 2>&1 < /dev/null &) ; sleep 7
 *     node scripts/orm-check.mjs --base=http://localhost:5210
 *     node scripts/orm-check.mjs --base=http://localhost:5210 --backend=webgl2
 *
 * Exits non-zero on the first failed check, so it can gate a commit.
 *
 * **Every sphere is measured where the page said it drew it**, read from `globalThis.__cells` via
 * `camera.project`, rather than at a screen grid computed here. The first version of this script
 * assumed a six-by-five grid of screen rectangles, which is only where the spheres are if the
 * camera happens to frame them exactly — and it did not, so most samples read background and the
 * numbers were noise that looked like data.
 */
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { launch } from '../packages/core/scripts/browser.mjs';
import { connect } from '../packages/core/scripts/cdp.mjs';
import { decodePng } from '../packages/core/scripts/png.mjs';

const CELLS = 5;
const COLUMNS = 6;
/** The page's own render size, which the sample positions are expressed in. */
const CSS_WIDTH = 1280;
const CSS_HEIGHT = 720;
/** Well inside a silhouette, so the measurement is of shading rather than of rasterisation. */
const SAMPLE_RADIUS_PX = 26;

const MODES = ['none', 'all', 'metal', 'rough', 'ao', 'ao0'];

function argOf(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
}

/** Mean luminance of a disc centred where the page reported drawing that sphere. */
function sphere(image, cells, column, row) {
  const cell = cells.find((k) => k.column === column && k.row === row);
  if (cell === undefined) throw new Error(`orm-check: the page drew no sphere at ${column},${row}`);
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

/**
 * Mean absolute difference over the spheres alone.
 *
 * Over the whole frame the background is most of it and dilutes every real difference toward zero,
 * which is how a broken first run of this reported the same 47.11 for four different pictures.
 */
function overSpheres(a, b, cells) {
  let sum = 0;
  let n = 0;
  for (let row = 0; row < CELLS; row++) {
    for (let column = 0; column < COLUMNS; column++) {
      sum += Math.abs(sphere(a, cells, column, row) - sphere(b, cells, column, row));
      n++;
    }
  }
  return sum / n;
}

async function capture(base, backend) {
  const out = mkdtempSync(path.join(tmpdir(), 'orm-'));
  const browser = await launch();
  const client = await connect(browser.port);
  const shots = {};
  let cells = null;
  const complaints = [];
  for (const mode of MODES) {
    const page = await client.page(
      `${base}/orm.html?backend=${backend}&channel=${mode}`,
      CSS_WIDTH,
      CSS_HEIGHT,
    );
    await page.settled('globalThis.__drawn', { settleMs: 4000 });
    const file = path.join(out, `${mode}.png`);
    await page.screenshot(file);
    shots[mode] = decodePng(readFileSync(file));
    cells ??= JSON.parse(await page.eval('JSON.stringify(globalThis.__cells)'));
    /* The favicon, which every page in demo/dev answers with a 404 and none of them owns. */
    complaints.push(...page.complaints().filter((line) => !line.includes('404')));
    await page.close?.();
  }
  await browser.close?.();
  return { shots, cells, complaints };
}

const base = argOf('base', 'http://localhost:5210').replace(/\/$/, '');
const backend = argOf('backend', 'webgpu');
const { shots, cells, complaints } = await capture(base, backend);

/**
 * How far the map has to bend the roughness column, and change the rough-metal cell, before either
 * says anything.
 *
 * **Both are floors well under a measured value and well over zero**, which is the whole shape of
 * the repair: with the map in, the roughness column's effect runs -72.6 to +58.3, a swing of
 * **130.9**, and the rough-metal cell sits **58.5** away from the same cell drawn with no map. With
 * the map deleted both are exactly 0, because the two frames are the same frame.
 *
 * They are floors rather than bands because more of either is not a defect: what these guard is the
 * map doing nothing, and the claims they gate say what too much would look like.
 */
const ROUGH_SWING = 20;
const METAL_EFFECT = 10;

let failed = 0;
function check(name, ok, detail) {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${detail}`);
}

console.log(`${backend}, ${shots.none.width}x${shots.none.height}\n`);
check(
  'the page draws without complaint',
  complaints.length === 0,
  complaints.join(' | ') || 'clean',
);

for (const mode of ['all', 'metal', 'rough', 'ao']) {
  const delta = overSpheres(shots[mode], shots.none, cells);
  check(
    `channel=${mode} differs from the control`,
    delta > 2,
    `mean |delta| over spheres ${delta.toFixed(2)}`,
  );
}

/* Across the middle row, where the map's B channel runs 0 to 1. */
const metalRow = Array.from({ length: CELLS }, (_, c) => sphere(shots.metal, cells, c, 2));
check(
  'metallic reshapes the surface',
  Math.abs(metalRow[4] - metalRow[0]) > 5,
  `luma across metal 0->1: ${metalRow.map((v) => v.toFixed(1)).join(' ')}`,
);

/*
 * Down the middle column, at metal 1. **Held metallic on purpose**: roughness reaches the picture
 * only through a specular lobe or a reflection, and these spheres carry no specular attribute and
 * the pass sets no reflectivity, so at metal 0 there is nothing for it to widen. That is not a bug
 * and it is easy to mistake for one — the column still shows a smooth gradient, because a lit
 * sphere always does.
 *
 * **And that last sentence is why this is measured against the control rather than against itself.**
 * This claim read `roughColumn[4] - roughColumn[0] > 3` and passed with the whole ORM map deleted,
 * measured 2026-09-04 with `scripts/claimAudit.sh`: the gradient it was reading is the one the
 * comment above already says a lit sphere always has. What the map does is *bend* that gradient, so
 * the quantity with the map in it is the difference from the same column drawn without one.
 */
const roughColumn = Array.from({ length: CELLS }, (_, r) => sphere(shots.rough, cells, 2, r));
const middleControl = Array.from({ length: CELLS }, (_, r) => sphere(shots.none, cells, 2, r));
const roughEffect = roughColumn.map((v, r) => v - (middleControl[r] ?? 0));
check(
  'roughness reshapes the surface, against the same column with no map',
  Math.abs((roughEffect[4] ?? 0) - (roughEffect[0] ?? 0)) > ROUGH_SWING,
  `map's effect down rough 0->1: ${roughEffect.map((v) => v.toFixed(1)).join(' ')}` +
    ` (luma ${roughColumn.map((v) => v.toFixed(1)).join(' ')})`,
);

/*
 * The failure the ambient floor exists to prevent. A rough metal has no diffuse and a reflection
 * scaled by (1 - roughness), so without the ambient it keeps it has nothing left at all.
 */
const roughMetal = sphere(shots.all, cells, 4, 4);
const smoothMetal = sphere(shots.all, cells, 4, 0);
/*
 * **The premise, because a non-metal is not black either.** This claim passed with the map deleted,
 * measured the same day: with `metal` forced to 0 the cell is an ordinary lit sphere and clears the
 * floor comfortably, so what read as "a rough metal keeps its ambient" was "a dielectric is lit".
 * The map has to have changed this cell before its brightness says anything about metals.
 */
const metalAtCell = Math.abs(roughMetal - sphere(shots.none, cells, 4, 4));
const dimmestDielectric = Math.min(
  ...Array.from({ length: CELLS }, (_, r) =>
    Math.min(...Array.from({ length: CELLS }, (_, c) => sphere(shots.none, cells, c, r))),
  ),
);
check(
  'a rough metal is not black',
  metalAtCell > METAL_EFFECT && roughMetal > dimmestDielectric * 0.35,
  `rough metal ${roughMetal.toFixed(1)} (${metalAtCell.toFixed(1)} from the control), ` +
    `smooth metal ${smoothMetal.toFixed(1)}, dimmest dielectric ${dimmestDielectric.toFixed(1)}`,
);

/*
 * The page paints the R channel as `1 - row / 4`, so row 0 is unoccluded and row 4 fully occluded.
 * **That is the texel, not `occlusionStrength`**, and conflating the two is how the first run of
 * these checks reported three failures against a shader that was correct.
 */
const aoColumn = Array.from({ length: CELLS }, (_, r) => sphere(shots.ao, cells, 2, r));
const controlColumn = Array.from({ length: CELLS }, (_, r) => sphere(shots.none, cells, 2, r));
check(
  'an unoccluded texel leaves the surface exactly alone',
  Math.abs(aoColumn[0] - controlColumn[0]) < 0.5,
  `texel 1 ${aoColumn[0].toFixed(1)} against control ${controlColumn[0].toFixed(1)}`,
);
check(
  'occlusion falls with the texel, all the way down',
  aoColumn.every((v, i) => i === 0 || v < aoColumn[i - 1]),
  `luma down texel 1->0: ${aoColumn.map((v) => v.toFixed(1)).join(' ')}`,
);
check(
  'a fully occluded texel takes nearly everything',
  aoColumn[4] < controlColumn[4] * 0.05,
  `texel 0 ${aoColumn[4].toFixed(1)} against control ${controlColumn[4].toFixed(1)}`,
);

/*
 * The end-to-end statement of glTF's definition, and the one a swapped `uOrmScale` component would
 * break: strength is a mix from 1 rather than a multiply, so 0 means unoccluded and not black.
 */
check(
  'occlusionStrength 0 is unoccluded and not black, which is what glTF means',
  overSpheres(shots.ao0, shots.none, cells) < 0.5,
  `mean |delta| ao0 vs none ${overSpheres(shots.ao0, shots.none, cells).toFixed(3)}`,
);

console.log(`\n${failed === 0 ? 'all checks passed' : `${failed} check(s) failed`}`);
process.exit(failed === 0 ? 0 : 1);
