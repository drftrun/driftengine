/**
 * Measure `demo/dev/ibl.html` rather than look at it.
 *
 * **This is what decides whether the irradiance term works.** No published scene bakes a probe
 * into a room with a direction to it, so the capture gate on those proves the term is inert where
 * it should be and proves nothing about whether it does anything.
 *
 * It is not a `*.test.mjs` and `npm run test:scripts` does not pick it up, deliberately: it needs
 * a dev server and a real GPU, which is the same reason `shots.mjs` is run by hand.
 *
 *     (setsid npx vite demo/dev --port 5202 > /tmp/vite.log 2>&1 < /dev/null &) ; sleep 8
 *     node scripts/ibl-check.mjs --base=http://localhost:5202
 *     node scripts/ibl-check.mjs --base=http://localhost:5202 --backend=webgpu
 *
 * Exits non-zero on the first failed check, so it can gate a commit.
 *
 * **Every sphere is measured where the page said it drew it**, read from `globalThis.__cells`
 * rather than at a screen grid computed here — the arrangement `orm-check.mjs` arrived at after a
 * first version assumed a grid, sampled mostly background, and produced noise that looked like
 * data.
 *
 * **The two states are one query flag apart and nothing else.** `?sh=0` bakes no probe at all, so
 * the shader's gate stays 0 and the hemispheric term lights the spheres — which is the state this
 * measures against, reached by the switch that produces it honestly rather than by poking a
 * uniform.
 */
import { launch, requireHardwareGpu } from '../packages/core/scripts/browser.mjs';
import { connect } from '../packages/core/scripts/cdp.mjs';
import { decodePng } from '../packages/core/scripts/png.mjs';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const found = args.find((entry) => entry.startsWith(`--${name}=`));
  return found === undefined ? fallback : found.slice(name.length + 3);
};

const BASE = flag('base', 'http://localhost:5202');
const BACKEND = flag('backend', 'webgl2');
const WIDTH = 1280;
const HEIGHT = 720;
/** Well inside a silhouette, so what is sampled is shading rather than rasterisation. */
const RADIUS = 18;

/** Mean linear-ish luminance of a disc, in 0..255. */
function sample(image, cx, cy) {
  let sum = 0;
  let count = 0;
  for (let y = Math.round(cy - RADIUS); y <= Math.round(cy + RADIUS); y++) {
    for (let x = Math.round(cx - RADIUS); x <= Math.round(cx + RADIUS); x++) {
      if (x < 0 || y < 0 || x >= image.width || y >= image.height) continue;
      if ((x - cx) ** 2 + (y - cy) ** 2 > RADIUS * RADIUS) continue;
      const at = (y * image.width + x) * image.channels;
      sum +=
        0.2126 * image.pixels[at] + 0.7152 * image.pixels[at + 1] + 0.0722 * image.pixels[at + 2];
      count++;
    }
  }
  return count === 0 ? 0 : sum / count;
}

/**
 * The left and right halves of one sphere, which is where a *direction* shows.
 *
 * A whole-sphere mean cannot see it: brightening one side and darkening the other by the same
 * amount leaves the mean where it was, and that is exactly what a sign error in the linear band
 * does.
 */
function halves(image, cx, cy) {
  const offset = RADIUS * 0.55;
  return { toBright: sample(image, cx + offset, cy), toDark: sample(image, cx - offset, cy) };
}

async function shoot(page, query) {
  await page.eval(
    `location.href = ${JSON.stringify(`${BASE}/ibl.html?backend=${BACKEND}${query}`)}`,
    {
      awaitPromise: false,
    },
  );
  await page.settled('globalThis.__drawn === true', { settleMs: 900 });
  const cells = await page.eval('globalThis.__cells');
  const shot = await page.call('Page.captureScreenshot', { format: 'png' });
  return { cells, image: decodePng(Buffer.from(shot.data, 'base64')) };
}

