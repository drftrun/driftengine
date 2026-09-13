/**
 * Does a contributed pass really own a target, fill it before the frame, and sample it during one?
 *
 * **A seam with no picture of its own, so this is its evidence.** What a pass-owned attachment
 * draws is whatever the package draws, and a screenshot of that says nothing about *when* the
 * target was filled. `demo/dev/passtarget.html` alternates the colour it writes per frame, so a
 * target filled one frame late reads back as the previous frame's colour on every frame rather
 * than being invisible.
 *
 * It is not a `*.test.mjs` and `npm run test:scripts` does not pick it up, deliberately: it needs
 * a dev server and a real GPU, which is the same reason `shots.mjs` is run by hand.
 *
 *     (setsid npx vite demo/dev --port 5202 > /tmp/vite.log 2>&1 < /dev/null &) ; sleep 7
 *     node scripts/passtarget-check.mjs --base=http://localhost:5202
 *
 * **Both backends, every run, and both must pass** — unlike the compute seam, where the two are
 * asserted to disagree. A pass-owned target is a capability both backends have, by two different
 * mechanisms: on WebGPU the ordering is a property of the frame's command encoder, and on WebGL2
 * it is a contract the pass keeps about the framebuffer binding. Running one of them proves
 * nothing about the other.
 *
 * Exits non-zero on the first failed check, so it can gate a commit.
 */
import { launch } from '../packages/core/scripts/browser.mjs';
import { connect } from '../packages/core/scripts/cdp.mjs';

function argOf(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
}

async function read(base, backend) {
  const browser = await launch();
  const client = await connect(browser.port);
  const page = await client.page(`${base}/passtarget.html?backend=${backend}`, 640, 480);
  await page.settled('globalThis.__passTargetCheck', { settleMs: 3000 });
  const result = JSON.parse(await page.eval('JSON.stringify(globalThis.__passTargetCheck)'));
  /* The favicon, which every page in demo/dev answers with a 404 and none of them owns. */
  const complaints = page.complaints().filter((line) => !line.includes('404'));
  await page.close?.();
  await browser.close?.();
  return { result, complaints };
}

const base = argOf('base', 'http://localhost:5202').replace(/\/$/, '');

let failed = 0;
function check(name, ok, detail) {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${detail}`);
}

/* WebGPU first, which is the backend consumers run. See the 2026-08-23 rule. */
for (const backend of ['webgpu', 'webgl2']) {
  const { result, complaints } = await read(base, backend);
  console.log(`\n${backend} — reported backend ${result.backend}\n`);
  const settled = result.frames.slice(1);
  check(
    'the page ran without complaint',
    complaints.length === 0,
    complaints.join(' | ') || 'clean',
  );
  check('no error was reported', result.error === null, result.error ?? 'none');
  check('every frame was drawn', result.frames.length === 6, `${result.frames.length} of 6`);
  /*
   * The failure a still picture cannot see. A target filled after the frame's pass had opened
   * would report the *previous* frame's colour, so every settled frame would be wrong — which is
   * why the colour alternates rather than being a constant.
   */
  check(
    'the colour written this frame is the colour sampled this frame',
    settled.length > 0 && settled.every((f) => f.ok),
    settled.map((f) => `${f.parity}:${f.r},${f.g},${f.b}`).join(' '),
  );
  /*
   * Separated out because it is a different fault with the same symptom in a summary: a target
   * that was never sampled reads black on every frame, and "not the right colour" would not say
   * which of the two happened.
   */
  check(
    'and the frame is not black, which is what a target nothing sampled looks like',
    settled.some((f) => f.r + f.g + f.b > 60),
    settled.map((f) => f.r + f.g + f.b).join(' '),
  );
}

console.log(`\n${failed === 0 ? 'all checks passed' : `${failed} check(s) failed`}`);
process.exit(failed === 0 ? 0 : 1);
