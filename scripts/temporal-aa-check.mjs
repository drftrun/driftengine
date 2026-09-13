/**
 * Does an edge have pixels along it that are neither of the two colours it separates?
 *
 * **That is the whole of antialiasing, stated as something countable.** An aliased edge is made of
 * the surface and the background and nothing between: each pixel is fully one or fully the other,
 * and which one it is flips as the edge crosses a pixel centre — that flipping is the crawl. A
 * resolved edge has pixels part way between, because the projection was jittered a fraction of a
 * pixel each frame and eight sub-pixel samples landed on both sides of it.
 *
 * So this counts pixels strictly between the two colours, and **the control is the same scene with
 * the resolve off**, where the count must be zero. Not "small" — zero. A hard edge on a flat white
 * quad against black has nothing in between it, which is what makes the signal unambiguous rather
 * than a threshold somebody tuned.
 *
 * **The camera never moves**, which is the strict form of the test. A moving camera would let a
 * blur of any kind manufacture intermediate pixels and pass; a still one produces them only if
 * something is sampling the geometry at more than one position within a pixel.
 *
 * **The mean is asserted beside the count**, because an antialiased edge must not also be a
 * displaced one. The jitter sequence is centred so its period sums to zero; were it not, the
 * resolved picture would sit a fraction of a pixel from where the unresolved one does and the whole
 * frame would change brightness. Comparing the means is what catches that, and it is the assertion
 * that fails if somebody "simplifies" the centring out of `temporalAa.ts`.
 *
 * It is not a `*.test.mjs` and `npm run test:scripts` does not pick it up, deliberately: it needs a
 * dev server and a real GPU, which is the same reason `shots.mjs` and `ring-growth-check.mjs` are
 * run by hand.
 *
 *     npx vite demo/dev --port 5212 &
 *     node scripts/temporal-aa-check.mjs --base=http://localhost:5212
 *
 * **Both backends, every run, and the control first** — the 2026-08-23 rule. The two resolve
 * independently, one through a rebound texture unit and one through a copy back over the scene, so
 * agreement between them is evidence and their controls agreeing is what makes the page trustworthy
 * in the first place.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { launch, requireHardwareGpu } from '../packages/core/scripts/browser.mjs';
import { connect } from '../packages/core/scripts/cdp.mjs';

const CSS_WIDTH = 1280;
const CSS_HEIGHT = 720;

/**
 * Long enough for the accumulation to converge, with margin.
 *
 * The sequence is eight frames and the blend keeps nine parts of ten, so the history's effective
 * window is about ten. Twelve is past both.
 */
const FRAMES = 12;

/**
 * What a resolved edge must clear.
 *
 * The measured figures are 1,078 on WebGL2 and 1,101 on WebGPU at this framing, so this is an
 * order of magnitude below what the effect produces and far above the zero its absence produces.
 * It is a floor rather than a range because a *better* resolve is not a failure.
 */
const RESOLVED_FLOOR = 500;

function isNoise(line) {
  return (
    line.includes('404') ||
    /* Teardown, with a shader still compiling as the browser is closed. */
    line.includes('A valid external Instance reference no longer exists')
  );
}

function argOf(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
}

async function shoot(base, backend, taa, shot) {
  const browser = await launch();
  try {
    const client = await connect(browser.port);
    /* Before anything is measured: a software rasteriser's figures are not this machine's. */
    await requireHardwareGpu(client);
    const page = await client.page(
      `${base}/taa.html?backend=${backend}&taa=${taa}&frames=${FRAMES}`,
      CSS_WIDTH,
      CSS_HEIGHT,
    );
    await page.settled('globalThis.__drawn', { settleMs: 1200 });
    await page.screenshot(shot);
    const complaints = page.complaints().filter((line) => !isNoise(line));
    const between = Number(await page.eval('globalThis.__intermediate'));
    const lit = Number(await page.eval('globalThis.__lit'));
    const mean = Number(await page.eval('globalThis.__mean'));
    await page.close?.();
    return { complaints, between, lit, mean };
  } finally {
    await browser.close?.();
  }
}

const base = argOf('base', 'http://localhost:5212').replace(/\/$/, '');
const out = mkdtempSync(path.join(tmpdir(), 'taa-'));

let failed = 0;
function check(name, ok, detail) {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${detail}`);
}

const measured = {};
for (const backend of ['webgl2', 'webgpu']) {
  console.log(`\n=== ${backend} ===`);
  const off = await shoot(base, backend, '0', path.join(out, `${backend}-off.png`));
  const on = await shoot(base, backend, '1', path.join(out, `${backend}-on.png`));
  measured[backend] = { off, on };

  console.log(
    `      off: ${off.between} px between · ${off.lit} lit · mean ${off.mean.toFixed(4)}`,
  );
  console.log(`      on : ${on.between} px between · ${on.lit} lit · mean ${on.mean.toFixed(4)}`);

  const complaints = [...off.complaints, ...on.complaints];
  check(
    `${backend}: draws both ways without a validation error`,
    complaints.length === 0,
    complaints.length === 0 ? 'clean' : complaints.join(' | '),
  );

  /*
   * **The control, and it is an equality rather than a threshold.** A flat white quad on black has
   * no intermediate pixels at all; if this is not zero the page is not drawing the edge this check
   * assumes and every figure below it means nothing.
   */
  check(
    `${backend}: the unresolved edge is two colours and nothing between`,
    off.between === 0,
    `${off.between} px between`,
  );

  check(
    `${backend}: the resolved edge has intermediate pixels along it`,
    on.between >= RESOLVED_FLOOR,
    `${on.between} px between, floor ${RESOLVED_FLOOR}`,
  );

  /*
   * **Antialiased and not displaced.** Eight offsets whose mean is not the centre of the pixel
   * would resolve to a picture sitting a fraction of a pixel from where every other pass draws.
   */
  check(
    `${backend}: resolving does not move the picture`,
    Math.abs(on.mean - off.mean) < 0.05,
    `mean ${off.mean.toFixed(4)} to ${on.mean.toFixed(4)}`,
  );
}

/*
 * **The two backends drew the same scene, so their controls must agree** — and they resolve by
 * different mechanics, so their resolved counts agreeing is the evidence that neither is doing
 * something of its own.
 */
check(
  'the backends agree on the unresolved frame',
  measured.webgl2.off.lit === measured.webgpu.off.lit,
  `webgl2 ${measured.webgl2.off.lit} lit · webgpu ${measured.webgpu.off.lit} lit`,
);

const resolved = [measured.webgl2.on.between, measured.webgpu.on.between];
check(
  'the backends resolve to within a tenth of each other',
  /* Both above the floor first: two zeroes are within a tenth of each other, and a run where
     neither backend resolved anything must not report agreement as though it were evidence. */
  resolved.every((count) => count >= RESOLVED_FLOOR) &&
    Math.abs(resolved[0] - resolved[1]) <= Math.max(...resolved) * 0.1,
  `webgl2 ${resolved[0]} against webgpu ${resolved[1]}`,
);

console.log(`\nshots in ${out}`);
process.exit(failed === 0 ? 0 : 1);
