/**
 * Does the second pipeline draw the same picture whether or not the camera has just moved?
 *
 * **Every other capture of the GPU-driven rigs is taken from a camera at rest**, and the two-phase
 * cull is the part of that pipeline which only misbehaves in motion: phase one judges what was
 * visible last frame, and a cluster it wrongly drops is missing for one frame and back the next —
 * by which time any held capture is correct. `demo/dev/motion.html` draws each position of a turn
 * twice, once arriving and once settled, and compares the two on the page; this reads the counts.
 *
 * It is not a `*.test.mjs` and `npm run test:scripts` does not pick it up, deliberately: it needs a
 * dev server and a real GPU, which is the same reason `shots.mjs` is run by hand.
 *
 *     (setsid npx vite demo/dev --port 5202 > /tmp/vite.log 2>&1 < /dev/null &) ; sleep 9
 *     node scripts/motion-check.mjs --base=http://localhost:5202
 *
 * **What it caught, 2026-09-17.** Phase one read the pyramid switch as on, because the pass wrote
 * one settings buffer twice through the queue and both writes land before the frame is submitted.
 * On the occlusion rig at four degrees a frame, five of forty-eight steps drew a frame with pixels
 * missing — 4, 8, 10, 6 and 75 of them — and the settled frame at the same position had them all.
 * With a buffer a phase, none of the three rigs differs at any step.
 *
 * WebGPU only, because the pipeline is: `gpuDrivenRefusal` is what WebGL2 answers.
 */
import { launch } from '../packages/core/scripts/browser.mjs';
import { connect } from '../packages/core/scripts/cdp.mjs';

function argOf(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
}

const base = argOf('base', 'http://localhost:5202').replace(/\/$/, '');
/* Four degrees a frame: fast enough that a stale pyramid is wrong somewhere, slow enough that the
   turn stays on the rig. */
const spin = Number(argOf('spin', '240'));
const rigs = argOf('rigs', 'occlusion,dense,materials').split(',');

async function read(rig) {
  const browser = await launch();
  const client = await connect(browser.port);
  const page = await client.page(
    `${base}/motion.html?backend=webgpu&rig=${rig}&spin=${spin}`,
    1280,
    720,
  );
  await page.settled('globalThis.__motionCheck', { settleMs: 500, timeoutMs: 120000 });
  const result = JSON.parse(await page.eval('JSON.stringify(globalThis.__motionCheck)'));
  const complaints = page.complaints().filter((line) => !line.includes('404'));
  await page.close?.();
  await browser.close?.();
  return { result, complaints };
}

let failed = 0;
function check(name, ok, detail) {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${detail}`);
}

for (const rig of rigs) {
  const { result, complaints } = await read(rig);
  console.log(`\n${rig} — ${result.moving.length} steps at ${spin} degrees a second\n`);
  check(
    'the page ran without complaint',
    complaints.length === 0,
    complaints.join(' | ') || 'clean',
  );
  check('no error was reported', result.error === null, result.error ?? 'none');
  /*
   * **The control, and without it the claim below is free.** A page whose camera did not move
   * draws the same frame twice at every step, and zero differing pixels is then what it reads
   * whether the cull is right or not.
   */
  const still = result.turned.slice(1).filter((pixels) => pixels === 0).length;
  check(
    'the camera turned at every step',
    result.turned.length > 1 && still === 0,
    `${still} of ${Math.max(0, result.turned.length - 1)} steps drew the frame before it`,
  );
  /* **Identical, not close**: a pixel the moving frame lacks is something that vanished. */
  const lost = result.moving
    .map((pixels, step) => ({ pixels, step }))
    .filter((entry) => entry.pixels > 0);
  check(
    'a frame that has just moved draws what a settled one does',
    result.moving.length > 0 && lost.length === 0,
    lost.length === 0
      ? `0 pixels differ at every step`
      : lost.map((entry) => `step ${entry.step}: ${entry.pixels} px`).join(', '),
  );
}

console.log(
  failed === 0 ? '\nall claims hold' : `\n${failed} claim${failed === 1 ? '' : 's'} failed`,
);
process.exit(failed === 0 ? 0 : 1);
