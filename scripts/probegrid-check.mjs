/**
 * Does a grid of environment probes light a room by where a surface stands?
 *
 * **One probe cannot fail this and that is the point.** A single baked probe lights everything
 * equally by construction, so a page with one probe cannot tell a working grid from a broken one —
 * which is why the control here is `?grid=1`, the same scene through the same code with the lattice
 * one probe wide, rather than a probe switched off.
 *
 * `demo/dev/ibl.html` already has the room this needs: a bright wall at +X and a dark one at -X, so
 * probes spread along X see genuinely different rooms. The sphere grid it draws is the instrument,
 * and every sphere is measured where the page said it drew it — read from `globalThis.__cells`
 * rather than at a screen grid computed here, which is the arrangement `orm-check.mjs` arrived at
 * after a first version assumed a grid, sampled mostly background and produced noise that looked
 * like data.
 *
 * **Every number is a difference between a grid of three and a grid of one**, and two earlier
 * versions of this check were wrong for want of that.
 *
 * Column brightness is not a read of the probe term. The spheres are lit by a room and seen at
 * different view angles, so the columns already run 29.5 to 8.8 across the frame with one probe,
 * for reasons that have nothing to do with probes. Subtracting the no-probe run does not fix it
 * either: one probe's light is *directional* — the room has a bright wall — so what it adds
 * legitimately varies by column too, 22.0 down to 2.9, because each sphere shows the camera a
 * different hemisphere. Neither number says anything on its own.
 *
 * What does say something is a grid of three against a grid of one, which differ in exactly one
 * thing: whether the environment varies with where a surface stands.
 *
 * **So the control is repeatability rather than flatness.** The same scene is measured twice
 * through two different query strings that describe it identically, and the spread of *that*
 * difference is the noise floor everything below has to clear. An instrument that cannot repeat
 * itself cannot measure a grid.
 *
 * **The claim a nearest-probe selection cannot pass is the middle column.** That a grid makes the
 * two ends of a room differ is satisfied by a hard switch at the midplane, which is the cheaper
 * implementation this one is not. What separates them is that the middle must lie *strictly
 * between* the ends: a switch makes it equal to one of them, a trilinear blend cannot.
 *
 * It is not a `*.test.mjs` and `npm run test:scripts` does not pick it up, deliberately: it needs a
 * dev server and a real GPU, which is the same reason `ibl-check.mjs` is run by hand.
 *
 *     (setsid npx vite demo/dev --port 5231 > /tmp/vite.log 2>&1 < /dev/null &) ; sleep 8
 *     node scripts/probegrid-check.mjs --base=http://localhost:5231
 *
 * Exits non-zero on the first failed check, so it can gate a commit.
 */
import { launch, requireHardwareGpu } from '../packages/core/scripts/browser.mjs';
import { connect } from '../packages/core/scripts/cdp.mjs';
import { decodePng } from '../packages/core/scripts/png.mjs';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const found = args.find((entry) => entry.startsWith(`--${name}=`));
  return found === undefined ? fallback : found.slice(name.length + 3);
};

const BASE = flag('base', 'http://localhost:5231').replace(/\/$/, '');
const ONLY = flag('backend', '');
const WIDTH = 1280;
const HEIGHT = 720;

/**
 * How far apart the two ends of the room must read before a grid counts as having done anything.
 *
 * Levels of 255 on the mean of a sphere's lit pixels. The single-probe control measures about one
 * level of spread across the same columns, which is the noise floor this has to clear.
 */
const SPREAD_MIN = 3;

/** How far the two backends may disagree about a column mean, in levels of 255. */
const PARITY = 2.0;

/** How far the same scene measured twice may move. The instrument's own floor. */
const NOISE_MAX = 1.0;

function isNoise(line) {
  return (
    line.includes('404') || line.includes('A valid external Instance reference no longer exists')
  );
}

