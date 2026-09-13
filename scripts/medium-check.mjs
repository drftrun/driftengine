/**
 * Does the global medium do what it says, and does it cost nothing when it is off?
 *
 * **Six claims, each written against a mutation that would break it**, which is the standard the
 * 2026-09-04 claim audit set: fifty-seven claims across eighteen scripts could not see their own
 * subject deleted, and the repair was to make each one fail when the term it names is removed. So
 * every check below names the deletion it catches, and the two that a photograph alone could not
 * catch are computed from the model rather than compared against a threshold somebody chose.
 *
 * **Run against six deletions on 2026-09-05, one per term the shader names**, and this is what
 * each one did. Every claim is killed by the mutation it is written against, and three of them
 * were rewritten because the first version was not — the notes at each check say which and why.
 *
 * | Deletion | What went red |
 * |---|---|
 * | the march accumulates nothing | shaft, shaft-moves, phase, silhouette |
 * | the shadow lookup is dropped, `lit = 1.0` | shaft (+186.3 against +98.2), shaft-moves (ratio 1.90) |
 * | the phase function returns `1 / 4pi` | phase (1.00 into the sun and 1.00 away) |
 * | extinction is not integrated, `exp(-sigma)` for `exp(-sigma * dl)` | `exp(-sigma d)` — 1.00 against 1.41 predicted, both patches moving 27.2 |
 * | the upsample's depth tolerance goes to infinity | silhouette (34.3 of variation against 0.1) |
 * | the composite runs whatever the density | **nothing, and that is honest** — see the note at that check |
 *
 * **Both backends, every run.** The march and its upsample are one GLSL source translated to WGSL
 * by `npm run wgsl`, so the two are the same arithmetic on paper; what differs is the framebuffer's
 * direction, and `DEPTH_01_TO_CLIP_Y_DOWN` records what one missing negation does to a
 * reconstruction. Nothing but running both catches that.
 *
 * It is not a `*.test.mjs` and `npm run test:scripts` does not pick it up, deliberately: it needs a
 * dev server and a real GPU, which is the same reason `shots.mjs` is run by hand.
 *
 *     (setsid npx vite demo/dev --port 5202 > /tmp/vite.log 2>&1 < /dev/null &) ; sleep 9
 *     node scripts/medium-check.mjs --base=http://localhost:5202
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
/** The first row the page's own readout occupies. Everything above it is the scene. */
const SCENE_BOTTOM = 640;
/** Half the side of the square a cell is averaged over, in CSS pixels. */
const CELL_RADIUS = 6;
/** How far either side of the post's centre the profile runs, in CSS pixels. */
const PROFILE_REACH = 22;

/** How the page is driven for each claim. One query is one run; a run is one browser page. */
const RUNS = {
  /* The build where the pass does not exist, and the same picture from a build where it does. */
  absent: 'steps=0&density=0.03&sun=250',
  zero: 'steps=48&density=0&sun=250',
  /* A room with a shaft in it, and the same room with the sun on the far side of the wall. */
  shaft: 'steps=48&density=0.03&sun=250',
  walled: 'steps=48&density=0.03&sun=70',
  /* The extinction pair: no shadows, so both floor patches are lit identically and differ only in
     how far away they are — and **isotropic**, so the phase function is the same constant in every
     direction and cannot enter the measurement. Without that this claim fails when the phase is
     flattened, which is a different claim's job and makes this one an unreliable witness. */
  litAbsent: 'steps=0&density=0&sunshadow=0&aniso=0',
  litThin: 'steps=48&density=0.02&sunshadow=0&aniso=0',
  litThick: 'steps=48&density=0.04&sunshadow=0&aniso=0',
  /* The phase pair, twice: into the sun and away from it. Thin enough not to clip. */
  intoForward: 'steps=48&density=0.008&sunshadow=0&look=sun&aniso=0.8',
  intoBackward: 'steps=48&density=0.008&sunshadow=0&look=sun&aniso=-0.8',
  awayForward: 'steps=48&density=0.008&sunshadow=0&look=away&aniso=0.8',
  awayBackward: 'steps=48&density=0.008&sunshadow=0&look=away&aniso=-0.8',
};

function argOf(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
}

