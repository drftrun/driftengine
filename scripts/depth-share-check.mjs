/**
 * Does a forward-path mesh behind the second pipeline's geometry get hidden by it?
 *
 * **That is the whole of `presentDepth`, and a unit test cannot say it.** `gpuDrivenPass.test.ts`
 * pins the blit's pipeline state — a depth write, the frame's own comparison — and two
 * perturbations of that state passed before the stub kept descriptors at all. What the state
 * *does* is a driver's business. So `demo/dev/depthShare.html` draws a grey wall on the second
 * pipeline, a red box on the first behind it and a green box on the first in front of it, and this
 * counts the red and the green.
 *
 * It is not a `*.test.mjs` and `npm run test:scripts` does not pick it up: it needs a dev server
 * and a real GPU, like `occlusion-check.mjs` and `motion-check.mjs`.
 *
 *     (setsid npx vite demo/dev --port 5202 > /tmp/vite.log 2>&1 < /dev/null &) ; sleep 9
 *     node scripts/depth-share-check.mjs --base=http://localhost:5202
 *
 * **The control is what proves the flag does anything.** With the depth not shared and the boxes
 * drawn after the blit, both boxes must show: nothing hides anything. Without that run a red count
 * of zero would be equally well explained by a red box that never drew.
 *
 * **And the order is the second control.** Drawn *before* a blit that writes no depth, both boxes
 * are painted over — which is the other half of "no ordering fixes it" — and with the depth
 * shared the order must stop mattering at all: the same pixels either way.
 *
 * **The panes are the blit's other job.** A pane the second pipeline blends over the sky has no
 * surface of its own pipeline behind it, so its target holds the pane alone at a coverage below
 * one. Composited *over* the frame, its pixel has to differ from the backdrop and has to move when
 * the backdrop does; a blit that drops it matches the backdrop, and one that paints it opaque
 * ignores the backdrop.
 */
import { launch } from '../packages/core/scripts/browser.mjs';
import { connect } from '../packages/core/scripts/cdp.mjs';

function argOf(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
}

async function read(base, query) {
  const browser = await launch();
  const client = await connect(browser.port);
  const page = await client.page(`${base}/depthShare.html?backend=webgpu&${query}`, 1280, 720);
  await page.settled('globalThis.__depthShare', { settleMs: 1500 });
  const result = JSON.parse(await page.eval('JSON.stringify(globalThis.__depthShare)'));
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

const runs = {};
for (const depth of [0, 1]) {
  for (const order of ['after', 'before']) {
    for (const backdrop of [0, 1]) {
      const key = `depth=${depth}&order=${order}&backdrop=${backdrop}`;
      runs[key] = await read(base, key);
    }
  }
}
const run = (depth, order, backdrop = 0) =>
  runs[`depth=${depth}&order=${order}&backdrop=${backdrop}`].result;

const complaints = Object.values(runs).flatMap((r) => r.complaints);
check(
  'every page ran without complaint',
  complaints.length === 0,
  complaints.join(' | ') || 'clean',
);
const errors = Object.values(runs)
  .map((r) => r.result.error)
  .filter((e) => e !== null);
check('no page reported an error', errors.length === 0, errors.join(' | ') || 'none');
const backends = [...new Set(Object.values(runs).map((r) => r.result.backend))];
check(
  'every page drew on WebGPU',
  backends.length === 1 && backends[0] === 'webgpu',
  `backends ${backends.join(', ')}`,
);

for (const [key, { result }] of Object.entries(runs)) {
  console.log(
    `      ${key.padEnd(34)} red ${String(result.red).padStart(6)}  green ${String(result.green).padStart(6)}  ` +
      `wall ${String(result.wall).padStart(6)}  panes ${JSON.stringify(result.panes)}  backdrop ${JSON.stringify(result.backdropPixel)}`,
  );
}
console.log('');

/*
 * **The floor a box's count must clear to count as drawn.** A 2 m cube at 13 to 19 m from a 60°
 * camera covers thousands of pixels at 1280 by 720; a few hundred is a sliver, which is what a
 * box clipped by a mistaken projection would leave. Picked from the control, which is the run
 * where nothing may hide anything.
 */
const DRAWN = 2000;

const control = run(0, 'after');
check(
  'the control: with no depth shared and the boxes drawn after, both show',
  control.red > DRAWN && control.green > DRAWN,
  `red ${control.red}, green ${control.green}`,
);
check(
  'and the wall is there to hide them',
  control.wall > DRAWN * 10,
  `${control.wall} grey pixels`,
);

const shared = run(1, 'after');
check(
  'with the depth shared, the box behind the wall is hidden',
  shared.red === 0,
  `red ${shared.red}, where the control had ${control.red}`,
);
check(
  'and the box in front of it is not, to the pixel',
  shared.green === control.green,
  `green ${shared.green}, the control ${control.green}`,
);

const early = run(0, 'before');
check(
  'drawn before a blit that writes no depth, both are painted over',
  early.red === 0 && early.green === 0,
  `red ${early.red}, green ${early.green}`,
);
const sharedEarly = run(1, 'before');
check(
  'drawn before a blit that shares its depth, the one in front survives it',
  sharedEarly.red === 0 && sharedEarly.green === control.green,
  `red ${sharedEarly.red}, green ${sharedEarly.green}, the control ${control.green}`,
);

/*
 * The panes, in every run. Differ from the backdrop by more than the tone curve's rounding, and
 * move with it — a channel sum rather than a channel, so a pane that happened to match one channel
 * of one backdrop is not a pass.
 */
const distance = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
const OPACITY = ['0.45', '0.72'];
for (const depth of [0, 1]) {
  for (const order of ['after', 'before']) {
    const dark = run(depth, order, 0);
    const bright = run(depth, order, 1);
    for (let p = 0; p < 2; p += 1) {
      const label = `a pane at ${OPACITY[p]}, depth ${depth ? 'shared' : 'not shared'}, boxes ${order}`;
      check(
        `${label}: it shows over the backdrop`,
        distance(dark.panes[p], dark.backdropPixel) > 12 &&
          distance(bright.panes[p], bright.backdropPixel) > 12,
        `${JSON.stringify(dark.panes[p])} over ${JSON.stringify(dark.backdropPixel)}, ` +
          `${JSON.stringify(bright.panes[p])} over ${JSON.stringify(bright.backdropPixel)}`,
      );
      check(
        `${label}: and the backdrop shows through it`,
        distance(dark.panes[p], bright.panes[p]) > 12,
        `${JSON.stringify(dark.panes[p])} against ${JSON.stringify(bright.panes[p])}`,
      );
    }
  }
}

console.log(`\n${failed === 0 ? 'all checks passed' : `${failed} check(s) failed`}`);
process.exit(failed === 0 ? 0 : 1);
