/**
 * Do two light volumes in one frame each draw with their own uniforms?
 *
 * **The case nothing in this repository had ever drawn, and the reason to draw it.** Four WebGPU
 * passes are on record handing every draw in a frame the *last* draw's uniforms — `drawBolts`,
 * `drawFlock`, `drawWindStreaks` and `drawCaustics` each write one shared buffer with
 * `queue.writeBuffer` while the frame's encoder is submitted afterwards, so the last write reaches
 * every draw. Water had exactly this and lost three bodies of four, 387,837 pixels of a 921,600
 * pixel frame. `drawLightVolume` is documented as taking its uniforms from a `UniformRing`, which
 * is the fix for that hazard, and nothing had ever checked, because one cone is the arrangement in
 * which a shared slot draws the right picture.
 *
 * A travelling beam is what makes this urgent: a consumer sweeping a shaft through a scene issues
 * one draw per cone per frame, which is the arithmetic a consumer does.
 *
 * **`?sunshadow=0`, and that is not a convenience.** With the sun's map on, the page's ceiling
 * blocks light everywhere but its 1.6 m aperture, so a second cone placed far enough away not to
 * overlap the first draws almost nothing — and every comparison against it passes while measuring
 * almost nothing. A first version of this check did exactly that and reported 0 of 422,400 pixels
 * differing, three times, on both backends. Its own control is what caught it: the two solo
 * captures differed in 563 pixels of 844,800, which is not two pictures of two cones.
 *
 * **The method is an identity rather than a threshold.** The page draws two cones with different
 * strengths and different dust. A volume is additive, so the frame with both must equal each cone
 * drawn alone, summed, less the scene they were both drawn over. If a shared slot were handing
 * both draws the second cone's uniforms, the first cone's contribution is the second's and the
 * identity breaks everywhere the first cone is.
 *
 * It is not a `*.test.mjs` and `npm run test:scripts` does not pick it up, deliberately: it needs a
 * dev server and a real GPU, which is the same reason `shots.mjs` is run by hand.
 *
 *     (setsid npx vite demo/dev --port 5202 > /tmp/vite.log 2>&1 < /dev/null &) ; sleep 9
 *     node scripts/volume-cones-check.mjs --base=http://localhost:5202
 *
 * **Two questions, and the second is the row's own.** A travelling cone is also a cone drawn from
 * a camera that moved to get there, so the second half compares one pose drawn cold against the
 * same pose swept into over twelve frames. Anything the volume keeps between frames shows there.
 *
 * **Both backends, every run, and WebGL2 printed first** — the 2026-08-23 rule. WebGL2 sets its
 * uniforms and draws in one stream, so it cannot have this defect and is the control that says the
 * scene itself is right.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { launch } from '../packages/core/scripts/browser.mjs';
import { connect } from '../packages/core/scripts/cdp.mjs';
import { readPng } from '../packages/core/scripts/png.mjs';
import { compare } from '../packages/core/scripts/frames.mjs';

const CSS_WIDTH = 1280;
const CSS_HEIGHT = 720;
/** The first row the page's readout occupies. Everything below it is text, not scene. */
const READOUT_TOP = 660;

function argOf(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
}