/** The mean brightness of a small box centred on where the page said a sphere is. */
function sampleAt(png, x, y, radius) {
  let sum = 0;
  let count = 0;
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const px = Math.round(x + dx);
      const py = Math.round(y + dy);
      if (px < 0 || py < 0 || px >= png.width || py >= png.height) continue;
      /* `channels` rather than a literal 4: `decodePng` answers what the file holds. */
      const at = (py * png.width + px) * png.channels;
      sum += 0.2126 * png.pixels[at] + 0.7152 * png.pixels[at + 1] + 0.0722 * png.pixels[at + 2];
      count++;
    }
  }
  return count === 0 ? 0 : sum / count;
}

async function shoot(backend, query) {
  const browser = await launch();
  try {
    const client = await connect(browser.port);
    /* Before anything is measured: a software rasteriser's figures are not this machine's. */
    await requireHardwareGpu(client);
    const page = await client.page(`${BASE}/ibl.html?backend=${backend}&${query}`, WIDTH, HEIGHT);
    await page.settled('globalThis.__drawn', { settleMs: 1000 });
    const cells = (await page.eval('globalThis.__cells')) ?? [];
    /* `page.screenshot` writes a file; this wants the bytes, which is what `ibl-check.mjs` does. */
    const shot = await page.call('Page.captureScreenshot', { format: 'png' });
    const png = decodePng(Buffer.from(shot.data, 'base64'));

    /* One mean per column, averaged down the rows, so a column is the room's own x axis. */
    const columns = new Map();
    for (const cell of cells) {
      const value = sampleAt(png, cell.x, cell.y, 4);
      const held = columns.get(cell.column) ?? { sum: 0, count: 0 };
      held.sum += value;
      held.count++;
      columns.set(cell.column, held);
    }
    const means = [...columns.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([column, held]) => ({ column, mean: held.sum / Math.max(held.count, 1) }));

    const out = {
      means,
      cells: cells.length,
      complaints: page.complaints().filter((l) => !isNoise(l)),
    };
    await page.close?.();
    return out;
  } finally {
    await browser.close?.();
  }
}

