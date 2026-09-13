/**
 * Does a frame past the WebGPU material ceiling come back whole once the ring has grown?
 *
 * **Past `MAX_MATERIALS_PER_FRAME` the backend skips the draw** — a stretch of the world simply
 * not drawn, which is what a consumer reported as ground that appears and disappears as the
 * camera moves. WebGL2 has no such ceiling and draws the lot, so the same scene differs between
 * the backends with nothing failing on either side.
 *
 * The rings grow now, at the start of the frame after one that ran out, and that means replacing a
 * `GPUBuffer` and rebuilding every bind group that held it. **A stub device cannot say whether the
 * rebuilt groups are valid**; only a real one can, and a wrong group is a validation failure or a
 * draw reading a destroyed buffer. That is the whole reason this file exists rather than another
 * unit test.
 *
 * It is not a `*.test.mjs` and `npm run test:scripts` does not pick it up, deliberately: it needs a
 * dev server and a real GPU, which is the same reason `shots.mjs` is run by hand.
 *
 *     npx vite demo/dev --port 5211 &
 *     node scripts/ring-growth-check.mjs --base=http://localhost:5211
 *
 * **It runs on the card.** An earlier run of this file asked for SwiftShader instead, on the
 * conclusion that this machine offered no headless WebGPU adapter: `--use-angle=vulkan` appeared to
 * take the GPU process down every time it was tried. The card was already failing and failed
 * outright an hour later, so the flag was never the cause. On those same flags after a reboot the
 * adapter is `vendor amd`, `architecture rdna-4`, and `requireHardwareGpu` refuses a software
 * rasteriser here, so its numbers can never be reported as the card's.
 *
 * **Both backends, every run, and WebGL2 printed first** — the 2026-08-23 rule. WebGL2 has no ring
 * to grow, so it is the control that says the page draws the number of quads it claims to, and any
 * shortfall on *both* backends is a fault in this instrument rather than in the renderer.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { launch, requireHardwareGpu } from '../packages/core/scripts/browser.mjs';
import { connect } from '../packages/core/scripts/cdp.mjs';

const CSS_WIDTH = 1280;
const CSS_HEIGHT = 720;

/**
 * More quads than the material ring holds, by enough that the shortfall is unmistakable.
 *
 * 1,200 against a ceiling of 1,024 loses 176 quads, which at this framing is a wide band of the
 * grid rather than a few pixels — a margin the instrument cannot miss and a count a rounding
 * difference between the backends cannot close.
 */
const QUADS = 1200;

/**
 * Noise this run cannot avoid and must not fail on.
 *
 * A 404 is the page's missing favicon. The pipeline error arrives as the browser is being closed
 * with a shader still compiling, and it was verified to appear on a run of a hundred quads that
 * drops nothing and grows nothing — so it is teardown and not the thing under test.
 */
function isNoise(line) {
  return (
    line.includes('404') ||
    /* Teardown, verified on a run that drops nothing and grows nothing. */
    line.includes('A valid external Instance reference no longer exists') ||
    /* A performance note about the screenshot's readback, not an error in the frame. */
    line.includes('GPU stall due to ReadPixels')
  );
}

function argOf(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
}

/*
 * **The lit-pixel count comes from the page, not from the screenshot.**
 *
 * Not because a WebGPU canvas photographs black — that was the failing card, and on the working
 * one this page's WebGPU shot carries 197,880 lit pixels against the page's own 194,650. The
 * difference is the on-page readout, which the screenshot includes and a copy of the canvas does
 * not, and that is the reason the count still comes from `rings.ts`: it copies its canvas inside
 * the animation frame that drew it and counts that alone. The screenshots are still taken and
 * still written out, for a person to look at.
 */

async function shoot(base, backend, query, shot) {
  const browser = await launch();
  const client = await connect(browser.port);
  /* Before anything is measured: a software rasteriser's figures are not this machine's. */
  await requireHardwareGpu(client);
  const page = await client.page(
    `${base}/rings.html?backend=${backend}&quads=${QUADS}&${query}`,
    CSS_WIDTH,
    CSS_HEIGHT,
  );
  await page.settled('globalThis.__drawn', { settleMs: 1500 });
  await page.screenshot(shot);
  const complaints = page.complaints().filter((line) => !isNoise(line));
  const budget = await page.eval('globalThis.__budget');
  const covered = await page.eval('globalThis.__covered');
  await page.close?.();
  await browser.close?.();
  return { complaints, budget, covered: Number(covered ?? 0) };
}