const luminance = (pixels, i) =>
  0.2126 * pixels[i] + 0.7152 * pixels[i + 1] + 0.0722 * pixels[i + 2];

/** Mean luminance of a square where the page reported placing that cell. */
function patch(image, cell) {
  const scale = image.width / CSS_WIDTH;
  const cx = cell.x * scale;
  const cy = cell.y * scale;
  const r = CELL_RADIUS * scale;
  let count = 0;
  let sum = 0;
  for (let y = Math.floor(cy - r); y <= cy + r; y++) {
    for (let x = Math.floor(cx - r); x <= cx + r; x++) {
      if (x < 0 || y < 0 || x >= image.width || y >= image.height) continue;
      sum += luminance(image.pixels, (y * image.width + x) * image.channels);
      count++;
    }
  }
  return count === 0 ? 0 : sum / count;
}

/**
 * Mean luminance of the scene, which is every row above the readout.
 *
 * **The readout is excluded because it does not change with the medium**, so including it would
 * dilute every ratio below by a constant — and the phase claim is a ratio of two means.
 */
function sceneMean(image) {
  const rows = Math.floor((SCENE_BOTTOM * image.height) / CSS_HEIGHT);
  let sum = 0;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < image.width; x++)
      sum += luminance(image.pixels, (y * image.width + x) * image.channels);
  }
  return sum / (rows * image.width);
}

/** A horizontal run of luminances through the post's centre, for the silhouette claim. */
function postProfile(image, cell) {
  const scale = image.width / CSS_WIDTH;
  const y = Math.round(cell.y * scale);
  const x0 = Math.round(cell.x * scale);
  const out = [];
  for (let dx = -Math.round(PROFILE_REACH * scale); dx <= PROFILE_REACH * scale; dx++) {
    const x = x0 + dx;
    if (x < 0 || x >= image.width) continue;
    out.push(luminance(image.pixels, (y * image.width + x) * image.channels));
  }
  return out;
}

/** How many pixels of two images differ by more than a rounding step. */
function differing(one, two) {
  if (one.width !== two.width || one.height !== two.height) return Infinity;
  let count = 0;
  const rows = Math.floor((SCENE_BOTTOM * one.height) / CSS_HEIGHT);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < one.width; x++) {
      const i = (y * one.width + x) * one.channels;
      for (let c = 0; c < 3; c++) {
        if (Math.abs(one.pixels[i + c] - two.pixels[i + c]) > 0) {
          count++;
          break;
        }
      }
    }
  }
  return count;
}

async function capture(client, out, base, backend, name, query) {
  const page = await client.page(
    `${base}/medium.html?backend=${backend}&${query}`,
    CSS_WIDTH,
    CSS_HEIGHT,
  );
  await page.settled('globalThis.__drawn', { settleMs: 2200 });
  const file = path.join(out, `${backend}-${name}.png`);
  await page.screenshot(file);
  const cells = JSON.parse(await page.eval('JSON.stringify(globalThis.__mediumCells)'));
  const error = await page.eval('document.getElementById("error").textContent');
  /* The favicon, which every page in demo/dev answers with a 404 and none of them owns. */
  const complaints = page.complaints().filter((line) => !line.includes('404'));
  await page.close?.();
  const image = decodePng(readFileSync(file));
  const at = (key) => patch(image, cells[key]);
  return {
    image,
    cells,
    error,
    complaints,
    mean: sceneMean(image),
    shaftAir: at('shaftAir'),
    besideAir: at('besideAir'),
    floorNear: at('floorNear'),
    floorFar: at('floorFar'),
    profile: postProfile(image, cells.post),
  };
}

const base = argOf('base', 'http://localhost:5202').replace(/\/$/, '');
const only = argOf('backend', null);
const backends = only === null ? ['webgl2', 'webgpu'] : [only];
const out = mkdtempSync(path.join(tmpdir(), 'medium-'));