let failed = 0;
function check(name, ok, detail) {
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name} — ${detail}`);
}

const measured = {};
const backends = ONLY === '' ? ['webgl2', 'webgpu'] : [ONLY];

const gridLit = {};

for (const backend of backends) {
  console.log(`\n=== ${backend} ===`);
  const one = await shoot(backend, 'grid=1');
  /* The same scene, said a second way: `sh=1` and `grid=1` are one probe either way. */
  const again = await shoot(backend, 'sh=1');
  const grid = await shoot(backend, 'grid=3');

  const difference = (a, b) => a.means.map((m, i) => m.mean - (b.means[i]?.mean ?? 0));
  const spread = (values) => (values[values.length - 1] ?? 0) - (values[0] ?? 0);
  const largest = (values) => Math.max(...values.map((v) => Math.abs(v)));

  const noise = difference(again, one);
  const delta = difference(grid, one);
  measured[backend] = delta;

  console.log(`      one probe : ${one.means.map((m) => m.mean.toFixed(1)).join(' ')}`);
  console.log(`      repeat    : ${noise.map((v) => v.toFixed(2)).join(' ')}`);
  console.log(`      grid - one: ${delta.map((v) => v.toFixed(1)).join(' ')}`);

  const complaints = [...one.complaints, ...again.complaints, ...grid.complaints];
  check(
    `${backend}: draws all three states without a validation error`,
    complaints.length === 0,
    complaints.length === 0 ? 'clean' : complaints.slice(0, 2).join(' | '),
  );

  /* The frame contains the spheres at all. Everything below is a statement about a picture. */
  check(
    `${backend}: the frame contains the instrument`,
    grid.cells > 0 && grid.means.length >= 3,
    `${grid.cells} spheres in ${grid.means.length} columns`,
  );

  /*
   * **The control: the same scene measured twice must come back the same.** This is the floor the
   * claim below is measured against, and it is what makes a difference of a few levels mean
   * something rather than being the instrument moving.
   */
  check(
    `${backend}: the same scene measured twice agrees`,
    largest(noise) < NOISE_MAX,
    `worst column moved ${largest(noise).toFixed(2)} levels, under ${NOISE_MAX}`,
  );

  /*
   * **The claim.** A grid must light the two ends of a room differently, and by far more than the
   * instrument's own noise.
   */
  /*
   * **The premise the two claims below rest on, held as a value so they can rest on it.**
   *
   * Measured 2026-09-04 with `scripts/claimAudit.sh`: deleting the grid's contribution to ambient
   * left nine of this script's fifteen claims green. Two of them were the monotonicity claim
   * further down, which a row of zeroes satisfies exactly — nothing steps back if nothing steps —
   * and one was the cross-backend claim, which cannot tell two grids that agree from two grids that
   * are both absent.
   */
  const gridLights =
    Math.abs(spread(delta)) >= SPREAD_MIN && Math.abs(spread(delta)) > 4 * largest(noise);
  gridLit[backend] = gridLights;
  check(
    `${backend}: a grid lights the two ends of the room differently`,
    gridLights,
    `${spread(delta).toFixed(2)} levels end to end, against a noise floor of ` +
      `${largest(noise).toFixed(2)}`,
  );

  /*
   * **And it must brighten one end while darkening the other, which is what the check above misses.**
   *
   * Found by breaking it: forcing every fragment to read layer zero — a grid that bound one probe
   * everywhere — still moved the picture and still moved it monotonically, because layer zero
   * stands at one end of the room rather than at its centre. The profile came back
   * `-14.0 -11.7 -8.9 -6.1 -4.4`, which is a room lit entirely by its dark end and passed every
   * other claim here.
   *
   * A grid is compared against a *centred* probe, so a working one has to cross zero: the end near
   * the dark wall loses light and the end near the bright wall gains it. One layer everywhere can
   * only move the whole room the same way.
   */
  const first = delta[0] ?? 0;
  const last = delta[delta.length - 1] ?? 0;
  check(
    `${backend}: one end of the room darkens while the other brightens`,
    Math.sign(first) !== Math.sign(last) &&
      Math.abs(first) > SPREAD_MIN / 2 &&
      Math.abs(last) > SPREAD_MIN / 2,
    `${first.toFixed(2)} at one end against ${last.toFixed(2)} at the other`,
  );

  /*
   * **The claim a nearest-probe selection cannot pass, and the first version of it did not work.**
   *
   * That version asserted the middle column lies strictly between the ends. Replacing the blend
   * with a switch and running it: the profile came back `-14.0  0.0  0.0  0.0  21.8`, and zero is
   * between -14 and 21.8, so the check passed a shader with the feature removed. Found by breaking
   * it rather than by reading it, which is why that step is not a formality.
   *
   * A switch's signature is a *flat run* with jumps at the cell boundaries: every column inside one
   * cell reads the same probe. So the claim is that **every step across the room is non-zero** —
   * which a blend gives everywhere and a switch cannot give at all.
   */
  const steps = delta.slice(1).map((v, i) => v - (delta[i] ?? 0));
  const smallest = Math.min(...steps.map((v) => Math.abs(v)));
  check(
    `${backend}: every column differs from its neighbour, which a switch cannot do`,
    smallest > Math.max(0.5, largest(noise) * 2),
    `smallest step ${smallest.toFixed(2)} levels across ${steps.length} steps ` +
      `(${steps.map((v) => v.toFixed(1)).join(', ')})`,
  );

  /* Monotonic across the room, which a blend is and a switch is not obliged to be. */
  let monotonic = true;
  for (let i = 1; i < delta.length; i++) {
    const step = (delta[i] ?? 0) - (delta[i - 1] ?? 0);
    if (spread(delta) >= 0 ? step < -0.75 : step > 0.75) monotonic = false;
  }
  check(
    `${backend}: what the grid changes rises across the room without stepping back`,
    gridLights && monotonic,
    delta.map((v) => v.toFixed(1)).join(' -> '),
  );
}

if (backends.length === 2) {
  const a = measured.webgl2;
  const b = measured.webgpu;
  let worst = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    worst = Math.max(worst, Math.abs((a[i] ?? 0) - (b[i] ?? 0)));
  }
  check(
    'the two backends agree about the grid',
    gridLit.webgl2 === true && gridLit.webgpu === true && worst <= PARITY,
    `worst column disagreement ${worst.toFixed(2)} levels, tolerance ${PARITY}`,
  );
}

console.log(failed === 0 ? '\nall checks passed' : `\n${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
