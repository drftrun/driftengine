#!/usr/bin/env node
/**
 * What a moving object leaves behind under a reconstruction, and whether the motion pass took it.
 *
 * **No capture in this repository can answer that.** `?hold=N` freezes the scene and the page
 * redraws one state for ever, so an accumulating resolve has converged long before the shutter
 * opens: the one published scene with rigid motion measures a mean delta of 0.93 from its native
 * frame at every hold tried, which is *better* than a still scene and says nothing at all.
 * `demo/dev/ghost.html` draws each position of a crossing twice — once arriving, with a history of
 * where the box was, and once settled — and compares them on the page; this reads the counts.
 *
 * **The control is the point of the arrangement.** With no reconstruction there is no history, so
 * the two frames are the same draw of the same matrices and must agree to the bit. A control that
 * is not zero means the page is measuring its own noise.
 *
 * It is not a `*.test.mjs` and `npm run test:scripts` does not pick it up, deliberately: it needs a
 * dev server and a real GPU, which is the same reason `motion-check.mjs` is run by hand.
 *
 *     (setsid npx vite demo/dev --port 5199 > /tmp/vite.log 2>&1 < /dev/null &) ; sleep 9
 *     node scripts/ghost-check.mjs --base=http://localhost:5199
 */
import { launch } from '../packages/core/scripts/browser.mjs';
import { connect } from '../packages/core/scripts/cdp.mjs';
import { decodePng, rgbaOf } from '../packages/core/scripts/png.mjs';

function argOf(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
}

const base = argOf('base', 'http://localhost:5199').replace(/\/$/, '');
const ratios = argOf('ratios', '0,1.5').split(',');
const motions = argOf('motions', 'slide,spin').split(',');
/*
 * How a draw names itself: `none` (the camera's motion only — the control the motion pass is
 * measured against), `matrix` (last frame's model) or `mover` (a `Mover`). The dynamic and instanced
 * rigs are their own identity and read the same under every one.
 */
const idents = argOf('idents', 'none,matrix').split(',');
/* `1` also measures each arriving frame against the same step drawn natively at four samples. */
const edges = argOf('edges', '0') === '1';

async function read(query) {
  const browser = await launch();
  const client = await connect(browser.port);
  const page = await client.page(`${base}/ghost.html?backend=webgpu&${query}`, 1280, 720);
  await page.settled('globalThis.__ghostCheck', { settleMs: 500, timeoutMs: 180000 });
  const result = JSON.parse(await page.eval('JSON.stringify(globalThis.__ghostCheck)'));
  const complaints = page.complaints().filter((line) => !line.includes('404'));
  await page.close?.();
  await browser.close?.();
  return { result, complaints };
}

