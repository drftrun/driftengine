/**
 * The native host's pixel gate: a published scene held in the browser and under the host, compared.
 *
 *     (setsid npx vite demo/dev --port 5202 --strictPort > /tmp/vite.log 2>&1 < /dev/null &)
 *     npm run native:gate -- --base=http://localhost:5202 [--scenes=gilded-chamber,night-court]
 *         [--hold=420] [--out=<dir>]
 *
 * **The browser's half is the canvas, not the page.** The dev harness draws a readout and a scrubber
 * over the canvas, so they are hidden before the screenshot and the canvas's own rectangle is cut out
 * of it. The host's half is the canvas texture read back (`src/readback.ts`), at the same size, held
 * the same way (`src/main.ts --hold`), from the same address.
 *
 * **Pixel-identical is the claim, so the count is exact**: a pixel that differs in any channel by any
 * amount is counted, and the worst channel difference is printed beside it. A browser composites a
 * WebGPU canvas without touching its bytes on this machine, which is what makes a zero possible.
 *
 * Not a `*.test.mjs`: it needs a dev server, a real GPU and a display, like every device check here.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { launch, requireHardwareGpu } from '../../packages/core/scripts/browser.mjs';
import { connect } from '../../packages/core/scripts/cdp.mjs';
import { crop, decodePng, encodePng, readPng, rgbaOf } from '../../packages/core/scripts/png.mjs';
import { DEFAULT_SCENES } from '../../scripts/shots.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

function argOf(name, fallback) {
  const hit = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
}

const base = argOf('base', 'http://localhost:5202').replace(/\/$/, '');
const hold = Number(argOf('hold', '420'));
const out = argOf('out', join(HERE, '.gate'));
const query = argOf('query', '');
const wanted = argOf('scenes', DEFAULT_SCENES.join(','))
  .split(',')
  .filter((name) => name !== '');

/** The same readiness the capture harness waits for: the hold counted and a frame drawn. */
const READY =
  `window.__heldFrame >= ${hold} && ` +
  `/[1-9]\\d* draws/.test(document.getElementById('stats')?.textContent ?? '')`;

/** Pixels that differ in any channel, and the largest difference in one. */
function exact(one, two) {
  let changed = 0;
  let worst = 0;
  for (let at = 0; at < one.rgba.length; at += 4) {
    let pixel = 0;
    for (let channel = 0; channel < 3; channel += 1) {
      pixel = Math.max(pixel, Math.abs(one.rgba[at + channel] - two.rgba[at + channel]));
    }
    if (pixel > 0) changed += 1;
    worst = Math.max(worst, pixel);
  }
  return { changed, worst, pixels: one.rgba.length / 4 };
}

mkdirSync(out, { recursive: true });
const browser = await launch();
const client = await connect(browser.port);
console.log(`renderer: ${await requireHardwareGpu(client)}`);

let failed = 0;
for (const name of wanted) {
  const index = DEFAULT_SCENES.indexOf(name);
  if (index < 0) throw new Error(`${name} is not a published scene: ${DEFAULT_SCENES.join(', ')}`);

  const page = await client.page(
    `${base}/?scene=${index}&hold=${hold}&backend=webgpu${query === '' ? '' : `&${query}`}`,
    1280,
    720,
  );
  await page.settled(READY, { settleMs: 2500 });
  await page.eval(
    `for (const id of ['stats', 'scrub']) { const node = document.getElementById(id); if (node) node.style.display = 'none'; } true`,
  );
  await page.frames(2);
  const rect = await page.eval(`(() => {
    const canvas = document.getElementById('canvas');
    const box = canvas.getBoundingClientRect();
    return { x: Math.round(box.left), y: Math.round(box.top), width: canvas.width, height: canvas.height };
  })()`);
  /*
   * **Only the rows the viewport shows.** The stage starts at 112.97 CSS pixels, so the canvas is
   * snapped to row 113 and its last row falls on row 720 of a 720-row screenshot — past the end of
   * it. Read naively, that row compares the host's frame against nothing and reports a whole row of
   * difference that is the page's layout rather than the engine's.
   */
  const visible = Math.min(rect.height, 720 - rect.y);
  const shot = await page.call('Page.captureScreenshot', { format: 'png' });
  await page.close();
  const inBrowser = crop(rgbaOf(decodePng(Buffer.from(shot.data, 'base64'))), {
    ...rect,
    height: visible,
  });
  writeFileSync(
    join(out, `browser-${name}.png`),
    encodePng(inBrowser.width, inBrowser.height, inBrowser.rgba),
  );

  const nativeFile = join(out, `native-${name}.png`);
  const run = spawnSync(
    'npm',
    [
      'run',
      'native:scene',
      '--',
      name,
      '--hidden',
      `--hold=${hold}`,
      `--size=${rect.width}x${rect.height}`,
      `--out=${nativeFile}`,
      ...(query === '' ? [] : [`--query=${query}`]),
    ],
    { encoding: 'utf8', timeout: 600_000 },
  );
  if (run.status !== 0) {
    failed += 1;
    /*
     * The whole of what the host said, beside its frames, and its own lines here without npm's.
     * A failure printed as the tail of npm's output was eight lines of npm and nothing of the
     * host's, and the one it hid was intermittent: it never came back to be read again.
     */
    const said = run.stdout + run.stderr;
    writeFileSync(join(out, `native-${name}.log`), said);
    const own = said.split('\n').filter((line) => !line.startsWith('npm error'));
    console.log(
      `FAIL  ${name}: the host did not draw it (exit ${String(run.status)}, signal ${String(run.signal)}; log in native-${name}.log)\n` +
        own.slice(-20).join('\n'),
    );
    continue;
  }
  const inHost = crop(rgbaOf(readPng(nativeFile)), {
    x: 0,
    y: 0,
    width: rect.width,
    height: visible,
  });
  const result = exact(inBrowser, inHost);
  if (result.changed > 0) failed += 1;
  console.log(
    `${result.changed === 0 ? 'SAME' : 'DIFF'}  ${name.padEnd(16)} ${result.changed} of ${result.pixels} pixels differ, ` +
      `worst channel by ${result.worst}  (${rect.width}x${visible} of ${rect.width}x${rect.height} on screen)`,
  );
}

await browser.close?.();
console.log(
  failed === 0
    ? '\nevery scene is pixel-identical under both hosts'
    : `\n${failed} scene(s) differ`,
);
process.exit(failed === 0 ? 0 : 1);