const failures = [];
function check(name, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail === undefined ? '' : ` — ${detail}`}`);
  if (!ok) failures.push(name);
}

const browser = await launch();
const client = await connect(browser.port);
await requireHardwareGpu(client);
const page = await client.page(`${BASE}/ibl.html?backend=${BACKEND}`, WIDTH, HEIGHT);
await page.settled('globalThis.__drawn === true', { settleMs: 900 });

const on = await shoot(page, '');
const off = await shoot(page, '&sh=0');
const reported = await page.eval(
  '(document.getElementById("stats") ?? { textContent: "" }).textContent',
);
console.log(`page reports: ${reported}\n`);

if (!Array.isArray(on.cells) || on.cells.length === 0) {
  console.log('FAIL  the page published no cells; nothing below means anything');
  process.exit(1);
}

/*
 * 1. The term does something. A zero here is the gate never opening, which no picture can show:
 *    a scene lit only by the hemispheric term looks perfectly reasonable.
 */
let moved = 0;
let sum = 0;
for (const cell of on.cells) {
  const a = sample(off.image, cell.x, cell.y);
  const b = sample(on.image, cell.x, cell.y);
  if (Math.abs(b - a) > 2) moved++;
  sum += b - a;
}
check(
  'the probe changes what a sphere shows',
  moved > on.cells.length / 2,
  `${moved} of ${on.cells.length} spheres moved, mean ${(sum / on.cells.length).toFixed(1)}/255`,
);

/*
 * 2. It has a direction, and this is the check that separates a real projection from a constant —
 *    which is what the term this replaces degenerated to at the top of a mip chain.
 */
let directional = 0;
let margin = 0;
for (const cell of on.cells) {
  const { toBright, toDark } = halves(on.image, cell.x, cell.y);
  if (toBright > toDark + 1) directional++;
  margin += toBright - toDark;
}
check(
  'the lit side faces the bright wall',
  directional > on.cells.length * 0.8,
  `${directional} of ${on.cells.length} spheres, mean margin ${(margin / on.cells.length).toFixed(1)}/255`,
);

/*
 * 3. With no probe there is no direction to find. The same measurement on the control, which must
 *    come back flat — if it does not, the grid is being lit by something else asymmetric and check
 *    2 was measuring that instead.
 */
let controlMargin = 0;
for (const cell of off.cells ?? on.cells) {
  const { toBright, toDark } = halves(off.image, cell.x, cell.y);
  controlMargin += toBright - toDark;
}
const controlMean = controlMargin / (off.cells ?? on.cells).length;
check(
  'the control has no direction of its own',
  Math.abs(controlMean) < 2,
  `mean margin ${controlMean.toFixed(1)}/255 with no probe`,
);

/*
 * 4. And it is a lift rather than a wash: a room that is mostly dark must not make every sphere
 *    brighter than the hemispheric term did by more than the room could account for. A term that
 *    is scaled wrong passes 1 and 2 and fails here, which is how the basis constants were caught.
 */
const brightest = Math.max(...on.cells.map((cell) => sample(on.image, cell.x, cell.y)));
check(
  'nothing is blown out by the term',
  brightest < 250,
  `brightest sphere ${brightest.toFixed(0)}/255`,
);

/*
 * 5. **A perfect reflector does not absorb.** The energy check, and the one this file could not
 *    make until `demo/dev/ibl.html` grew a metal ladder.
 *
 *    `metal` reaches the lit pass only through an ORM map and this page bound none, so every check
 *    above runs on dielectrics at `f0` 0.04 — where the environment BRDF's missing multiple-
 *    scattering energy is worth about a thousandth of what it is worth on a metal. The split sum
 *    shipped losing a fully metallic surface 22% of its reflection at roughness 0.4 and 44% at
 *    0.8, and it was reported by a consumer rather than caught here.
 *
 *    **Three query flags, each answering a way the measurement can lie.** `?metal=1` puts `f0` at
 *    1, where the property is exact: a perfect reflector returns everything at every roughness.
 *    `?uniform=1` paints every wall alike, so what a rung reflects cannot change with roughness
 *    and a falloff is the shading rather than the room — the contrasty room falls five-fold on its
 *    own and that is its content. `?gain=1.5` scales the reflection and not the diffuse, and
 *    without it this check is worthless: at gain 1 the diffuse term is about as bright as the
 *    reflection, the blend is between two near-equal values, and the ladder came back identical to
 *    a hundredth of a level with the compensation in and with it out.
 *
 *    Measured on this machine, both backends agreeing to the hundredth: **13.4% falling with the
 *    single-scatter term, 4.9% rising with the compensation.** The threshold sits between them and
 *    the *sign* is the substance — a compensated ladder rises slightly at the rough end, because
 *    the recovered energy is returned against the prefiltered radiance rather than the irradiance.
 */
const ladder = await shoot(page, '&ladder=1&metal=1&uniform=1&gain=1.5');
if (!Array.isArray(ladder.cells) || ladder.cells.length < 2) {
  check('the metal ladder published its rungs', false, 'no cells, so the energy check is blind');
} else {
  const rungs = ladder.cells.map((cell) => sample(ladder.image, cell.x, cell.y));
  const mirror = rungs[0];
  const roughest = rungs[rungs.length - 1];
  const spread = (Math.max(...rungs) - Math.min(...rungs)) / Math.max(...rungs);
  check(
    'a perfect reflector returns what it is given at every roughness',
    spread < 0.09,
    `mirror ${mirror.toFixed(1)} to roughest ${roughest.toFixed(1)}, spread ${(spread * 100).toFixed(1)}% ` +
      '(13.4% is the single-scatter term losing energy)',
  );
  check(
    'and the rough end is not the dark end',
    roughest >= mirror - 1,
    `roughest ${roughest.toFixed(1)} against mirror ${mirror.toFixed(1)}`,
  );
  check(
    'the ladder is not clipping, so the spread above is real',
    Math.max(...rungs) < 250,
    `brightest rung ${Math.max(...rungs).toFixed(0)}/255`,
  );
}

for (const line of page.logs.filter((l) => /error|exception/i.test(l)).slice(0, 5)) {
  console.log(`  ! ${line.slice(0, 160)}`);
}

await page.close();
client.close();
await browser.close();

if (failures.length > 0) {
  console.log(`\n${failures.length} failed on ${BACKEND}`);
  process.exit(1);
}
console.log(`\nall checks passed on ${BACKEND}`);