async function shoot(base, backend, query, shot) {
  const browser = await launch();
  const client = await connect(browser.port);
  const page = await client.page(
    `${base}/volume.html?backend=${backend}&${query}`,
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
const out = mkdtempSync(path.join(tmpdir(), 'volumecones-'));

let failed = 0;
function check(name, ok, detail) {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${detail}`);
}

/*
 * The cones stand at z = -3.4 and z = +6.8 - 3.4, and the camera is at x 9.5, z 11 looking at the
 * origin — so the nearer cone is on the right of the frame and the further one on the left. The
 * split is taken at the middle rather than measured, and the assertion below is not sensitive to
 * where it falls: a half that contains all of one cone and none of the other is enough, and each
 * half is compared against the same half of its own solo capture.
 */
const HALF = Math.floor(CSS_WIDTH / 2);

/** Each backend's two-cone frame, so the two can be held against each other at the end. */
const byBackend = {};
/**
 * Whether each backend drew a volume at all, which every claim below the premise depends on.
 *
 * **The premise was asserted and nothing was made to depend on it.** The comment further down
 * already says the danger in full — *"if the two were drawn identically, then every comparison
 * further down would pass while measuring nothing"* — and then four claims went on comparing
 * anyway. Measured 2026-09-04 with `scripts/claimAudit.sh`: zeroing this pass's output,
 * `fragColor = vec4(0.0)`, left **nine of eleven** claims green, including that two empty frames
 * sum to an empty frame, that an empty frame equals the empty frame it was swept into, and that
 * the two backends draw the same nothing.
 *
 * So the premise is a value now rather than a sentence, and the claims that rest on it say so.
 */
const drewVolume = {};

for (const backend of ['webgl2', 'webgpu']) {
  console.log(`\n--- ${backend} ---`);
  const both = await shoot(
    base,
    backend,
    'cones=2&sunshadow=0',
    path.join(out, `${backend}-both.png`),
  );
  const first = await shoot(
    base,
    backend,
    'cones=2&only=0&sunshadow=0',
    path.join(out, `${backend}-0.png`),
  );
  const second = await shoot(
    base,
    backend,
    'cones=2&only=1&sunshadow=0',
    path.join(out, `${backend}-1.png`),
  );
  /* No cone at all: `only` names an index the loop never reaches, which is the scene underneath. */
  const background = await shoot(
    base,
    backend,
    'cones=2&only=9&sunshadow=0',
    path.join(out, `${backend}-none.png`),
  );

  const scale = both.image.width / CSS_WIDTH;
  const bottom = Math.floor(READOUT_TOP * scale);
  const split = Math.floor(HALF * scale);

  /*
   * **The premise every assertion below rests on, and it is not free.** If the second cone landed
   * off screen, or if the two were drawn identically, then every comparison further down would
   * pass while measuring nothing — which is exactly the failure this whole check exists to catch
   * in someone else's code. A first version of this script reported 0 of 422,400 pixels differing,
   * three times, on both backends, with the second cone standing outside the ceiling's aperture
   * and drawing almost nothing.
   */
  const whole = { x0: 0, y0: 0, x1: both.image.width, y1: bottom };
  const apart = compare(first.image, second.image, { region: whole, tolerance: 8 });
  const drawn = apart.changed > apart.pixels * 0.02;
  drewVolume[backend] = drawn;
  check(
    `${backend} the two cones are actually different pictures`,
    drawn,
    `${apart.changed} of ${apart.pixels} pixels differ between cone 0 alone and cone 1 alone`,
  );

  /*
   * **The assertion, and it is an identity rather than a threshold.**
   *
   * A light volume is additive, so a frame with both cones is the frame with neither plus each
   * cone's own contribution: `both = solo0 + solo1 - background`, per channel, clamped. That holds
   * wherever the two overlap, which they do on screen even though they stand 6.4 m apart in the
   * world — a second version of this check split the frame in half and compared each half against
   * one solo capture, and failed on 12,004 pixels of honest overlap, identically on both backends.
   * An identity over the whole frame needs no guess about where anything landed.
   *
   * If a shared uniform slot were handing both draws the last one's values, the first cone's
   * contribution in `both` is the second cone's, and this identity breaks everywhere the first
   * cone is.
   */
  const expected = {
    width: both.image.width,
    height: both.image.height,
    channels: both.image.channels,
    pixels: Buffer.alloc(both.image.pixels.length),
  };
  let saturated = 0;
  for (let i = 0; i < expected.pixels.length; i++) {
    const sum = first.image.pixels[i] + second.image.pixels[i] - background.image.pixels[i];
    if (sum > 255) saturated++;
    expected.pixels[i] = Math.max(0, Math.min(255, sum));
  }
  const additive = compare(both.image, expected, { region: whole, tolerance: 8 });
  check(
    `${backend} two volumes in one frame are the sum of each drawn alone`,
    drawn && additive.changed < additive.pixels * 0.005,
    `${additive.changed} of ${additive.pixels} pixels differ from solo0 + solo1 - background` +
      ` (${saturated} samples clamped)`,
  );

  /*
   * **And the same beam arrived at from motion.** The row this instrument closes is a *travelling*
   * cone, and the fault it was written to look for is anything the volume derives from a stale
   * camera: a reprojection, a per-frame origin, a matrix uploaded once. The page draws the sweep
   * frame by frame, so a pose reached after twelve frames of motion and the same pose drawn
   * straight away are the same picture unless something is carried between frames that should not
   * be. Half a sweep rather than the end of it, because a pose at the extreme is where a camera
   * stops moving and a stale matrix catches up.
   */
  const still = await shoot(
    base,
    backend,
    'phase=0.5&sunshadow=0&fog=0.03',
    path.join(out, `${backend}-still.png`),
  );
  const moved = await shoot(
    base,
    backend,
    'phase=0.5&warm=12&sunshadow=0&fog=0.03',
    path.join(out, `${backend}-moved.png`),
  );
  /*
   * The control for it, for the same reason the cones have one: `0 pixels differ` also describes a
   * phase that moves nothing. `?fog=` is on for both of these, because a beam sweeping *through
   * haze* is the configuration the row names and the medium is arithmetic per draw.
   */
  const elsewhere = await shoot(
    base,
    backend,
    'phase=0.9&sunshadow=0&fog=0.03',
    path.join(out, `${backend}-far.png`),
  );
  const swept = compare(still.image, elsewhere.image, { region: whole, tolerance: 8 });
  check(
    /* Gated on `drawn` because sweeping moves the *lamp* as well as the volume, so the lit floor
       moves under it and this passed with the volume gone entirely. */
    `${backend} the sweep actually moves the beam`,
    drawn && swept.changed > swept.pixels * 0.02,
    `${swept.changed} of ${swept.pixels} pixels differ between phase 0.5 and phase 0.9`,
  );

  const travel = compare(still.image, moved.image, { region: whole, tolerance: 8 });
  check(
    `${backend} a travelling beam draws the same pose it is swept into`,
    drawn && travel.changed < travel.pixels * 0.005,
    `${travel.changed} of ${travel.pixels} pixels differ between phase 0.5 drawn cold and swept into over 12 frames`,
  );

  byBackend[backend] = both.image;

  const complaints = [
    ...both.complaints,
    ...first.complaints,
    ...second.complaints,
    ...background.complaints,
    ...still.complaints,
    ...moved.complaints,
    ...elsewhere.complaints,
  ];
  check(
    `${backend} draws two volumes without complaint`,
    complaints.length === 0,
    complaints.join(' | ') || 'silent',
  );
}

/*
 * **And the two backends against each other**, which is the house rule and is free here: three
 * defects shipped on the WebGPU path because every capture went through `?backend=webgl2`, and
 * each drew a plausible picture on its own.
 */
if (byBackend.webgl2 !== undefined && byBackend.webgpu !== undefined) {
  const across = compare(byBackend.webgl2, byBackend.webgpu, { tolerance: 8 });
  console.log('');
  check(
    'the two backends draw two cones the same',
    drewVolume.webgl2 === true &&
      drewVolume.webgpu === true &&
      across.changed < across.pixels * 0.01,
    `${across.changed} of ${across.pixels} pixels differ between webgl2 and webgpu`,
  );
}

rmSync(out, { recursive: true, force: true });
console.log(failed === 0 ? '\nall checks passed' : `\n${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