let failed = 0;
function check(name, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail === undefined ? '' : `  ${detail}`}`);
  if (!ok) failed += 1;
}

/**
 * Twenty-four arriving frames of one run, as luma, through the page's stepper: each is the first
 * frame at a new position, captured before anything settles it.
 */
async function steppedLumas(query) {
  const browser = await launch();
  const client = await connect(browser.port);
  const page = await client.page(`${base}/ghost.html?backend=webgpu&stepper=1&${query}`, 1280, 720);
  await page.settled('globalThis.__ghostStep !== undefined', { settleMs: 300, timeoutMs: 180000 });
  const frames = [];
  for (let i = 0; i < 24; i += 1) {
    await page.eval(`globalThis.__ghostStep(${i})`);
    const shot = await page.call('Page.captureScreenshot', { format: 'png' });
    const image = rgbaOf(decodePng(Buffer.from(shot.data, 'base64')));
    const luma = new Float32Array(image.width * image.height);
    for (let p = 0; p < luma.length; p += 1) {
      luma[p] =
        0.2126 * image.rgba[p * 4] +
        0.7152 * image.rgba[p * 4 + 1] +
        0.0722 * image.rgba[p * 4 + 2];
    }
    frames.push({ width: image.width, luma });
  }
  await page.close?.();
  await browser.close?.();
  return frames;
}

/**
 * Mean luma error at the reference's edges — pixels whose gradient there exceeds 24 — split in
 * two: edges the moving thing occupied in this step or a neighbouring one (where a ghost, a doubled
 * edge or a lag shows), and every other edge, which never moved (where a reconstruction's own
 * softness at its ratio shows, and motion tracking cannot change it). A pixel is moving when the
 * reference differs there by more than eight levels between this step and the one before or after.
 */
function edgeErrors(frames, reference) {
  let moving = 0;
  let movingCount = 0;
  let still = 0;
  let stillCount = 0;
  for (let i = 0; i < frames.length; i += 1) {
    const { width, luma } = reference[i];
    const before = reference[Math.max(0, i - 1)].luma;
    const after = reference[Math.min(reference.length - 1, i + 1)].luma;
    const test = frames[i].luma;
    for (let p = width + 1; p < luma.length - width - 1; p += 1) {
      const g = Math.abs(luma[p + 1] - luma[p - 1]) + Math.abs(luma[p + width] - luma[p - width]);
      if (g <= 24) continue;
      const error = Math.abs(test[p] - luma[p]);
      if (Math.abs(luma[p] - before[p]) > 8 || Math.abs(luma[p] - after[p]) > 8) {
        moving += error;
        movingCount += 1;
      } else {
        still += error;
        stillCount += 1;
      }
    }
  }
  return {
    moving: movingCount === 0 ? Number.NaN : moving / movingCount,
    still: stillCount === 0 ? Number.NaN : still / stillCount,
  };
}

/** Both halves, as the one line the report prints. */
function describeEdges(errors) {
  return `moving edges ${errors.moving.toFixed(2)}, still edges ${errors.still.toFixed(2)}`;
}

for (const motion of motions) {
  /*
   * The reference is the native frame at four samples: the picture the reconstruction is trying to
   * be. A one-sample native frame is aliased, so measured against it a reconstruction is penalised
   * for being smoother; it is reported beside the others as the figure to meet instead.
   */
  const reference = edges
    ? await steppedLumas(`recon=0&samples=4&motion=${motion}&ident=none`)
    : null;
  if (reference !== null) {
    /* The control for the edge measure: the same unreconstructed run twice must agree exactly. */
    const again = await steppedLumas(`recon=0&samples=4&motion=${motion}&ident=none`);
    const floor = edgeErrors(again, reference);
    check(
      `${motion}, reference against itself`,
      floor.moving === 0 && floor.still === 0,
      describeEdges(floor),
    );
    const single = await steppedLumas(`recon=0&motion=${motion}&ident=none`);
    console.log(
      `      ${motion}, native one sample: ${describeEdges(edgeErrors(single, reference))}`,
    );
  }
  for (const ratio of ratios) {
    /* The control needs no second run: with no reconstruction there is no history to misplace. */
    for (const ident of ratio === '0' ? ['none'] : idents) {
      const label =
        ratio === '0'
          ? `${motion}, no reconstruction`
          : `${motion}, reconstruction at ${ratio}, ident ${ident}`;
      const { result, complaints } = await read(`recon=${ratio}&motion=${motion}&ident=${ident}`);
      if (result.error !== null) {
        check(label, false, result.error);
        continue;
      }
      const total = result.moving.reduce((sum, value) => sum + value, 0);
      const trail = result.trail.reduce((sum, value) => sum + value, 0);
      const worst = Math.max(...result.trail);
      let detail = `${total} px differ, ${trail} trailing, worst step ${worst}, worst channel ${result.worst}`;
      if (reference !== null && ratio !== '0') {
        const frames = await steppedLumas(`recon=${ratio}&motion=${motion}&ident=${ident}`);
        detail += `, ${describeEdges(edgeErrors(frames, reference))}`;
      }
      if (ratio === '0') {
        /* An equality rather than a threshold: with no history the two frames are the same draw,
           so anything above zero is this page measuring itself. */
        check(`${label} leaves nothing behind`, total === 0, detail);
      } else {
        console.log(`      ${label}: ${detail}`);
      }
      for (const line of complaints) console.log(`      complaint: ${line}`);
    }
  }
}

process.exitCode = failed > 0 ? 1 : 0;
