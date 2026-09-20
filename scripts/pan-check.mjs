#!/usr/bin/env node
/**
 * Whether a reconstruction's history follows a moving camera, read from `demo/dev/pan.html`.
 *
 * **The ghost check's other half.** That page moves an object under a still camera; this one moves
 * the camera over a still world, twice — sliding, where every surface moves by its depth, and
 * turning, where every surface moves alike — and reports how far each tile of the reconstructed
 * picture sits from the native one. A resolve reprojecting through a discarded depth passed every
 * other check in the tree and trailed a sliding camera by one and a half to three pixels.
 *
 * **The control is an equality**: with no reconstruction the page's two renderers draw the same
 * frames, and anything but zero is the page measuring itself. **The measurement is a bound**: a
 * quarter pixel is the search step and the jitter's own residue, and a history that is not moved
 * trails by the motion between frames times the frames it is kept — several steps of it.
 *
 * Not a `*.test.mjs`, for the reason `ghost-check.mjs` is not: it needs a dev server and a real GPU.
 *
 *     (setsid npx vite demo/dev --port 5199 > /tmp/vite.log 2>&1 < /dev/null &) ; sleep 9
 *     node scripts/pan-check.mjs --base=http://localhost:5199
 */
import { launch, requireHardwareGpu } from '../packages/core/scripts/browser.mjs';
import { connect } from '../packages/core/scripts/cdp.mjs';

function argOf(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
}

const base = argOf('base', 'http://localhost:5199').replace(/\/$/, '');
const ratios = argOf('ratios', '0,1.5').split(',');
const pans = argOf('pans', 'slide,turn').split(',');
/** Pixels a tile may sit from the native frame: two search steps. */
const BOUND = 0.5;

let failed = 0;
function check(name, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail === undefined ? '' : `  ${detail}`}`);
  if (!ok) failed += 1;
}

const browser = await launch();
try {
  const client = await connect(browser.port);
  console.log(`renderer: ${await requireHardwareGpu(client)}`);
  for (const pan of pans) {
    for (const ratio of ratios) {
      const recon = ratio === '0' ? '' : `&recon=${ratio}&samples=1`;
      const page = await client.page(
        `${base}/pan.html?backend=webgpu&pan=${pan}${recon}`,
        1280,
        720,
      );
      await page.settled('globalThis.__panCheck', { settleMs: 300, timeoutMs: 180000 });
      const result = JSON.parse(await page.eval('JSON.stringify(globalThis.__panCheck)'));
      const complaints = page.complaints().filter((line) => !line.includes('404'));
      await page.close();
      const label =
        ratio === '0' ? `${pan}, no reconstruction` : `${pan}, reconstruction at ${ratio}`;
      if (result.error !== null) {
        check(label, false, result.error);
        continue;
      }
      const detail = `worst tile ${result.worst} px, ${result.differing} px differ (${result.backend})`;
      if (ratio === '0') check(`${label} is the native frame`, result.differing === 0, detail);
      else check(`${label} follows the camera`, result.worst <= BOUND, detail);
      for (const line of complaints) console.log(`      complaint: ${line}`);
    }
  }
} finally {
  await browser.close();
}
process.exitCode = failed > 0 ? 1 : 0;