const base = argOf('base', 'http://localhost:5211').replace(/\/$/, '');
const out = mkdtempSync(path.join(tmpdir(), 'ringgrowth-'));

let failed = 0;
function check(name, ok, detail) {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${detail}`);
}

const area = {};
const budgets = {};
for (const backend of ['webgl2', 'webgpu']) {
  console.log(`\n=== ${backend} ===`);
  const one = await shoot(base, backend, 'frames=1', path.join(out, `${backend}-1.png`));
  const settled = await shoot(base, backend, 'frames=3', path.join(out, `${backend}-3.png`));

  area[backend] = { first: one.covered, settled: settled.covered };
  budgets[backend] = { first: one.budget ?? '', settled: settled.budget ?? '' };
  console.log(
    `      lit px: first frame ${area[backend].first} · settled ${area[backend].settled}`,
  );
  console.log(
    `      budget: first "${budgets[backend].first}" · settled "${budgets[backend].settled}"`,
  );

  /*
   * The ceiling's own warning is expected here — provoking it is the point — so it is not a
   * complaint. **Anything else is, and on WebGPU that is the assertion with the most teeth in this
   * file**: growth destroys a `GPUBuffer` and rebuilds every bind group that held it, and a group
   * left pointing at the old one is a Dawn validation error, loudly, on the next draw.
   */
  const complaints = [...one.complaints, ...settled.complaints].filter(
    (line) => !line.includes('material changes in a frame'),
  );
  check(
    `${backend}: draws 1,200 quads without a validation error`,
    complaints.length === 0,
    complaints.length === 0 ? 'clean' : complaints.join(' | '),
  );
}

/*
 * **The control.** WebGL2 has no ring and nothing to grow, so it must draw the whole grid on its
 * first frame and report nothing dropped on either. If it does not, this page does not draw what
 * it claims to and every figure above it is noise rather than evidence.
 */
check(
  'webgl2: draws the whole grid, having no ceiling to hit',
  area.webgl2.first > 1000 && area.webgl2.first === area.webgl2.settled,
  `${area.webgl2.first} px on both frames`,
);
check(
  'webgl2: drops nothing, on either frame',
  budgets.webgl2.first === 'nothing dropped' && budgets.webgl2.settled === 'nothing dropped',
  `"${budgets.webgl2.first}" then "${budgets.webgl2.settled}"`,
);

/*
 * **The finding.** The frame that discovers the ceiling is short by exactly the overflow, because
 * the ring only grows at the start of the next one. Asserted rather than tolerated: a first frame
 * that dropped nothing would mean the ceiling was never reached and the run proves nothing.
 */
check(
  'webgpu: the frame that discovers the ceiling drops the overflow',
  /materials 1200\/1024 dropped 176/.test(budgets.webgpu.first),
  `"${budgets.webgpu.first}"`,
);

/*
 * **The fix.** Three frames in, the ring has grown and the same scene draws whole. Before this
 * branch it read `materials 1200/1024 dropped 176` here too, for every frame, for as long as the
 * scene stayed that size.
 */
check(
  'webgpu: a grown ring drops nothing on the same scene',
  budgets.webgpu.settled === 'nothing dropped',
  `"${budgets.webgpu.settled}"`,
);

/*
 * **The pixel comparison, which is the assertion the budget string cannot make.**
 *
 * `nothing dropped` is the renderer's account of itself; this is the picture. A grown ring must
 * put the same lit area on screen as the backend that never had a ceiling, and with growth
 * disabled it reads 165,527 against 194,650 — the 176 quads, as a hole you can see.
 *
 * An earlier run skipped this, on the finding that a WebGPU canvas reads back black here. It does
 * not; the card was failing. There is no skip branch now, because a check that quietly skips is a
 * check that rots — a zero here is a failure like any other.
 */
check(
  'webgpu: a grown ring draws what the backend with no ceiling draws',
  area.webgpu.settled > 0 &&
    Math.abs(area.webgpu.settled - area.webgl2.settled) < area.webgl2.settled * 0.02,
  `webgpu ${area.webgpu.settled} against webgl2 ${area.webgl2.settled}`,
);

console.log(`\nshots in ${out}`);
process.exit(failed === 0 ? 0 : 1);
