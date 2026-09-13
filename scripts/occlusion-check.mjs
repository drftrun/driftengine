/**
 * Does occlusion culling remove draws without removing pixels?
 *
 * **Two halves, and neither is evidence alone.** A cull that removes nothing is a feature that does
 * not work; a cull that changes the picture is a hole in the world, which is worse than no culling.
 * So this reads a count off `demo/dev/occlusion.html` and photographs the frame, twice per backend
 * — buffer on and buffer off — and asserts that the count falls and the pixels do not move.
 *
 * It is not a `*.test.mjs` and `npm run test:scripts` does not pick it up, deliberately: it needs a
 * dev server and a real GPU, which is the same reason `shots.mjs` is run by hand.
 *
 *     (setsid npx vite demo/dev --port 5202 > /tmp/vite.log 2>&1 < /dev/null &) ; sleep 9
 *     node scripts/occlusion-check.mjs --base=http://localhost:5202
 *
 * **Both backends, every run.** The buffer is arithmetic on the CPU and is the same code on both,
 * so the two are asserted to agree exactly — which is a stronger claim than either passing alone
 * and is the thing that would break first if any of it moved onto a GPU.
 */
import { launch } from '../packages/core/scripts/browser.mjs';
import { connect } from '../packages/core/scripts/cdp.mjs';
import { readPng } from '../packages/core/scripts/png.mjs';
import { compare } from '../packages/core/scripts/frames.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** The first row the page's own readout occupies. Everything above it is the scene. */
const READOUT_TOP = 680;

function argOf(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
}

async function read(base, backend, width, shot) {
  const browser = await launch();
  const client = await connect(browser.port);
  const page = await client.page(
    `${base}/occlusion.html?backend=${backend}&occ=${width}`,
    1280,
    720,
  );
  await page.settled('globalThis.__occlusionCheck', { settleMs: 2000 });
  const result = JSON.parse(await page.eval('JSON.stringify(globalThis.__occlusionCheck)'));
  await page.screenshot(shot);
  const complaints = page.complaints().filter((line) => !line.includes('404'));
  await page.close?.();
  await browser.close?.();
  return { result, complaints };
}

const base = argOf('base', 'http://localhost:5202').replace(/\/$/, '');
const out = mkdtempSync(path.join(tmpdir(), 'occ-'));

let failed = 0;
function check(name, ok, detail) {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${detail}`);
}

try {
  const counts = {};
  /** Whether each backend's buffer culled a real share, which the claims below rest on. */
  const culling = {};
  for (const backend of ['webgpu', 'webgl2']) {
    const off = await read(base, backend, 0, path.join(out, `${backend}-off.png`));
    const on = await read(base, backend, 256, path.join(out, `${backend}-on.png`));
    console.log(`\n${backend} — reported backend ${on.result.backend}\n`);
    check(
      'the page ran without complaint',
      on.complaints.length === 0 && off.complaints.length === 0,
      [...on.complaints, ...off.complaints].join(' | ') || 'clean',
    );
    check('no error was reported', on.result.error === null, on.result.error ?? 'none');
    check(
      'the control draws everything',
      off.result.culled === 0,
      `culled ${off.result.culled} with the buffer off`,
    );
    /*
     * The cull has to be substantial. A field of seventy-two boxes behind a wall with four controls
     * in front of and past it: anything under a third is a buffer that is barely working.
     */
    const cullsHard = on.result.culled > off.result.drawn / 3;
    culling[backend] = cullsHard;
    check(
      'the buffer removes a real share of the draws',
      cullsHard,
      `${on.result.culled} of ${off.result.drawn} culled`,
    );
    /*
     * The four controls are the shapes a cull that lost its conservatism takes: in front of the
     * wall, past each edge, and taller than it. All four must survive.
     */
    check(
      'every control survives',
      on.result.controlsDrawn === 4,
      `${on.result.controlsDrawn} of 4`,
    );
    /*
     * And the picture. **Identical, not close**: a cull that changed one pixel removed something
     * that was on screen, and there is no tolerance at which that is acceptable.
     */
    /*
     * **Above the readout, and that region is not a convenience.** `captureScreenshot` photographs
     * the *page*, and the page prints its own counts in the corner — which differ between the two
     * runs by construction. Compared whole, the two frames differ by 1,916 pixels in a band at the
     * bottom-left, every one of them a letter; it reads exactly like a cull that moved the picture,
     * and it cost an afternoon before somebody read the coordinates.
     */
    const diff = compare(
      readPng(path.join(out, `${backend}-off.png`)),
      readPng(path.join(out, `${backend}-on.png`)),
      { region: { x0: 0, y0: 0, x1: 1280, y1: READOUT_TOP } },
    );
    /*
     * **Gated on the cull having happened**, because a buffer that culls nothing changes no pixels
     * and this is exactly what that reads like. Measured 2026-09-04 with `scripts/claimAudit.sh`:
     * making `occluded` return false always left eleven of this script's thirteen claims green,
     * this one and the cross-backend claim below among them.
     */
    check(
      'and the frame is identical, pixel for pixel',
      cullsHard && diff.changed === 0,
      `${diff.changed} of ${diff.pixels} pixels changed`,
    );
    counts[backend] = on.result.culled;
  }
  check(
    'both backends culled the same objects, which is what one implementation means',
    culling.webgl2 === true && culling.webgpu === true && counts.webgpu === counts.webgl2,
    `webgpu ${counts.webgpu}, webgl2 ${counts.webgl2}`,
  );
} finally {
  rmSync(out, { recursive: true, force: true });
}

console.log(`\n${failed === 0 ? 'all checks passed' : `${failed} check(s) failed`}`);
process.exit(failed === 0 ? 0 : 1);