let failed = 0;
function check(name, ok, detail) {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${detail}`);
}

for (const backend of backends) {
  const browser = await launch();
  const client = await connect(browser.port);
  const shot = {};
  for (const [name, query] of Object.entries(RUNS)) {
    shot[name] = await capture(client, out, base, backend, name, query);
  }
  await browser.close?.();

  console.log(
    `\n${backend}, ${shot.shaft.image.width}x${shot.shaft.image.height}, frames in ${out}\n`,
  );

  const complaints = Object.values(shot).flatMap((run) => run.complaints);
  const errors = Object.entries(shot).filter(([, run]) => run.error !== '');
  check(
    'every run draws without complaint',
    complaints.length === 0,
    complaints.join(' | ') || 'clean',
  );
  check(
    'no run reported an error',
    errors.length === 0,
    errors.map(([name, run]) => `${name}: ${run.error}`).join(' | ') || 'none',
  );

  /*
   * Identical, not close. There is no tolerance at which a feature that was switched off is
   * allowed to have changed the picture, and this catches a composite whose arithmetic is not the
   * identity at zero — a target cleared to something other than "nothing happened", an alpha
   * written the wrong way up, an inscatter that does not vanish with the density.
   *
   * **What it cannot catch, said here rather than left to be assumed: whether a pass was
   * submitted.** At density 0 the march writes zero light and a transmittance of exactly 1, so
   * `dst * 1 + 0` is the frame either way — running the pass costs GPU time and moves no pixel.
   * Photographing it therefore proves the picture and not the price. The price is `mediumActive`
   * in `globalMedium.ts`, which both backends read before allocating anything, and
   * `globalMedium.test.ts` is what asserts it; the engine's own timer is no help here, since
   * `GPU_SLOTS` brackets a frame into shadows, reflection and rest and cannot see one pass.
   */
  const moved = differing(shot.absent.image, shot.zero.image);
  check(
    'density zero draws the frame the build without the pass draws',
    moved === 0,
    `${moved} pixels differ between steps=0 and density=0`,
  );

  /*
   * The march itself, measured as what it *added* at each cell rather than as the cell's value.
   *
   * **The subtraction is what makes the two cells comparable.** They have different surfaces
   * behind them, and against the same page with the ceiling at zero that background cancels
   * exactly — leaving the medium and nothing else. Two cells whose backgrounds had to match would
   * be a far more fragile instrument, and the claim is about the air rather than about the wall.
   */
  const addedShaft = shot.shaft.shaftAir - shot.absent.shaftAir;
  const addedBeside = shot.shaft.besideAir - shot.absent.besideAir;
  check(
    'the air in the shaft takes far more light than the air beside it',
    addedShaft > 2.5 * addedBeside && addedShaft > 8,
    `+${addedShaft.toFixed(1)} in the shaft against +${addedBeside.toFixed(1)} beside it`,
  );

  /*
   * And the shaft is the sun's rather than the window's shape alone: with the sun round the other
   * side of the wall no light enters, so the two cells fall back to the ambient term together.
   *
   * **This is the claim the shadow lookup dies on.** A march that never samples the map lights
   * every point of air the sun's colour whatever is between them, so it draws the same ratio at
   * both bearings — and the check above would still pass, because the two cells would differ by
   * their path lengths alone.
   */
  const walledShaft = shot.walled.shaftAir - shot.absent.shaftAir;
  const walledBeside = shot.walled.besideAir - shot.absent.besideAir;
  const litRatio = addedShaft / Math.max(addedBeside, 1e-3);
  const walledRatio = walledShaft / Math.max(walledBeside, 1e-3);
  /*
   * **Both halves, and the first half is why.** Asserting only that the ratio collapses passes a
   * build whose march never samples the shadow map at all: without the lookup there is no shaft at
   * either bearing, the ratio is near one both times, and moving the sun still changes it through
   * the phase function alone — measured at 1.90 falling to 0.72, which clears "less than half"
   * comfortably while the feature under test is deleted. So the claim also has to say that there
   * was a shaft to lose.
   */
  check(
    'the shaft goes when the sun goes round the wall',
    litRatio > 2.5 && walledRatio < litRatio / 2,
    `shaft-to-beside ${litRatio.toFixed(2)} with the sun at the window, ${walledRatio.toFixed(2)} behind the wall`,
  );

  /*
   * The phase function, as an ordering that flips rather than as a brightness.
   *
   * A forward-scattering medium is bright looking into the light and dim looking away; a backward
   * one is the reverse; **a constant phase is the same in both directions**, which is exactly what
   * the flip catches and no single measurement could.
   */
  const into = shot.intoForward.mean / shot.intoBackward.mean;
  const away = shot.awayForward.mean / shot.awayBackward.mean;
  check(
    'forward anisotropy brightens toward the light and back darkens it',
    into > 1.5 && away < 1 / 1.5,
    `into the sun forward/back ${into.toFixed(2)}, away from it ${away.toFixed(2)}`,
  );

  /*
   * Extinction, against what `exp(-sigma d)` predicts rather than against a threshold.
   *
   * Both patches are the same floor under the same light, so they differ only in distance; what
   * each loses when the density doubles is `S` times the change in its own transmittance. The
   * ratio of the two losses is therefore a pure function of the two distances and the two
   * densities, with the surface's own brightness cancelling — which is why this can be an equality
   * to within a tolerance instead of an inequality.
   *
   * **A flat tint fails it outright** by moving both patches equally, and so does any model that
   * applies extinction without integrating it over the distance travelled.
   */
  const thin = 0.02;
  const thick = 0.04;
  const dNear = shot.litThin.cells.floorNear.distance;
  const dFar = shot.litThin.cells.floorFar.distance;
  const predicted =
    (Math.exp(-thin * dFar) - Math.exp(-thick * dFar)) /
    (Math.exp(-thin * dNear) - Math.exp(-thick * dNear));
  const nearMoved = Math.abs(shot.litThin.floorNear - shot.litThick.floorNear);
  const farMoved = Math.abs(shot.litThin.floorFar - shot.litThick.floorFar);
  const measured = farMoved / Math.max(nearMoved, 1e-3);
  /*
   * **The floor under the ratio, which a ratio needs and this one nearly went without.** A
   * denominator that barely moved makes the quotient a report on rounding: run against a
   * flattened phase function this measured -29215 against 1.41 and the number said nothing about
   * extinction at all. Five units of 255 is far above the quantisation and far below what
   * doubling the density does to a lit surface at either distance.
   */
  const MOVED = 5;
  check(
    'each surface loses what exp(-sigma d) says it loses',
    nearMoved > MOVED && farMoved > MOVED && Math.abs(measured / predicted - 1) < 0.2,
    `${measured.toFixed(2)} measured against ${predicted.toFixed(2)} predicted at ` +
      `${dNear.toFixed(1)} m and ${dFar.toFixed(1)} m, ` +
      `each patch moving ${nearMoved.toFixed(1)} and ${farMoved.toFixed(1)}`,
  );

  /*
   * The silhouette. The post is dark and close and stands against a window that is bright and far,
   * so the fog behind it is many times its own — and the march runs at half resolution, which puts
   * both into the same low-resolution texel.
   *
   * **What is measured is the post's own surface, edge against centre.** A depth-aware upsample
   * refuses the taps whose march ended on the window, so the post is flat across; a plain bilinear
   * one carries the window's fog inward and the post wears a halo. The bound is a fraction of the
   * step across the silhouette, so it does not depend on the scene's own brightness.
   */
  const profile = shot.shaft.profile;
  const dark = Math.min(...profile);
  const bright = Math.max(...profile);
  const step = bright - dark;
  const inside = profile.filter((v) => v < dark + step * 0.5);
  const halo = inside.length === 0 ? Infinity : Math.max(...inside) - Math.min(...inside);
  /*
   * **The step has to exist before its evenness means anything**, which is the floor
   * `emissive-check.mjs` had to learn twice: a post standing against a background it does not
   * differ from has no halo and no silhouette either, and a claim that reads "0.0 of variation"
   * off a flat frame is the blindest kind of pass. Run against a march that accumulates nothing,
   * this reported minus infinity against a step of zero and called it a pass.
   */
  const SILHOUETTE = 40;
  check(
    'a silhouette does not bleed fog across it',
    step > SILHOUETTE && halo < step * 0.06,
    `${halo.toFixed(1)} of variation across the post against a step of ${step.toFixed(1)}`,
  );
}

console.log(failed === 0 ? '\nall claims hold' : `\n${failed} claim(s) failed`);
process.exit(failed === 0 ? 0 : 1);
